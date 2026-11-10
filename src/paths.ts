// Where skel keeps your settings and its state on this machine.
import { existsSync } from "node:fs";
import { homedir, userInfo } from "node:os";
import { join } from "node:path";

// Returns the folder for your settings and saved logins, separate from repository files.
// A caller that was handed an environment passes its HOME: homedir() goes by the HOME this
// process started with, and ignores one set since or given to it.
export const configDir = (home = homedir()) => join(home, ".config", "skel");
// Returns the folder for skel's clones, sessions and database on this machine. Pass a home
// for the same reason as for configDir.
export const dataDir = (home = homedir()) => join(home, ".local", "share", "skel");
// Returns the private agent token file path used by setup and Claude Code sessions.
export const claudeTokenFile = (home = homedir()) => join(configDir(home), "claude-token");

// Returns the socket folder shared by the CLI and daemon. Some terminals and multiplexers
// start shells without XDG_RUNTIME_DIR, while the daemon, started by systemd, always has it
// as /run/user/<uid>. A Sprite or a Mac has no systemd to make that folder, nor a /run you
// can write to, so there the sockets go in a folder of skel's own, which the daemon makes for
// you alone.
function runtimeDir(): string {
  const systemd = join("/run/user", String(userInfo().uid));
  return process.env.XDG_RUNTIME_DIR || (existsSync(systemd) ? systemd : join(dataDir(), "run"));
}

// Returns the socket path where the daemon listens for your commands, and where it takes
// the lock that keeps a second daemon from starting.
export const daemonSocket = () => join(runtimeDir(), "skel.sock");
// Returns the socket path where this skel reaches the daemon. Inside an agent's sandbox
// that is the agent's own socket, mounted there, which tells the daemon who is calling.
export const cliSocket = () => process.env.SKELCREW_SOCKET || daemonSocket();
// Returns a short hash of the text, for a name that must stay short or tell apart names that
// read alike.
const short = (text: string) =>
  new Bun.CryptoHasher("sha256").update(text).digest("hex").slice(0, 16);

// Returns where a repository's lead lives: the name of its tmux session and config folder, its
// folder, and its daemon socket, alone in its folder since the sandbox mounts it whole. The name
// reads as the repository, with a hash in letters, so simon/my.app and simon/my-app never share
// one. It ends in a letter, and a thread's folder ends in its task's number, so a lead and a
// thread never share one either. `kept` marks the lead this machine had before skel gave each
// repository its own: it keeps its name, folder and socket, so it runs on through the upgrade
// with its conversation.
export function leadPlaces(owner: string, repo: string, kept = false) {
  if (kept)
    return {
      name: "lead",
      folder: join(dataDir(), "lead"),
      socket: join(runtimeDir(), "skel", "lead", "skel.sock"),
    };
  const hash = short(`${owner}/${repo}`);
  const letters = hash
    .slice(0, 8)
    .replace(/./g, (c) => "abcdefghijklmnop"[Number.parseInt(c, 16)] ?? "");
  return {
    name: `lead-${repo.replace(/[^\w-]/g, "-").slice(0, 40)}-${letters}`,
    folder: join(dataDir(), "leads", owner, repo),
    socket: join(runtimeDir(), "skel", "leads", hash, "skel.sock"),
  };
}
// Returns a thread's daemon socket path, alone in its folder like a lead's. Linux refuses a
// socket path over 108 bytes, and a Mac over 104, which a long repository name would make,
// so the folder is named by a short hash of the thread's folder.
export const threadSocket = (folder: string) =>
  join(runtimeDir(), "skel", "threads", short(folder), "skel.sock");
// Returns the parent folder of skel's repository clones.
const reposDir = () => join(dataDir(), "repos");
// Returns a repository's clone folder so skel works away from your checkout.
export const cloneDir = (owner: string, repo: string) => join(reposDir(), owner, repo);
// Each thread's clone, and the log of its changes beside it.
export const threadsDir = () => join(dataDir(), "threads");
