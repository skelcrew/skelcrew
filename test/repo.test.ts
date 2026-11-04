// Bringing a repository into skel's own clones, repo ls, repo rm and trust, run as you would
// run them, against a fake gh, a fake daemon and a folder of bare repositories standing in
// for GitHub.
import { Database } from "bun:sqlite";
import { afterEach, beforeEach, expect, test } from "bun:test";
import {
  appendFileSync,
  existsSync,
  mkdirSync,
  mkdtempSync,
  readFileSync,
  realpathSync,
  rmSync,
  writeFileSync,
} from "node:fs";
import { createServer, type Server } from "node:net";
import { tmpdir } from "node:os";
import { join } from "node:path";

const main = join(import.meta.dir, "..", "src", "main.ts");
let home = "";
let daemon: Server | undefined;

const hint =
  "skel has no repositories yet. Run skel in a checkout of one, or ask the lead for one by its GitHub name.";
const clone = (full: string) => join(home, ".local", "share", "skel", "repos", full);
const trustFile = () => join(home, ".config", "skel", "trusted");

function fake(name: string, body: string): void {
  writeFileSync(
    join(home, "bin", name),
    `#!/bin/sh\necho "${name} $*" >> "$HOME/calls"\n${body}\n`,
    { mode: 0o755 },
  );
}

beforeEach(async () => {
  home = realpathSync(mkdtempSync(join(tmpdir(), "skel-repo-test-")));
  mkdirSync(join(home, "bin"));
  mkdirSync(join(home, "run"), { mode: 0o700 });
  // The fake GitHub knows a repository when its bare repository is there, and reports your
  // permission and whether it is a fork from the files beside it.
  fake(
    "gh",
    `test "$1 $2" = "repo view" || exit 1
full=$3
test -d "$HOME/github/$full.git" || { echo "Could not resolve to a Repository" >&2; exit 1; }
permission=$(cat "$HOME/github/$full.permission")
fork=$(test -e "$HOME/github/$full.fork" && echo true || echo false)
echo "{\\"name\\":\\"\${full#*/}\\",\\"owner\\":{\\"login\\":\\"\${full%/*}\\"},\\"viewerPermission\\":\\"$permission\\",\\"isFork\\":$fork}"`,
  );
  fake("tmux", "exit 0");
  fake("systemctl", "exit 1");
  // git reaches the fake GitHub for every https://github.com/ URL.
  writeFileSync(
    join(home, ".gitconfig"),
    `[url "file://${home}/github/"]\n\tinsteadOf = https://github.com/\n`,
  );
  // As the first run leaves a machine, so plain skel goes straight to the repository.
  mkdirSync(join(home, ".config", "skel"), { recursive: true });
  writeFileSync(join(home, ".config", "skel", "config.yaml"), "harness: claude\n");
  writeFileSync(join(home, ".config", "skel", "claude-token"), "sk-ant-oat01-good\n");
  mkdirSync(join(home, ".config", "systemd", "user"), { recursive: true });
  writeFileSync(join(home, ".config", "systemd", "user", "skel.service"), "");
  daemon = createServer((connection) =>
    connection.on("data", () => {
      appendFileSync(join(home, "calls"), "daemon lead\n");
      connection.end('{"lead":true}\n');
    }),
  );
  await new Promise<void>((listening) => daemon?.listen(join(home, "run", "skel.sock"), listening));
});
afterEach(() => {
  daemon?.close();
  rmSync(home, { recursive: true, force: true });
});

function git(cwd: string, ...args: string[]): string {
  const run = Bun.spawnSync(
    ["git", "-C", cwd, "-c", "user.name=t", "-c", "user.email=t@t", ...args],
    { stdout: "pipe", stderr: "pipe" },
  );
  if (!run.success) throw new Error(run.stderr.toString());
  return run.stdout.toString();
}

// Puts a repository with one file on the fake GitHub, and returns your checkout of it.
function onGitHub(full: string, permission = "READ", fork = false): string {
  const bare = join(home, "github", `${full}.git`);
  const work = join(home, "code", full);
  mkdirSync(work, { recursive: true });
  writeFileSync(join(work, "README"), `${full}\n`);
  git(work, "init", "-q", "-b", "main");
  git(work, "add", ".");
  git(work, "commit", "-q", "-m", "start");
  git(home, "clone", "-q", "--bare", work, bare);
  git(work, "remote", "add", "origin", `https://github.com/${full}`);
  writeFileSync(join(home, "github", `${full}.permission`), permission);
  if (fork) writeFileSync(join(home, "github", `${full}.fork`), "");
  return work;
}

async function skel(args: string[], typed = "", cwd = home, more: Record<string, string> = {}) {
  const run = Bun.spawn([process.execPath, main, ...args], {
    cwd,
    env: {
      PATH: `${join(home, "bin")}:${process.env.PATH ?? ""}`,
      HOME: home,
      XDG_RUNTIME_DIR: join(home, "run"),
      ...more,
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

const calls = () =>
  existsSync(join(home, "calls")) ? readFileSync(join(home, "calls"), "utf8") : "";
const attached = () => calls().endsWith("daemon lead\ntmux -L skel attach -t =lead\n");

test("brings in a repository you can push to from its checkout, without asking", async () => {
  const checkout = onGitHub("simon/app", "WRITE");
  const config = readFileSync(join(checkout, ".git", "config"), "utf8");
  const run = await skel([], "", checkout);
  expect(run.err).toBe("");
  expect(run.code).toBe(0);
  expect(run.out).not.toContain("Do you trust");
  expect(run.out).not.toContain(hint);
  expect(attached()).toBe(true);
  expect(readFileSync(join(clone("simon/app"), "README"), "utf8")).toBe("simon/app\n");
  // The lead reads the clone's config, so no token may be in it.
  expect(git(clone("simon/app"), "config", "remote.origin.url")).toBe(
    "https://github.com/simon/app.git\n",
  );
  expect(readFileSync(join(checkout, ".git", "config"), "utf8")).toBe(config);
  expect(git(checkout, "status", "--porcelain")).toBe("");
  expect((await skel(["repo", "ls"])).out).toBe(`app  simon/app  ${clone("simon/app")}\n`);
});

test("brings it in from a folder inside the checkout too", async () => {
  const checkout = onGitHub("simon/app", "WRITE");
  mkdirSync(join(checkout, "src"));
  expect((await skel([], "", join(checkout, "src"))).code).toBe(0);
  expect(existsSync(join(clone("simon/app"), "README"))).toBe(true);
});

test("asks about a repository you can't push to, and a yes clones it and is remembered", async () => {
  const checkout = onGitHub("simon/app");
  const run = await skel([], "y\n", checkout);
  expect(run.err).toBe("");
  expect(run.out).toContain("Do you trust simon/app?");
  expect(existsSync(join(clone("simon/app"), "README"))).toBe(true);
  // The answer lives with your settings, so a clone of the repository can't bring it.
  expect(readFileSync(trustFile(), "utf8")).toBe("simon/app\n");
  expect(attached()).toBe(true);
});

test("asks about a fork, even one you can push to", async () => {
  const checkout = onGitHub("simon/app", "ADMIN", true);
  const run = await skel([], "y\n", checkout);
  expect(run.out).toContain("Do you trust simon/app?");
});

for (const [what, typed] of [
  ["a no", "n\n"],
  ["Ctrl-D", ""],
]) {
  test(`after ${what} clones nothing, attaches anyway, and asks again next time`, async () => {
    const checkout = onGitHub("simon/app");
    const first = await skel([], typed, checkout);
    expect(first.code).toBe(0);
    expect(first.out).toContain("Do you trust simon/app?");
    expect(first.out).toContain(hint);
    expect(existsSync(clone("simon/app"))).toBe(false);
    expect(existsSync(trustFile())).toBe(false);
    expect(attached()).toBe(true);
    expect((await skel([], "", checkout)).out).toContain("Do you trust simon/app?");
  });
}

// Plain skel must stay fast: keeping the clone current is the daemon's work.
test("asks GitHub nothing and fetches nothing for a repository skel has", async () => {
  const checkout = onGitHub("simon/app");
  await skel([], "y\n", checkout);
  writeFileSync(join(checkout, "NEWS"), "more\n");
  git(checkout, "add", ".");
  git(checkout, "commit", "-q", "-m", "more");
  git(checkout, "push", "-q", join(home, "github", "simon", "app.git"), "main");
  for (const origin of [
    "https://github.com/simon/app",
    "git@github.com:Simon/App.git",
    "ssh://git@github.com/simon/app.git",
  ]) {
    git(checkout, "remote", "set-url", "origin", origin);
    writeFileSync(join(home, "calls"), "");
    const again = await skel([], "", checkout);
    expect(again.err).toBe("");
    expect(again.out).toBe("");
    expect(calls()).not.toContain("gh");
    expect(attached()).toBe(true);
  }
  writeFileSync(join(home, "calls"), "");
  expect((await skel(["--from", "simon/app"])).out).toBe("");
  expect(calls()).not.toContain("gh");
  expect(existsSync(join(clone("simon/app"), "NEWS"))).toBe(false);
});

test("does nothing in a repository that isn't on GitHub, or has no origin", async () => {
  const checkout = onGitHub("simon/app", "WRITE");
  git(checkout, "remote", "set-url", "origin", "https://gitlab.com/simon/app");
  const elsewhere = await skel([], "", checkout);
  expect(elsewhere.err).toBe("");
  expect(elsewhere.out).toBe(`${hint}\n`);
  expect(attached()).toBe(true);
  git(checkout, "remote", "remove", "origin");
  const none = await skel([], "", checkout);
  expect(none.err).toBe("");
  expect(none.out).toBe(`${hint}\n`);
  expect(existsSync(clone("simon/app"))).toBe(false);
});

test("outside a repository, says how to bring one in only while skel has none", async () => {
  const first = await skel([]);
  expect(first.err).toBe("");
  expect(first.out).toBe(`${hint}\n`);
  expect(calls()).not.toContain("gh");
  expect(attached()).toBe(true);
  await skel([], "", onGitHub("simon/app", "WRITE"));
  expect((await skel([])).out).toBe("");
});

test("--from brings in the repository it names, wherever skel runs", async () => {
  onGitHub("simon/app", "WRITE");
  const run = await skel(["--from", "simon/app"]);
  expect(run.err).toBe("");
  expect(existsSync(join(clone("simon/app"), "README"))).toBe(true);
  expect(attached()).toBe(true);
});

test("--from says why it can't bring a repository in, and attaches anyway", async () => {
  const run = await skel(["--from", "nobody/none"]);
  expect(run.code).toBe(0);
  expect(run.err).toContain("nobody/none");
  expect(attached()).toBe(true);
});

test("repo ls says how to bring a repository in while there is none", async () => {
  expect((await skel(["repo", "ls"])).out).toBe(`${hint}\n`);
});

// The daemon writes skel's database while you run commands that read or write it too.
test("repo ls waits while another process writes skel's database", async () => {
  expect((await skel(["repo", "ls"])).out).toBe(`${hint}\n`);
  const held = join(home, "held");
  const script = `import { Database } from "bun:sqlite";
import { writeFileSync } from "node:fs";
const db = new Database(${JSON.stringify(join(home, ".local", "share", "skel", "skel.db"))});
db.run("BEGIN EXCLUSIVE");
writeFileSync(${JSON.stringify(held)}, "");
await Bun.sleep(1000);
db.run("COMMIT");`;
  const writer = Bun.spawn([process.execPath, "-e", script], { stderr: "pipe" });
  try {
    const deadline = Date.now() + 10_000;
    while (!existsSync(held)) {
      if (Date.now() > deadline) throw new Error(await new Response(writer.stderr).text());
      await Bun.sleep(20);
    }
    const listed = await skel(["repo", "ls"]);
    expect(listed.err).toBe("");
    expect(listed.out).toBe(`${hint}\n`);
  } finally {
    writer.kill();
    await writer.exited;
  }
});

test("repo rm removes skel's clone and forgets the trust", async () => {
  const checkout = onGitHub("simon/app");
  await skel([], "y\n", checkout);
  const removed = await skel(["repo", "rm", "app"]);
  expect(removed.err).toBe("");
  expect(existsSync(clone("simon/app"))).toBe(false);
  expect(readFileSync(trustFile(), "utf8")).toBe("");
  expect((await skel(["repo", "ls"])).out).toBe(`${hint}\n`);
  // Your checkout is yours, and stays.
  expect(existsSync(join(checkout, "README"))).toBe(true);
  const missing = await skel(["repo", "rm", "app"]);
  expect(missing.code).toBe(1);
  expect(missing.err).toContain("app");
});

test("names two repositories that share a GitHub name with their owners", async () => {
  await skel([], "", onGitHub("simon/app", "WRITE"));
  await skel([], "", onGitHub("other/app", "WRITE"));
  expect((await skel(["repo", "ls"])).out).toBe(
    `other/app  other/app  ${clone("other/app")}\nsimon/app  simon/app  ${clone("simon/app")}\n`,
  );
  await skel(["repo", "rm", "other/app"]);
  expect((await skel(["repo", "ls"])).out).toBe(`app  simon/app  ${clone("simon/app")}\n`);
});

test("repo trust clones a repository you can't push to, named by its GitHub name", async () => {
  onGitHub("other/tool");
  const run = await skel(["repo", "trust", "other/tool"]);
  expect(run.err).toBe("");
  expect(run.code).toBe(0);
  expect(existsSync(join(clone("other/tool"), "README"))).toBe(true);
  expect(readFileSync(trustFile(), "utf8")).toBe("other/tool\n");
  expect((await skel(["repo", "ls"])).out).toContain("tool  other/tool");
});

test("repo trust refuses inside skel's sandbox, where a yes could come from an agent", async () => {
  onGitHub("other/tool");
  const run = await skel(["repo", "trust", "other/tool"], "", home, { SKEL_SANDBOX: "1" });
  expect(run.code).toBe(1);
  expect(run.err).toContain("your own terminal");
  expect(existsSync(clone("other/tool"))).toBe(false);
  expect(existsSync(trustFile())).toBe(false);
});

test("repo trust asks for owner/repo for a repository skel doesn't know yet", async () => {
  const run = await skel(["repo", "trust", "tool"]);
  expect(run.code).toBe(1);
  expect(run.err).toContain("owner/repo");
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

// A git template, or anything else, could put a credential in a new clone's config. The lead
// reads every clone in skel's folder, so such a clone must never get there, even briefly.
test("refuses a clone whose config holds a credential, before the lead could see it", async () => {
  onGitHub("simon/app", "WRITE");
  const template = join(home, "template");
  mkdirSync(template);
  writeFileSync(
    join(template, "config"),
    "[http]\n\textraheader = AUTHORIZATION: basic c2VjcmV0\n",
  );
  appendFileSync(join(home, ".gitconfig"), `[init]\n\ttemplateDir = ${template}\n`);
  const run = await skel(["--from", "simon/app"]);
  expect(run.err).toContain("credential");
  expect(existsSync(clone("simon/app"))).toBe(false);
  expect(existsSync(join(home, ".local", "share", "skel", "cloning", "simon", "app"))).toBe(false);
  expect((await skel(["repo", "ls"])).out).toBe(`${hint}\n`);
});
