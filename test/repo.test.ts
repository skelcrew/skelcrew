// skel repo ls and repo rm, run as you would run them.

import { Database } from "bun:sqlite";
import { afterEach, beforeEach, expect, test } from "bun:test";
import { mkdirSync, mkdtempSync, realpathSync, rmSync } from "node:fs";
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

// skel init kept a path to your checkout for each repository, under a short name of your
// choosing.
test("keeps the repositories of a database from before skel had clones of its own", async () => {
  const data = join(home, ".local", "share", "skel");
  mkdirSync(data, { recursive: true });
  const old = new Database(join(data, "skel.db"));
  old.run(`CREATE TABLE repositories (
    name TEXT PRIMARY KEY, path TEXT NOT NULL UNIQUE, owner TEXT NOT NULL, repo TEXT NOT NULL)`);
  old.run(`INSERT INTO repositories VALUES ('app', '/code/app', 'simon', 'app'),
    ('web', '/code/app2', 'simon', 'app'), ('tools', '/code/t', 'simon', 'skel-tools')`);
  old.close();
  const listed = await skel(["repo", "ls"]);
  expect(listed.err).toBe("");
  expect(listed.out).toBe(
    `app         simon/app         ${data}/repos/simon/app\n` +
      `skel-tools  simon/skel-tools  ${data}/repos/simon/skel-tools\n`,
  );
  const db = new Database(join(data, "skel.db"));
  const columns = db.query("SELECT name FROM pragma_table_info('repositories')").all();
  db.close();
  expect(columns).not.toContainEqual({ name: "path" });
});
