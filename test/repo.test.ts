// skel init, repo ls and repo rm, run as you would run them, against a fake gh.
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

// A git repository whose GitHub name and your permission on it the fake gh reports, or
// refuses to know.
function repository(folder: string, github: string | null, permission = "READ"): string {
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
    ? `echo '{"name":"${name}","owner":{"login":"${owner}"},"viewerPermission":"${permission}"}'`
    : `echo 'none of the git remotes point to a known GitHub host' >&2; exit 1`;
  // The fake answers for every repository; tests that need two use the same GitHub name.
  writeFileSync(join(bin, "gh"), `#!/bin/sh\n${answer}\n`, { mode: 0o755 });
  return path;
}

// Says yes to the trust question and keeps both commands as they are.
const trustAndKeep = "y\n\n\n";

async function skel(args: string[], typed = "", cwd = home) {
  const run = Bun.spawn(["bun", main, ...args], {
    cwd,
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
  const added = await skel(["init", path], trustAndKeep);
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
  await skel(["init", path], trustAndKeep);
  await skel(["repo", "rm", "app"]);
  await skel(["init", path], trustAndKeep);
  const exclude = readFileSync(join(path, ".git", "info", "exclude"), "utf8");
  expect(exclude.split("\n").filter((line) => line === ".skel/")).toHaveLength(1);
});

test("doesn't add a repository you don't trust", async () => {
  const path = repository("app", "simon/app");
  const added = await skel(["init", path], "n\n");
  expect(added.code).toBe(1);
  expect((await skel(["repo", "ls"])).out).not.toContain(path);
});

test("asks about trust only once per folder", async () => {
  const path = repository("app", "simon/app");
  await skel(["init", path], trustAndKeep);
  await skel(["repo", "rm", "app"]);
  const again = await skel(["init", path], "\n\n");
  expect(again.code).toBe(0);
  expect(again.out).not.toContain("trust");
  // The answer lives with your settings, so a clone of the repository can't bring it.
  expect(readFileSync(join(home, ".config", "skel", "trusted"), "utf8")).toContain(path);
  expect(existsSync(join(path, ".skel"))).toBe(false);
});

test("refuses a folder that isn't on GitHub, before asking about trust", async () => {
  const path = repository("app", null);
  const added = await skel(["init", path], trustAndKeep);
  expect(added.code).toBe(1);
  expect(added.err).toContain("GitHub");
  expect(added.out).not.toContain("trust");
});

test("refuses a folder that isn't a git repository", async () => {
  const path = join(home, "plain");
  mkdirSync(path);
  const added = await skel(["init", path], trustAndKeep);
  expect(added.code).toBe(1);
  expect(added.err).toContain("git");
});

test("takes another short name with --name, and refuses one already taken", async () => {
  const first = repository("app", "simon/app");
  const second = repository("app2", "simon/app");
  expect((await skel(["init", first, "--name", "web"], trustAndKeep)).code).toBe(0);
  const clash = await skel(["init", second, "--name", "web"], trustAndKeep);
  expect(clash.code).toBe(1);
  expect(clash.err).toContain("web");
  const listed = (await skel(["repo", "ls"])).out;
  expect(listed).toContain("web");
  expect(listed).not.toContain(second);
});

test("refuses a folder already added under another name", async () => {
  const path = repository("app", "simon/app");
  await skel(["init", path], trustAndKeep);
  const again = await skel(["init", path, "--name", "web"], trustAndKeep);
  expect(again.code).toBe(1);
  expect(again.err).toContain("app");
});

test("refuses a short name that would read as a flag", async () => {
  const path = repository("app", "simon/app");
  const added = await skel(["init", path, "--name", "-app"], trustAndKeep);
  expect(added.code).toBe(1);
  expect(added.err).toContain("-app");
});

test("refuses a folder with no origin remote", async () => {
  const path = repository("app", "simon/app");
  Bun.spawnSync(["git", "-C", path, "remote", "remove", "origin"]);
  const added = await skel(["init", path], trustAndKeep);
  expect(added.code).toBe(1);
  expect(added.err).toContain("origin");
});

test("removes a repository, and says so when there is none by that name", async () => {
  const path = repository("app", "simon/app");
  await skel(["init", path], trustAndKeep);
  expect((await skel(["repo", "rm", "app"])).code).toBe(0);
  expect((await skel(["repo", "ls"])).out).not.toContain(path);
  const missing = await skel(["repo", "rm", "app"]);
  expect(missing.code).toBe(1);
  expect(missing.err).toContain("app");
});

test("adds the repository in the current folder", async () => {
  const path = repository("app", "simon/app");
  const added = await skel(["init"], trustAndKeep, path);
  expect(added.err).toBe("");
  expect(added.code).toBe(0);
  expect((await skel(["repo", "ls"])).out).toContain(path);
});

test("refuses a folder inside a repository, below its top", async () => {
  const path = repository("app", "simon/app");
  mkdirSync(join(path, "src"));
  const added = await skel(["init"], trustAndKeep, join(path, "src"));
  expect(added.code).toBe(1);
  expect(added.err).toContain("top");
});

test("says cloning comes later for owner/repo", async () => {
  const added = await skel(["init", "simon/app"]);
  expect(added.code).toBe(1);
  expect(added.err).toContain("clon");
});

test("trusts a repository you can push to, without asking", async () => {
  const path = repository("app", "simon/app", "WRITE");
  const added = await skel(["init", path], "\n\n");
  expect(added.code).toBe(0);
  expect(added.out).toContain("you can push to simon/app");
  expect(added.out).not.toContain("Do you trust");
});

test("asks about trust when you can only read the repository", async () => {
  const path = repository("app", "simon/app", "READ");
  const added = await skel(["init", path], trustAndKeep);
  expect(added.code).toBe(0);
  expect(added.out).toContain("Do you trust");
});

const skelYaml = (path: string) => readFileSync(join(path, "skel.yaml"), "utf8");

test("guesses bun's commands, and writes them for you to commit", async () => {
  const path = repository("app", "simon/app", "WRITE");
  writeFileSync(join(path, "bun.lock"), "");
  const added = await skel(["init", path], "\n\n");
  expect(added.out).toContain("Setup command [bun install]");
  expect(added.out).toContain("Test command [bun test]");
  expect(added.out).toContain("Commit it");
  expect(skelYaml(path)).toBe("setup: [ bun install ]\ntest: [ bun test ]\n");
});

test("guesses npm's commands, with a test command only when package.json has one", async () => {
  const path = repository("app", "simon/app", "WRITE");
  writeFileSync(join(path, "package-lock.json"), "{}");
  writeFileSync(join(path, "package.json"), JSON.stringify({ scripts: { build: "tsc" } }));
  const added = await skel(["init", path], "\n\n");
  expect(added.out).toContain("Setup command [npm ci]");
  expect(added.out).toContain("Test command []");
  expect(skelYaml(path)).toBe("setup: [ npm ci ]\n");
  await skel(["repo", "rm", "app"]);
  writeFileSync(join(path, "package.json"), JSON.stringify({ scripts: { test: "jest" } }));
  rmSync(join(path, "skel.yaml"));
  const again = await skel(["init", path], "\n\n");
  expect(again.out).toContain("Test command [npm test]");
});

test("guesses nothing for other repositories, and writes no file without commands", async () => {
  const path = repository("app", "simon/app", "WRITE");
  const added = await skel(["init", path], "\n\n");
  expect(added.code).toBe(0);
  expect(added.out).toContain("Setup command []");
  expect(added.out).not.toContain("Commit it");
  expect(existsSync(join(path, "skel.yaml"))).toBe(false);
});

test("typed text replaces a command and - means none", async () => {
  const path = repository("app", "simon/app", "WRITE");
  writeFileSync(join(path, "bun.lock"), "");
  await skel(["init", path], "bun install --frozen-lockfile\n-\n");
  expect(skelYaml(path)).toBe("setup: [ bun install --frozen-lockfile ]\n");
});

test("shows an existing skel.yaml's commands, and keeps its other settings", async () => {
  const path = repository("app", "simon/app", "WRITE");
  writeFileSync(join(path, "bun.lock"), "");
  writeFileSync(
    join(path, "skel.yaml"),
    "# for skel\nmax_rounds: 2\nsetup: [make deps, make tools]\ntest: [make test]\n",
  );
  const added = await skel(["init", path], "\nmake check\n");
  expect(added.out).toContain("Setup command [make deps && make tools]");
  expect(added.out).toContain("Test command [make test]");
  expect(skelYaml(path)).toBe(
    "# for skel\nmax_rounds: 2\nsetup: [ make deps, make tools ]\ntest: [ make check ]\n",
  );
});

test("leaves an existing skel.yaml alone when both commands are emptied", async () => {
  const path = repository("app", "simon/app", "WRITE");
  const before = "max_rounds: 2\nsetup: [make deps]\n";
  writeFileSync(join(path, "skel.yaml"), before);
  const added = await skel(["init", path], "-\n-\n");
  expect(added.code).toBe(0);
  expect(skelYaml(path)).toBe(before);
});

test("refuses a skel.yaml that isn't valid", async () => {
  const path = repository("app", "simon/app", "WRITE");
  writeFileSync(join(path, "skel.yaml"), "setup: bun install\n");
  const added = await skel(["init", path], "\n\n");
  expect(added.code).toBe(1);
  expect(added.err).toContain("skel.yaml");
});

test("Ctrl-D at a command question adds nothing", async () => {
  const path = repository("app", "simon/app", "WRITE");
  writeFileSync(join(path, "bun.lock"), "");
  const stopped = await skel(["init", path], "\n");
  expect(stopped.code).toBe(1);
  expect(existsSync(join(path, "skel.yaml"))).toBe(false);
  const exclude = join(path, ".git", "info", "exclude");
  expect(existsSync(exclude) ? readFileSync(exclude, "utf8") : "").not.toContain(".skel/");
  expect((await skel(["repo", "ls"])).out).not.toContain(path);
});

test("says to use skel init when no repository is added", async () => {
  expect((await skel(["repo", "ls"])).out).toContain("skel init");
});

test("skel repo add is gone", async () => {
  const path = repository("app", "simon/app", "WRITE");
  const added = await skel(["repo", "add", path]);
  expect(added.code).toBe(1);
  expect(added.err).toContain("skel init");
  expect(added.err).not.toContain("repo add");
});
