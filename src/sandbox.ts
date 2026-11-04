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
  readdirSync,
  readFileSync,
  realpathSync,
  renameSync,
  rmSync,
  writeFileSync,
} from "node:fs";
import { basename, dirname, join, resolve } from "node:path";
import { z } from "zod";
import { dataDir } from "./paths.ts";

const { O_NONBLOCK, O_NOFOLLOW, O_RDONLY } = constants;

// Where the folder of the agent's socket appears inside, whatever its path outside.
const socketsInside = "/run/skel";

// Returns a read-only mount so agents can read a folder without changing its files.
const ro = (p: string) => ["--ro-bind", p, p];
// Returns a writable mount for the agent's own work or session files.
const rw = (p: string) => ["--bind", p, p];
// Returns an empty mount that hides a host folder and its credentials from the agent.
const hide = (p: string) => ["--tmpfs", p];

// Finds a program's package folder so its required files remain visible after hiding your
// home folder. Codex from npm links to bin/codex.js in its package, and runs a program from
// another folder of it. Never the home folder itself, nor above it, which would bring back
// too much.
function packageOf(folder: string, home: string): string {
  for (let at = folder; at !== home && at !== dirname(at); at = dirname(at))
    if (existsSync(join(at, "package.json"))) return at;
  return folder;
}

// Returns bubblewrap arguments that hide your credentials and expose only the agent's
// chosen writable folders. Keeps the terminal connection and network available for the
// harness and model, and puts skel's own commands on the agent's PATH.
export function sandboxArgs(given: {
  home: string;
  path: string;
  mounts: string[];
  socket?: string;
  cwd: string;
  command: string[];
  programs?: string[] | undefined;
}): string[] {
  const { home, path, mounts, socket, cwd, command, programs: named = [command[0]] } = given;
  // Its own process list, so your other processes can't be seen or signalled. No
  // --new-session: it moves Claude Code out of the terminal's process group, so it misses
  // resize signals and draws at the wrong width. The network stays shared for the model's
  // API.
  const args = ["bwrap", "--die-with-parent", "--unshare-pid"];
  args.push("--ro-bind", "/", "/", "--dev", "/dev", "--proc", "/proc", "--tmpfs", "/tmp");
  // The ssh agent, keyring, D-Bus, systemd and docker listen under /run, and some run
  // commands for whoever connects. Only the DNS resolver comes back.
  args.push(...hide("/run"));
  if (existsSync("/run/systemd/resolve")) args.push(...ro("/run/systemd/resolve"));
  args.push(...hide(home));
  // Programs often live under the home folder: Claude Code under nvm keeps node beside it,
  // and its package where its link points. So the program's folder and the package its link
  // resolves into come back, as does bun, which skel's own commands run on. The program is
  // the command's first word unless others are named, as for a shell running a setup command.
  const programs = new Set<string>();
  for (const name of [...named, "bun"]) {
    const found = name && Bun.which(name, { PATH: path });
    if (found) {
      programs.add(dirname(found));
      programs.add(packageOf(dirname(realpathSync(found)), home));
    }
  }
  for (const p of programs) args.push(...ro(p));
  // skel built as one file runs its modules from a folder only it sees, and needs nothing
  // but itself. From a checkout, only the parts skel runs from: the checkout's .git and
  // other files aren't the agent's to read. bun runs skel without node_modules by fetching
  // its packages itself, and bwrap refuses to start when a folder it should mount is missing.
  const skel = resolve(import.meta.dir, "..");
  const single = import.meta.dir.startsWith("/$bunfs");
  const bin = single ? dirname(process.execPath) : join(skel, "bin");
  if (single) args.push(...ro(process.execPath));
  else
    for (const part of ["bin", "src", "node_modules", "package.json"])
      if (existsSync(join(skel, part))) args.push(...ro(join(skel, part)));
  args.push(...mounts);
  // Its folder rather than the socket itself: the daemon makes the socket anew each time it
  // starts, and a mounted file would stay the old one, which nothing answers on. Read-only,
  // so the agent can't replace it. The folder must hold nothing else.
  if (socket) {
    args.push(...["--ro-bind", dirname(socket), socketsInside]);
    args.push("--setenv", "SKEL_SOCKET", join(socketsInside, basename(socket)));
  }
  args.push("--setenv", "SKEL_SANDBOX", "1", "--setenv", "PATH", `${bin}:${path}`);
  args.push("--chdir", cwd, "--", ...command);
  return args;
}

// Rejects clone settings containing credentials or unreadable settings, so agents cannot
// receive your GitHub login. The lead reads each clone's .git/config, so a credential in it
// would be the lead's.
export function refuseCredentials(repository: string): void {
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
export const settings = '{"skipDangerousModePermissionPrompt":true,"sandbox":{"enabled":false}}';

// Only what a shell and Claude Code need gets in. Tokens and keys in your environment stay
// out, and so do CLAUDE_CODE_* variables inherited from a Claude Code session, which make
// the agent misbehave, for example by writing no transcript. ANTHROPIC_API_KEY is for those
// who use a key rather than a login.
const passed = [
  ...["PATH", "HOME", "USER", "LOGNAME", "SHELL", "TERM", "COLORTERM", "LANG", "TZ"],
  "ANTHROPIC_API_KEY",
];

const Token = z.string().trim().min(1);

// Returns only the environment a shell and Claude Code need, so tokens and keys in yours
// stay out of every sandbox.
function keptEnv(env: Record<string, string | undefined>): Record<string, string> {
  const kept: Record<string, string> = {};
  for (const [key, value] of Object.entries(env)) {
    if (value !== undefined && (passed.includes(key) || key.startsWith("LC_"))) kept[key] = value;
  }
  return kept;
}

// Returns the sandboxed command and environment for one of skel.yaml's setup commands, to
// run through a shell in the thread's clone. It comes from the repository, so it runs in
// the sandbox like the agents, with no socket and no login.
export function setupCommand(
  folder: string,
  command: string,
  env: Record<string, string | undefined> = process.env,
): { argv: string[]; env: Record<string, string> } {
  const home = env.HOME;
  if (!home) throw new Error("HOME isn't set, so skel can't find its own folders");
  const argv = sandboxArgs({
    home,
    path: env.PATH ?? "",
    mounts: rw(folder),
    cwd: folder,
    command: ["sh", "-c", command],
    // sh lives outside the home folder, but the programs a setup command runs, such as npm
    // under nvm, often don't. Every word is tried rather than the first, since a command
    // can start with cd or a variable; words that name no program bring back nothing. Only
    // bare names: the command comes from the repository, and a path could name a program in
    // a folder of yours that holds secrets, such as skel's own token.
    programs: command.split(/\s+/).filter((word) => !word.includes("/")),
  });
  return { argv, env: keptEnv(env) };
}

// Reports whether a session saved a conversation, so skel knows whether --resume can bring
// it back. Claude Code saves a conversation only once it has a message, so a session nobody talked to
// has nothing to resume, and its id can't start a new one either. It saves it in the
// session's own config folder, under a folder named after the folder it runs in, with every
// character but letters and digits made a dash. Names over 200 characters get a hash
// instead, which skel's folders never come near.
export function hasTranscript(name: string, folder: string, session: string): boolean {
  const project = folder.replace(/[^a-zA-Z0-9]/g, "-");
  return existsSync(join(dataDir(), "claude", name, "projects", project, `${session}.jsonl`));
}

// Prepares an agent's own config folder and trusted Claude Code settings, then returns its
// sandbox command and environment. A builder, given its thread's clone, works there and sees
// nothing else; the lead works in its own folder and sees skel's clone of every repository.
// Each session keeps its own transcripts and logs in with skel's agent token, while your
// other credentials stay hidden.
export function agentCommand(given: {
  name: string;
  socket: string;
  model: string;
  thread?: string;
  prompt?: string;
  system?: string;
  resume?: string;
  sessionId?: string;
  env?: Record<string, string | undefined>;
}): { argv: string[]; env: Record<string, string> } {
  const {
    name,
    socket,
    model,
    thread,
    prompt,
    system,
    resume,
    sessionId,
    env = process.env,
  } = given;
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
  const cwd = thread ?? join(home, ".local", "share", "skel", "lead");
  const mounts = [...rw(cwd), ...rw(config)];
  if (!thread) {
    // The whole folder of clones is mounted, made first if need be, so a repository brought
    // in while the lead runs shows up in its sandbox too.
    const repos = join(home, ".local", "share", "skel", "repos");
    mkdirSync(repos, { recursive: true });
    for (const owner of readdirSync(repos))
      for (const repo of readdirSync(join(repos, owner)))
        refuseCredentials(join(repos, owner, repo));
    mkdirSync(cwd, { recursive: true });
    mounts.push(...ro(repos));
  }

  // Claude Code asks whether to trust the folder even in bypass mode, and would wait there
  // with nobody to answer.
  const file = join(config, ".claude.json");
  let json: z.infer<typeof ClaudeJson> = {};
  if (existsSync(file)) {
    // Non-blocking, since the agent could leave a pipe there, and opening one waits
    // forever.
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
  if (system) command.push("--append-system-prompt", system);
  if (prompt) command.push(prompt);

  const kept = keptEnv(env);
  kept.CLAUDE_CONFIG_DIR = config;
  kept.CLAUDE_CODE_OAUTH_TOKEN = token;
  // Its greyed-out suggestions propose steps, such as pushing, that belong to skel.
  kept.CLAUDE_CODE_ENABLE_PROMPT_SUGGESTION = "false";
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
