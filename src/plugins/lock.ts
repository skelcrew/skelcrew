// Your own lock: the exact version and commit of each personal plugin.
import { existsSync, mkdirSync, readFileSync, rmSync, writeFileSync } from "node:fs";
import { join } from "node:path";
import { isMap, parse, parseDocument, stringify } from "yaml";
import { z } from "zod";
import { configFile } from "../config.ts";
import { configDir } from "../paths.ts";
import { Version } from "./plugin.ts";

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
export type Lock = z.infer<typeof Lock>;

// Returns the text of a lock file, sorted, with a line on top saying who writes it.
export function lockText(lock: Lock): string {
  const sorted = Object.fromEntries(Object.entries(lock).sort(([a], [b]) => a.localeCompare(b)));
  const body = Object.keys(sorted).length > 0 ? stringify(sorted) : "";
  return `# Your personal plugins at their exact versions, written by Skelcrew. sc install installs them.\n${body}`;
}

// Writes the lock.
function writeLock(lock: Lock): void {
  mkdirSync(configDir(), { recursive: true });
  writeFileSync(lockFile(), lockText(lock));
}

// Returns your lock file, checked, or null when this machine has none yet.
export const readLock = (): Lock | null => readLockAt(lockFile());

// Returns the lock in `file`, checked: yours, or a repository's skelcrew.lock. Returns null when
// the file isn't there.
export function readLockAt(file: string): Lock | null {
  if (!existsSync(file)) return null;
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

// Returns your lock, checked. A machine with no lock yet pins nothing: only a lock makes a plugin
// yours, so the plugins installed here before it are never written into one.
export const yourLock = (): Lock => readLock() ?? {};

// Pins one plugin in your lock at what is installed now, or with null takes it out. Every
// install, update and removal of a plugin from GitHub calls it, so the lock always says what
// this machine runs. The file is changed in place, so every other pin, and any comment, stays
// as it was.
export function setLocked(source: string, locked: Locked | null): void {
  // Checked first, so a lock that isn't valid is never written into. A machine with no lock yet
  // gets one with its line on top.
  readLock();
  const file = lockFile();
  if (!existsSync(file)) writeLock({});
  const document = parseDocument(readFileSync(file, "utf8"));
  // A lock that pins nothing, such as one with only its first line, has no map to change, so it
  // is written afresh.
  if (!isMap(document.contents)) {
    writeLock(locked === null ? {} : { [source]: locked });
    return;
  }
  if (locked === null) document.delete(source);
  else document.set(source, locked);
  // With no line width, a long line you wrote, such as a pin on one line, isn't folded.
  writeFileSync(file, document.toString({ lineWidth: 0 }));
}

// Runs `write`, which changes `files`: by default your config.yaml and your lock, or a
// repository's skelcrew.yaml and skelcrew.lock. When it fails, each file is put back as it was,
// so a plugin is never left named in one and missing from the other.
export function writeBoth(write: () => void, files = [configFile(), lockFile()]): void {
  const before = files.map((file) => (existsSync(file) ? readFileSync(file, "utf8") : null));
  try {
    write();
  } catch (error) {
    // A file that can't be put back was most likely the one that couldn't be written, so it
    // is as it was already.
    for (const [at, file] of files.entries()) {
      const text = before[at];
      try {
        if (text === null || text === undefined) rmSync(file, { force: true });
        else writeFileSync(file, text);
      } catch {}
    }
    throw error;
  }
}

// Returns the personal plugins pinned in your lock.
export const yourPlugins = (): string[] => Object.keys(yourLock());
