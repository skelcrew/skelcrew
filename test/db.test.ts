// skel's database, opened over one an older skel left behind.
import { Database } from "bun:sqlite";
import { afterEach, beforeEach, expect, test } from "bun:test";
import { mkdirSync, mkdtempSync, realpathSync, rmSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";

let home = "";
beforeEach(() => {
  home = realpathSync(mkdtempSync(join(tmpdir(), "skel-db-test-")));
});
afterEach(() => {
  rmSync(home, { recursive: true, force: true });
});

test("a thread an older skel recorded keeps working, with no rounds and no pull request yet", () => {
  const data = join(home, ".local", "share", "skel");
  mkdirSync(data, { recursive: true });
  const old = new Database(join(data, "skel.db"));
  old.run(`CREATE TABLE threads (owner TEXT NOT NULL, repo TEXT NOT NULL, task INTEGER NOT NULL,
    folder TEXT NOT NULL UNIQUE, branch TEXT NOT NULL, base TEXT, status TEXT NOT NULL,
    session TEXT, PRIMARY KEY (owner, repo, task))`);
  old.run(
    `INSERT INTO threads VALUES ('simon', 'app', 12, 'app-12', 'skel/12', NULL, 'working', NULL)`,
  );
  old.close();
  const code = `import { openDb } from ${JSON.stringify(join(import.meta.dir, "..", "src", "db.ts"))};
import { liveThreads } from ${JSON.stringify(join(import.meta.dir, "..", "src", "thread.ts"))};
console.log(JSON.stringify(liveThreads(openDb())));`;
  const run = Bun.spawnSync([process.execPath, "-e", code], {
    env: { ...process.env, HOME: home },
    stdout: "pipe",
    stderr: "pipe",
  });
  expect(run.stderr.toString()).toBe("");
  expect(JSON.parse(run.stdout.toString())).toEqual([
    expect.objectContaining({
      folder: "app-12",
      rounds: 0,
      pr: null,
      needs_you: false,
      reviewing: null,
      submitting: null,
      telling: null,
    }),
  ]);
});
