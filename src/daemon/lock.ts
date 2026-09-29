// One daemon per repository. The lock is a small SQLite file,
// .skelcrew/daemon.lock, that the daemon opens and holds in an exclusive
// transaction for as long as it runs. The operating system keeps that
// hold for the daemon's process and lets go of it the moment the process
// ends, however it ends. So:
//
// - a second daemon is refused at once, even if several start together;
// - a daemon that crashed never keeps the next one out;
// - no process id is ever trusted, so a reused one can't block a start.
//
// The lock file is never deleted. Deleting a lock file that another
// process may be opening is a race of its own. The daemon's process id is
// written to .skelcrew/daemon.pid only to say who runs it.

import { Database } from "bun:sqlite";
import { readFileSync, rmSync, truncateSync, writeFileSync } from "node:fs";
import { dirname, join } from "node:path";

export type Lock = { release(): void };

export type Locked = { ok: true; lock: Lock } | { ok: false; message: string };

export function takeLock(path: string, pid = process.pid): Locked {
  const pidFile = join(dirname(path), "daemon.pid");
  let held = hold(path);
  // A lock file that isn't a database was left by an older Skelcrew, or is
  // damaged. It is emptied in place, never deleted, and tried once more.
  // Emptying it can't free a hold another daemon has: that is kept by the
  // operating system, not by what the file says.
  if (held.kind === "not_a_lock") {
    try {
      truncateSync(path, 0);
    } catch (error) {
      return { ok: false, message: couldNot(describe(error)) };
    }
    held = hold(path);
  }
  switch (held.kind) {
    case "held":
      try {
        writeFileSync(pidFile, `${pid}\n`);
      } catch {
        // Only used to say who runs the daemon.
      }
      return {
        ok: true,
        lock: {
          release: () => {
            if (readPid(pidFile) === pid) rmSync(pidFile, { force: true });
            held.db.close();
          },
        },
      };
    case "busy": {
      const holder = readPid(pidFile);
      const who = holder === null ? "" : `, as process ${holder}`;
      return { ok: false, message: `The daemon is already running for this repository${who}.` };
    }
    case "not_a_lock":
      return { ok: false, message: couldNot("it isn't a lock Skelcrew made. Remove it by hand.") };
    case "failed":
      return { ok: false, message: couldNot(held.reason) };
  }
}

type Held =
  | { kind: "held"; db: Database }
  | { kind: "busy" }
  | { kind: "not_a_lock" }
  | { kind: "failed"; reason: string };

// Opens the lock file and takes an exclusive hold at once, without waiting.
function hold(path: string): Held {
  let db: Database;
  try {
    db = new Database(path, { create: true });
  } catch (error) {
    return { kind: "failed", reason: describe(error) };
  }
  try {
    db.run("PRAGMA busy_timeout = 0");
    db.run("PRAGMA locking_mode = EXCLUSIVE");
    db.run("BEGIN EXCLUSIVE");
    return { kind: "held", db };
  } catch (error) {
    db.close();
    const reason = describe(error);
    if (/not a database|malformed/i.test(reason)) return { kind: "not_a_lock" };
    if (/locked|busy/i.test(reason)) return { kind: "busy" };
    return { kind: "failed", reason };
  }
}

function couldNot(reason: string): string {
  return `The lock .skelcrew/daemon.lock couldn't be taken: ${reason}`;
}

function readPid(path: string): number | null {
  try {
    const text = readFileSync(path, "utf8").trim();
    return /^[1-9]\d*$/.test(text) ? Number(text) : null;
  } catch {
    return null;
  }
}

function describe(error: unknown): string {
  return error instanceof Error ? error.message : String(error);
}
