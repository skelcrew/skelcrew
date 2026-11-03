// The sandbox every agent runs in, and how Claude Code starts inside it. bubblewrap draws
// the boundary: the agent's folder is writable, the rest of the system read-only, and your
// home folder and credentials hidden.
import {
  chmodSync,
  existsSync,
  mkdirSync,
  readdirSync,
  readFileSync,
  realpathSync,
  writeFileSync,
} from "node:fs";
import { dirname, join, resolve } from "node:path";
import { z } from "zod";

export type Agent =
  | { kind: "lead"; repositories: string[] }
  | { kind: "builder" | "reviewer"; repository: string; worktree: string };

// Where the agent's socket appears inside, whatever its path outside.
const socketInside = "/run/skel.sock";

const ro = (p: string) => ["--ro-bind", p, p];
const rw = (p: string) => ["--bind", p, p];
const hide = (p: string) => ["--tmpfs", p];
// A missing path is covered with an empty read-only file, or the agent could create it.
const fixed = (p: string) => (existsSync(p) ? ro(p) : ["--ro-bind", "/dev/null", p]);

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
  if (agent.kind === "lead") {
    const lead = join(home, ".local", "share", "skel", "lead");
    mkdirSync(lead, { recursive: true });
    const mounts = rw(lead);
    for (const repo of agent.repositories) {
      mounts.push(...ro(repo));
      // .skel holds every thread's worktree and socket, and a socket answers whoever
      // connects, even through a read-only mount.
      if (existsSync(join(repo, ".skel"))) mounts.push(...hide(join(repo, ".skel")));
    }
    return { mounts, env: {}, cwd: lead };
  }
  const { repository, worktree } = agent;
  const mounts = [...ro(repository), ...hide(join(repository, ".skel"))];
  if (agent.kind === "reviewer")
    return { mounts: [...mounts, ...ro(worktree)], env: {}, cwd: worktree };
  // A worktree commits into the repository's .git: objects, refs and logs live there. But
  // the daemon's push runs git outside the sandbox with your rights, and git follows a
  // commondir file in .git, or in any worktree's folder, to a config that runs commands.
  // So the builder gets a .git of its own whose top level is thrown away: what a commit,
  // rebase or merge must keep comes back from the real one, and nothing else does.
  const git = join(repository, ".git");
  const link = readFileSync(join(worktree, ".git"), "utf8")
    .replace(/^gitdir: /, "")
    .trim();
  const own = resolve(worktree, link);
  mounts.push(...rw(worktree), ...ro(join(worktree, ".git")), ...hide(git));
  for (const entry of readdirSync(git)) {
    const p = join(git, entry);
    if (["objects", "refs", "logs"].includes(entry)) mounts.push(...rw(p));
    // Git locks packed-refs on every deletion, as a rebase makes. The lock lands in the
    // thrown-away top level, so only deleting a packed branch fails.
    else if (entry !== "worktrees") mounts.push(...ro(p));
  }
  // Only this worktree's folder comes back, which holds its HEAD, index and a rebase's state.
  mounts.push(...rw(own));
  for (const p of ["commondir", "gitdir", "config.worktree"]) mounts.push(...fixed(join(own, p)));
  return { mounts, env: identity(repository, home), cwd: worktree };
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

// Your own Claude Code runs code from these, so agents only read them.
const yourSetup = ["settings.json", "CLAUDE.md"];
const yourSetupFolders = ["hooks", "plugins", "commands", "agents", "skills"];

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
  if (!home) throw new Error("HOME isn't set, so skel can't find Claude Code's login");
  const { mounts, env: seenEnv, cwd } = agentMounts(agent, home);

  // The login and transcripts are shared, not copied: a copied login goes stale when either
  // side refreshes its token, and --resume looks for transcripts here.
  const claude = join(home, ".claude");
  mkdirSync(claude, { recursive: true });
  mounts.push(...rw(claude));
  for (const file of yourSetup) mounts.push(...fixed(join(claude, file)));
  for (const folder of yourSetupFolders) {
    // Made empty when missing, or the agent could create it and put code in it.
    mkdirSync(join(claude, folder), { recursive: true });
    mounts.push(...ro(join(claude, folder)));
  }

  // Claude Code writes to ~/.claude.json as it runs, and it lists the MCP servers your own
  // runs start, so each session gets a throwaway copy. It asks whether to trust the folder
  // even in bypass mode, and would wait there with nobody to answer.
  const original = join(home, ".claude.json");
  const copy = join(home, ".local", "share", "skel", "sessions", `${name}.claude.json`);
  mkdirSync(dirname(copy), { recursive: true });
  const json = existsSync(original)
    ? ClaudeJson.parse(JSON.parse(readFileSync(original, "utf8")))
    : {};
  // Your MCP servers would start inside with your settings, and an API key is yours.
  const { mcpServers: _servers, primaryApiKey: _key, projects = {}, ...rest } = json;
  const trimmed: Record<string, Record<string, unknown>> = {};
  for (const [folder, project] of Object.entries(projects)) {
    const { mcpServers: _projectServers, ...settings } = project;
    trimmed[folder] = settings;
  }
  trimmed[cwd] = { ...trimmed[cwd], hasTrustDialogAccepted: true };
  writeFileSync(copy, JSON.stringify({ ...rest, projects: trimmed }), { mode: 0o600 });
  chmodSync(copy, 0o600);
  mounts.push("--bind", copy, original);

  const command = ["claude", "--model", model, "--permission-mode", "bypassPermissions"];
  command.push("--settings", settings);
  if (resume) command.push("--resume", resume);
  if (prompt) command.push(prompt);

  const kept: Record<string, string> = {};
  for (const [key, value] of Object.entries(env)) {
    if (value !== undefined && (passed.includes(key) || key.startsWith("LC_"))) kept[key] = value;
  }
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
