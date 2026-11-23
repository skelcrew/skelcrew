// Missing agent logins become an item that sends the human to sc, without a daemon prompt.
import { afterEach, beforeEach, expect, test } from "bun:test";
import { mkdirSync, mkdtempSync, rmSync, writeFileSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { source, threadSql } from "./harness.ts";

let home = "";
beforeEach(() => {
  home = mkdtempSync(join(tmpdir(), "skelcrew-login-needed-"));
  const clone = join(home, ".local", "share", "skelcrew", "repos", "simon", "app");
  mkdirSync(clone, { recursive: true });
  writeFileSync(
    join(clone, "skelcrew.yaml"),
    "setup: []\ntest: []\nlimits: { threads: 9 }\nroles: { builder: { harness: claude } }\n",
  );
});
afterEach(() => {
  rmSync(home, { recursive: true, force: true });
});

test("a builder missing its login gets an item telling the human to run sc", () => {
  const script = `
import { openDb } from ${JSON.stringify(source("db.ts"))};
import { startBuilder, failThread, bringBack } from ${JSON.stringify(source("flow/builder.ts"))};
import { readThread } from ${JSON.stringify(source("flow/thread.ts"))};
import { ownItem } from ${JSON.stringify(source("flow/own-items.ts"))};
const db = openDb();
db.run("INSERT INTO repositories (owner, repo, name) VALUES ('simon', 'app', 'app')");
db.run(${JSON.stringify(threadSql({ repo: "app", task: "12", branch: "work", status: "working" }))});
const thread = readThread(db, "app-12");
try { await startBuilder(db, "unused-test-host", thread); } catch (error) { failThread(db, "unused-test-host", thread, error); }
try { await bringBack(db, "unused-test-host", readThread(db, "app-12")); } catch (error) { failThread(db, "unused-test-host", readThread(db, "app-12"), error); }
console.log(JSON.stringify({ ...ownItem(readThread(db, "app-12"), false), status: readThread(db, "app-12").status }));
`;
  const run = Bun.spawnSync([process.execPath, "-e", script], {
    env: { HOME: home, PATH: "/usr/bin:/bin", XDG_RUNTIME_DIR: join(home, "run") },
    stdout: "pipe",
    stderr: "pipe",
  });
  expect(run.success).toBe(true);
  const last = run.stdout.toString().trim().split("\n").at(-1) ?? "null";
  const item = JSON.parse(last);
  expect(item?.status).toBe("working");
  expect(item?.title).toBe("An agent needs a login");
  expect(item?.text).toContain("run sc");
  expect(item?.text).not.toContain("run sc install");
});
