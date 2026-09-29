// One daemon per repository. The daemon takes an exclusive `flock` on
// .skelcrew/daemon.lock and keeps it for as long as it runs. The operating
// system keeps that lock for the daemon's process and lets go of it the
// moment the process ends, however it ends. So:
//
// - a second daemon is refused at once, even if several start together;
//   `flock` either gets the lock or it doesn't, in one step;
// - a daemon that crashed never keeps the next one out;
// - no process id is ever trusted, so a reused one can't block a start;
// - it works the same on a file the daemon can't write to.
//
// The lock is taken through the system's C library, since Bun has no
// `flock` of its own. It is the same on macOS and Linux. Windows has no
// `flock` (it has LockFileEx), and the rest of the daemon assumes Unix too,
// so there the lock refuses plainly.
//
// The lock file is never deleted. Deleting a lock file that another process
// may be opening is a race of its own. What it holds doesn't matter. The
// daemon's process id is written to .skelcrew/daemon.pid, only to say who
// runs it.

import { dlopen, FFIType, read } from "bun:ffi";
import { closeSync, constants, openSync, readFileSync, rmSync, writeFileSync } from "node:fs";
import { dirname, join } from "node:path";

export type Lock = { release(): void };

export type Locked = { ok: true; lock: Lock } | { ok: false; message: string };

// From <sys/file.h>: an exclusive lock, and don't wait for it.
const LOCK_EX = 2;
const LOCK_NB = 4;

export function takeLock(path: string, pid = process.pid): Locked {
  const system = libc();
  if (!system.ok) return { ok: false, message: couldNot(system.reason) };

  // Opened read-only, so a lock file the daemon can't write to still works.
  // Files opened here aren't passed on to processes the daemon starts, so
  // git or the checks can't keep the lock after the daemon has died.
  let fd: number;
  try {
    fd = openSync(path, constants.O_RDONLY | constants.O_CREAT, 0o644);
  } catch (error) {
    return { ok: false, message: couldNot(describe(error)) };
  }

  if (system.value.flock(fd, LOCK_EX | LOCK_NB) !== 0) {
    const errno = system.value.errno();
    closeSync(fd);
    if (errno === system.value.wouldBlock) {
      const holder = readPid(join(dirname(path), "daemon.pid"));
      const who = holder === null ? "" : `, as process ${holder}`;
      return { ok: false, message: `The daemon is already running for this repository${who}.` };
    }
    return { ok: false, message: couldNot(`the system refused it, with error ${errno}`) };
  }

  const pidFile = join(dirname(path), "daemon.pid");
  try {
    writeFileSync(pidFile, `${pid}\n`);
  } catch {
    // Only used to say who runs the daemon.
  }
  let released = false;
  return {
    ok: true,
    lock: {
      release: () => {
        if (released) return;
        released = true;
        if (readPid(pidFile) === pid) rmSync(pidFile, { force: true });
        // Closing the file lets go of the lock.
        closeSync(fd);
      },
    },
  };
}

type Libc = {
  flock(fd: number, operation: number): number;
  errno(): number;
  // The error `flock` gives when another process holds the lock.
  wouldBlock: number;
};

let loaded: { ok: true; value: Libc } | { ok: false; reason: string } | null = null;

// The C library's `flock`, and a way to read why it failed. Both differ by
// name between macOS and Linux.
function libc(): { ok: true; value: Libc } | { ok: false; reason: string } {
  if (loaded !== null) return loaded;
  const found =
    process.platform === "darwin"
      ? { library: "libSystem.B.dylib", errnoAt: "__error", wouldBlock: 35 }
      : process.platform === "linux"
        ? { library: "libc.so.6", errnoAt: "__errno_location", wouldBlock: 11 }
        : null;
  if (found === null) {
    loaded = { ok: false, reason: `Skelcrew's daemon doesn't run on ${process.platform} yet.` };
    return loaded;
  }
  try {
    const lib = dlopen(found.library, {
      flock: { args: [FFIType.i32, FFIType.i32], returns: FFIType.i32 },
      [found.errnoAt]: { args: [], returns: FFIType.ptr },
    });
    const flock = lib.symbols.flock;
    const errnoAt = lib.symbols[found.errnoAt];
    if (flock === undefined || errnoAt === undefined) {
      loaded = { ok: false, reason: `${found.library} has no flock.` };
      return loaded;
    }
    loaded = {
      ok: true,
      value: {
        flock: (fd, operation) => Number(flock(fd, operation)),
        errno: () => {
          const at = errnoAt();
          return typeof at === "number" && at !== 0 ? read.i32(at) : -1;
        },
        wouldBlock: found.wouldBlock,
      },
    };
  } catch (error) {
    loaded = { ok: false, reason: `the system library couldn't be loaded: ${describe(error)}` };
  }
  return loaded;
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
