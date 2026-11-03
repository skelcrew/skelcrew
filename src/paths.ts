// Where skel keeps your settings and its state on this machine.
import { homedir } from "node:os";
import { join } from "node:path";

export const configDir = () => join(homedir(), ".config", "skel");
export const dataDir = () => join(homedir(), ".local", "share", "skel");

function runtimeDir(): string {
  const run = process.env.XDG_RUNTIME_DIR;
  if (!run) throw new Error("XDG_RUNTIME_DIR isn't set, so skel can't find its daemon's socket");
  return run;
}

export const cliSocket = () => join(runtimeDir(), "skel.sock");
// Alone in its folder, since the sandbox mounts the whole folder.
export const leadSocket = () => join(runtimeDir(), "skel", "lead", "skel.sock");
