// skel repo add, ls and rm, run as you would run them, against a fake gh.
import { afterEach, beforeEach, expect, test } from "bun:test";
import {
  existsSync,
  mkdirSync,
  mkdtempSync,
  readFileSync,
  realpathSync,
  rmSync,
  writeFileSync,
} from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";

const main = join(import.meta.dir, "..", "src", "main.ts");
let home = "";

beforeEach(() => {
  home = realpathSync(mkdtempSync(join(tmpdir(), "skel-repo-test-")));
});
afterEach(() => rmSync(home, { recursive: true, force: true }));

// A git repository whose GitHub name the fake gh reports, or refuses to know.
function repository(folder: string, github: string | null): string {
  const path = join(home, "code", folder);
  mkdirSync(path, { recursive: true });
  Bun.spawnSync(["git", "init", "-q", path]);
  Bun.spawnSync([
    "git",
    "-C",
    path,
    "remote",
    "add",
    "origin",
    `https://github.com/${github ?? "x/y"}`,
  ]);
  const bin = join(home, "bin");
  mkdirSync(bin, { recursive: true });
  const [owner, name] = (github ?? "/").split("/");
  const answer = github
    ? `echo '{"name":"${name}","owner":{"login":"${owner}"}}'`
    : `echo 'none of the git remotes point to a known GitHub host' >&2; exit 1`;
  // The fake answers for every repository; tests that need two use the same GitHub name.
  writeFileSync(join(bin, "gh"), `#!/bin/sh\n${answer}\n`, { mode: 0o755 });
  return path;
}

async function skel(args: string[], typed = "") {
  const run = Bun.spawn(["bun", main, ...args], {
    env: {
      PATH: `${join(home, "bin")}:${process.env.PATH ?? ""}`,
      HOME: home,
    },
    stdin: new Blob([typed]),
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

test("adds a repository you trust and lists it", async () => {
  const path = repository("app", "simon/app");
  const added = await skel(["repo", "add", path], "y\n");
  expect(added.err).toBe("");
  expect(added.code).toBe(0);
  expect(added.out).toContain("trust");
  const listed = await skel(["repo", "ls"]);
  expect(listed.out).toContain("app");
  expect(listed.out).toContain("simon/app");
  expect(listed.out).toContain(path);
});

test("keeps skel's folder out of git", async () => {
  const path = repository("app", "simon/app");
  await skel(["repo", "add", path], "y\n");
  await skel(["repo", "rm", "app"]);
  await skel(["repo", "add", path], "y\n");
  const exclude = readFileSync(join(path, ".git", "info", "exclude"), "utf8");
  expect(exclude.split("\n").filter((line) => line === ".skel/")).toHaveLength(1);
});

test("doesn't add a repository you don't trust", async () => {
  const path = repository("app", "simon/app");
  const added = await skel(["repo", "add", path], "n\n");
  expect(added.code).toBe(1);
  expect((await skel(["repo", "ls"])).out).not.toContain(path);
});

test("asks about trust only once per folder", async () => {
  const path = repository("app", "simon/app");
  await skel(["repo", "add", path], "y\n");
  await skel(["repo", "rm", "app"]);
  const again = await skel(["repo", "add", path]);
  expect(again.code).toBe(0);
  expect(again.out).not.toContain("trust");
  // The answer lives with your settings, so a clone of the repository can't bring it.
  expect(readFileSync(join(home, ".config", "skel", "trusted"), "utf8")).toContain(path);
  expect(existsSync(join(path, ".skel"))).toBe(false);
});

test("refuses a folder that isn't on GitHub, before asking about trust", async () => {
  const path = repository("app", null);
  const added = await skel(["repo", "add", path], "y\n");
  expect(added.code).toBe(1);
  expect(added.err).toContain("GitHub");
  expect(added.out).not.toContain("trust");
});

test("refuses a folder that isn't a git repository", async () => {
  const path = join(home, "plain");
  mkdirSync(path);
  const added = await skel(["repo", "add", path], "y\n");
  expect(added.code).toBe(1);
  expect(added.err).toContain("git");
});

test("takes another short name with --name, and refuses one already taken", async () => {
  const first = repository("app", "simon/app");
  const second = repository("app2", "simon/app");
  expect((await skel(["repo", "add", first, "--name", "web"], "y\n")).code).toBe(0);
  const clash = await skel(["repo", "add", second, "--name", "web"], "y\n");
  expect(clash.code).toBe(1);
  expect(clash.err).toContain("web");
  const listed = (await skel(["repo", "ls"])).out;
  expect(listed).toContain("web");
  expect(listed).not.toContain(second);
});

test("refuses a folder already added under another name", async () => {
  const path = repository("app", "simon/app");
  await skel(["repo", "add", path], "y\n");
  const again = await skel(["repo", "add", path, "--name", "web"], "y\n");
  expect(again.code).toBe(1);
  expect(again.err).toContain("app");
});

test("refuses a short name that would read as a flag", async () => {
  const path = repository("app", "simon/app");
  const added = await skel(["repo", "add", path, "--name", "-app"], "y\n");
  expect(added.code).toBe(1);
  expect(added.err).toContain("-app");
});

test("refuses a folder with no origin remote", async () => {
  const path = repository("app", "simon/app");
  Bun.spawnSync(["git", "-C", path, "remote", "remove", "origin"]);
  const added = await skel(["repo", "add", path], "y\n");
  expect(added.code).toBe(1);
  expect(added.err).toContain("origin");
});

test("removes a repository, and says so when there is none by that name", async () => {
  const path = repository("app", "simon/app");
  await skel(["repo", "add", path], "y\n");
  expect((await skel(["repo", "rm", "app"])).code).toBe(0);
  expect((await skel(["repo", "ls"])).out).not.toContain(path);
  const missing = await skel(["repo", "rm", "app"]);
  expect(missing.code).toBe(1);
  expect(missing.err).toContain("app");
});
