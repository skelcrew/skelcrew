// The local checks: the commands in workflow.yml's `checks`, such as
// `bun test`. They are the `local` gate, and the merge runs them again on
// the merged result. Running them is enforcing a gate, so they live in the
// daemon, not in a plugin.

import { spawn } from "node:child_process";
import { statSync } from "node:fs";
import { StringDecoder } from "node:string_decoder";
import type { Done } from "../plugins/version-control";

// Runs the checks in a folder: passes, or fails with what broke.
export type RunChecks = (dir: string) => Promise<Done<null>>;

export type ChecksOptions = {
  // A command running longer than this is stopped and counts as failed.
  timeoutMs?: number;
  // How many lines of a failing command's output its failure keeps.
  outputLines?: number;
  // And how many characters at most, for output with very long lines.
  outputChars?: number;
};

// Once a command has exited, its output gets this long to finish arriving.
// Something that escaped its process group can hold the output open for
// ever, so the run doesn't wait for that.
const lastOutputMs = 300;

// Runs the commands one after another, in the folder it is given, and stops
// at the first failure. The failure names the command and how it ended,
// then the end of its output, where test runners say what broke. That is
// what the agent sees.
export function localChecks(commands: string[], options: ChecksOptions = {}): RunChecks {
  const timeoutMs = options.timeoutMs ?? 30 * 60_000;
  const tail = { lines: options.outputLines ?? 40, chars: options.outputChars ?? 4_000 };

  return async (dir) => {
    for (const [i, command] of commands.entries()) {
      if (!isFolder(dir)) {
        const message =
          i === 0
            ? `There is no folder at ${dir} to check.`
            : `The folder ${dir} disappeared while the checks ran, before \`${command}\`.`;
        return { ok: false, message };
      }
      const result = await runOne(command, dir, timeoutMs, tail);
      switch (result.kind) {
        case "timed_out":
          return {
            ok: false,
            message: joined(
              `\`${command}\` took longer than ${timeoutMs / 1000} seconds, so it was stopped.`,
              result.output,
            ),
          };
        case "not_started":
          return { ok: false, message: `\`${command}\` couldn't start: ${result.reason}` };
        case "signalled":
          return {
            ok: false,
            message: joined(`\`${command}\` was stopped by ${result.signal}.`, result.output),
          };
        case "exited":
          if (result.code !== 0) {
            return {
              ok: false,
              message: joined(
                `\`${command}\` failed with exit code ${result.code}.`,
                result.output,
              ),
            };
          }
      }
    }
    return { ok: true, value: null };
  };
}

function joined(first: string, output: string): string {
  return output === "" ? first : `${first}\n${output}`;
}

function isFolder(path: string): boolean {
  try {
    return statSync(path).isDirectory();
  } catch {
    return false;
  }
}

type Ran =
  | { kind: "exited"; code: number; output: string }
  | { kind: "signalled"; signal: string; output: string }
  | { kind: "timed_out"; output: string }
  | { kind: "not_started"; reason: string };

// One command, through the shell, since a check is a line of shell such as
// `bun run lint && bun test`. Its input is closed, so a command waiting for
// input gets nothing instead of hanging. CI=true tells test runners and
// the like not to wait for a person. Output and errors are read together,
// in the order they came.
//
// The command runs in a process group of its own, and the result is
// decided when the shell exits, not when its output closes. From then on
// the time limit no longer counts. Then the whole group is stopped, so
// nothing it started in the background keeps running, and the run moves on
// once the output has closed, or shortly after if something that left the
// group still holds it open.
//
// Stopping by group has one limit: a command that turns on job control
// (`set -m`) gives each background job a group of its own, and those are
// left running. Finding every process a command hid from its group isn't
// possible in general.
function runOne(
  command: string,
  dir: string,
  timeoutMs: number,
  tail: { lines: number; chars: number },
): Promise<Ran> {
  return new Promise((resolve) => {
    let child: ReturnType<typeof spawn>;
    try {
      child = spawn("sh", ["-c", `exec 2>&1; ${command}`], {
        cwd: dir,
        stdio: ["ignore", "pipe", "ignore"],
        env: { ...process.env, CI: "true" },
        detached: true,
      });
    } catch (error) {
      resolve({
        kind: "not_started",
        reason: error instanceof Error ? error.message : String(error),
      });
      return;
    }

    const output = new Tail(tail.lines, tail.chars);
    child.stdout?.on("data", (chunk: Buffer) => output.push(chunk));

    // The output can close before or after the exit, so both are watched
    // from the start.
    let outputClosed = false;
    let ended: (() => Ran) | null = null;
    let settled = false;
    const finish = (ran: Ran) => {
      if (settled) return;
      settled = true;
      clearTimeout(limit);
      clearTimeout(grace);
      child.stdout?.destroy();
      resolve(ran);
    };
    const limit = setTimeout(() => {
      stopGroup(child.pid);
      finish({ kind: "timed_out", output: output.text() });
    }, timeoutMs);
    let grace: ReturnType<typeof setTimeout> | undefined;

    child.stdout?.on("close", () => {
      outputClosed = true;
      if (ended !== null) finish(ended());
    });
    child.on("error", (error) => finish({ kind: "not_started", reason: error.message }));
    child.on("exit", (code, signal) => {
      clearTimeout(limit);
      ended = () =>
        signal !== null
          ? { kind: "signalled", signal, output: output.text() }
          : { kind: "exited", code: code ?? 1, output: output.text() };
      // Stopping the group closes the output held by anything it started.
      stopGroup(child.pid);
      const result = ended;
      if (outputClosed) finish(result());
      else grace = setTimeout(() => finish(result()), lastOutputMs);
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

// Keeps only the end of a command's output, so a command that prints a
// great deal can't fill the daemon's memory. Bytes are decoded as they
// arrive, so a character split across two chunks stays whole.
class Tail {
  private decoder = new StringDecoder("utf8");
  private kept = "";

  constructor(
    private readonly lines: number,
    private readonly chars: number,
  ) {}

  push(chunk: Buffer): void {
    this.kept += this.decoder.write(chunk);
    if (this.kept.length > this.chars * 4) this.kept = wholeEnd(this.kept, this.chars * 2);
  }

  text(): string {
    const all = (this.kept + this.decoder.end()).trimEnd();
    const last = all.split("\n").slice(-this.lines).join("\n");
    return [...last].length > this.chars ? `…${wholeEnd(last, this.chars)}` : last;
  }
}

// The last `count` characters of the text, counted as whole characters, so
// an emoji is never cut in half.
function wholeEnd(text: string, count: number): string {
  return [...text].slice(-count).join("");
}
