// Starts a repository's daemon in the background: `skelcrew serve` in a
// process of its own, which carries on after the command that started it.
//
// Its output goes to .skelcrew/daemon.log. If it exits before it answers,
// the client says why, from what it wrote there.

import { spawn } from "node:child_process";
import { closeSync, openSync, readFileSync, statSync } from "node:fs";
import { join } from "node:path";
import type { Started } from "../daemon/client";
import { daemonPaths } from "../daemon/paths";

const main = join(import.meta.dir, "main.ts");

export function startDaemon(repo: string): Started {
  const found = daemonPaths(repo);
  if (!found.ok) return found;
  const log = join(found.paths.folder, "daemon.log");

  let from: number;
  let fd: number;
  try {
    fd = openSync(log, "a");
    from = statSync(log).size;
  } catch (error) {
    return { ok: false, message: `.skelcrew/daemon.log couldn't be opened: ${describe(error)}` };
  }

  let exited: string | null = null;
  try {
    // detached: the daemon gets a process group of its own, so Ctrl-C in
    // this terminal doesn't stop it.
    const child = spawn(process.execPath, [main, "serve"], {
      cwd: repo,
      detached: true,
      stdio: ["ignore", fd, fd],
    });
    child.on("error", (error) => {
      exited = error.message;
    });
    child.on("exit", (code, signal) => {
      exited = written(log, from) || `It exited with ${signal ?? `code ${code}`}.`;
    });
    child.unref();
  } catch (error) {
    return { ok: false, message: `The daemon couldn't be started: ${describe(error)}` };
  } finally {
    closeSync(fd);
  }
  return { ok: true, exited: () => exited };
}

// What the daemon wrote to its log since it was started.
function written(log: string, from: number): string {
  try {
    return readFileSync(log).subarray(from).toString("utf8").trim();
  } catch {
    return "";
  }
}

function describe(error: unknown): string {
  return error instanceof Error ? error.message : String(error);
}
