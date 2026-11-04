// Where skel keeps your settings and its state on this machine.
import { homedir, userInfo } from "node:os";
import { join } from "node:path";

// Returns the folder for your settings and saved logins, separate from repository files.
export const configDir = () => join(homedir(), ".config", "skel");
// Returns the folder for skel's clones, sessions and database on this machine.
export const dataDir = () => join(homedir(), ".local", "share", "skel");

// Returns the socket folder shared by the CLI and daemon. Some terminals and multiplexers
// start shells without XDG_RUNTIME_DIR, while the daemon, started by systemd, always has it
// as /run/user/<uid>.
const runtimeDir = () => process.env.XDG_RUNTIME_DIR || join("/run/user", String(userInfo().uid));

// Returns the socket path where your commands reach the daemon.
export const cliSocket = () => join(runtimeDir(), "skel.sock");
// Returns the lead's daemon socket path, alone in its folder since the sandbox mounts it
// whole.
export const leadSocket = () => join(runtimeDir(), "skel", "lead", "skel.sock");
// Returns the parent folder of skel's repository clones, which the lead sees whole.
export const reposDir = () => join(dataDir(), "repos");
// Returns the folder for skel's own Codex login and sessions, shared by reviews.
export const codexHome = () => join(dataDir(), "codex");
// Returns a repository's clone folder so skel works away from your checkout.
export const cloneDir = (owner: string, repo: string) => join(reposDir(), owner, repo);
