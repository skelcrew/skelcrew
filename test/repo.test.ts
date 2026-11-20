// Bringing a repository into Skelcrew's own clones, repo ls, repo rm and trust, run as you would
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
import { builtInFlowText } from "../src/flows.ts";
import { builtInRole } from "../src/roles.ts";
import { asked, fakePlugin, inTerminal, source, threadSql } from "./harness.ts";

const main = source("main.ts");
let home = "";
let daemon: Server | undefined;
// The fake forge's settings folder, where it keeps what it is asked and its answers.
let forge = "";

const hint = "Skelcrew has no repositories yet. Run sc in a checkout of one.";
// What Skelcrew says once you leave the screen.
const left = "Your agents keep running. Run sc to come back.\n";
const clone = (full: string) => join(home, ".local", "share", "skelcrew", "repos", full);
const trustFile = () => join(home, ".config", "skelcrew", "trusted");

// What the fake daemon answers when asked for a lead.
let daemonReply = "";
// Repositories the fake daemon hands back for plain sc to ask about their .agents/, in turn,
// before it answers with the lead.
let handBack: object[] = [];

function fake(name: string, body: string): void {
  writeFileSync(
    join(home, "bin", name),
    `#!/bin/sh\necho "${name} $*" >> "$HOME/calls"\n${body}\n`,
    { mode: 0o755 },
  );
}

beforeEach(async () => {
  daemonReply = '{"lead":"app-lead","repository":"simon/app"}';
  handBack = [];
  for (const remote of Object.keys(claimed)) delete claimed[remote];
  home = realpathSync(mkdtempSync(join(tmpdir(), "skel-repo-test-")));
  mkdirSync(join(home, "bin"));
  mkdirSync(join(home, "run"), { mode: 0o700 });
  fake("tmux", "exit 0");
  // Run from a clone rather than a worktree, as in a builder's thread, Skelcrew rewrites the
  // service's unit and reloads systemd. Nothing else may reach systemd.
  fake("systemctl", 'test "$2" = daemon-reload');
  // git reaches the fake GitHub for every https://github.com/ URL.
  writeFileSync(
    join(home, ".gitconfig"),
    `[url "file://${home}/github/"]\n\tinsteadOf = https://github.com/\n`,
  );
  // As the first run leaves a machine, so plain sc goes straight to the repository.
  mkdirSync(join(home, ".config", "skelcrew"), { recursive: true });
  writeFileSync(join(home, ".config", "skelcrew", "config.yaml"), "harness: claude\n");
  writeFileSync(join(home, ".config", "skelcrew", "claude-token"), "sk-ant-oat01-good\n");
  mkdirSync(join(home, ".config", "systemd", "user"), { recursive: true });
  writeFileSync(join(home, ".config", "systemd", "user", "skelcrew.service"), "");
  forge = fakePlugin(home, "github", ["tracker", "forge"]);
  daemon = createServer((connection) =>
    connection.on("data", (data) => {
      // Plain sc asks what the daemon runs before anything else, which these tests don't follow.
      if (JSON.parse(data.toString()).command === "status") return connection.end("{}\n");
      appendFileSync(join(home, "calls"), "daemon lead\n");
      writeFileSync(join(home, "asked"), data.toString());
      const next = handBack.shift();
      if (next) return connection.end(`${JSON.stringify({ agents: next })}\n`);
      // A real daemon starts a stopped lead here, on the .agents/ approved by now.
      const approvals = join(home, ".config", "skelcrew", "approved-agents.yaml");
      if (existsSync(approvals))
        writeFileSync(join(home, "approved-at-lead"), readFileSync(approvals));
      connection.end(`${daemonReply}\n`);
    }),
  );
  await new Promise<void>((listening) =>
    daemon?.listen(join(home, "run", "skelcrew.sock"), listening),
  );
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

// Returns the remotes Skelcrew asked the forge about.
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

// Returns what Skelcrew ran, with the long tmux line that opens the screen cut to the agent it
// opens on, and without asking tmux's version or giving the agents' server its settings, which
// each opening does. The fake daemon names
// the lead's session app-lead.
const calls = () =>
  existsSync(join(home, "calls"))
    ? readFileSync(join(home, "calls"), "utf8")
        .replace(/tmux -L skelcrew -f \/dev\/null (source-file -|list-panes -a .*)\n/g, "")
        .replace(/tmux -V\n/g, "")
        .replace(/tmux -L skelcrew-screen .* sh skelcrew (\S+) \S+ ;.*/g, "screen on $1")
    : "";
const attached = () => calls().endsWith("daemon lead\nscreen on app-lead\n");

// Returns each repository sc repo ls --json lists, as its name, owner/name and forge.
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

// Plain Skelcrew must stay fast: keeping the clone current is the daemon's work.
test("asks its forge nothing and fetches nothing for a repository Skelcrew has", async () => {
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

const noRemoteLine =
  "This git repository has no remote. To add a remote and push it:\n\n  git remote add origin <url>\n  git push -u origin HEAD\n\nThen run sc again.\n\n";

// With no forge to say you can push to it, Skelcrew can't vouch for what is in it.
test("asks about a repository no forge claims, and does nothing in one with no origin", async () => {
  const checkout = onGitHub("simon/app", "WRITE");
  git(checkout, "remote", "set-url", "origin", "https://gitlab.com/simon/app");
  const elsewhere = await skel([], "", checkout);
  expect(elsewhere.err).toBe("");
  expect(elsewhere.out).toContain("Do you trust simon/app?");
  expect(elsewhere.out).toContain(hint);
  expect(calls()).not.toContain("daemon lead");
  git(checkout, "remote", "remove", "origin");
  expect(await skel([], "", checkout)).toEqual({ out: "", err: noRemoteLine, code: 1 });
  expect(existsSync(clone("simon/app"))).toBe(false);
});

test("outside a repository, says how to bring one in, and attaches to nothing, while Skelcrew has none", async () => {
  const first = await skel([]);
  expect(first.err).toBe("");
  expect(first.out).toBe(`${hint}\n`);
  expect(claimsAsked()).toEqual([]);
  expect(calls()).not.toContain("daemon lead");
  await skel([], "", onGitHub("simon/app", "WRITE"));
  expect((await skel([])).out).toBe(left);
});

test("--from brings in the repository it names, wherever Skelcrew runs", async () => {
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

// Exiting each lead closes every tab, on purpose, so plain sc outside a repository opens none and
// says why.
test("outside a repository and with every tab closed, sc opens nothing and says why", async () => {
  await skel([], "", onGitHub("simon/app", "WRITE"));
  daemonReply = '{"closed":true}';
  writeFileSync(join(home, "calls"), "");
  const outside = await skel([]);
  expect(outside).toEqual({
    out: "",
    err: "No git repository found. Run sc inside a git repository to open it.\n",
    code: 1,
  });
  const loose = join(home, "loose");
  mkdirSync(loose);
  git(loose, "init", "-q");
  expect(await skel([], "", loose)).toEqual({ out: "", err: noRemoteLine, code: 1 });
  expect(calls()).not.toContain("screen on");
});

// Opening another repository there would look as if Skelcrew had ignored where you are.
test("in a repository with no remote, sc opens nothing even with tabs open, and says how to add one", async () => {
  await skel([], "", onGitHub("simon/app", "WRITE"));
  writeFileSync(join(home, "calls"), "");
  const loose = join(home, "loose");
  mkdirSync(loose);
  git(loose, "init", "-q");
  expect(await skel([], "", loose)).toEqual({ out: "", err: noRemoteLine, code: 1 });
  expect(calls()).not.toContain("screen on");
  expect(calls()).not.toContain("daemon lead");
});

// The daemon opens that repository's lead, or the one you opened last when it names none.
test("tells the daemon the repository you attached from, once Skelcrew has it", async () => {
  const asked = () => JSON.parse(readFileSync(join(home, "asked"), "utf8"));
  const app = onGitHub("simon/app", "WRITE");
  await skel([], "", app);
  expect(asked()).toEqual({ command: "lead", from: "simon/app" });
  git(app, "remote", "set-url", "origin", "git@github.com:Simon/App.git");
  await skel([], "", app);
  expect(asked()).toEqual({ command: "lead", from: "simon/app" });
  await skel(["--from", "simon/app"]);
  expect(asked()).toEqual({ command: "lead", from: "simon/app" });
  // Outside a checkout, only a repository whose tab is open.
  await skel([]);
  expect(asked()).toEqual({ command: "lead", tab: true });
  // Not yet in Skelcrew, as you didn't trust it.
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

// Plain sc must start fast, and asking the forge means starting its plugin and calling GitHub.
test("asks the forge about a checkout's old name only once", async () => {
  const app = onGitHub("simon/app", "WRITE");
  claim("simon/old", "WRITE", false, "simon/app");
  git(app, "remote", "set-url", "origin", "git@github.com:simon/old.git");
  await skel([], "", app);
  const before = claimsAsked().length;
  const again = await skel([], "", app);
  expect(again.code).toBe(0);
  expect(claimsAsked().length).toBe(before);
  expect(attached()).toBe(true);
  expect(JSON.parse(readFileSync(join(home, "asked"), "utf8"))).toEqual({
    command: "lead",
    from: "simon/app",
  });
});

test("says how to update a checkout's remote that uses a repository's old name, keeping its form", async () => {
  const app = onGitHub("simon/app", "WRITE");
  claim("simon/old", "WRITE", false, "simon/app");
  git(app, "remote", "set-url", "origin", "git@github.com:simon/old.git");
  const ssh =
    "simon/old moved to simon/app. To update this checkout, run:\n  git remote set-url origin git@github.com:simon/app.git\n";
  // Said every time the old name is used, and never in the way of the screen.
  for (let run = 0; run < 2; run++) {
    expect((await skel([], "", app)).out).toContain(ssh);
    expect(attached()).toBe(true);
  }
  git(app, "remote", "set-url", "origin", "https://github.com/simon/old");
  expect((await skel([], "", app)).out).toContain(
    "  git remote set-url origin https://github.com/simon/app\n",
  );
  git(app, "remote", "set-url", "origin", "https://github.com/simon/app");
  expect((await skel([], "", app)).out).not.toContain("moved to");
});

test("repo ls says how to bring a repository in while there is none", async () => {
  expect((await skel(["repo", "ls"])).out).toBe(`${hint}\n`);
});

test("repo rm removes Skelcrew's clone and forgets the trust", async () => {
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

test("repo rm refuses while the repository has live threads or queued tasks, and names them", async () => {
  await skel([], "y\n", onGitHub("simon/app"));
  const db = new Database(join(home, ".local", "share", "skelcrew", "skelcrew.db"));
  db.run(`${threadSql({ task: "12" })}
${threadSql({ task: "15", status: "waiting" })}
${threadSql({ task: "16", status: "queued" })}
${threadSql({ task: "9", status: "done" })}`);
  const refused = await skel(["repo", "rm", "app"]);
  expect(refused.code).toBe(1);
  expect(refused.err).toBe(
    "Skelcrew: app has live threads: APP-12, APP-15, APP-16. Stop them first.\n",
  );
  expect(existsSync(clone("simon/app"))).toBe(true);
  db.run("UPDATE threads SET status = 'done' WHERE task = 12");
  db.run("UPDATE threads SET status = 'failed' WHERE task = 15");
  db.run("UPDATE threads SET status = 'done' WHERE task = 16");
  db.close();
  const removed = await skel(["repo", "rm", "app"]);
  expect(removed.err).toBe("");
  expect(existsSync(clone("simon/app"))).toBe(false);
});

test("repo rm refuses inside Skelcrew's sandbox, where Skelcrew's database is hidden", async () => {
  await skel([], "", onGitHub("simon/app", "WRITE"));
  const run = await skel(["repo", "rm", "app"], "", home, { SKELCREW_SANDBOX: "1" });
  expect(run.code).toBe(1);
  expect(run.err).toBe(
    "Skelcrew: removing a repository is only for your own terminal, not for agents\n",
  );
  expect(existsSync(clone("simon/app"))).toBe(true);
});

test("plain sc refuses inside Skelcrew's sandbox, and brings in nothing", async () => {
  const checkout = onGitHub("simon/app", "WRITE");
  const run = await skel([], "", checkout, { SKELCREW_SANDBOX: "1" });
  expect(run.code).toBe(1);
  expect(run.err).toBe(
    "Skelcrew: attaching to the lead is only for your own terminal, not for agents\n",
  );
  expect(calls()).toBe("");
  expect(existsSync(clone("simon/app"))).toBe(false);
});

// The list and the screen exist side by side until the human picks one. The list runs in sc
// itself and prints once, alone, when there is no terminal. The list's own tests check the rest.
test("sc --list shows the list in place of the screen, here or for --from", async () => {
  const checkout = onGitHub("simon/app", "WRITE");
  await skel([], "", checkout);
  for (const args of [["--list"], ["--list", "--from", "simon/app"]]) {
    writeFileSync(join(home, "calls"), "");
    const run = await skel(args, "", checkout);
    expect(run.err).toBe("");
    expect(run.code).toBe(0);
    expect(run.out).toStartWith(" Skelcrew ");
    expect(calls()).toEndWith("daemon lead\n");
    expect(calls()).not.toContain("screen on");
  }
});

test("sc --list refuses inside Skelcrew's sandbox", async () => {
  const run = await skel(["--list"], "", onGitHub("simon/app", "WRITE"), { SKELCREW_SANDBOX: "1" });
  expect(run.code).toBe(1);
  expect(run.err).toBe(
    "Skelcrew: showing the list is only for your own terminal, not for agents\n",
  );
  expect(calls()).toBe("");
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

// A builder's title on its plugin's host starts with its task's name, which gains its owner once
// another repository shares its name, and loses it once none does. The host keeps the title
// while the builder runs, so adding and removing a repository rename it.
test("adding or removing a repository renames the running builders whose names it changes", async () => {
  await skel([], "", onGitHub("simon/app", "WRITE"));
  // A builder of simon/app's runs on a fake plugin host, under the title it started with.
  const plugin = join(home, "plugin-fake");
  mkdirSync(plugin, { recursive: true });
  writeFileSync(
    join(plugin, "skelcrew-plugin.yaml"),
    `name: fake
version: 0.1.0
skelcrew: 0.1.0
about: A session host for tests
kind: runtime
provides: [sessions]
session: [bun, ${JSON.stringify(join(import.meta.dir, "fake-host.ts"))}]
attach: ["true"]
`,
  );
  const session = join(home, ".config", "skelcrew", "plugins", "fake", "sessions", "fake-app-12");
  mkdirSync(session, { recursive: true });
  writeFileSync(join(session, "labels.json"), JSON.stringify({ title: "APP-12 Add export" }));
  const db = new Database(join(home, ".local", "share", "skelcrew", "skelcrew.db"));
  db.run("INSERT INTO plugins (name, folder) VALUES ('fake', ?)", [plugin]);
  db.run(threadSql({ task: "12", title: "Add export", host: "fake", host_id: "fake-app-12" }));
  db.close();
  const title = () => JSON.parse(readFileSync(join(session, "labels.json"), "utf8")).title;
  await skel([], "", onGitHub("other/app", "WRITE"));
  expect(title()).toBe("SIMON/APP-12 Add export");
  expect((await skel(["repo", "rm", "other/app"])).err).toBe("");
  expect(title()).toBe("APP-12 Add export");
});

// Names are typed in any case, so App and app would name both.
test("names two repositories whose names differ only in case with their owners", async () => {
  await skel([], "", onGitHub("simon/app", "WRITE"));
  await skel([], "", onGitHub("other/App", "WRITE"));
  expect(await listed()).toEqual([
    ["other/App", "other/App", "github"],
    ["simon/app", "simon/app", "github"],
  ]);
});

test("repo ls lists each repository with its tracker and forge, as text and for tools", async () => {
  expect(JSON.parse((await skel(["repo", "ls", "--json"])).out)).toEqual([]);
  await skel([], "", onGitHub("simon/app", "WRITE"));
  // With no skelcrew.yaml, its forge is its tracker too, as GitHub can be one.
  expect((await skel(["repo", "ls"])).out).toBe(
    `NAME  REPOSITORY  TRACKER  FORGE   CLONE\napp   simon/app   github   github  ${clone("simon/app")}\n`,
  );
  // A bare tracker: is YAML's null, which reads as no line at all, so the forge stays its tracker.
  writeFileSync(join(clone("simon/app"), "skelcrew.yaml"), "tracker:\n");
  expect(JSON.parse((await skel(["repo", "ls", "--json"])).out)).toMatchObject([
    { tracker: "github", forge: "github", missing: null },
  ]);
  // tracker: none keeps it on git alone, with nothing missing.
  writeFileSync(join(clone("simon/app"), "skelcrew.yaml"), "tracker: none\n");
  expect(JSON.parse((await skel(["repo", "ls", "--json"])).out)).toMatchObject([
    { tracker: null, forge: "github", missing: null },
  ]);
  // Its skelcrew.yaml names a tracker that isn't installed, so it has none.
  writeFileSync(join(clone("simon/app"), "skelcrew.yaml"), "tracker: linear\n");
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
      tabClosed: false,
      agentsWaiting: false,
      installWaiting: false,
    },
  ]);
  writeFileSync(join(clone("simon/app"), "skelcrew.yaml"), "tracker: github\n");
  expect((await skel(["repo", "ls"])).out).toBe(
    `NAME  REPOSITORY  TRACKER  FORGE   CLONE\napp   simon/app   github   github  ${clone("simon/app")}\n`,
  );
  writeFileSync(join(clone("simon/app"), "skelcrew.yaml"), "tracker: linear\n");
  expect((await skel(["repo", "ls"])).out).toContain("linear, not installed");
});

// The engine can't install a plugin, as only a yes at your terminal can, so the row says to.
test("repo ls says to run sc install while a repository's files name a plugin this machine lacks", async () => {
  await skel([], "", onGitHub("simon/app", "WRITE"));
  const waiting = async () =>
    JSON.parse((await skel(["repo", "ls", "--json"])).out)[0].installWaiting;
  expect(await waiting()).toBe(false);
  writeFileSync(join(clone("simon/app"), "skelcrew.yaml"), "plugins: [simon/skelcrew-fake]\n");
  writeFileSync(
    join(clone("simon/app"), "skelcrew.lock"),
    `simon/skelcrew-fake: { name: fake, version: 0.1.0, commit: ${"a".repeat(40)} }\n`,
  );
  expect(await waiting()).toBe(true);
  expect((await skel(["repo", "ls"])).out).toContain("run sc install");
  // Installed at its pin, it is all the repository needs.
  const db = new Database(join(home, ".local", "share", "skelcrew", "skelcrew.db"));
  const plugin = join(home, "fake-plugin");
  mkdirSync(plugin);
  writeFileSync(
    join(plugin, "skelcrew-plugin.yaml"),
    'name: fake\nversion: 0.1.0\nskelcrew: 0.1.0\nabout: Fake\nkind: io\nprovides: [tracker]\ncall: ["true"]\n',
  );
  git(plugin, "init", "-q", "-b", "main");
  git(plugin, "add", ".");
  git(plugin, "commit", "-q", "-m", "0.1.0");
  const commit = git(plugin, "rev-parse", "HEAD").trim();
  writeFileSync(
    join(clone("simon/app"), "skelcrew.lock"),
    `simon/skelcrew-fake: { name: fake, version: 0.1.0, commit: ${commit} }\n`,
  );
  db.run("INSERT INTO plugins (name, folder, source) VALUES ('fake', ?, 'simon/skelcrew-fake')", [
    plugin,
  ]);
  expect(await waiting()).toBe(false);
  // A runtime plugin, or one by another name than the lock gives, is refused by sc install, so
  // it still needs you.
  writeFileSync(
    join(plugin, "skelcrew-plugin.yaml"),
    'name: fake\nversion: 0.1.0\nskelcrew: 0.1.0\nabout: Fake\nkind: runtime\nprovides: [sessions]\nsession: ["true"]\nattach: ["true"]\n',
  );
  git(plugin, "commit", "-q", "-am", "runtime");
  const runtime = git(plugin, "rev-parse", "HEAD").trim();
  writeFileSync(
    join(clone("simon/app"), "skelcrew.lock"),
    `simon/skelcrew-fake: { name: fake, version: 0.1.0, commit: ${runtime} }\n`,
  );
  expect(await waiting()).toBe(true);
  // Back at the I/O commit, a lock that names another plugin isn't met either.
  git(plugin, "checkout", "-q", commit);
  writeFileSync(
    join(clone("simon/app"), "skelcrew.lock"),
    `simon/skelcrew-fake: { name: other, version: 0.1.0, commit: ${commit} }\n`,
  );
  expect(await waiting()).toBe(true);
  db.close();
  // Files that can't be read need you too, and sc install says what is wrong with them.
  writeFileSync(join(clone("simon/app"), "skelcrew.yaml"), "plugins: [./plugin]\n");
  expect(await waiting()).toBe(true);
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

test("repo trust refuses inside Skelcrew's sandbox, where a yes could come from an agent", async () => {
  onGitHub("other/tool");
  const run = await skel(["repo", "trust", "other/tool"], "", home, { SKELCREW_SANDBOX: "1" });
  expect(run.code).toBe(1);
  expect(run.err).toContain("your own terminal");
  expect(existsSync(clone("other/tool"))).toBe(false);
  expect(existsSync(trustFile())).toBe(false);
});

test("repo trust asks for owner/repo for a repository Skelcrew doesn't know yet", async () => {
  const run = await skel(["repo", "trust", "tool"]);
  expect(run.code).toBe(1);
  expect(run.err).toContain("owner/repo");
});

test("repo add adds the checkout you are in, and attaches to nothing", async () => {
  const checkout = onGitHub("simon/app", "WRITE");
  const run = await skel(["repo", "add"], "", checkout);
  expect(run.err).toBe("");
  expect(run.code).toBe(0);
  expect(run.out).toBe("Adding simon/app to Skelcrew...\nAdded simon/app, as app.\n");
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

test("repo add says so for a repository Skelcrew has, and fetches nothing", async () => {
  const checkout = onGitHub("simon/app", "WRITE");
  await skel(["repo", "add"], "", checkout);
  writeFileSync(join(home, "calls"), "");
  const again = await skel(["repo", "add", "simon/app"]);
  expect(again.err).toBe("");
  expect(again.out).toBe("Skelcrew has simon/app already, as app.\n");
  expect(calls()).toBe("");
});

// Exiting a repository's lead closes its tab. The repository stays, and adding it opens the tab.
test("repo ls notes a closed tab, and repo add opens it again", async () => {
  const checkout = onGitHub("simon/app", "WRITE");
  await skel(["repo", "add"], "", checkout);
  const closeTab = (closed: number) => {
    const db = new Database(join(home, ".local", "share", "skelcrew", "skelcrew.db"));
    db.run("UPDATE repositories SET tab_closed = ?", [closed]);
    db.close();
  };
  closeTab(1);
  expect((await skel(["repo", "ls"])).out).toBe(
    `NAME  REPOSITORY  TRACKER  FORGE   CLONE\napp   simon/app   github   github  ${clone("simon/app")}  tab closed\n`,
  );
  expect(JSON.parse((await skel(["repo", "ls", "--json"])).out)).toMatchObject([
    { name: "app", tabClosed: true },
  ]);
  writeFileSync(join(home, "calls"), "");
  const again = await skel(["repo", "add", "simon/app"]);
  expect(again.out).toBe("Skelcrew has simon/app already, as app. Its tab is open again.\n");
  // The daemon starts its lead again, with no screen open.
  expect(calls()).toBe("daemon lead\n");
  expect(JSON.parse(readFileSync(join(home, "asked"), "utf8"))).toEqual({
    command: "lead",
    from: "simon/app",
  });
  // With no daemon running, the tab opens all the same, and the daemon's start brings the lead.
  daemon?.close();
  const alone = await skel(["repo", "add", "simon/app"]);
  expect(alone.out).toBe("Skelcrew has simon/app already, as app. Its tab is open again.\n");
  expect(JSON.parse((await skel(["repo", "ls", "--json"])).out)).toMatchObject([
    { name: "app", tabClosed: false },
  ]);
  // A tab that is open needs no word about it.
  expect((await skel(["repo", "add", "simon/app"])).out).toBe(
    "Skelcrew has simon/app already, as app.\n",
  );
});

test("repo add says why outside a checkout with a remote, and for a name no forge knows", async () => {
  const outside = await skel(["repo", "add"]);
  expect(outside.code).toBe(1);
  expect(outside.err).toBe(
    `Skelcrew: ${home} isn't a checkout with a remote. Run sc repo add in one, or give the repository's URL.\n`,
  );
  const unknown = await skel(["repo", "add", "nobody/none"]);
  expect(unknown.code).toBe(1);
  expect(unknown.err).toContain("no forge installed knows nobody/none");
});

// A repository with no forge takes Skelcrew's pushes on your own git login, which the daemon must
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

  // A repository just created has no commit for the push check to push, nor a default branch.
  test("an empty one is added too, once git can push to it", async () => {
    const work = elsewhere();
    const bare = join(home, "elsewhere", "simon", "notes.git");
    rmSync(bare, { recursive: true, force: true });
    git(home, "init", "-q", "--bare", "-b", "main", bare);
    const run = await skel(["repo", "add"], "y\n", work);
    expect(run.err).toBe("");
    expect(run.out).toContain("Added simon/notes, as notes.");
    expect(await listed()).toEqual([["notes", "simon/notes", "none"]]);
    // The check's stand-in commit went nowhere.
    expect(git(bare, "for-each-ref").trim()).toBe("");
  });

  test("isn't added when git refuses to push, and Skelcrew says what to fix", async () => {
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
    // Every lead reads the folder of clones, so one Skelcrew didn't add is gone from it.
    expect(existsSync(clone("simon/notes"))).toBe(false);
  });

  // Two servers can each hold a simon/notes. Taking the second as the one Skelcrew has would
  // put its code in the first's clone, where leads and builders read it.
  test("one on another server with the same owner/name is refused, and the clone stays", async () => {
    await skel(["repo", "add"], "y\n", elsewhere());
    const other = join(home, "other");
    const work = join(home, "code", "other-notes");
    mkdirSync(work, { recursive: true });
    writeFileSync(join(work, "README"), "other notes\n");
    git(work, "init", "-q", "-b", "main");
    git(work, "add", ".");
    git(work, "commit", "-q", "-m", "start");
    git(home, "clone", "-q", "--bare", work, join(other, "simon", "notes.git"));
    appendFileSync(
      join(home, ".gitconfig"),
      `[url "file://${other}/"]\n\tinsteadOf = https://other.example/\n`,
    );
    const run = await skel(["repo", "add", "https://other.example/simon/notes.git"], "y\n");
    expect(run.code).toBe(1);
    expect(run.err).toContain("Skelcrew has simon/notes already, from file://");
    expect(readFileSync(join(clone("simon/notes"), "README"), "utf8")).toBe("notes\n");
    expect(await listed()).toEqual([["notes", "simon/notes", "none"]]);
  });
});

test("repo add and init refuse inside Skelcrew's sandbox, where a yes could come from an agent", async () => {
  const checkout = onGitHub("simon/app", "WRITE");
  for (const [args, what] of [
    [["repo", "add"], "adding a repository"],
    [["init"], "setting up a repository for Skelcrew"],
  ] as const) {
    const run = await skel([...args], "", checkout, { SKELCREW_SANDBOX: "1" });
    expect(run.code).toBe(1);
    expect(run.err).toBe(`Skelcrew: ${what} is only for your own terminal, not for agents\n`);
  }
  expect(existsSync(join(checkout, "skelcrew.yaml"))).toBe(false);
  expect(existsSync(clone("simon/app"))).toBe(false);
});

// The files sc init writes are the built-in defaults, with your harness and model in each role,
// so the repository works the same for a teammate. Setup and test are only examples, as
// Skelcrew never guesses them.
test("init writes skelcrew.yaml and .agents/ from the built-in defaults, approves them, and adds the repository", async () => {
  writeFileSync(
    join(home, ".config", "skelcrew", "config.yaml"),
    "harness: claude\nmodel: sonnet\nlead: { model: opus }\nreviewer: { harness: codex }\n",
  );
  const checkout = onGitHub("simon/app", "WRITE");
  mkdirSync(join(checkout, "src"));
  // It names no tracker, so the repository keeps its forge as its tracker, and asks nothing.
  const commit = githubInstalledAsYours();
  const run = await skel(["init"], "", join(checkout, "src"));
  expect(run.err).toBe("");
  expect(run.code).toBe(0);
  expect(run.out).not.toContain("tracker");
  expect(run.out).not.toContain("Approve");
  // The GitHub plugin installed as yours is pinned at its version, with nothing to install.
  expect(run.out).not.toContain("Install it?");
  expect(readFileSync(join(checkout, "skelcrew.yaml"), "utf8")).toBe(
    `# Shared with everyone who works on this repository. Never put a secret here.
# setup: [bun install]
# test: [bun test]
# Keeps this repository on git alone, with no tracker.
# tracker: none
# At most this many builders at once in this repository.
# limits: { threads: 4 }
plugins:
  - skelcrew/skelcrew-github
`,
  );
  expect(parse(readFileSync(join(checkout, "skelcrew.lock"), "utf8"))).toEqual({
    "skelcrew/skelcrew-github": { name: "github", version: "0.1.0", commit },
  });
  const role = (name: "lead" | "builder" | "reviewer") =>
    readFileSync(join(checkout, ".agents", "roles", `${name}.md`), "utf8");
  expect(role("lead")).toBe(
    `---\nharness: claude\nmodel: opus\n---\n${builtInRole("lead").instructions}`,
  );
  expect(role("builder")).toBe(
    `---\nharness: claude\nmodel: sonnet\n---\n${builtInRole("builder").instructions}`,
  );
  expect(role("reviewer")).toBe(
    `---\nharness: codex\n---\n${builtInRole("reviewer").instructions}`,
  );
  expect(readFileSync(join(checkout, ".agents", "flows", "default.yaml"), "utf8")).toBe(
    builtInFlowText,
  );
  // Nothing is staged in the checkout, and what is approved is the tree the push will bring.
  expect(git(checkout, "status", "--porcelain")).toBe(
    "?? .agents/\n?? skelcrew.lock\n?? skelcrew.yaml\n",
  );
  git(checkout, "add", "-A");
  git(checkout, "commit", "-q", "-m", "init");
  const approved = parse(
    readFileSync(join(home, ".config", "skelcrew", "approved-agents.yaml"), "utf8"),
  );
  expect(approved).toEqual({ "simon/app": git(checkout, "rev-parse", "HEAD:.agents").trim() });
  expect(existsSync(join(clone("simon/app"), "README"))).toBe(true);
  // Without a terminal to say yes at, it shows the commands that bring the files to the default
  // branch, one per line.
  expect(run.out).toBe(
    [
      "Adding simon/app to Skelcrew...",
      "",
      "Wrote skelcrew.yaml, skelcrew.lock and .agents/.",
      "Skelcrew reads these files from main, so commit and push them there:",
      "",
      "  git add skelcrew.yaml skelcrew.lock .agents",
      "",
      '  git commit -m "Set up Skelcrew" -- skelcrew.yaml skelcrew.lock .agents',
      "",
      "  git push origin main",
      "",
      "Then run sc.",
      "",
    ].join("\n"),
  );
});

// The forge's plugin isn't on this machine yet, so sc init installs it as sc add does: it shows
// what the plugin runs and asks first.
test("init installs the forge's plugin after asking, and pins it", async () => {
  const checkout = onGitHub("simon/app", "WRITE");
  const commit = publishGitHubPlugin();
  const run = await inTerminal([process.execPath, main, "init"], {
    typed: "y\n",
    env: {
      PATH: `${join(home, "bin")}:${process.env.PATH ?? ""}`,
      HOME: home,
      XDG_RUNTIME_DIR: join(home, "run"),
    },
    cwd: checkout,
  });
  expect(run.err).toBe("");
  expect(run.code).toBe(0);
  // It says why Skelcrew needs the plugin, and asks once.
  expect(run.out).toStartWith(
    "This is a GitHub repository (simon/app). Skelcrew needs its GitHub plugin to read issues, open pull requests and merge them.\n\nGitHub plugin 0.1.0, from skelcrew/skelcrew-github. Runs on this machine as you, outside the agents' sandbox. Type d for details.\nInstall the GitHub plugin? [Y/n] Installed the GitHub plugin.\nAdding simon/app to Skelcrew...\n",
  );
  expect(parse(readFileSync(join(checkout, "skelcrew.yaml"), "utf8")).plugins).toEqual([
    "skelcrew/skelcrew-github",
  ]);
  expect(parse(readFileSync(join(checkout, "skelcrew.lock"), "utf8"))).toEqual({
    "skelcrew/skelcrew-github": { name: "github", version: "0.1.0", commit },
  });
  // The plugin is the repository's, never yours.
  expect(existsSync(join(home, ".config", "skelcrew", "skelcrew.lock"))).toBe(false);
  expect(await listed()).toEqual([["app", "simon/app", "github"]]);
});

// A skelcrew.yaml from sc init has setup: and test: only as comments, so the lead is told
// neither is configured, and proposes them before its first thread.
test("the lead is told setup and test aren't configured when sc init left them as comments", async () => {
  const checkout = onGitHub("simon/app", "WRITE");
  githubInstalledAsYours();
  expect((await skel(["init"], "", checkout)).err).toBe("");
  git(checkout, "add", "-A");
  git(checkout, "commit", "-q", "-m", "init");
  git(checkout, "push", "-q", join(home, "github", "simon/app.git"), "main");
  git(clone("simon/app"), "pull", "-q", join(home, "github", "simon/app.git"), "main");
  expect(existsSync(join(clone("simon/app"), "skelcrew.yaml"))).toBe(true);
  const code = `import { repositoryCommands } from ${JSON.stringify(source("config.ts"))};
import { leadInstructions } from ${JSON.stringify(source("flow/lead.ts"))};
const commands = repositoryCommands({ owner: "simon", repo: "app" });
console.log(leadInstructions("You lead.\\n", "simon/app", "/c", commands, false));`;
  const told = Bun.spawnSync([process.execPath, "-e", code], {
    env: { PATH: process.env.PATH ?? "", HOME: home },
    stdout: "pipe",
    stderr: "pipe",
  });
  expect(told.stderr.toString()).toBe("");
  expect(told.stdout.toString()).toContain(
    "When this session started, no setup command was configured, and no test command was configured.",
  );
});

// YAML reads true, null or 123 as something other than text, which a model name must be.
test("init writes model names that read back as the same text", async () => {
  writeFileSync(
    join(home, ".config", "skelcrew", "config.yaml"),
    'harness: claude\nmodel: "123"\nlead: { model: "true" }\nbuilder: { model: "null" }\n',
  );
  const checkout = onGitHub("simon/app", "WRITE");
  expect((await skel(["init"], "", checkout)).err).toBe("");
  const model = (name: string) =>
    parse(
      readFileSync(join(checkout, ".agents", "roles", `${name}.md`), "utf8").split("---\n")[1] ??
        "",
    ).model;
  expect([model("lead"), model("builder"), model("reviewer")]).toEqual(["true", "null", "123"]);
});

// Every repository gets its forge's plugin, so one whose skelcrew.yaml names no plugin gains it.
test("init keeps a skelcrew.yaml that is there, adding only the forge's plugin, and adds the repository", async () => {
  const checkout = onGitHub("simon/app", "WRITE");
  githubInstalledAsYours();
  const file = join(checkout, "skelcrew.yaml");
  writeFileSync(file, "# How to build it.\nsetup: [make]\n");
  const run = await skel(["init"], "", checkout);
  expect(run.err).toBe("");
  expect(run.code).toBe(0);
  expect(readFileSync(file, "utf8")).toBe(
    "# How to build it.\nsetup: [make]\nplugins:\n  - skelcrew/skelcrew-github\n",
  );
  expect(run.out).toContain(
    "skelcrew.yaml is there already, so Skelcrew only added skelcrew/skelcrew-github to its plugins.",
  );
  expect(run.out).toContain("Wrote skelcrew.yaml, skelcrew.lock and .agents/.\n");
  expect(await listed()).toEqual([["app", "simon/app", "github"]]);
});

// sc add would move a pin to the version installed here, so a pin the repository has already
// stays as it is, and only skelcrew.yaml gains the plugin's name.
test("init keeps the pin a skelcrew.lock that is there has for the forge's plugin", async () => {
  const checkout = onGitHub("simon/app", "WRITE");
  githubInstalledAsYours();
  writeFileSync(join(checkout, "skelcrew.yaml"), "setup: [make]\n");
  const lock = `# Ours.\nskelcrew/skelcrew-github: { name: github, version: 0.0.9, commit: ${"a".repeat(40)} }\n`;
  writeFileSync(join(checkout, "skelcrew.lock"), lock);
  mkdirSync(join(checkout, ".agents"));
  const run = await skel(["init"], "", checkout);
  expect(run.err).toBe("");
  expect(readFileSync(join(checkout, "skelcrew.lock"), "utf8")).toBe(lock);
  expect(readFileSync(join(checkout, "skelcrew.yaml"), "utf8")).toBe(
    "setup: [make]\nplugins:\n  - skelcrew/skelcrew-github\n",
  );
  expect(run.out).toContain("Wrote skelcrew.yaml.\n");
});

// A pin the repository has already must still bring its plugin, or the repository would come in
// without its forge.
test("init installs the forge's plugin at the pin a skelcrew.lock that is there has, after asking", async () => {
  const checkout = onGitHub("simon/app", "WRITE");
  const commit = publishGitHubPlugin();
  const lock = `skelcrew/skelcrew-github: {name: github, version: 0.1.0, commit: ${commit}}\n`;
  writeFileSync(join(checkout, "skelcrew.lock"), lock);
  const run = await inTerminal([process.execPath, main, "init"], {
    typed: "y\n",
    env: {
      PATH: `${join(home, "bin")}:${process.env.PATH ?? ""}`,
      HOME: home,
      XDG_RUNTIME_DIR: join(home, "run"),
    },
    cwd: checkout,
  });
  expect(run.err).toBe("");
  expect(run.code).toBe(0);
  expect(run.out).toContain("Install the github plugin? [Y/n]");
  expect(run.out).toContain("Installed github 0.1.0.");
  expect(readFileSync(join(checkout, "skelcrew.lock"), "utf8")).toBe(lock);
  expect(parse(readFileSync(join(checkout, "skelcrew.yaml"), "utf8")).plugins).toEqual([
    "skelcrew/skelcrew-github",
  ]);
  // The forge it installed claimed the remote, so the repository came in with no question.
  expect(run.out).not.toContain("Do you trust");
  expect(await listed()).toEqual([["app", "simon/app", "github"]]);
});

// A skelcrew.lock that pins other plugins keeps them, and gains the forge's pin beside them.
test("init adds the forge's pin to a skelcrew.lock that is there, keeping its other pins", async () => {
  const checkout = onGitHub("simon/app", "WRITE");
  const commit = githubInstalledAsYours();
  // Written as people write it, with spaces, which a rewrite of the whole file would drop.
  const other = `simon/skelcrew-other: { name: other, version: 1.0.0, commit: ${"b".repeat(40)} }\n`;
  writeFileSync(join(checkout, "skelcrew.lock"), `# Ours.\n${other}`);
  expect((await skel(["init"], "", checkout)).err).toBe("");
  const lock = readFileSync(join(checkout, "skelcrew.lock"), "utf8");
  expect(lock).toStartWith(`# Ours.\n${other}`);
  expect(parse(lock)["skelcrew/skelcrew-github"]).toEqual({
    name: "github",
    version: "0.1.0",
    commit,
  });
});

// Runs sc init in the checkout with a terminal as its input, typing `typed`, with a git identity
// for the commit it offers.
function initAtTerminal(checkout: string, typed: string) {
  appendFileSync(join(home, ".gitconfig"), "[user]\n\tname = t\n\temail = t@t\n");
  return inTerminal([process.execPath, main, "init"], {
    typed,
    env: {
      PATH: `${join(home, "bin")}:${process.env.PATH ?? ""}`,
      HOME: home,
      XDG_RUNTIME_DIR: join(home, "run"),
    },
    cwd: checkout,
  });
}

// What sc init shows when it leaves the commit to you, after the reason it gives.
const commands =
  '\n  git add skelcrew.yaml skelcrew.lock .agents\n\n  git commit -m "Set up Skelcrew" -- skelcrew.yaml skelcrew.lock .agents\n\n  git push origin main\n\nThen run sc.\n';

// The lead and builders read the repository as its default branch has it, so sc init offers to
// commit what it wrote and push it there, then opens the lead as plain sc does.
test("init on a yes commits only the files it wrote, pushes them to the default branch, and opens the lead", async () => {
  const checkout = onGitHub("simon/app", "WRITE");
  githubInstalledAsYours();
  writeFileSync(join(checkout, "notes.txt"), "mine\n");
  const run = await initAtTerminal(checkout, "y\n");
  expect(run.err).toBe("");
  expect(run.code).toBe(0);
  expect(run.out).toContain(
    "Wrote skelcrew.yaml, skelcrew.lock and .agents/.\nCommit and push these files to main now? [Y/n] Pushed them to main.\n",
  );
  expect(run.out).toEndWith(left);
  expect(calls()).toContain("daemon lead\n");
  // Your other work stays as it was, out of the commit.
  expect(git(checkout, "status", "--porcelain")).toBe("?? notes.txt\n");
  expect(git(checkout, "log", "-1", "--format=%s")).toBe("Set up Skelcrew\n");
  const bare = join(home, "github", "simon", "app.git");
  expect(git(bare, "ls-tree", "--name-only", "main").split("\n")).toEqual([
    ".agents",
    "README",
    "skelcrew.lock",
    "skelcrew.yaml",
    "",
  ]);
  // Skelcrew's clone has them already, so the lead opens on them.
  expect(existsSync(join(clone("simon/app"), "skelcrew.yaml"))).toBe(true);
});

test("init after a no commits nothing, shows the commands, and opens no lead", async () => {
  const checkout = onGitHub("simon/app", "WRITE");
  githubInstalledAsYours();
  const run = await initAtTerminal(checkout, "n\n");
  expect(run.code).toBe(0);
  expect(run.out).toEndWith(
    `Commit and push these files to main now? [Y/n] Skelcrew reads these files from main, so commit and push them there:\n${commands}`,
  );
  expect(git(checkout, "log", "-1", "--format=%s")).toBe("start\n");
  expect(calls()).not.toContain("daemon lead");
});

// With other work staged, sc init asks nothing and leaves the commit to you. The commit it shows
// names its files, so following it keeps the staged work out.
test("init with other changes staged asks nothing and leaves the commit to you", async () => {
  const checkout = onGitHub("simon/app", "WRITE");
  githubInstalledAsYours();
  writeFileSync(join(checkout, "notes.txt"), "mine\n");
  git(checkout, "add", "notes.txt");
  const run = await initAtTerminal(checkout, "y\n");
  expect(run.code).toBe(0);
  expect(run.out).not.toContain("now? [Y/n]");
  expect(run.out).toEndWith(
    `Other changes are staged here, so Skelcrew leaves the commit to you. The commit below names its files, so they stay out of it. Skelcrew reads these files from main, so commit and push them there:\n${commands}`,
  );
  expect(git(checkout, "log", "-1", "--format=%s")).toBe("start\n");
  // Run as shown, the commit takes only sc init's files.
  git(checkout, "add", "skelcrew.yaml", "skelcrew.lock", ".agents");
  git(
    checkout,
    "commit",
    "-q",
    "-m",
    "Set up Skelcrew",
    "--",
    "skelcrew.yaml",
    "skelcrew.lock",
    ".agents",
  );
  expect(git(checkout, "status", "--porcelain")).toBe("A  notes.txt\n");
});

// A file sc init edits that had your changes already would bring them into its commit, so it
// leaves the commit to you, saying why.
test("init asks nothing when a file it edits had changes of yours", async () => {
  const checkout = onGitHub("simon/app", "WRITE");
  githubInstalledAsYours();
  writeFileSync(join(checkout, "skelcrew.yaml"), "setup: [make]\n");
  git(checkout, "add", "skelcrew.yaml");
  git(checkout, "commit", "-q", "-m", "config");
  writeFileSync(join(checkout, "skelcrew.yaml"), "# Mine, not yet committed.\nsetup: [make]\n");
  const run = await initAtTerminal(checkout, "y\n");
  expect(run.code).toBe(0);
  expect(run.out).not.toContain("now? [Y/n]");
  expect(run.out).toContain(
    "skelcrew.yaml had changes of yours already, which the commit would take too, so Skelcrew leaves it to you.",
  );
  expect(git(checkout, "log", "-1", "--format=%s")).toBe("config\n");
});

// A push from another branch wouldn't reach the default branch, and switching there can fail
// where it tracks a file sc init wrote here. So the commands commit and push this branch, and
// say to merge it into the default branch.
test("init on another branch asks nothing, and its commands push that branch to merge", async () => {
  const checkout = onGitHub("simon/app", "WRITE");
  githubInstalledAsYours();
  git(checkout, "switch", "-q", "-c", "setup");
  const run = await initAtTerminal(checkout, "y\n");
  expect(run.code).toBe(0);
  expect(run.out).not.toContain("now? [Y/n]");
  expect(run.out).toEndWith(
    'You are on setup, and Skelcrew reads these files from main. Once they are there, the lead uses them. To commit and push them:\n\n  git add skelcrew.yaml skelcrew.lock .agents\n\n  git commit -m "Set up Skelcrew" -- skelcrew.yaml skelcrew.lock .agents\n\n  git push origin setup\n\nThen merge setup into main, such as with a pull request, and run sc.\n',
  );
  // Followed as shown, the commands need no switch, which could fail where main tracks one of
  // the files. The push goes straight to the fake GitHub's folder, as the test's git has no
  // setting that leads github.com there.
  const bare = join(home, "github", "simon", "app.git");
  for (const step of [
    ["add", "skelcrew.yaml", "skelcrew.lock", ".agents"],
    ["commit", "-q", "-m", "Set up Skelcrew", "--", "skelcrew.yaml", "skelcrew.lock", ".agents"],
    ["push", "-q", bare, "setup"],
  ])
    git(checkout, ...step);
  expect(git(bare, "ls-tree", "--name-only", "setup")).toContain("skelcrew.yaml");
});

// With no branch checked out, the commands make one first, so the commit has a branch to push.
test("init on no branch starts its commands by making one", async () => {
  const checkout = onGitHub("simon/app", "WRITE");
  githubInstalledAsYours();
  git(checkout, "switch", "-q", "--detach");
  const run = await initAtTerminal(checkout, "y\n");
  expect(run.code).toBe(0);
  expect(run.out).toContain(
    "You are on no branch, and Skelcrew reads these files from main. Once they are there, the lead uses them. To commit and push them:\n\n  git switch -c skelcrew-setup\n\n",
  );
  expect(run.out).toContain("  git push origin skelcrew-setup\n");
  expect(run.out).toEndWith(
    "Then merge skelcrew-setup into main, such as with a pull request, and run sc.\n",
  );
});

// The lead only sees pushed files, so a push that fails opens no lead, and says what is left.
test("init whose push fails says why, shows the push that is left, and opens no lead", async () => {
  const checkout = onGitHub("simon/app", "WRITE");
  githubInstalledAsYours();
  const hook = join(home, "github", "simon", "app.git", "hooks", "pre-receive");
  writeFileSync(hook, "#!/bin/sh\necho 'protected branch' >&2\nexit 1\n", { mode: 0o755 });
  const run = await initAtTerminal(checkout, "y\n");
  expect(run.code).toBe(0);
  expect(run.out).toContain("git push failed: ");
  expect(run.out).toContain("protected branch");
  expect(run.out).toEndWith(
    "The lead only sees the files once they are pushed.\n\n  git push origin main\n\nThen run sc.\n",
  );
  expect(git(checkout, "log", "-1", "--format=%s")).toBe("Set up Skelcrew\n");
  expect(calls()).not.toContain("daemon lead");
});

// The human commits the file, so a line init didn't need to change stays byte for byte.
test("init adds the forge's plugin to a skelcrew.yaml without changing its other lines", async () => {
  const checkout = onGitHub("simon/app", "WRITE");
  githubInstalledAsYours();
  const file = join(checkout, "skelcrew.yaml");
  writeFileSync(file, "setup:   [ make, test ]  # ours\ntest: [make]");
  expect((await skel(["init"], "", checkout)).err).toBe("");
  expect(readFileSync(file, "utf8")).toBe(
    "setup:   [ make, test ]  # ours\ntest: [make]\nplugins:\n  - skelcrew/skelcrew-github\n",
  );
  // A line of ... ends the document, so the plugin goes before it.
  writeFileSync(file, "setup: [make]\n... # end\n");
  expect((await skel(["init"], "", checkout)).err).toBe("");
  expect(readFileSync(file, "utf8")).toBe(
    "setup: [make]\nplugins:\n  - skelcrew/skelcrew-github\n... # end\n",
  );
  // A bare plugins: names none, so it gets the plugin in its place, before any comment.
  for (const [bare, filled] of [
    ["plugins:", "plugins: [skelcrew/skelcrew-github]"],
    ["plugins: # later", "plugins: [skelcrew/skelcrew-github] # later"],
  ]) {
    writeFileSync(file, `setup:   [ make ]\n${bare}\ntest: [make]\n`);
    expect((await skel(["init"], "", checkout)).err).toBe("");
    expect(readFileSync(file, "utf8")).toBe(`setup:   [ make ]\n${filled}\ntest: [make]\n`);
  }
  // An empty plugins: [] gets the plugin in its place.
  writeFileSync(file, "setup:   [ make ]\nplugins: [ ]  # none yet\ntest: [make]\n");
  expect((await skel(["init"], "", checkout)).err).toBe("");
  expect(readFileSync(file, "utf8")).toBe(
    "setup:   [ make ]\nplugins: [skelcrew/skelcrew-github]  # none yet\ntest: [make]\n",
  );
});

// Written again, a file written as one map would change on every line, so init leaves it as it
// is and says which line to add by hand. A lock written so is left the same way.
test("init leaves a skelcrew.yaml or skelcrew.lock written as one map as it is", async () => {
  const checkout = onGitHub("simon/app", "WRITE");
  const commit = githubInstalledAsYours();
  const yaml = join(checkout, "skelcrew.yaml");
  const lock = join(checkout, "skelcrew.lock");
  writeFileSync(yaml, "{setup: [ make ], test: [make test]}\n");
  const run = await skel(["init"], "", checkout);
  expect(run.err).toBe("");
  expect(readFileSync(yaml, "utf8")).toBe("{setup: [ make ], test: [make test]}\n");
  expect(existsSync(lock)).toBe(false);
  expect(run.out).toContain(
    "is written as one map, which Skelcrew leaves as it is. Add plugins: [skelcrew/skelcrew-github] to it by hand.",
  );
  writeFileSync(yaml, "setup: [make]\n");
  const other = `{simon/skelcrew-other: { name: other, version: 1.0.0, commit: ${"b".repeat(40)} }}\n`;
  writeFileSync(lock, other);
  const again = await skel(["init"], "", checkout);
  expect(again.err).toBe("");
  expect(readFileSync(yaml, "utf8")).toBe("setup: [make]\n");
  expect(readFileSync(lock, "utf8")).toBe(other);
  expect(again.out).toContain(
    `skelcrew.lock is written as one map, which Skelcrew leaves as it is. Add skelcrew/skelcrew-github: {name: github, version: 0.1.0, commit: ${commit}} to it by hand.`,
  );
});

// A repository that names its plugins chose them, so init leaves its files as they are.
test("init leaves a skelcrew.yaml that names plugins as it is", async () => {
  const checkout = onGitHub("simon/app", "WRITE");
  githubInstalledAsYours();
  const file = join(checkout, "skelcrew.yaml");
  const text = "setup: [make]\ntest: [make test]\nplugins: [simon/skelcrew-other]\n";
  writeFileSync(file, text);
  const run = await skel(["init"], "", checkout);
  expect(run.err).toBe("");
  expect(readFileSync(file, "utf8")).toBe(text);
  expect(existsSync(join(checkout, "skelcrew.lock"))).toBe(false);
  expect(run.out).toContain("skelcrew.yaml is there already, so Skelcrew left it as it is.");
  // Setup and test are filled in already, so the lead has nothing to propose.
  expect(run.out).not.toContain("filled in");
});

// Being able to push isn't having read what a teammate wrote in .agents/, so init writes nothing
// into one that is there and asks before approving it.
test("init leaves an .agents/ that is there as it is, and asks before approving it", async () => {
  const checkout = onGitHub("simon/app", "WRITE");
  mkdirSync(join(checkout, ".agents", "roles"), { recursive: true });
  writeFileSync(join(checkout, ".agents", "roles", "builder.md"), "Ship it fast.\n");
  git(checkout, "add", "-A");
  git(checkout, "commit", "-q", "-m", "agents");
  git(checkout, "push", "-q", join(home, "github", "simon/app.git"), "main");
  const run = await skel(["init"], "n\n", checkout);
  expect(run.err).toBe("");
  expect(run.out).toContain(".agents/ is there already, so Skelcrew left it as it is.");
  expect(run.out).toContain("Ship it fast.");
  expect(run.out).toContain("Approve simon/app's .agents/?");
  expect(run.out).toContain("Tasks in simon/app run on the built-in roles.");
  expect(git(checkout, "status", "--porcelain")).toBe("?? skelcrew.yaml\n");
  expect(readFileSync(join(home, ".config", "skelcrew", "approved-agents.yaml"), "utf8")).toBe(
    "simon/app: none\n",
  );
});

// Pushes an .agents/ with one builder role to the repository's default branch, then takes the
// checkout back to the commit before it, as an older branch would be.
function agentsOnlyOnGitHub(checkout: string): void {
  mkdirSync(join(checkout, ".agents", "roles"), { recursive: true });
  writeFileSync(join(checkout, ".agents", "roles", "builder.md"), "Ship it fast.\n");
  git(checkout, "add", "-A");
  git(checkout, "commit", "-q", "-m", "agents");
  git(checkout, "push", "-q", join(home, "github", "simon/app.git"), "main");
  git(checkout, "reset", "-q", "--hard", "HEAD~1");
}

// Makes the fake forge the GitHub plugin installed as yours from skelcrew/skelcrew-github, at a
// commit of its own, as sc add -g leaves it. Returns that commit.
function githubInstalledAsYours(): string {
  const folder = join(home, "plugin-github");
  git(folder, "init", "-q", "-b", "main");
  git(folder, "add", ".");
  git(folder, "commit", "-q", "-m", "0.1.0");
  const db = new Database(join(home, ".local", "share", "skelcrew", "skelcrew.db"));
  db.run("UPDATE plugins SET source = ? WHERE name = 'github'", ["skelcrew/skelcrew-github"]);
  db.close();
  return git(folder, "rev-parse", "HEAD").trim();
}

// Puts the fake forge on the fake GitHub as skelcrew/skelcrew-github, tagged v0.1.0, and takes it
// off this machine, as before it is installed. Returns the tag's commit.
function publishGitHubPlugin(): string {
  const folder = join(home, "github", "skelcrew", "skelcrew-github");
  mkdirSync(folder, { recursive: true });
  writeFileSync(
    join(folder, "skelcrew-plugin.yaml"),
    readFileSync(join(home, "plugin-github", "skelcrew-plugin.yaml")),
  );
  git(folder, "init", "-q", "-b", "main");
  git(folder, "add", ".");
  git(folder, "commit", "-q", "-m", "0.1.0");
  git(folder, "tag", "v0.1.0");
  const db = new Database(join(home, ".local", "share", "skelcrew", "skelcrew.db"));
  db.run("DELETE FROM plugins WHERE name = 'github'");
  db.close();
  return git(folder, "rev-parse", "HEAD").trim();
}

const approvals = () =>
  parse(readFileSync(join(home, ".config", "skelcrew", "approved-agents.yaml"), "utf8"));

// A no given as the repository comes in stands, though init then writes the built-in files.
test("init on a checkout without .agents/ keeps a no given as the repository came in", async () => {
  const checkout = onGitHub("simon/app", "WRITE");
  agentsOnlyOnGitHub(checkout);
  const run = await skel(["init"], "n\n", checkout);
  expect(run.err).toBe("");
  expect(run.out).toContain("Approve simon/app's .agents/?");
  expect(approvals()).toEqual({ "simon/app": "none" });
  expect(run.out).toContain(
    "Skelcrew kept the .agents/ you approved for simon/app. Once you push the new one, run sc repo trust app to approve it.",
  );
});

// sc init on an old branch must never swap the roles new tasks start on.
test("init on a checkout without .agents/ keeps the version you approved", async () => {
  const checkout = onGitHub("simon/app", "WRITE");
  agentsOnlyOnGitHub(checkout);
  expect((await skel(["repo", "add"], "y\n", checkout)).out).toContain(
    "Approved simon/app's .agents/.",
  );
  const approved = approvals();
  const run = await skel(["init"], "", checkout);
  expect(run.err).toBe("");
  expect(approvals()).toEqual(approved);
  expect(existsSync(join(checkout, ".agents", "roles", "lead.md"))).toBe(true);
});

// The checkout's .agents/ may be on no default branch yet, and a repository Skelcrew has asks
// nothing as it is added again, so init shows the checkout's own and asks.
test("init asks about a checkout's .agents/ that isn't on the default branch, for a repository Skelcrew has", async () => {
  const checkout = onGitHub("simon/app", "WRITE");
  expect((await skel(["repo", "add"], "", checkout)).err).toBe("");
  mkdirSync(join(checkout, ".agents", "roles"), { recursive: true });
  writeFileSync(join(checkout, ".agents", "roles", "builder.md"), "Ship it fast.\n");
  const run = await skel(["init"], "y\n", checkout);
  expect(run.err).toBe("");
  expect(run.out).toContain("Ship it fast.");
  expect(run.out).toContain("Approved simon/app's .agents/.");
  expect(readFileSync(join(checkout, ".agents", "roles", "builder.md"), "utf8")).toBe(
    "Ship it fast.\n",
  );
  git(checkout, "add", "-A");
  git(checkout, "commit", "-q", "-m", "init");
  expect(approvals()).toEqual({ "simon/app": git(checkout, "rev-parse", "HEAD:.agents").trim() });
});

// A tracked file stays in every commit though a .gitignore rule matches it, so it is in the
// version you are asked to approve too.
test("init asks about a checkout's .agents/ with its tracked files that .gitignore matches", async () => {
  const checkout = onGitHub("simon/app", "WRITE");
  expect((await skel(["repo", "add"], "", checkout)).err).toBe("");
  mkdirSync(join(checkout, ".agents", "roles"), { recursive: true });
  writeFileSync(join(checkout, ".agents", "roles", "builder.md"), "Ship it fast.\n");
  writeFileSync(join(checkout, ".agents", "roles", "lead.md"), "Lead calmly.\n");
  writeFileSync(join(checkout, ".gitignore"), "builder.md\n");
  git(checkout, "add", "-f", "-A");
  git(checkout, "commit", "-q", "-m", "agents");
  const run = await skel(["init"], "y\n", checkout);
  expect(run.err).toBe("");
  expect(run.out).toContain("Ship it fast.");
  expect(approvals()).toEqual({ "simon/app": git(checkout, "rev-parse", "HEAD:.agents").trim() });
});

// The files sc init writes are approved as written, though a .gitignore rule matches them: you
// commit them with git add -f.
test("init approves the .agents/ it writes even when git ignores it", async () => {
  const checkout = onGitHub("simon/app", "WRITE");
  writeFileSync(join(checkout, ".gitignore"), ".agents/\n");
  const run = await skel(["init"], "", checkout);
  expect(run.err).toBe("");
  expect(run.code).toBe(0);
  git(checkout, "add", "-f", ".agents");
  git(checkout, "commit", "-q", "-m", "init");
  expect(approvals()).toEqual({ "simon/app": git(checkout, "rev-parse", "HEAD:.agents").trim() });
});

// git commit and git commit -a would take different versions of an edited file, so init asks
// you to settle which before it shows or approves either.
test("init approves nothing while .agents/ has changes that aren't staged", async () => {
  const checkout = onGitHub("simon/app", "WRITE");
  expect((await skel(["repo", "add"], "", checkout)).err).toBe("");
  mkdirSync(join(checkout, ".agents", "roles"), { recursive: true });
  writeFileSync(join(checkout, ".agents", "roles", "builder.md"), "Staged words.\n");
  git(checkout, "add", "-A");
  writeFileSync(join(checkout, ".agents", "roles", "builder.md"), "Unstaged words.\n");
  const run = await skel(["init"], "y\n", checkout);
  expect(run.err).toBe("");
  expect(run.out).toContain(
    ".agents/ has changes you haven't staged, so Skelcrew can't tell which version you'll commit. Stage or drop them, then run sc init again.",
  );
  expect(run.out).not.toContain("Approve");
  expect(existsSync(join(home, ".config", "skelcrew", "approved-agents.yaml"))).toBe(false);
});

// A file staged and then deleted from disk is such a change too, and sc init never approves its
// own files beside it.
test("init approves nothing when the index holds .agents/ files it didn't write", async () => {
  const checkout = onGitHub("simon/app", "WRITE");
  mkdirSync(join(checkout, ".agents", "skills", "old"), { recursive: true });
  writeFileSync(join(checkout, ".agents", "skills", "old", "SKILL.md"), "Old words.\n");
  git(checkout, "add", "-A");
  rmSync(join(checkout, ".agents"), { recursive: true });
  const run = await skel(["init"], "", checkout);
  expect(run.err).toBe("");
  expect(existsSync(join(checkout, ".agents", "roles", "lead.md"))).toBe(true);
  expect(run.out).toContain(".agents/ has changes you haven't staged");
  expect(existsSync(join(home, ".config", "skelcrew", "approved-agents.yaml"))).toBe(false);
});

test("init stops outside a git repository, and in one with no remote", async () => {
  const outside = await skel(["init"]);
  expect(outside.code).toBe(1);
  expect(outside.err).toBe(
    "Skelcrew: sc init runs in a checkout of a git repository, and this folder isn't in one.\n",
  );
  const checkout = onGitHub("simon/app", "WRITE");
  git(checkout, "remote", "remove", "origin");
  const none = await skel(["init"], "", checkout);
  expect(none.code).toBe(1);
  expect(none.err).toBe(
    "Skelcrew: sc init needs the repository's remote, and this checkout has none. Push it somewhere first, such as to GitHub.\n",
  );
  expect(existsSync(join(checkout, "skelcrew.yaml"))).toBe(false);
});

// A git template, or anything else, could put a credential in a new clone's config. The lead
// reads every clone in Skelcrew's folder, so such a clone must never get there, even briefly.
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
  expect(existsSync(join(home, ".local", "share", "skelcrew", "cloning", "simon", "app"))).toBe(
    false,
  );
  expect((await skel(["repo", "ls"])).out).toBe(`${hint}\n`);
});

describe("a forge that needs its setup for the repository", () => {
  // Has the fake forge exit with 2 on claims, as GitHub's does where its app isn't installed,
  // and gives it a setup that asks for Enter and then fixes that, unless `fails`. The setup
  // keeps the remote it was handed.
  function needsSetup(fails = false): void {
    writeFileSync(
      join(forge, "setup-claims"),
      "Skelcrew's GitHub App isn't installed on simon/app",
    );
    const folder = join(home, "plugin-github");
    writeFileSync(
      join(folder, "setup.sh"),
      `echo "Install the app. Press Enter."
read answer
echo "$SKELCREW_REMOTE" > "$SKELCREW_PLUGIN_CONFIG/setup-remote"
${fails ? 'echo "GitHub is unreachable" >&2; exit 1' : 'rm "$SKELCREW_PLUGIN_CONFIG/setup-claims"; echo "Installed."'}
`,
    );
    appendFileSync(join(folder, "skelcrew-plugin.yaml"), "setup: [sh, setup.sh]\n");
  }

  // Runs sc with `args` in the checkout at a real terminal, in tmux on a socket of its own,
  // presses `key` once the setup asks for Enter, and returns the screen once sc has ended. The
  // pane stays after sc ends, so the screen also says how it ended, such as by a signal.
  async function atTerminal(checkout: string, args: string[] = [], key = "Enter"): Promise<string> {
    const real = Bun.which("tmux") ?? "tmux";
    const socket = `skelcrew-repo-test-${process.pid}`;
    const tmux = (...args: string[]) =>
      Bun.spawnSync([real, "-L", socket, "-f", "/dev/null", ...args], {
        stdout: "pipe",
        stderr: "pipe",
      });
    const screen = () => tmux("capture-pane", "-p", "-t", "sc").stdout.toString();
    const ended = () =>
      tmux("display-message", "-p", "-t", "sc", "#{pane_dead}").stdout.toString().trim() === "1";
    // Waits until the terminal shows the text, as a prompt reads keys only once it is up.
    const waitFor = async (text: string) => {
      for (let tries = 0; tries < 100 && !screen().includes(text); tries++) await Bun.sleep(100);
      expect(screen()).toContain(text);
    };
    const path = `${join(home, "bin")}:${process.env.PATH ?? ""}`;
    const env = `PATH=${path} HOME=${home} XDG_RUNTIME_DIR=${join(home, "run")} TERM=xterm-256color`;
    try {
      // The command is the session's own, so no shell of yours, with its settings, runs. The
      // option is set before the session starts, so a quick sc can't end before it holds.
      tmux(
        "start-server",
        ";",
        "set-option",
        "-g",
        "remain-on-exit",
        "on",
        ";",
        "new-session",
        "-d",
        "-s",
        "sc",
        "-c",
        checkout,
        "-x",
        "120",
        "-y",
        "40",
        `env -i ${env} ${process.execPath} ${main} ${args.join(" ")}`,
      );
      await waitFor("Press Enter.");
      tmux("send-keys", "-t", "sc", key);
      for (let tries = 0; tries < 100 && !ended(); tries++) await Bun.sleep(100);
      expect(ended()).toBe(true);
      return screen();
    } finally {
      tmux("kill-server");
    }
  }

  test("at a terminal, sc runs that setup there, then brings the repository in", async () => {
    const checkout = onGitHub("simon/app", "WRITE");
    needsSetup();
    const screen = await atTerminal(checkout);
    // The setup's first line can be gone from the screen by the time sc ends, and waiting for
    // it already showed it, so only its last words are checked here.
    expect(screen).toContain("Installed.\n");
    expect(screen).not.toContain("github failed");
    expect(screen).not.toContain("Ran github's setup");
    expect(readFileSync(join(forge, "setup-remote"), "utf8")).toBe(
      "https://github.com/simon/app\n",
    );
    expect(existsSync(join(clone("simon/app"), "README"))).toBe(true);
    expect(attached()).toBe(true);
  }, 60_000);

  test("sc repo add runs that setup there too, then adds the repository", async () => {
    const checkout = onGitHub("simon/app", "WRITE");
    needsSetup();
    const screen = await atTerminal(checkout, ["repo", "add"]);
    expect(screen).toContain(
      "Installed.\nAdding simon/app to Skelcrew...\nAdded simon/app, as app.\n",
    );
    expect(existsSync(join(clone("simon/app"), "README"))).toBe(true);
  }, 60_000);

  test("Ctrl-C at the setup stops sc, with no lead opened", async () => {
    const checkout = onGitHub("simon/app", "WRITE");
    needsSetup();
    const screen = await atTerminal(checkout, [], "C-c");
    expect(screen).toContain("Pane is dead (signal 2");
    expect(screen).not.toContain("Installed.");
    expect(screen).not.toContain(hint);
    expect(existsSync(clone("simon/app"))).toBe(false);
    expect(calls()).not.toContain("daemon lead");
  }, 60_000);

  test("a setup that fails says why, and sc goes on without the repository", async () => {
    const checkout = onGitHub("simon/app", "WRITE");
    needsSetup(true);
    const screen = await atTerminal(checkout);
    expect(screen).toContain("GitHub is unreachable");
    expect(screen).toContain(hint);
    expect(existsSync(clone("simon/app"))).toBe(false);
    expect(calls()).not.toContain("daemon lead");
  }, 60_000);

  test("with no terminal, nothing runs, and the error names the command that fixes it", async () => {
    const checkout = onGitHub("simon/app", "WRITE");
    needsSetup();
    const run = await skel([], "\n", checkout);
    expect(run.code).toBe(0);
    expect(run.err).toBe(
      "Skelcrew: github failed: Skelcrew's GitHub App isn't installed on simon/app. Run sc setup github to set it up again.\n",
    );
    expect(existsSync(join(forge, "setup-remote"))).toBe(false);
    expect(existsSync(clone("simon/app"))).toBe(false);
  });
});

describe("a repository's .agents/", () => {
  const approvals = () => join(home, ".config", "skelcrew", "approved-agents.yaml");
  // Returns what you approved for simon/app: a tree, none, or nothing when you never answered.
  const approved = (): string | undefined =>
    existsSync(approvals()) ? parse(readFileSync(approvals(), "utf8"))?.["simon/app"] : undefined;
  // Pushes a builder role to the fake GitHub from your checkout, and returns its .agents/ tree.
  function pushRole(checkout: string, text: string): string {
    mkdirSync(join(checkout, ".agents", "roles"), { recursive: true });
    writeFileSync(join(checkout, ".agents", "roles", "builder.md"), text);
    git(checkout, "add", "-A");
    git(checkout, "commit", "-q", "-m", "roles");
    git(checkout, "push", "-q", join(home, "github", "simon", "app.git"), "HEAD:main");
    return git(checkout, "rev-parse", "HEAD:.agents").trim();
  }

  test("is shown and asked about as the repository comes in, even one you can push to", async () => {
    const checkout = onGitHub("simon/app", "WRITE");
    const tree = pushRole(checkout, "Build it the team's way.\n");
    const run = await skel(["repo", "add"], "y\n", checkout);
    expect(run.err).toBe("");
    expect(run.out).toContain("+Build it the team's way.");
    expect(run.out).toContain(".agents/roles/builder.md");
    expect(run.out).toContain("Approve simon/app's .agents/?");
    expect(run.out).toContain("Added simon/app, as app.");
    expect(approved()).toBe(tree);
  });

  test("a no still adds the repository, on the built-in roles, and sc doesn't ask again", async () => {
    const checkout = onGitHub("simon/app", "WRITE");
    pushRole(checkout, "Build it the team's way.\n");
    const run = await skel(["repo", "add"], "n\n", checkout);
    expect(run.out).toContain("sc repo trust app");
    expect(run.out).toContain("Added simon/app, as app.");
    expect(approved()).toBe("none");
    expect((await skel([], "", checkout)).out).not.toContain("Approve");
  });

  test("without an answer, nothing is saved, and the next sc there asks again", async () => {
    const checkout = onGitHub("simon/app", "WRITE");
    pushRole(checkout, "Build it the team's way.\n");
    await skel(["repo", "add"], "", checkout);
    expect(approved()).toBeUndefined();
    const again = await skel([], "y\n", checkout);
    expect(again.out).toContain("Approve simon/app's .agents/?");
    expect(approved()).toBe(git(checkout, "rev-parse", "HEAD:.agents").trim());
  });

  test("sc outside a checkout asks about the .agents/ of the repository it opens again", async () => {
    const checkout = onGitHub("simon/app", "WRITE");
    pushRole(checkout, "Build it the team's way.\n");
    await skel(["repo", "add"], "", checkout);
    expect(approved()).toBeUndefined();
    // The daemon hands back the repository you opened last, and starts its lead once sc asked.
    handBack = [{ owner: "simon", repo: "app", name: "app" }];
    const run = await skel([], "y\n");
    expect(run.err).toBe("");
    expect(run.out).toContain("+Build it the team's way.");
    expect(run.out).toContain("Approve simon/app's .agents/?");
    const tree = git(checkout, "rev-parse", "HEAD:.agents").trim();
    expect(approved()).toBe(tree);
    // The lead starts on what you approved, and the daemon is told sc asked.
    expect(readFileSync(join(home, "approved-at-lead"), "utf8")).toContain(tree);
    expect(JSON.parse(readFileSync(join(home, "asked"), "utf8"))).toEqual({
      command: "lead",
      tab: true,
      asked: "simon/app",
    });
    expect((await skel([], "")).out).not.toContain("Approve");
  });

  test("a repository with none asks nothing", async () => {
    const run = await skel(["repo", "add"], "", onGitHub("simon/app", "WRITE"));
    expect(run.out).not.toContain(".agents");
    expect(approved()).toBeUndefined();
  });

  test("repo trust shows what changed and asks, and a yes approves the new version", async () => {
    const checkout = onGitHub("simon/app", "WRITE");
    pushRole(checkout, "Build it the team's way.\n");
    await skel(["repo", "add"], "y\n", checkout);
    const tree = pushRole(checkout, "Build it another way.\n");
    const run = await skel(["repo", "trust", "app"], "y\n");
    expect(run.err).toBe("");
    expect(run.out).toContain("-Build it the team's way.\n+Build it another way.");
    expect(run.out).toContain("Approve simon/app's .agents/?");
    expect(approved()).toBe(tree);
    const same = await skel(["repo", "trust", "app"]);
    expect(same.out).toContain("simon/app's .agents/ is the version you approved.");
  });

  test("repo trust with a no keeps the version you approved", async () => {
    const checkout = onGitHub("simon/app", "WRITE");
    const first = pushRole(checkout, "Build it the team's way.\n");
    await skel(["repo", "add"], "y\n", checkout);
    pushRole(checkout, "Build it another way.\n");
    const run = await skel(["repo", "trust", "app"], "n\n");
    expect(run.out).toContain("New tasks in simon/app keep the version you approved.");
    expect(approved()).toBe(first);
  });

  // Only you can approve, and the lead may be closed, so the repository's own row says it.
  test("repo ls says to run repo trust while the default branch has an .agents/ you haven't approved", async () => {
    const checkout = onGitHub("simon/app", "WRITE");
    pushRole(checkout, "Build it the team's way.\n");
    await skel(["repo", "add"], "y\n", checkout);
    const waiting = async () =>
      JSON.parse((await skel(["repo", "ls", "--json"])).out)[0].agentsWaiting;
    expect(await waiting()).toBe(false);
    expect((await skel(["repo", "ls"])).out).not.toContain("repo trust");
    // A no keeps the version you approved, and the change still waits for you.
    pushRole(checkout, "Build it another way.\n");
    await skel(["repo", "trust", "app"], "n\n");
    expect(await waiting()).toBe(true);
    expect((await skel(["repo", "ls"])).out).toContain("run sc repo trust app");
    await skel(["repo", "trust", "app"], "y\n");
    expect(await waiting()).toBe(false);
  });

  test("repo rm forgets what you approved", async () => {
    const checkout = onGitHub("simon/app", "WRITE");
    pushRole(checkout, "Build it the team's way.\n");
    await skel(["repo", "add"], "y\n", checkout);
    await skel(["repo", "rm", "app"]);
    expect(approved()).toBeUndefined();
  });
});

test("sc says once which old role keys your config.yaml uses, what replaces them, and changes nothing", async () => {
  const file = join(home, ".config", "skelcrew", "config.yaml");
  const yours =
    "harness: claude\nbuilder: { model: sonnet }\nreviewer: { harness: codex }\nroles: { lead: { model: opus } }\n" +
    // The lead's line holds a setting of its own, which no role replaces.
    "lead: { may_arm_merges: true }\n";
  writeFileSync(file, yours);
  const first = await skel([]);
  expect(first.out).toContain(
    "Your config.yaml's builder: is read as roles: { builder: … }, which replaces it.",
  );
  expect(first.out).toContain(
    "Your config.yaml's reviewer: is read as roles: { reviewer: … }, which replaces it.",
  );
  expect(first.out).not.toContain("lead:");
  expect((await skel([])).out).not.toContain("replaces it");
  expect(readFileSync(file, "utf8")).toBe(yours);
});

test("sc says once which old keys the repository's skelcrew.yaml uses, what replaces them, and changes nothing", async () => {
  const checkout = onGitHub("simon/app", "WRITE");
  const yours = "setup: [make]\nbuilder: { model: sonnet }\nmax_rounds: 5\n";
  writeFileSync(join(checkout, "skelcrew.yaml"), yours);
  git(checkout, "add", "-A");
  git(checkout, "commit", "-q", "-m", "settings");
  git(checkout, "push", "-q", join(home, "github", "simon", "app.git"), "HEAD:main");
  const first = await skel([], "", checkout);
  expect(first.err).toBe("");
  expect(first.out).toContain(
    "simon/app's skelcrew.yaml has builder:, read as the harness and model in .agents/roles/builder.md, which replaces it.",
  );
  expect(first.out).toContain(
    "simon/app's skelcrew.yaml has max_rounds:, read as rounds: in .agents/flows/default.yaml, which replaces it.",
  );
  expect(first.out).not.toContain("lead:");
  expect((await skel([], "", checkout)).out).not.toContain("replaces it");
  expect(readFileSync(join(clone("simon/app"), "skelcrew.yaml"), "utf8")).toBe(yours);
});

test("sc outside a checkout names the old keys of the repository it opens again", async () => {
  const checkout = onGitHub("simon/app", "WRITE");
  writeFileSync(join(checkout, "skelcrew.yaml"), "reviewer: { harness: codex }\n");
  git(checkout, "add", "-A");
  git(checkout, "commit", "-q", "-m", "settings");
  git(checkout, "push", "-q", join(home, "github", "simon", "app.git"), "HEAD:main");
  expect((await skel(["repo", "add"], "", checkout)).err).toBe("");
  // The daemon answers with the repository you opened last.
  const run = await skel([]);
  expect(run.err).toBe("");
  expect(run.out).toContain(
    "simon/app's skelcrew.yaml has reviewer:, read as the harness and model in .agents/roles/reviewer.md, which replaces it.",
  );
});

test("repo trust shows the whole .agents/ when the clone lost the version you approved", async () => {
  const checkout = onGitHub("simon/app", "WRITE");
  mkdirSync(join(checkout, ".agents", "roles"), { recursive: true });
  writeFileSync(join(checkout, ".agents", "roles", "builder.md"), "First way.\n");
  git(checkout, "add", "-A");
  git(checkout, "commit", "-q", "-m", "roles");
  git(checkout, "push", "-q", join(home, "github", "simon", "app.git"), "HEAD:main");
  await skel(["repo", "add"], "y\n", checkout);
  // The approval names a version no clone has, as after the clone was made again.
  const approvals = join(home, ".config", "skelcrew", "approved-agents.yaml");
  writeFileSync(approvals, `simon/app: ${"a".repeat(40)}\n`);
  const run = await skel(["repo", "trust", "simon/app"], "y\n");
  expect(run.err).toBe("");
  expect(run.out).toContain("no longer has the version you approved");
  expect(run.out).toContain("+First way.");
  expect(readFileSync(approvals, "utf8")).toBe(
    `simon/app: ${git(checkout, "rev-parse", "HEAD:.agents").trim()}\n`,
  );
});

test("sc says once that rounds: replaces max_rounds: in your config.yaml, here and under repos:", async () => {
  const file = join(home, ".config", "skelcrew", "config.yaml");
  const yours = "harness: claude\nmax_rounds: 5\nrepos:\n  simon/app: { max_rounds: 2 }\n";
  writeFileSync(file, yours);
  const first = await skel([]);
  expect(first.out).toContain(
    "Your config.yaml's max_rounds: is read as rounds:, which replaces it.",
  );
  expect(first.out).toContain(
    "Your config.yaml's max_rounds: under repos: simon/app is read as rounds:, which replaces it.",
  );
  expect((await skel([])).out).not.toContain("replaces it");
  expect(readFileSync(file, "utf8")).toBe(yours);
});
