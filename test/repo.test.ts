// skel repo ls and repo rm, run as you would run them.
import { afterEach, beforeEach, expect, test } from "bun:test";
import { mkdtempSync, realpathSync, rmSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";

const main = join(import.meta.dir, "..", "src", "main.ts");
let home = "";

beforeEach(() => {
  home = realpathSync(mkdtempSync(join(tmpdir(), "skel-repo-test-")));
});
afterEach(() => rmSync(home, { recursive: true, force: true }));

async function skel(args: string[]) {
  const run = Bun.spawn(["bun", main, ...args], {
    cwd: home,
    env: { PATH: process.env.PATH ?? "", HOME: home },
    stdout: "pipe",
    stderr: "pipe",
  });
  const [out, err, code] = await Promise.all([
    new Response(run.stdout).text(),
    new Response(run.stderr).text(),
    run.exited,
  ]);
  return { out, err, code };
}

test("says so when there are no repositories", async () => {
  expect((await skel(["repo", "ls"])).out).toContain("No repositories");
});

test("says so when there is no repository by the name to remove", async () => {
  const missing = await skel(["repo", "rm", "app"]);
  expect(missing.code).toBe(1);
  expect(missing.err).toContain("app");
});

test("skel init is gone", async () => {
  const run = await skel(["init"]);
  expect(run.code).toBe(1);
  expect(run.err).not.toContain("init");
});
