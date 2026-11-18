// Your own lock: the exact version and commit of each of your personal plugins, in
// ~/.config/skelcrew/skelcrew.lock, beside the list of them under plugins: in your config.yaml.
// sc install makes the machine match both.
import type { Database } from "bun:sqlite";
import { existsSync, mkdirSync, readFileSync, writeFileSync } from "node:fs";
import { join } from "node:path";
import { parse, stringify } from "yaml";
import { z } from "zod";
import { configFile, yourConfigDocument } from "../config.ts";
import { configDir } from "../paths.ts";
import { readSettings } from "../settings.ts";
import { installedPlugins, readManifest, Version } from "./plugin.ts";

// Returns the path of your own lock file.
export const lockFile = () => join(configDir(), "skelcrew.lock");

// One plugin as the lock pins it: its name, its version, and the commit its version tag pointed
// at when it was locked. The commit is what makes the lock exact, as a tag can be moved.
const Locked = z.object({
  name: z.string().min(1),
  version: Version,
  commit: z.string().regex(/^[0-9a-f]{40}([0-9a-f]{24})?$/, "must be a full git commit"),
});
export type Locked = z.infer<typeof Locked>;
// The lock: each plugin by the GitHub repository it comes from, such as skelcrew/skelcrew-github.
const Lock = z.record(z.string(), Locked);
type Lock = z.infer<typeof Lock>;

// Returns the commit a plugin's clone is at. A plugin from GitHub is a clone of its version tag,
// so this is the commit you approved when it was installed.
export function commitOf(folder: string): string {
  const run = Bun.spawnSync(["git", "-C", folder, "rev-parse", "HEAD"], {
    stdout: "pipe",
    stderr: "pipe",
  });
  if (!run.success) throw new Error(`${folder} isn't a git clone, so it has no commit to lock`);
  return run.stdout.toString().trim();
}

// Writes the lock, with a line on top saying who writes it.
function writeLock(lock: Lock): void {
  mkdirSync(configDir(), { recursive: true });
  const sorted = Object.fromEntries(Object.entries(lock).sort(([a], [b]) => a.localeCompare(b)));
  const body = Object.keys(sorted).length > 0 ? stringify(sorted) : "";
  writeFileSync(
    lockFile(),
    `# Your personal plugins at their exact versions, written by Skelcrew. sc install installs them.\n${body}`,
  );
}

// Returns your lock, checked. A machine set up before the lock existed has none yet: its plugins
// from GitHub are written into a new lock as they are, and added to plugins: in your config.yaml.
// So the move reinstalls nothing and asks nothing again.
export function yourLock(db: Database): Lock {
  const file = lockFile();
  if (existsSync(file)) {
    let parsed: unknown;
    try {
      parsed = parse(readFileSync(file, "utf8"));
    } catch (error) {
      throw new Error(`${file} isn't valid YAML: ${String(error)}`);
    }
    // A lock with only its first line is empty, which YAML reads as null.
    const lock = Lock.safeParse(parsed ?? {});
    if (!lock.success) throw new Error(`${file} isn't valid: ${z.prettifyError(lock.error)}`);
    return lock.data;
  }
  // A plugin from a folder of yours has no version to pin, so only those from GitHub count. One
  // whose folder can't be read is left out, rather than stop every plugin command.
  const lock: Lock = {};
  for (const { source, folder } of installedPlugins(db)) {
    if (source === null) continue;
    try {
      const { name, version } = readManifest(folder);
      lock[source] = { name, version, commit: commitOf(folder) };
    } catch {}
  }
  if (Object.keys(lock).length === 0) return lock;
  writeLock(lock);
  // Added to the plugins your config names already, such as a new one copied from another
  // machine, so the setup carries all of them.
  const named = yourPlugins();
  const added = Object.keys(lock).filter((source) => !named.includes(source));
  if (added.length > 0) setYourPlugins([...named, ...added]);
  return lock;
}

// Pins one plugin in your lock at what is installed now, or with null takes it out. Every
// install, update and removal of a plugin from GitHub calls it, so the lock always says what
// this machine runs.
export function setLocked(db: Database, source: string, locked: Locked | null): void {
  const lock = yourLock(db);
  if (locked === null) delete lock[source];
  else lock[source] = locked;
  writeLock(lock);
}

// Returns your personal plugins, as plugins: in your config.yaml lists them.
export const yourPlugins = (): string[] => readSettings(["plugins"]).plugins;

// Writes your personal plugins into plugins: in your config.yaml, keeping the rest of it as it
// is.
export function setYourPlugins(sources: string[]): void {
  const config = yourConfigDocument();
  config.set("plugins", sources);
  mkdirSync(configDir(), { recursive: true });
  writeFileSync(configFile(), config.toString());
}
