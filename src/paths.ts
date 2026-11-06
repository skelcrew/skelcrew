// Where skel keeps your settings and its state on this machine.
import { existsSync } from "node:fs";
import { homedir, userInfo } from "node:os";
import { join } from "node:path";

// Returns the folder for your settings and saved logins, separate from repository files.
export const configDir = () => join(homedir(), ".config", "skel");
// Returns the folder for skel's clones, sessions and database on this machine.
export const dataDir = () => join(homedir(), ".local", "share", "skel");

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
export const cliSocket = () => process.env.SKEL_SOCKET || daemonSocket();
// Returns the lead's daemon socket path, alone in its folder since the sandbox mounts it
// whole.
export const leadSocket = () => join(runtimeDir(), "skel", "lead", "skel.sock");
// Returns a thread's daemon socket path, alone in its folder like the lead's. Linux refuses
// a socket path over 108 bytes, and a Mac over 104, which a long repository name would make,
// so the folder is named by a short hash of the thread's folder.
export const threadSocket = (folder: string) => {
  const short = new Bun.CryptoHasher("sha256").update(folder).digest("hex").slice(0, 16);
  return join(runtimeDir(), "skel", "threads", short, "skel.sock");
};
// Returns the parent folder of skel's repository clones, which the lead sees whole.
export const reposDir = () => join(dataDir(), "repos");
// Returns the folder for skel's own Codex login and sessions, shared by reviews.
export const codexHome = () => join(dataDir(), "codex");
// Returns a repository's clone folder so skel works away from your checkout.
export const cloneDir = (owner: string, repo: string) => join(reposDir(), owner, repo);
// Each thread's clone, and the log of its changes beside it.
export const threadsDir = () => join(dataDir(), "threads");
