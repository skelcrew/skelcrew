// Bringing a repository into skel's own clones, repo ls, repo rm and trust, run as you would
// run them, against a fake forge plugin, a fake daemon and a folder of bare repositories
// standing in for GitHub.
import { Database } from "bun:sqlite";
import { afterEach, beforeEach, describe, expect, test } from "bun:test";
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
import { parse } from "yaml";
import { asked, fakePlugin, source } from "./harness.ts";

const main = source("main.ts");
let home = "";
let daemon: Server | undefined;
// The fake forge's settings folder, where it keeps what it is asked and its answers.
let forge = "";

const hint = "skel has no repositories yet. Run skel in a checkout of one.";
// What skel says once you leave the screen.
const left = "Your agents keep running. Run skel to come back.\n";
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
  for (const remote of Object.keys(claimed)) delete claimed[remote];
  home = realpathSync(mkdtempSync(join(tmpdir(), "skel-repo-test-")));
  mkdirSync(join(home, "bin"));
  mkdirSync(join(home, "run"), { mode: 0o700 });
  fake("tmux", "exit 0");
  // Run from a clone rather than a worktree, as in a builder's thread, skel rewrites the
  // service's unit and reloads systemd. Nothing else may reach systemd.
  fake("systemctl", 'test "$2" = daemon-reload');
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
  forge = fakePlugin(home, "github", ["tracker", "forge"]);
  daemon = createServer((connection) =>
    connection.on("data", (data) => {
      appendFileSync(join(home, "calls"), "daemon lead\n");
      writeFileSync(join(home, "asked"), data.toString());
      connection.end('{"lead":"app-lead","repository":"simon/app"}\n');
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

// The remotes the fake forge claims, each with its answer.
const claimed: Record<string, object> = {};

// Has the fake forge claim the repository by its URL in any form and by its full name, as
// GitHub's plugin does, with your permission on it and whether it is a fork. `as` is the name
// the forge gives it now, such as after a rename.
function claim(full: string, permission: string, fork: boolean, as = full): void {
  const answer = {
    key: as,
    name: as.split("/")[1],
    link: `https://github.com/${as}`,
    clone: `https://github.com/${as}.git`,
    push: ["WRITE", "MAINTAIN", "ADMIN"].includes(permission),
    fork,
  };
  for (const remote of [
    full,
    `https://github.com/${full}`,
    `https://github.com/${full}.git`,
    `git@github.com:${full}.git`,
  ])
    claimed[remote] = answer;
  writeFileSync(join(forge, "claims.json"), JSON.stringify(claimed));
}

// Returns the remotes skel asked the forge about.
const claimsAsked = () =>
  asked(forge)
    .filter((q) => q.ask === "claims")
    .map((q) => q.remote);

// Puts a repository with one file on the fake GitHub, which the fake forge claims, and returns
// your checkout of it.
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
  claim(full, permission, fork);
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

// Returns what skel ran, with the long tmux line that opens the screen cut to the agent it
// opens on. The fake daemon names the lead's session app-lead.
const calls = () =>
  existsSync(join(home, "calls"))
    ? readFileSync(join(home, "calls"), "utf8")
        .replace(/tmux -L skel -f \/dev\/null source-file -\n/g, "")
        .replace(/tmux -L skel-screen .* sh skel (\S+) \S+ ;.*/g, "screen on $1")
    : "";
const attached = () => calls().endsWith("daemon lead\nscreen on app-lead\n");

// Returns each repository skel repo ls --json lists, as its name, owner/name and forge.
async function listed(): Promise<string[][]> {
  const rows: { name: string; repository: string; forge: string | null }[] = JSON.parse(
    (await skel(["repo", "ls", "--json"])).out,
  );
  return rows.map((r) => [r.name, r.repository, r.forge ?? "none"]);
}

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
  expect(await listed()).toEqual([["app", "simon/app", "github"]]);
  // A server stays awake, so it needs no wake-ups.
  expect(asked(forge).filter((q) => q.ask === "wake")).toEqual([]);
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
  test(`after ${what} clones nothing, has nothing to attach to, and asks again next time`, async () => {
    const checkout = onGitHub("simon/app");
    const first = await skel([], typed, checkout);
    expect(first.code).toBe(0);
    expect(first.out).toContain("Do you trust simon/app?");
    expect(first.out).toContain(hint);
    expect(existsSync(clone("simon/app"))).toBe(false);
    expect(existsSync(trustFile())).toBe(false);
    expect(calls()).not.toContain("daemon lead");
    expect((await skel([], "", checkout)).out).toContain("Do you trust simon/app?");
  });
}

// Plain skel must stay fast: keeping the clone current is the daemon's work.
test("asks its forge nothing and fetches nothing for a repository skel has", async () => {
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
    expect(again.out).toBe(left);
    expect(attached()).toBe(true);
  }
  writeFileSync(join(home, "calls"), "");
  expect((await skel(["--from", "simon/app"])).out).toBe(left);
  expect(claimsAsked()).toEqual(["https://github.com/simon/app"]);
  expect(existsSync(join(clone("simon/app"), "NEWS"))).toBe(false);
});

// With no forge to say you can push to it, skel can't vouch for what is in it.
test("asks about a repository no forge claims, and does nothing in one with no origin", async () => {
  const checkout = onGitHub("simon/app", "WRITE");
  git(checkout, "remote", "set-url", "origin", "https://gitlab.com/simon/app");
  const elsewhere = await skel([], "", checkout);
  expect(elsewhere.err).toBe("");
  expect(elsewhere.out).toContain("Do you trust simon/app?");
  expect(elsewhere.out).toContain(hint);
  expect(calls()).not.toContain("daemon lead");
  git(checkout, "remote", "remove", "origin");
  const none = await skel([], "", checkout);
  expect(none.err).toBe("");
  expect(none.out).toBe(`${hint}\n`);
  expect(existsSync(clone("simon/app"))).toBe(false);
});

test("outside a repository, says how to bring one in, and attaches to nothing, while skel has none", async () => {
  const first = await skel([]);
  expect(first.err).toBe("");
  expect(first.out).toBe(`${hint}\n`);
  expect(claimsAsked()).toEqual([]);
  expect(calls()).not.toContain("daemon lead");
  await skel([], "", onGitHub("simon/app", "WRITE"));
  expect((await skel([])).out).toBe(left);
});

test("--from brings in the repository it names, wherever skel runs", async () => {
  onGitHub("simon/app", "WRITE");
  const run = await skel(["--from", "simon/app"]);
  expect(run.err).toBe("");
  expect(existsSync(join(clone("simon/app"), "README"))).toBe(true);
  expect(attached()).toBe(true);
});

test("--from says why it can't bring a repository in, and attaches to the one you opened last", async () => {
  const none = await skel(["--from", "nobody/none"]);
  expect(none.code).toBe(0);
  expect(none.err).toContain("nobody/none");
  expect(calls()).not.toContain("daemon lead");
  await skel([], "", onGitHub("simon/app", "WRITE"));
  const run = await skel(["--from", "nobody/none"]);
  expect(run.code).toBe(0);
  expect(run.err).toContain("nobody/none");
  expect(attached()).toBe(true);
});

// The daemon opens that repository's lead, or the one you opened last when it names none.
test("tells the daemon the repository you attached from, once skel has it", async () => {
  const asked = () => JSON.parse(readFileSync(join(home, "asked"), "utf8"));
  const app = onGitHub("simon/app", "WRITE");
  await skel([], "", app);
  expect(asked()).toEqual({ command: "lead", from: "simon/app" });
  git(app, "remote", "set-url", "origin", "git@github.com:Simon/App.git");
  await skel([], "", app);
  expect(asked()).toEqual({ command: "lead", from: "simon/app" });
  await skel(["--from", "simon/app"]);
  expect(asked()).toEqual({ command: "lead", from: "simon/app" });
  await skel([]);
  expect(asked()).toEqual({ command: "lead" });
  // Not yet in skel, as you didn't trust it.
  await skel([], "n\n", onGitHub("other/tool"));
  expect(asked()).toEqual({ command: "lead" });
  git(app, "remote", "set-url", "origin", "https://gitlab.com/simon/app");
  await skel([], "", app);
  expect(asked()).toEqual({ command: "lead" });
});

test("tells the daemon a repository's new name on its forge when your checkout uses its old one", async () => {
  const app = onGitHub("simon/app", "WRITE");
  claim("simon/old", "WRITE", false, "simon/app");
  git(app, "remote", "set-url", "origin", "https://github.com/simon/old");
  await skel([], "", app);
  expect(existsSync(join(clone("simon/app"), "README"))).toBe(true);
  expect(JSON.parse(readFileSync(join(home, "asked"), "utf8"))).toEqual({
    command: "lead",
    from: "simon/app",
  });
});

test("repo ls says how to bring a repository in while there is none", async () => {
  expect((await skel(["repo", "ls"])).out).toBe(`${hint}\n`);
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

// skel takes a machine with sprite-env, the Sprite's own tool, on its PATH for a Sprite. This
// one has the daemon's service, as the first run leaves it, and says the Sprite's URL.
function onSprite(): void {
  fake(
    "sprite-env",
    `case "$*" in
  "services get skel") exit 0 ;;
  info) echo '{"sprite_name":"demo","sprite_url":"https://demo-simon.sprites.app"}' ;;
  *) exit 1 ;;
esac`,
  );
}

const wakes = (ask: string) => asked(forge).filter((q) => q.ask === ask);

test("on a Sprite, brings in a repository asking its forge for the wake-ups that wake the Sprite", async () => {
  onSprite();
  const run = await skel([], "", onGitHub("simon/app", "WRITE"));
  expect(run.err).toBe("");
  expect(wakes("wake")).toEqual([
    { ask: "wake", repository: "simon/app", url: "https://demo-simon.sprites.app/github" },
  ]);
});

// Wake-ups left on would wake the Sprite for a repository skel no longer polls.
test("on a Sprite, repo rm stops the wake-ups", async () => {
  onSprite();
  await skel([], "", onGitHub("simon/app", "WRITE"));
  const removed = await skel(["repo", "rm", "app"]);
  expect(removed.err).toBe("");
  expect(wakes("unwake")).toEqual([
    { ask: "unwake", repository: "simon/app", url: "https://demo-simon.sprites.app/github" },
  ]);
});

test("repo rm refuses while the repository has live threads, and names them", async () => {
  await skel([], "y\n", onGitHub("simon/app"));
  const db = new Database(join(home, ".local", "share", "skel", "skel.db"));
  db.run(`INSERT INTO threads (owner, repo, task, folder, branch, status) VALUES
    ('simon', 'app', 12, 'app-12', 'skel/12', 'working'),
    ('simon', 'app', 15, 'app-15', 'skel/15', 'waiting'),
    ('simon', 'app', 9, 'app-9', 'skel/9', 'done')`);
  const refused = await skel(["repo", "rm", "app"]);
  expect(refused.code).toBe(1);
  expect(refused.err).toBe("skel: app has live threads: app-12, app-15. Stop them first.\n");
  expect(existsSync(clone("simon/app"))).toBe(true);
  db.run("UPDATE threads SET status = 'done' WHERE task = 12");
  db.run("UPDATE threads SET status = 'failed' WHERE task = 15");
  db.close();
  const removed = await skel(["repo", "rm", "app"]);
  expect(removed.err).toBe("");
  expect(existsSync(clone("simon/app"))).toBe(false);
});

test("repo rm refuses inside skel's sandbox, where skel's database is hidden", async () => {
  await skel([], "", onGitHub("simon/app", "WRITE"));
  const run = await skel(["repo", "rm", "app"], "", home, { SKEL_SANDBOX: "1" });
  expect(run.code).toBe(1);
  expect(run.err).toBe(
    "skel: removing a repository is only for your own terminal, not for agents\n",
  );
  expect(existsSync(clone("simon/app"))).toBe(true);
});

test("plain skel refuses inside skel's sandbox, and brings in nothing", async () => {
  const checkout = onGitHub("simon/app", "WRITE");
  const run = await skel([], "", checkout, { SKEL_SANDBOX: "1" });
  expect(run.code).toBe(1);
  expect(run.err).toBe(
    "skel: attaching to the lead is only for your own terminal, not for agents\n",
  );
  expect(calls()).toBe("");
  expect(existsSync(clone("simon/app"))).toBe(false);
});

test("names two repositories that share a name with their owners", async () => {
  await skel([], "", onGitHub("simon/app", "WRITE"));
  await skel([], "", onGitHub("other/app", "WRITE"));
  expect(await listed()).toEqual([
    ["other/app", "other/app", "github"],
    ["simon/app", "simon/app", "github"],
  ]);
  await skel(["repo", "rm", "other/app"]);
  expect(await listed()).toEqual([["app", "simon/app", "github"]]);
});

test("repo ls lists each repository with its tracker and forge, as text and for tools", async () => {
  expect(JSON.parse((await skel(["repo", "ls", "--json"])).out)).toEqual([]);
  await skel([], "", onGitHub("simon/app", "WRITE"));
  // Its skel.yaml names a tracker that isn't installed, so it has none.
  writeFileSync(join(clone("simon/app"), "skel.yaml"), "tracker: linear\n");
  const json = await skel(["repo", "ls", "--json"]);
  expect(json.err).toBe("");
  expect(JSON.parse(json.out)).toEqual([
    {
      name: "app",
      repository: "simon/app",
      tracker: null,
      forge: "github",
      missing: "linear",
      clone: clone("simon/app"),
    },
  ]);
  writeFileSync(join(clone("simon/app"), "skel.yaml"), "tracker: github\n");
  expect((await skel(["repo", "ls"])).out).toBe(
    `NAME  REPOSITORY  TRACKER  FORGE   CLONE\napp   simon/app   github   github  ${clone("simon/app")}\n`,
  );
  writeFileSync(join(clone("simon/app"), "skel.yaml"), "tracker: linear\n");
  expect((await skel(["repo", "ls"])).out).toContain("linear, not installed");
});

test("repo trust clones a repository you can't push to, named by its GitHub name", async () => {
  onGitHub("other/tool");
  const run = await skel(["repo", "trust", "other/tool"]);
  expect(run.err).toBe("");
  expect(run.code).toBe(0);
  expect(existsSync(join(clone("other/tool"), "README"))).toBe(true);
  expect(readFileSync(trustFile(), "utf8")).toBe("other/tool\n");
  expect(await listed()).toEqual([["tool", "other/tool", "github"]]);
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

test("repo add adds the checkout you are in, and attaches to nothing", async () => {
  const checkout = onGitHub("simon/app", "WRITE");
  const run = await skel(["repo", "add"], "", checkout);
  expect(run.err).toBe("");
  expect(run.code).toBe(0);
  expect(run.out).toBe("Cloning simon/app for skel.\nAdded simon/app, as app.\n");
  expect(existsSync(join(clone("simon/app"), "README"))).toBe(true);
  expect(calls()).not.toContain("daemon");
});

test("repo add takes a checkout's path, or a repository's name on its forge", async () => {
  onGitHub("simon/app", "WRITE");
  onGitHub("simon/site", "WRITE");
  const byPath = await skel(["repo", "add", join("code", "simon", "app")]);
  expect(byPath.err).toBe("");
  expect(byPath.out).toContain("Added simon/app, as app.");
  const byName = await skel(["repo", "add", "simon/site"]);
  expect(byName.err).toBe("");
  expect(byName.out).toContain("Added simon/site, as site.");
  expect(existsSync(join(clone("simon/site"), "README"))).toBe(true);
});

test("repo add asks about a repository you can't push to, and a no adds nothing", async () => {
  onGitHub("other/tool");
  const no = await skel(["repo", "add", "other/tool"], "n\n");
  expect(no.out).toContain("Do you trust other/tool?");
  expect(no.out).not.toContain("Added");
  expect(existsSync(clone("other/tool"))).toBe(false);
  const yes = await skel(["repo", "add", "other/tool"], "y\n");
  expect(yes.out).toContain("Added other/tool, as tool.");
});

test("repo add says so for a repository skel has, and fetches nothing", async () => {
  const checkout = onGitHub("simon/app", "WRITE");
  await skel(["repo", "add"], "", checkout);
  writeFileSync(join(home, "calls"), "");
  const again = await skel(["repo", "add", "simon/app"]);
  expect(again.err).toBe("");
  expect(again.out).toBe("skel has simon/app already, as app.\n");
  expect(calls()).toBe("");
});

test("repo add says why outside a checkout with a remote, and for a name no forge knows", async () => {
  const outside = await skel(["repo", "add"]);
  expect(outside.code).toBe(1);
  expect(outside.err).toBe(
    `skel: ${home} isn't a checkout with a remote. Run skel repo add in one, or give the repository's URL.\n`,
  );
  const unknown = await skel(["repo", "add", "nobody/none"]);
  expect(unknown.code).toBe(1);
  expect(unknown.err).toContain("no forge installed knows nobody/none");
});

// A repository with no forge takes skel's pushes on your own git login, which the daemon must
// be able to use without you.
describe("a repository no forge claims", () => {
  // Returns a checkout whose remote is a folder of bare repositories no forge claims.
  function elsewhere(): string {
    const bare = join(home, "elsewhere", "simon", "notes.git");
    const work = join(home, "code", "notes");
    mkdirSync(work, { recursive: true });
    writeFileSync(join(work, "README"), "notes\n");
    git(work, "init", "-q", "-b", "main");
    git(work, "add", ".");
    git(work, "commit", "-q", "-m", "start");
    git(home, "clone", "-q", "--bare", work, bare);
    git(work, "remote", "add", "origin", `file://${bare}`);
    return work;
  }

  test("is named by its remote's path, asked about, and added once git can push to it", async () => {
    const run = await skel(["repo", "add"], "y\n", elsewhere());
    expect(run.err).toBe("");
    expect(run.out).toContain("Do you trust simon/notes?");
    expect(run.out).toContain("Added simon/notes, as notes.");
    expect(await listed()).toEqual([["notes", "simon/notes", "none"]]);
    expect(existsSync(join(clone("simon/notes"), "README"))).toBe(true);
  });

  test("isn't added when git refuses to push, and skel says what to fix", async () => {
    const real = Bun.which("git") ?? "git";
    writeFileSync(
      join(home, "bin", "git"),
      `#!/bin/sh\ncase "$*" in *"push --dry-run"*) echo "Permission denied (publickey)." >&2; exit 128 ;; esac\nexec ${real} "$@"\n`,
      { mode: 0o755 },
    );
    const run = await skel(["repo", "add"], "y\n", elsewhere());
    expect(run.code).toBe(1);
    expect(run.err).toContain("git refused");
    expect(run.err).toContain("Permission denied (publickey).");
    expect(run.err).toContain("a key with no passphrase or a credential helper");
    expect(await listed()).toEqual([]);
  });
});

test("repo add and init refuse inside skel's sandbox, where a yes could come from an agent", async () => {
  const checkout = onGitHub("simon/app", "WRITE");
  for (const [args, what] of [
    [["repo", "add"], "adding a repository"],
    [["init"], "setting up a repository for skel"],
  ] as const) {
    const run = await skel([...args], "", checkout, { SKEL_SANDBOX: "1" });
    expect(run.code).toBe(1);
    expect(run.err).toBe(`skel: ${what} is only for your own terminal, not for agents\n`);
  }
  expect(existsSync(join(checkout, "skel.yaml"))).toBe(false);
  expect(existsSync(clone("simon/app"))).toBe(false);
});

test("init writes a starter skel.yaml with your harness and model for each role, and adds the repository", async () => {
  writeFileSync(
    join(home, ".config", "skel", "config.yaml"),
    "harness: claude\nmodel: sonnet\nlead: { model: opus }\nreviewer: { harness: codex }\n",
  );
  const checkout = onGitHub("simon/app", "WRITE");
  mkdirSync(join(checkout, "src"));
  const run = await skel(["init"], "", join(checkout, "src"));
  expect(run.err).toBe("");
  expect(run.code).toBe(0);
  expect(readFileSync(join(checkout, "skel.yaml"), "utf8")).toBe(
    `# Shared with everyone who works on this repository. Never put a secret here.
lead:     { harness: claude, model: opus }
builder:  { harness: claude, model: sonnet }
reviewer: { harness: codex }
# setup: [bun install]
# test: [bun test]
`,
  );
  expect(existsSync(join(clone("simon/app"), "README"))).toBe(true);
  expect(run.out).toContain("Added simon/app, as app.");
  expect(run.out).toContain(
    "Wrote skel.yaml. skel reads it from its own clone, so it counts once you commit it and push it to the default branch.",
  );
});

// YAML reads true, null or 123 as something other than text, which a model name must be.
test("init writes model names that read back as the same text", async () => {
  writeFileSync(
    join(home, ".config", "skel", "config.yaml"),
    'harness: claude\nmodel: "123"\nlead: { model: "true" }\nbuilder: { model: "null" }\n',
  );
  const checkout = onGitHub("simon/app", "WRITE");
  expect((await skel(["init"], "", checkout)).err).toBe("");
  expect(parse(readFileSync(join(checkout, "skel.yaml"), "utf8"))).toEqual({
    lead: { harness: "claude", model: "true" },
    builder: { harness: "claude", model: "null" },
    reviewer: { harness: "claude", model: "123" },
  });
});

test("init leaves a skel.yaml that is there alone", async () => {
  const checkout = onGitHub("simon/app", "WRITE");
  writeFileSync(join(checkout, "skel.yaml"), "setup: [make]\n");
  const run = await skel(["init"], "", checkout);
  expect(run.code).toBe(0);
  expect(readFileSync(join(checkout, "skel.yaml"), "utf8")).toBe("setup: [make]\n");
  expect(run.out).toContain("skel.yaml is there already, so skel left it as it is.");
  expect(run.out).toContain("Added simon/app, as app.");
});

test("init stops outside a git repository, and in one with no remote", async () => {
  const outside = await skel(["init"]);
  expect(outside.code).toBe(1);
  expect(outside.err).toBe(
    "skel: skel init runs in a checkout of a git repository, and this folder isn't in one.\n",
  );
  const checkout = onGitHub("simon/app", "WRITE");
  git(checkout, "remote", "remove", "origin");
  const none = await skel(["init"], "", checkout);
  expect(none.code).toBe(1);
  expect(none.err).toBe(
    "skel: skel init needs the repository's remote, and this checkout has none. Push it somewhere first, such as to GitHub.\n",
  );
  expect(existsSync(join(checkout, "skel.yaml"))).toBe(false);
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
