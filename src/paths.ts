// Where skel keeps your settings and its state on this machine.
import { homedir } from "node:os";
import { join } from "node:path";

export const configDir = () => join(homedir(), ".config", "skel");
export const dataDir = () => join(homedir(), ".local", "share", "skel");
