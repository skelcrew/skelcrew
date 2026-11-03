// The sandbox every agent runs in, and how Claude Code starts inside it. bubblewrap draws
// the boundary: the agent's folder is writable, the rest of the system read-only, and your
// home folder and credentials hidden.
import {
  closeSync,
  constants,
  existsSync,
  fstatSync,
  lstatSync,
  mkdirSync,
  openSync,
  readFileSync,
  realpathSync,
  renameSync,
  rmSync,
  writeFileSync,
} from "node:fs";
import { basename, dirname, join, resolve } from "node:path";
import { z } from "zod";

const { O_NONBLOCK, O_NOFOLLOW, O_RDONLY } = constants;

// Where the folder of the agent's socket appears inside, whatever its path outside.
const socketsInside = "/run/skel";

const ro = (p: string) => ["--ro-bind", p, p];
const rw = (p: string) => ["--bind", p, p];
const hide = (p: string) => ["--tmpfs", p];

function sandboxArgs(given: {
  home: string;
  path: string;
  mounts: string[];
  socket: string;
  cwd: string;
  command: string[];
}): string[] {
  const { home, path, mounts, socket, cwd, command } = given;
  // Its own process list, so your other processes can't be seen or signalled. No
  // --new-session: it moves Claude Code out of the terminal's process group, so it misses
  // resize signals and draws at the wrong width. The network stays shared for the model's API.
  const args = ["bwrap", "--die-with-parent", "--unshare-pid"];
  args.push("--ro-bind", "/", "/", "--dev", "/dev", "--proc", "/proc", "--tmpfs", "/tmp");
  // The ssh agent, keyring, D-Bus, systemd and docker listen under /run, and some run
  // commands for whoever connects. Only the DNS resolver comes back.
  args.push(...hide("/run"));
  if (existsSync("/run/systemd/resolve")) args.push(...ro("/run/systemd/resolve"));
  args.push(...hide(home));
  // Programs often live under the home folder: Claude Code under nvm keeps node beside it,
  // and its package where its link points. So the command's folder and the folder its link
  // resolves into come back, as does bun, which skel's own commands run on.
  const programs = new Set<string>();
  for (const name of [command[0], "bun"]) {
    const found = name && Bun.which(name, { PATH: path });
    if (found) {
      programs.add(dirname(found));
      programs.add(dirname(realpathSync(found)));
    }
  }
  for (const p of programs) args.push(...ro(p));
  // Only the parts skel runs from: its folder can be a checkout, whose .git and .skel hold
  // other threads' work.
  const skel = resolve(import.meta.dir, "..");
  for (const part of ["bin", "src", "node_modules", "package.json"])
    args.push(...ro(join(skel, part)));
  args.push(...mounts);
  // Its folder rather than the socket itself: the daemon makes the socket anew each time it
  // starts, and a mounted file would stay the old one, which nothing answers on. Read-only,
  // so the agent can't replace it. The folder must hold nothing else.
  args.push(...["--ro-bind", dirname(socket), socketsInside]);
  const inside = join(socketsInside, basename(socket));
  args.push("--setenv", "SKEL_SANDBOX", "1", "--setenv", "SKEL_SOCKET", inside);
  args.push("--chdir", cwd, "--", ...command);
  return args;
}

// The lead reads each repository's .git/config, so a credential in it would be the lead's.
function refuseCredentials(repository: string): void {
  const read = Bun.spawnSync(
    ["git", "-C", repository, "config", "--local", "--includes", "--get-regexp", "."],
    {
      stdout: "pipe",
      stderr: "pipe",
    },
  );
  // Exit 1 means an empty config. Any other failure, such as a line git can't parse, would
  // hide what the file holds, while the lead can still read it.
  if (read.exitCode !== 0 && read.exitCode !== 1)
    throw new Error(
      `git can't read ${repository}/.git/config, so skel can't check it for credentials: ${read.stderr.toString().trim()}`,
    );
  for (const line of read.stdout.toString().split("\n")) {
    const key = line.split(" ")[0] ?? "";
    if (/^http\..*extraheader$/i.test(key) || /https?:\/\/[^/\s]*@/i.test(line))
      throw new Error(
        `${repository}/.git/config holds a credential (${key}), which agents could read. Remove it from the remote URL and leave GitHub to gh`,
      );
  }
}

const ClaudeJson = z.looseObject({
  projects: z.record(z.string(), z.looseObject({})).optional(),
});

// Bypass mode shows a warning first, which nobody is there to accept. Claude Code's own
// sandbox fails inside skel's, so it stays off even if your settings turn it on.
const settings = '{"skipDangerousModePermissionPrompt":true,"sandbox":{"enabled":false}}';

// Only what a shell and Claude Code need gets in. Tokens and keys in your environment stay
// out, and so do CLAUDE_CODE_* variables inherited from a Claude Code session, which make
// the agent misbehave, for example by writing no transcript.
// ANTHROPIC_API_KEY is for those who use a key rather than a login.
const passed = [
  ...["PATH", "HOME", "USER", "LOGNAME", "SHELL", "TERM", "COLORTERM", "LANG", "TZ"],
  "ANTHROPIC_API_KEY",
];

const Token = z.string().trim().min(1);

export function agentCommand(given: {
  repositories: string[];
  name: string;
  socket: string;
  model: string;
  prompt?: string;
  resume?: string;
  sessionId?: string;
  env?: Record<string, string | undefined>;
}): { argv: string[]; env: Record<string, string> } {
  const { repositories, name, socket, model, prompt, resume, sessionId, env = process.env } = given;
  if (sessionId && resume) throw new Error("a session can't be both new and resumed");
  if (sessionId && !z.uuid().safeParse(sessionId).success)
    throw new Error(`Claude Code needs a UUID as a session ID, not "${sessionId}"`);
  const home = env.HOME;
  if (!home) throw new Error("HOME isn't set, so skel can't find its own folders");
  // The name becomes a folder, so it must not climb out of skel's.
  if (!/^[a-zA-Z0-9][\w.-]*$/.test(name)) throw new Error(`"${name}" can't name a session`);

  // A token from claude setup-token never renews. A shared login would: renewing makes the
  // old refresh token stop working, so your own login or the agent's would go stale.
  const tokenFile = join(home, ".config", "skel", "claude-token");
  if (!existsSync(tokenFile))
    throw new Error("Claude Code's login token for agents isn't saved yet: run skel to set it up");
  const token = Token.parse(readFileSync(tokenFile, "utf8"));

  // A folder of its own per session, never your ~/.claude: an agent could write memory or
  // settings that another session loads as instructions. It stays, so --resume finds the
  // transcripts.
  const configs = join(home, ".local", "share", "skel", "claude");
  const config = join(configs, name);
  // skel writes here with your rights, and the agent can change what is in its folder. A
  // link it left would send that write to any file of yours.
  for (const p of [configs, config, join(config, ".claude.json")])
    if (lstatSync(p, { throwIfNoEntry: false })?.isSymbolicLink())
      throw new Error(`${p} is a link, so skel won't write through it`);
  mkdirSync(config, { recursive: true });
  // The lead sees its repositories read-only and works in a folder of its own.
  for (const repo of repositories) {
    refuseCredentials(repo);
    // Made before the sandbox starts, since a folder hidden only once it exists would let
    // threads started after the lead show up in its sandbox.
    mkdirSync(join(repo, ".skel"), { recursive: true });
  }
  const cwd = join(home, ".local", "share", "skel", "lead");
  mkdirSync(cwd, { recursive: true });
  // Each repository's .skel holds the threads' work, which isn't the lead's to read.
  const mounts = [
    ...rw(cwd),
    ...repositories.flatMap((repo) => [...ro(repo), ...hide(join(repo, ".skel"))]),
    ...rw(config),
  ];

  // Claude Code asks whether to trust the folder even in bypass mode, and would wait there
  // with nobody to answer.
  const file = join(config, ".claude.json");
  let json: z.infer<typeof ClaudeJson> = {};
  if (existsSync(file)) {
    // Non-blocking, since the agent could leave a pipe there, and opening one waits forever.
    const fd = openSync(file, O_RDONLY | O_NOFOLLOW | O_NONBLOCK);
    try {
      const stat = fstatSync(fd);
      if (!stat.isFile() || stat.size > 64 * 1024 * 1024)
        throw new Error(`${file} isn't a plain file, so skel won't use it`);
      json = ClaudeJson.parse(JSON.parse(readFileSync(fd, "utf8")));
    } finally {
      closeSync(fd);
    }
  }
  const projects = json.projects ?? {};
  projects[cwd] = { ...projects[cwd], hasTrustDialogAccepted: true };
  // Written beside it and renamed over it, so even a link made since the check is replaced,
  // never followed. "wx" refuses a link already at the new name.
  const fresh = join(config, `.claude.json.${process.pid}`);
  rmSync(fresh, { force: true });
  writeFileSync(fresh, JSON.stringify({ ...json, projects }), { mode: 0o600, flag: "wx" });
  renameSync(fresh, file);

  const command = ["claude", "--model", model, "--permission-mode", "bypassPermissions"];
  command.push("--settings", settings);
  if (resume) command.push("--resume", resume);
  if (sessionId) command.push("--session-id", sessionId);
  if (prompt) command.push(prompt);

  const kept: Record<string, string> = {};
  for (const [key, value] of Object.entries(env)) {
    if (value !== undefined && (passed.includes(key) || key.startsWith("LC_"))) kept[key] = value;
  }
  kept.CLAUDE_CONFIG_DIR = config;
  kept.CLAUDE_CODE_OAUTH_TOKEN = token;
  const argv = sandboxArgs({
    home,
    path: env.PATH ?? "",
    mounts,
    socket,
    cwd,
    command,
  });
  return { argv, env: kept };
}
