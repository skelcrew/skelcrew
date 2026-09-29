import { afterEach, describe, expect, test } from "bun:test";
import { existsSync, mkdtempSync, rmSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";
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

  test("fails with a message, not a throw, for a folder that doesn't exist", async () => {
    const result = await localChecks(["true"])(join(folder(), "nowhere"));
    expect(result.ok).toBe(false);
  });
});
