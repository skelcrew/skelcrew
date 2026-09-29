import { afterEach, describe, expect, test } from "bun:test";
import { existsSync, mkdtempSync, readFileSync, rmSync, writeFileSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { $ } from "bun";
import { localChecks } from "./checks";

let dirs: string[] = [];
function folder(): string {
  const dir = mkdtempSync(join(tmpdir(), "skelcrew-checks-"));
  dirs.push(dir);
  return dir;
}
afterEach(() => {
  for (const dir of dirs) rmSync(dir, { recursive: true, force: true });
  dirs = [];
});

describe("localChecks", () => {
  test("passes when every command passes", async () => {
    expect(await localChecks(["true", "echo fine"])(folder())).toEqual({ ok: true, value: null });
  });

  test("runs the commands in the folder it is given", async () => {
    const dir = folder();
    expect((await localChecks(["touch ran-here"])(dir)).ok).toBe(true);
    expect(existsSync(join(dir, "ran-here"))).toBe(true);
  });

  test("stops at the first failure, and runs nothing after it", async () => {
    const dir = folder();
    const result = await localChecks(["false", "touch after"])(dir);
    expect(result.ok).toBe(false);
    expect(existsSync(join(dir, "after"))).toBe(false);
  });

  test("names the failing command and its exit code, with its output", async () => {
    const result = await localChecks(["true", "echo 'to stdout'; echo 'to stderr' >&2; exit 3"])(
      folder(),
    );
    expect(result.ok).toBe(false);
    const message = !result.ok ? result.message : "";
    expect(message).toStartWith(
      "`echo 'to stdout'; echo 'to stderr' >&2; exit 3` failed with exit code 3.",
    );
    expect(message).toContain("to stdout");
    expect(message).toContain("to stderr");
  });

  // Test runners print what broke at the end, so the end is what's kept.
  test("keeps the end of long output", async () => {
    const result = await localChecks(["seq 1 500; exit 1"], { outputLines: 20 })(folder());
    const message = !result.ok ? result.message : "";
    expect(message).toContain("\n500");
    expect(message).toContain("\n481");
    expect(message).not.toContain("\n480\n");
  });

  test("stops a command that runs too long, and says so", async () => {
    const started = Date.now();
    const result = await localChecks(["sleep 5"], { timeoutMs: 200 })(folder());
    expect(Date.now() - started).toBeLessThan(3_000);
    expect(result).toEqual({
      ok: false,
      message: "`sleep 5` took longer than 0.2 seconds, so it was stopped.",
    });
  });

  test("gives a command waiting for input nothing, so it can't hang", async () => {
    const result = await localChecks(["cat"], { timeoutMs: 2_000 })(folder());
    expect(result).toEqual({ ok: true, value: null });
  });

  test("runs the commands with CI=true, so test watchers don't wait", async () => {
    expect((await localChecks(['test "$CI" = true'])(folder())).ok).toBe(true);
  });

  // Found by review: a helper that leaves the process group, like a test
  // server started in its own session, kept the output open, and the run
  // waited past its limit.
  test("returns in time even when a process escapes and holds the output open", async () => {
    const started = Date.now();
    const escaping = `perl -MPOSIX -e 'POSIX::setsid(); sleep 20' skelcrew-escaped & echo passed`;
    const result = await localChecks([escaping], { timeoutMs: 1_000 })(folder());
    await $`pkill -f skelcrew-escaped`.nothrow().quiet();
    expect(Date.now() - started).toBeLessThan(3_000);
    expect(result).toEqual({ ok: true, value: null });
  });

  // Found by review: a background job kept the output open, so a command
  // that passed at once was reported as a timeout.
  test("decides by the command's own exit, not by when its output closes", async () => {
    const started = Date.now();
    const result = await localChecks(["sleep 3 & echo done"], { timeoutMs: 5_000 })(folder());
    expect(Date.now() - started).toBeLessThan(2_000);
    expect(result).toEqual({ ok: true, value: null });
  });

  // Found by review: after a pass, a background process kept running.
  test("stops everything a command started once it has finished", async () => {
    const dir = folder();
    const result = await localChecks(["sleep 7 >/dev/null 2>&1 & echo $! > pid; echo ok"])(dir);
    expect(result.ok).toBe(true);
    const pid = Number(readFileSync(join(dir, "pid"), "utf8"));
    await Bun.sleep(100);
    expect(() => process.kill(pid, 0)).toThrow();
  });

  // Found by review: all output was kept, and one long line became a
  // message of millions of characters.
  test("keeps the failure message short, however much a command prints", async () => {
    const lines = await localChecks(["seq 1 200000; exit 1"])(folder());
    const oneLine = await localChecks(["head -c 1000000 /dev/zero | tr '\\0' x; exit 1"])(folder());
    for (const result of [lines, oneLine]) {
      expect(result.ok).toBe(false);
      expect(!result.ok && result.message.length).toBeLessThan(5_000);
    }
    expect(!lines.ok && lines.message).toContain("\n200000");
  });

  // Found by review: every command waited the full grace period after it
  // exited, because the output had already closed.
  test("moves on at once when a command's output has closed", async () => {
    const started = Date.now();
    const result = await localChecks(Array(10).fill("true"))(folder());
    expect(result.ok).toBe(true);
    expect(Date.now() - started).toBeLessThan(1_500);
  });

  // Found by review: a command that exited just before the limit lost to
  // it, so a pass became a timeout and a failure lost its output.
  test("keeps the real result of a command that finishes just before the limit", async () => {
    const limit = { timeoutMs: 500 };
    expect(await localChecks(["sleep 0.35; echo passed"], limit)(folder())).toEqual({
      ok: true,
      value: null,
    });
    const failed = await localChecks(
      ["sleep 0.35; echo 'expected 2 got 3'; exit 1"],
      limit,
    )(folder());
    expect(!failed.ok && failed.message).toContain("exit code 1");
    expect(!failed.ok && failed.message).toContain("expected 2 got 3");
  });

  // Found by review: a timeout said nothing about what was running.
  test("shows the end of the output when a command times out", async () => {
    const result = await localChecks(["echo 'running test_hangs_forever'; sleep 5"], {
      timeoutMs: 300,
    })(folder());
    // As a line of its own: the message's first line names the command,
    // which contains the same words.
    const lines = !result.ok ? result.message.split("\n") : [];
    expect(lines.slice(1)).toContain("running test_hangs_forever");
  });

  // Found by review: trimming could cut an emoji in half.
  test("trims the output on whole characters", async () => {
    const result = await localChecks(["printf 'a😀b'; exit 1"], { outputChars: 2 })(folder());
    expect(!result.ok && result.message).toEndWith("…😀b");
  });

  test("names the signal when a command is killed by one", async () => {
    const result = await localChecks(["kill -9 $$"])(folder());
    expect(result).toEqual({ ok: false, message: "`kill -9 $$` was stopped by SIGKILL." });
  });

  // Found by review: a file where the folder should be threw.
  test("fails with a message, not a throw, when the folder is a file", async () => {
    const file = join(folder(), "a-file");
    writeFileSync(file, "");
    expect(await localChecks(["true"])(file)).toEqual({
      ok: false,
      message: `There is no folder at ${file} to check.`,
    });
  });

  test("says so plainly when the folder disappears during the checks", async () => {
    const dir = folder();
    expect(await localChecks(['rm -rf "$PWD"', "true"])(dir)).toEqual({
      ok: false,
      message: `The folder ${dir} disappeared while the checks ran, before \`true\`.`,
    });
  });

  test("fails with a message, not a throw, for a folder that doesn't exist", async () => {
    const result = await localChecks(["true"])(join(folder(), "nowhere"));
    expect(result.ok).toBe(false);
  });
});
