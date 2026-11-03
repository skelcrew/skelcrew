// The sandbox every agent runs in. bubblewrap draws the boundary: the agent's folder is
// writable, the rest of the system read-only, and your home folder and credentials hidden.
import { existsSync, mkdirSync, readFileSync, realpathSync } from "node:fs";
import { dirname, join, resolve } from "node:path";

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
  // other threads' work and sockets.
  const skel = resolve(import.meta.dir, "..");
  for (const part of ["bin", "src", "node_modules", "package.json"])
    args.push(...ro(join(skel, part)));
  args.push(...mounts);
  args.push("--bind", socket, socketInside);
  args.push("--setenv", "SKEL_SANDBOX", "1", "--setenv", "SKEL_SOCKET", socketInside);
  args.push("--chdir", cwd, "--", ...command);
  return args;
}

// What each kind of agent sees beyond the read-only system, and the folder it starts in.
export function agentMounts(agent: Agent, home: string): { mounts: string[]; cwd: string } {
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
    return { mounts, cwd: lead };
  }
  const { repository, worktree } = agent;
  const mounts = [...ro(repository), ...hide(join(repository, ".skel"))];
  if (agent.kind === "reviewer") return { mounts: [...mounts, ...ro(worktree)], cwd: worktree };
  // A worktree commits into the repository's .git: objects, refs and a rebase's locks live
  // there. But the daemon's push runs git outside the sandbox with your rights, so whatever
  // changes what git does stays read-only.
  const git = join(repository, ".git");
  const own = readFileSync(join(worktree, ".git"), "utf8")
    .replace(/^gitdir: /, "")
    .trim();
  mounts.push(...rw(worktree), ...ro(join(worktree, ".git")), ...rw(git));
  for (const p of ["config", "hooks", "info"]) mounts.push(...fixed(join(git, p)));
  for (const p of ["commondir", "gitdir", "config.worktree"]) mounts.push(...fixed(join(own, p)));
  return { mounts, cwd: worktree };
}
