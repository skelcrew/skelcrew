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
import { dirname, join, resolve } from "node:path";
import { z } from "zod";

const { O_NONBLOCK, O_NOFOLLOW, O_RDONLY } = constants;

export type Agent =
  | { kind: "lead"; repositories: string[] }
  | { kind: "builder" | "reviewer"; repository: string; worktree: string };

// Where the agent's socket appears inside, whatever its path outside.
const socketInside = "/run/skel.sock";

const ro = (p: string) => ["--ro-bind", p, p];
const rw = (p: string) => ["--bind", p, p];
const hide = (p: string) => ["--tmpfs", p];
// A missing path is covered with an empty read-only file, or the agent could create it.
// Not /dev/null: on a folder mounted nodev, such as /tmp, opening it is refused, and git
// then warns on every command.
const fixed = (p: string, empty: string) => (existsSync(p) ? ro(p) : ["--ro-bind", empty, p]);

export function sandboxArgs(given: {
  home: string;
  path: string;
  mounts: string[];
  env?: Record<string, string>;
  socket: string;
  cwd: string;
  command: string[];
}): string[] {
  const { home, path, mounts, env = {}, socket, cwd, command } = given;
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
  // other threads' work and sockets.
  const skel = resolve(import.meta.dir, "..");
  for (const part of ["bin", "src", "node_modules", "package.json"])
    args.push(...ro(join(skel, part)));
  args.push(...mounts);
  args.push("--bind", socket, socketInside);
  args.push("--setenv", "SKEL_SANDBOX", "1", "--setenv", "SKEL_SOCKET", socketInside);
  for (const [key, value] of Object.entries(env)) args.push("--setenv", key, value);
  args.push("--chdir", cwd, "--", ...command);
  return args;
}

type Seen = { mounts: string[]; env: Record<string, string>; cwd: string };

// What each kind of agent sees beyond the read-only system, and the folder it starts in.
export function agentMounts(agent: Agent, home: string): Seen {
  for (const repo of agent.kind === "lead" ? agent.repositories : [agent.repository])
    refuseCredentials(repo);
  if (agent.kind === "lead") {
    const lead = join(home, ".local", "share", "skel", "lead");
    mkdirSync(lead, { recursive: true });
    const mounts = rw(lead);
    for (const repo of agent.repositories) {
      // .skel holds every thread's worktree and socket, and a socket answers whoever
      // connects, even through a read-only mount. It is made now, so threads started
      // after the lead land under the hidden folder too.
      mkdirSync(join(repo, ".skel"), { recursive: true });
      mounts.push(...ro(repo), ...hide(join(repo, ".skel")));
    }
    return { mounts, env: {}, cwd: lead };
  }
  const { repository, worktree } = agent;
  const mounts = [...ro(repository), ...hide(join(repository, ".skel"))];
  if (agent.kind === "reviewer")
    return { mounts: [...mounts, ...ro(worktree)], env: {}, cwd: worktree };
  // A worktree commits into the repository's .git: objects and refs live there. But
  // the daemon's push runs git outside the sandbox with your rights, and git follows a
  // commondir file in .git, or in any worktree's folder, to a config that runs commands.
  // So the builder gets a .git of its own whose top level is thrown away: what a commit,
  // rebase or merge must keep comes back from the real one, and nothing else does.
  const git = join(repository, ".git");
  const link = readFileSync(join(worktree, ".git"), "utf8")
    .replace(/^gitdir: /, "")
    .trim();
  const own = resolve(worktree, link);
  const empty = join(home, ".local", "share", "skel", "empty");
  if (!existsSync(empty)) {
    mkdirSync(dirname(empty), { recursive: true });
    writeFileSync(empty, "", { mode: 0o444 });
  }
  mounts.push(...rw(worktree), ...ro(join(worktree, ".git")), ...hide(git));
  for (const entry of readdirSync(git)) {
    const p = join(git, entry);
    if (["objects", "refs"].includes(entry)) mounts.push(...rw(p));
    // Git outside appends to a reflog by following whatever is there, so a link planted in
    // logs would let a push write into any file of yours. Reflogs stay thrown away.
    // Git locks packed-refs on every deletion, as a rebase makes. The lock lands in the
    // thrown-away top level, so only deleting a packed branch fails.
    else if (!["logs", "worktrees"].includes(entry)) mounts.push(...ro(p));
  }
  // Alternates send git to other object stores, and a push or repack outside would trust
  // them. The whole folder is read-only, since a file in it could be renamed away.
  mkdirSync(join(git, "objects", "info"), { recursive: true });
  mounts.push(...ro(join(git, "objects", "info")));
  // Only this worktree's folder comes back, which holds its HEAD, index and a rebase's state.
  mounts.push(...rw(own), ...hide(join(own, "logs")));
  for (const p of ["commondir", "gitdir", "config.worktree"])
    mounts.push(...fixed(join(own, p), empty));
  return { mounts, env: identity(repository, home), cwd: worktree };
}

// Every agent reads the repository's .git/config, so a credential in it would be theirs.
function refuseCredentials(repository: string): void {
  const config = Bun.spawnSync(
    ["git", "-C", repository, "config", "--local", "--get-regexp", "."],
    {
      stdout: "pipe",
    },
  ).stdout.toString();
  for (const line of config.split("\n")) {
    const key = line.split(" ")[0] ?? "";
    if (/^http\..*extraheader$/i.test(key) || /https?:\/\/[^/\s]*@/i.test(line))
      throw new Error(
        `${repository}/.git/config holds a credential (${key}), which agents could read. Remove it from the remote URL and leave GitHub to gh`,
      );
  }
}

// What the daemon checks before it runs git in a repository. A builder can leave links in
// refs and objects, which git outside would follow to write into any folder of yours, and
// stray locks that stop it. Alternates would make it trust other object stores.
export function checkGitDir(repository: string): void {
  const git = join(repository, ".git");
  const refuse = (p: string, why: string) => {
    throw new Error(`${p} ${why}, so skel won't run git in ${repository}`);
  };
  const walk = (folder: string) => {
    for (const entry of readdirSync(folder, { withFileTypes: true })) {
      const p = join(folder, entry.name);
      if (entry.isSymbolicLink()) refuse(p, "is a link");
      if (entry.name.endsWith(".lock")) refuse(p, "is a stray lock");
      if (entry.isDirectory()) walk(p);
    }
  };
  for (const folder of ["refs", "objects"])
    if (existsSync(join(git, folder))) walk(join(git, folder));
  for (const name of ["packed-refs", "packed-refs.lock"]) {
    const stat = lstatSync(join(git, name), { throwIfNoEntry: false });
    if (stat?.isSymbolicLink()) refuse(join(git, name), "is a link");
    if (stat && name.endsWith(".lock")) refuse(join(git, name), "is a stray lock");
  }
  for (const name of ["alternates", "http-alternates"]) {
    const p = join(git, "objects", "info", name);
    if (existsSync(p) && readFileSync(p, "utf8").trim() !== "")
      refuse(p, "names other object stores");
  }
}

// Commits are authored by you, but your ~/.gitconfig is hidden with the rest of your home.
// Only your name and email go in, read as git outside would read them.
function identity(repository: string, home: string): Record<string, string> {
  const read = (key: string) =>
    Bun.spawnSync(["git", "-C", repository, "config", key], {
      env: { ...process.env, HOME: home },
      stdout: "pipe",
    })
      .stdout.toString()
      .trim();
  const env: Record<string, string> = {};
  const name = read("user.name");
  const email = read("user.email");
  if (name) Object.assign(env, { GIT_AUTHOR_NAME: name, GIT_COMMITTER_NAME: name });
  if (email) Object.assign(env, { GIT_AUTHOR_EMAIL: email, GIT_COMMITTER_EMAIL: email });
  return env;
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
  agent: Agent;
  name: string;
  socket: string;
  model: string;
  prompt?: string;
  resume?: string;
  env?: Record<string, string | undefined>;
}): { argv: string[]; env: Record<string, string> } {
  const { agent, name, socket, model, prompt, resume, env = process.env } = given;
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
  const { mounts, env: seenEnv, cwd } = agentMounts(agent, home);
  mounts.push(...rw(config));

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
    env: seenEnv,
    socket,
    cwd,
    command,
  });
  return { argv, env: kept };
}
