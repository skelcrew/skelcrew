// Where skel keeps your settings and its state on this machine.
import { homedir } from "node:os";
import { join } from "node:path";

export function configDir(): string {
  return join(process.env.XDG_CONFIG_HOME || join(homedir(), ".config"), "skel");
}

export function dataDir(): string {
  return join(process.env.XDG_DATA_HOME || join(homedir(), ".local", "share"), "skel");
}
