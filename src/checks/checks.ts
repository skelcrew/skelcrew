// The local checks: the commands in workflow.yml's `checks`, such as
// `bun test`. They are the `local` gate, and the merge runs them again on
// the merged result. Running them is enforcing a gate, so they live in the
// daemon, not in a plugin.

import { spawn } from "node:child_process";
import { existsSync } from "node:fs";
import type { Done } from "../plugins/version-control";

// Runs the checks in a folder: passes, or fails with what broke.
export type RunChecks = (dir: string) => Promise<Done<null>>;

export type ChecksOptions = {
  // A command running longer than this is stopped and counts as failed.
  timeoutMs?: number;
  // How many lines of a failing command's output its failure keeps.
  outputLines?: number;
};

// Runs the commands one after another, in the folder it is given, and stops
// at the first failure. The failure names the command and its exit code,
// then the end of its output, where test runners say what broke. That is
// what the agent sees.
export function localChecks(commands: string[], options: ChecksOptions = {}): RunChecks {
  const timeoutMs = options.timeoutMs ?? 30 * 60_000;
  const outputLines = options.outputLines ?? 40;

  return async (dir) => {
    if (!existsSync(dir)) return { ok: false, message: `There is no folder at ${dir} to check.` };
    for (const command of commands) {
      const result = await runOne(command, dir, timeoutMs);
      if (result.kind === "timed_out") {
        return {
          ok: false,
          message: `\`${command}\` took longer than ${timeoutMs / 1000} seconds, so it was stopped.`,
        };
      }
      if (result.kind === "not_started") {
        return { ok: false, message: `\`${command}\` couldn't start: ${result.reason}` };
      }
      if (result.code !== 0) {
        const tail = result.output.trimEnd().split("\n").slice(-outputLines).join("\n");
        return {
          ok: false,
          message: `\`${command}\` failed with exit code ${result.code}.\n${tail}`,
        };
      }
    }
    return { ok: true, value: null };
  };
}

type Ran =
  | { kind: "finished"; code: number; output: string }
  | { kind: "timed_out" }
  | { kind: "not_started"; reason: string };

// One command, through the shell, since a check is a line of shell such as
// `bun run lint && bun test`. Its input is closed, so a command waiting for
// input gets nothing instead of hanging. CI=true tells test runners and
// the like not to wait for a person. Output and errors are read together,
// in the order they came.
//
// The command runs in a process group of its own. A check often starts
// processes of its own, such as test workers, so on a timeout the whole
// group is stopped, not just the shell.
function runOne(command: string, dir: string, timeoutMs: number): Promise<Ran> {
  return new Promise((resolve) => {
    const child = spawn("sh", ["-c", `exec 2>&1; ${command}`], {
      cwd: dir,
      stdio: ["ignore", "pipe", "ignore"],
      env: { ...process.env, CI: "true" },
      detached: true,
    });
    const chunks: Buffer[] = [];
    child.stdout.on("data", (chunk: Buffer) => chunks.push(chunk));

    let timedOut = false;
    const timer = setTimeout(() => {
      timedOut = true;
      stopGroup(child.pid);
    }, timeoutMs);

    child.on("error", (error) => {
      clearTimeout(timer);
      resolve({ kind: "not_started", reason: error.message });
    });
    child.on("close", (code) => {
      clearTimeout(timer);
      if (timedOut) return resolve({ kind: "timed_out" });
      resolve({ kind: "finished", code: code ?? 1, output: Buffer.concat(chunks).toString() });
    });
  });
}

// Stops every process in the group. A negative id means the group.
function stopGroup(pid: number | undefined): void {
  if (pid === undefined) return;
  try {
    process.kill(-pid, "SIGKILL");
  } catch {
    // The group has already gone.
  }
}
