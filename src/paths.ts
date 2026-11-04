// Where skel keeps your settings and its state on this machine.
import { homedir, userInfo } from "node:os";
import { join } from "node:path";

export const configDir = () => join(homedir(), ".config", "skel");
export const dataDir = () => join(homedir(), ".local", "share", "skel");

// Some terminals and multiplexers start shells without XDG_RUNTIME_DIR, while the daemon,
// started by systemd, always has it as /run/user/<uid>.
const runtimeDir = () => process.env.XDG_RUNTIME_DIR || join("/run/user", String(userInfo().uid));

export const daemonSocket = () => join(runtimeDir(), "skel.sock");
// Inside an agent's sandbox, the daemon's socket is the agent's own, mounted there.
export const cliSocket = () => process.env.SKEL_SOCKET || daemonSocket();
// Each alone in its folder, since the sandbox mounts the whole folder.
export const leadSocket = () => join(runtimeDir(), "skel", "lead", "skel.sock");
// Linux refuses a socket path over 108 bytes, which a long repository name would make, so
// a thread's socket folder is named by a short hash of the thread's folder.
export const threadSocket = (folder: string) => {
  const short = new Bun.CryptoHasher("sha256").update(folder).digest("hex").slice(0, 16);
  return join(runtimeDir(), "skel", "threads", short, "skel.sock");
};
// skel's own clone of each repository, which the lead sees whole.
export const reposDir = () => join(dataDir(), "repos");
export const cloneDir = (owner: string, repo: string) => join(reposDir(), owner, repo);
// Each thread's clone, and the log of its changes beside it.
export const threadsDir = () => join(dataDir(), "threads");
