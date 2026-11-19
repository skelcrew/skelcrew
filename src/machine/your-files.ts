// Your personal files as sc --remote <host> install sends them to a server: config.yaml, your
// own lock and the agents' Claude Code token. Also the check that tells a server its lock
// differs from the laptop's.
import { existsSync, readFileSync } from "node:fs";
import { join } from "node:path";
import { configFile, yourConfigDocument } from "../config.ts";
import { openDb } from "../db.ts";
import { claudeTokenFile, dataDir } from "../paths.ts";
import { type Lock, lockText, readLock, yourLock, yourPlugins } from "../plugins/lock.ts";
import { installedPlugins, readManifest } from "../plugins/plugin.ts";

// Returns the database when this machine has one. Opening it would make one, and a laptop that
// only runs sc --remote needs none.
const dbHere = () => (existsSync(join(dataDir(), "skelcrew.db")) ? openDb() : null);

// Returns the plugins installed here that only reach machines, by the repository each comes
// from. Such a plugin is used where you run --remote, never on the server, so it isn't sent. One
// whose folder can't be read is sent, as nothing says it is one.
function laptopOnly(): string[] {
  const db = dbHere();
  return (db ? installedPlugins(db) : []).flatMap(({ source, folder }) => {
    if (source === null) return [];
    try {
      const { kind, provides } = readManifest(folder);
      return kind === "runtime" && provides.every((one) => one === "machine") ? [source] : [];
    } catch {
      return [];
    }
  });
}

// Returns your lock as a server gets it, without the plugins only the laptop uses, or null when
// you have no lock yet.
function lockToSend(): Lock | null {
  const lock = readLock();
  if (!lock) return null;
  const skipped = laptopOnly();
  return Object.fromEntries(Object.entries(lock).filter(([source]) => !skipped.includes(source)));
}

// Returns a short fingerprint of a lock, the same for the same pins in any order or layout.
const lockHash = (lock: Lock) =>
  new Bun.CryptoHasher("sha256")
    .update(JSON.stringify(Object.entries(lock).sort(([a], [b]) => a.localeCompare(b))))
    .digest("hex")
    .slice(0, 16);

// Returns the fingerprint of the lock this laptop would send, which sc --remote passes with each
// command so the server can tell its own lock differs. Null with no lock to compare.
export function laptopLockHash(): string | null {
  const lock = lockToSend();
  return lock ? lockHash(lock) : null;
}

// Reports whether this server's lock differs from the one the laptop that runs this command
// with --remote would send. A lock that can't be read differs, as install replaces it.
export function lockDiffers(): boolean {
  const laptop = process.env.SKELCREW_LAPTOP_LOCK;
  if (!laptop) return false;
  try {
    const here = readLock();
    return here === null || lockHash(here) !== laptop;
  } catch {
    return true;
  }
}

// Returns your personal files as a server gets them, each by its name in ~/.config/skelcrew,
// with a file you don't have left out. A plugin only the laptop uses is taken out of plugins:
// and the lock, so sc install there doesn't install it. A laptop set up before the lock gets
// its lock first, written from the plugins it has, so a server set up the same way gets the
// same pins and installs nothing.
export function yourFiles(): { name: string; text: string }[] {
  const db = dbHere();
  if (db) yourLock(db);
  const skipped = laptopOnly();
  const files: { name: string; text: string }[] = [];
  // Your config as it is, or with only plugins: changed, so its comments and layout stay.
  if (existsSync(configFile())) {
    const named = yourPlugins();
    let text = readFileSync(configFile(), "utf8");
    if (named.some((source) => skipped.includes(source))) {
      const config = yourConfigDocument();
      config.set(
        "plugins",
        named.filter((source) => !skipped.includes(source)),
      );
      text = config.toString();
    }
    files.push({ name: "config.yaml", text });
  }
  // The lock is written afresh, which only drops its comments, as Skelcrew writes it.
  const lock = lockToSend();
  if (lock) files.push({ name: "skelcrew.lock", text: lockText(lock) });
  if (existsSync(claudeTokenFile()))
    files.push({ name: "claude-token", text: readFileSync(claudeTokenFile(), "utf8") });
  return files;
}
