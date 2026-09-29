// One daemon per repository. The daemon holds a lock file with its process
// id. A second daemon finds it and refuses to start, unless the process in
// it no longer runs: then the daemon that left it died, and the lock is
// taken over.
//
// The lock is written whole to a file of its own first, then linked into
// place. A link fails if the lock already exists, so two daemons starting
// at once can't both get it, and nobody ever reads a half-written lock.

import { linkSync, readFileSync, renameSync, rmSync, writeFileSync } from "node:fs";

export type Lock = { release(): void };

export type Locked = { ok: true; lock: Lock } | { ok: false; message: string };

export function takeLock(path: string, pid = process.pid): Locked {
  const mine = `${path}.${pid}.${Math.random().toString(36).slice(2)}`;
  try {
    writeFileSync(mine, `${pid}\n`);
    // A few tries: each one either takes the lock, finds a live holder, or
    // clears a dead one and tries again.
    for (let attempt = 0; attempt < 5; attempt += 1) {
      const linked = link(mine, path);
      if (linked === "linked") {
        return { ok: true, lock: { release: () => release(path, pid) } };
      }
      if (linked !== "exists") return { ok: false, message: couldNot(linked) };
      const holder = readPid(path);
      if (holder !== null && alive(holder)) return { ok: false, message: running(holder) };
      clearDead(path, holder);
    }
    return { ok: false, message: couldNot("another daemon kept taking it") };
  } catch (error) {
    return { ok: false, message: couldNot(describe(error)) };
  } finally {
    rmSync(mine, { force: true });
  }
}

function running(pid: number): string {
  return `The daemon is already running for this repository, as process ${pid}.`;
}

function couldNot(reason: string): string {
  return `The lock .skelcrew/daemon.lock couldn't be taken: ${reason}`;
}

// Moves the dead lock aside, then checks it is still the one that was read.
// Another daemon may have cleared it and taken a lock of its own in
// between. That lock is put back.
function clearDead(path: string, seen: number | null): void {
  const aside = `${path}.dead.${process.pid}.${Math.random().toString(36).slice(2)}`;
  try {
    renameSync(path, aside);
  } catch {
    return;
  }
  const moved = readPid(aside);
  if (moved !== seen && moved !== null && alive(moved)) link(aside, path);
  rmSync(aside, { force: true });
}

function release(path: string, pid: number): void {
  if (readPid(path) === pid) rmSync(path, { force: true });
}

// "linked", "exists" when the target is already there, or why it failed.
function link(from: string, to: string): string {
  try {
    linkSync(from, to);
    return "linked";
  } catch (error) {
    if (error instanceof Error && "code" in error && error.code === "EEXIST") return "exists";
    return describe(error);
  }
}

// A lock holds a process id and a newline. Anything else was not written
// by a daemon that finished writing it, and counts as no holder.
function readPid(path: string): number | null {
  try {
    const text = readFileSync(path, "utf8").trim();
    return /^[1-9]\d*$/.test(text) ? Number(text) : null;
  } catch {
    return null;
  }
}

// Signal 0 checks a process exists without touching it. EPERM means it
// exists but belongs to someone else.
function alive(pid: number): boolean {
  try {
    process.kill(pid, 0);
    return true;
  } catch (error) {
    return error instanceof Error && "code" in error && error.code === "EPERM";
  }
}

function describe(error: unknown): string {
  return error instanceof Error ? error.message : String(error);
}
