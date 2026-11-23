// Polling a repository's tracker and forge for events on a thread's PR, against a running
// daemon: a fake plugin answers the poll from a file the test changes, and a shell script
// stands in for the builder, keeping what is typed into it.
import { Database } from "bun:sqlite";
import { afterEach, beforeEach, expect, test } from "bun:test";
import { existsSync, mkdirSync, renameSync, rmSync, writeFileSync } from "node:fs";
import { join } from "node:path";
import { hasAgentLogin } from "../src/agents/login.ts";
import { answer, asked, git, insideSandbox, prItem, source, taskItem } from "./harness.ts";
import {
  addApp,
  changes,
  claim12,
  claims,
  copied,
  daemonLog,
  data,
  env,
  headOf,
  home,
  issue12,
  leadName,
  main,
  morePolls,
  plugin,
  polls,
  prAgents,
  read,
  running,
  script,
  serve,
  setUp,
  socket,
  tearDown,
  thread,
  until,
} from "./polling.ts";

beforeEach(setUp);
afterEach(tearDown);

test("polling agents have their logins before the daemon starts", () => {
  expect(hasAgentLogin("claude", home)).toBe(true);
  expect(hasAgentLogin("codex", home)).toBe(true);
});

test("the first poll brings everything open into Skelcrew's copy, and later ones what changed", async () => {
  addApp();
  changes([issue12(), taskItem("13", "Fix login"), prItem("34", "Bump deps")]);
  serve();
  await until(() => copied().rows.length === 3);
  expect(copied()).toEqual({
    rows: ["pr 34", "task 12", "task 13"],
    totals: { open_issues: 2, open_prs: 1 },
  });
  // The plugin only sends what changed since the `next` it gave. A closed issue goes.
  changes([taskItem("13", "Fix login", { state: "closed" })], "2026-11-07T10:00:00Z");
  await until(() => copied().rows.length === 2);
  expect(copied().rows).toEqual(["pr 34", "task 12"]);
  const later = asked(plugin).filter((q) => q.ask === "changed");
  expect(later[0]).toEqual({
    ask: "changed",
    repository: "simon/app",
    jobs: ["tracker", "forge"],
    next: null,
    prs: [],
  });
  // Each later poll asks from the `next` the one before it was given.
  expect(later.at(-1)?.next).not.toBeNull();
  // A daemon that starts again asks for everything open, so what closed meanwhile goes too.
  const first = running[0];
  first?.kill();
  await first?.exited;
  changes([issue12()]);
  serve();
  await until(() => copied().rows.length === 1);
  expect(copied()).toEqual({ rows: ["task 12"], totals: { open_issues: 1, open_prs: 0 } });
});

// Builders fetch the default branch from Skelcrew's clone, so it must follow the remote's,
// however the default branch moved.
test("a push straight to main and a merge of a PR without a thread both reach Skelcrew's clone by the next poll", async () => {
  const work = addApp();
  const remote = join(home, "github", "simon", "app.git");
  changes([]);
  serve();
  const skelcrewClone = join(data(), "repos", "simon", "app");
  await until(() => existsSync(join(skelcrewClone, "README")));
  const cloneHead = () => git(skelcrewClone, "rev-parse", "HEAD").trim();
  // Someone pushes straight to main. The poll after it brings it in, and the log says so.
  writeFileSync(join(work, "pushed"), "1\n");
  git(work, "add", ".");
  git(work, "commit", "-q", "-m", "pushed");
  git(work, "push", "-q", remote, "main");
  const pushed = git(work, "rev-parse", "HEAD").trim();
  await until(() => cloneHead() === pushed);
  await until(() => read(daemonLog()).includes(`to ${pushed.slice(0, 7)}`));
  expect(read(daemonLog())).toContain("Skelcrew's clone of simon/app moved its default branch");
  // Someone merges a PR no thread has. The poll that hears of the merge brings it in.
  git(work, "checkout", "-q", "-b", "feature");
  writeFileSync(join(work, "feature"), "1\n");
  git(work, "add", ".");
  git(work, "commit", "-q", "-m", "feature");
  git(work, "checkout", "-q", "main");
  git(work, "merge", "-q", "--no-ff", "-m", "Merge pull request #40", "feature");
  git(work, "push", "-q", remote, "main");
  changes([prItem("40", "Add feature", { state: "merged", branch: "feature" })]);
  const merged = git(work, "rev-parse", "HEAD").trim();
  await until(() => cloneHead() === merged);
  expect(existsSync(join(skelcrewClone, "feature"))).toBe(true);
});

// A repository just created on GitHub has no commits, so no default branch to fetch. Polling it
// must neither fail nor fill the log, and its first commit must reach Skelcrew's clone.
test("an empty repository is polled quietly, refuses a thread plainly, and its first commit reaches Skelcrew's clone", async () => {
  const work = addApp(true);
  changes([issue12(), prItem("34", "Bump deps")]);
  serve();
  // Issues and PRs still reach Skelcrew's copy, and the log says once that there are no commits.
  await until(() => copied().rows.length === 2);
  expect(copied().rows).toEqual(["pr 34", "task 12"]);
  await morePolls();
  const log = read(daemonLog());
  expect(log).not.toContain("failed");
  expect(log.split("simon/app has no commits yet").length).toBe(2);
  // A thread has nothing to start from, from the default branch or one named with --from.
  // sc start says so rather than starting one whose setup can only fail.
  for (const from of [[], ["--from", "main"]]) {
    const started = Bun.spawnSync([process.execPath, main, "start", "app-12", ...from], {
      env: env(),
      stdout: "pipe",
      stderr: "pipe",
    });
    expect(started.stdout.toString()).toBe("");
    expect(started.stderr.toString()).toBe(
      "Skelcrew: simon/app has no commits yet, so a thread has nothing to start from. Push a first commit, then start it again.\n",
    );
    expect(started.exitCode).toBe(1);
    expect(thread()).toEqual({});
  }
  // The first commit pushed reaches Skelcrew's clone at the next poll, and the log says so once.
  git(work, "push", "-q", join(home, "github", "simon", "app.git"), "main");
  const skelcrewClone = join(data(), "repos", "simon", "app");
  await until(() => existsSync(join(skelcrewClone, "README")));
  const first = git(work, "rev-parse", "HEAD").trim();
  expect(git(skelcrewClone, "rev-parse", "HEAD").trim()).toBe(first);
  await morePolls();
  expect(read(daemonLog())).toContain(
    `Skelcrew's clone of simon/app has its first commit, ${first.slice(0, 7)}`,
  );
  expect(read(daemonLog()).split("has its first commit").length).toBe(2);
  expect(read(daemonLog())).not.toContain("couldn't update");
});

// The first commit can come before the refresh after the one that made the clone, and the log
// must still have said the repository was empty.
test("an empty repository is logged as it is cloned, and its clone follows the branch its first commit made the default", () => {
  const work = addApp(true);
  const code = `import { openDb } from ${JSON.stringify(source("db.ts"))};
import { refreshClone, repositories } from ${JSON.stringify(source("flow/repo.ts"))};
const db = openDb();
const [app] = repositories(db);
if (!app) throw new Error("no repository");
await refreshClone(db, app);`;
  const refresh = () => {
    const run = Bun.spawnSync([process.execPath, "-e", code], {
      env: env(),
      stdout: "pipe",
      stderr: "pipe",
    });
    expect(run.stderr.toString()).toBe("");
    return run.stdout.toString();
  };
  expect(refresh()).toBe("simon/app has no commits yet\n");
  // The first commit goes to develop, which becomes the default branch, rather than to the
  // main the remote named when it was cloned. The clone follows, as threads' PRs go there.
  const bare = join(home, "github", "simon", "app.git");
  git(work, "push", "-q", bare, "main:develop");
  git(bare, "symbolic-ref", "HEAD", "refs/heads/develop");
  const first = git(work, "rev-parse", "HEAD").trim().slice(0, 7);
  expect(refresh()).toBe(`Skelcrew's clone of simon/app has its first commit, ${first}\n`);
  const skelcrewClone = join(data(), "repos", "simon", "app");
  expect(git(skelcrewClone, "symbolic-ref", "--short", "HEAD").trim()).toBe("develop");
  expect(git(skelcrewClone, "rev-parse", "--short=7", "HEAD").trim()).toBe(first);
});

// A claim made while there is nothing to start from would keep the label from starting the
// task once there is.
test("a labeled task on an empty repository is neither claimed nor started until its first commit, even before it is cloned", async () => {
  const work = addApp(true);
  answer(plugin, "took", { took: true });
  changes([issue12(true)]);
  // Hold the clone the daemon makes as it starts, so polls run before it is there, as they
  // can on a slow remote.
  script(
    "git",
    `case "$*" in *"clone --quiet "*" https://github.com/"*)
  touch "$HOME/held"
  while [ ! -e "$HOME/go" ] && [ -d "$HOME" ]; do sleep 0.05; done ;;
esac
exec ${Bun.which("git") ?? "git"} "$@"`,
  );
  // With no lead open, which would wait for the clone as it starts, polling starts at once.
  const db = new Database(join(data(), "skelcrew.db"));
  db.run("UPDATE repositories SET opened = NULL");
  db.close();
  serve();
  await until(() => existsSync(join(home, "held")));
  await until(() => copied().rows.length === 1);
  await morePolls();
  expect(claims()).toEqual([]);
  writeFileSync(join(home, "go"), "");
  await until(() => read(daemonLog()).includes("simon/app has no commits yet"));
  await morePolls();
  expect(claims()).toEqual([]);
  expect(thread()).toEqual({});
  git(work, "push", "-q", join(home, "github", "simon", "app.git"), "main");
  await until(() => thread().issue === "12");
  expect(claims()).toEqual([claim12]);
});

// Every branch can be deleted from a repository Skelcrew has already cloned, and its clone
// keeps the old commits. The repository is empty all the same.
test("a repository emptied after Skelcrew cloned it starts no thread until its next first commit", async () => {
  const work = addApp();
  answer(plugin, "took", { took: true });
  changes([]);
  serve();
  const skelcrewClone = join(data(), "repos", "simon", "app");
  await until(() => existsSync(join(skelcrewClone, "README")));
  const bare = join(home, "github", "simon", "app.git");
  git(bare, "update-ref", "-d", "refs/heads/main");
  await until(() => read(daemonLog()).includes("simon/app has no commits yet"));
  // sc start says so, and a task labeled now is neither claimed nor started.
  const started = Bun.spawnSync([process.execPath, main, "start", "app-12"], {
    env: env(),
    stdout: "pipe",
    stderr: "pipe",
  });
  expect(started.stderr.toString()).toBe(
    "Skelcrew: simon/app has no commits yet, so a thread has nothing to start from. Push a first commit, then start it again.\n",
  );
  changes([issue12(true)]);
  await until(() => copied().rows.length === 1);
  await morePolls();
  expect(claims()).toEqual([]);
  expect(thread()).toEqual({});
  // The next first commit goes to develop, which becomes the default, and is logged as a
  // first commit. The labeled task then starts.
  writeFileSync(join(work, "again"), "1\n");
  git(work, "add", ".");
  git(work, "commit", "-q", "-m", "again");
  git(work, "push", "-q", bare, "main:develop");
  git(bare, "symbolic-ref", "HEAD", "refs/heads/develop");
  const first = git(work, "rev-parse", "HEAD").trim();
  await until(() => read(daemonLog()).includes(`has its first commit, ${first.slice(0, 7)}`));
  expect(read(daemonLog())).not.toContain("moved its default branch");
  expect(git(skelcrewClone, "symbolic-ref", "--short", "HEAD").trim()).toBe("develop");
  expect(git(skelcrewClone, "rev-parse", "HEAD").trim()).toBe(first);
  await until(() => thread().issue === "12");
  expect(claims()).toEqual([claim12]);
});

// A remote whose HEAD names a branch that is gone has commits all the same, and the log must
// say what is wrong rather than take it for an empty repository.
test("a repository whose default branch is gone still logs why its clone can't update", async () => {
  addApp();
  git(join(home, "github", "simon", "app.git"), "symbolic-ref", "HEAD", "refs/heads/gone");
  changes([]);
  serve();
  await until(() => read(daemonLog()).includes("couldn't update Skelcrew's clone of simon/app"));
  expect(read(daemonLog())).toContain("couldn't find remote ref HEAD");
  expect(read(daemonLog())).not.toContain("no commits yet");
});

// The notes about .agents/ that wait, saved, for app's lead, and those typed into it.
function agentsNotes(): { saved: string[]; typed: string[] } {
  const db = new Database(join(data(), "skelcrew.db"), { readonly: true });
  db.run("PRAGMA busy_timeout = 5000");
  const rows = db.query("SELECT text FROM notes").all();
  db.close();
  const saved = rows.map((row) => String(Object.values(Object(row))[0]));
  const typed = read(join(data(), "claude", leadName, "typed")).split("\n");
  const about = (text: string) => text.includes(".agents/");
  return { saved: saved.filter(about), typed: typed.filter(about) };
}

// What the daemon told, or saved to tell, app's lead about its .agents/, once there is a note.
// Inside Skelcrew's own sandbox the lead can't start, so its notes stay saved, and elsewhere
// they are typed in. A note stays saved from its paste until a moment after its Enter, so
// counting both places then would count it twice. Outside the sandbox the count waits until
// no note is left saved, and counts what the lead got.
async function toldAboutAgents(): Promise<string[]> {
  const any = () => agentsNotes().saved.length + agentsNotes().typed.length > 0;
  await until(any);
  if (insideSandbox) return agentsNotes().saved;
  await until(() => agentsNotes().saved.length === 0);
  return agentsNotes().typed;
}

test("a push that changes .agents/ tells the lead once that the human must approve it", async () => {
  const work = addApp();
  const remote = join(home, "github", "simon", "app.git");
  changes([]);
  serve();
  const skelcrewClone = join(data(), "repos", "simon", "app");
  await until(() => existsSync(join(skelcrewClone, "README")));
  mkdirSync(join(work, ".agents", "roles"), { recursive: true });
  writeFileSync(join(work, ".agents", "roles", "builder.md"), "Build it the team's way.\n");
  git(work, "add", ".");
  git(work, "commit", "-q", "-m", "roles");
  git(work, "push", "-q", remote, "main");
  expect((await toldAboutAgents())[0]).toContain("sc repo trust app");
  // Later polls of the same .agents/ say nothing more.
  await morePolls();
  expect(await toldAboutAgents()).toHaveLength(1);
});

// A lead already running when Skelcrew learned of flows keeps the instructions it started with,
// so it is told of them once. Its session stands in for a lead from before the update.
// The merge confirms say when a PR changes .agents/, which merging doesn't approve. The PR's
// changes are those since its head left its base, so a PR whose head stays put can change
// .agents/ or not as it is retargeted or its base moves. A PR with no thread counts too.
test("each poll finds whether an open PR changes .agents/, again as its base changes", async () => {
  const work = addApp();
  const remote = join(home, "github", "simon", "app.git");
  // `roles` adds a role, and `fix`, on top of it, changes nothing in .agents/.
  git(work, "checkout", "-q", "-b", "roles");
  mkdirSync(join(work, ".agents", "roles"), { recursive: true });
  writeFileSync(join(work, ".agents", "roles", "builder.md"), "Build it my way.\n");
  git(work, "add", ".");
  git(work, "commit", "-q", "-m", "roles");
  git(work, "checkout", "-q", "-b", "fix");
  writeFileSync(join(work, "fix.txt"), "fixed\n");
  git(work, "add", ".");
  git(work, "commit", "-q", "-m", "fix");
  const head = headOf(work);
  git(work, "push", "-q", remote, "roles", "fix");
  const fix = (base: string) => prItem("8", "Fix", { head, branch: "fix", base });
  changes([fix("roles")]);
  serve();
  await until(() => prAgents("8") !== null);
  expect(prAgents("8")).toEqual({ head, changed: 0 });
  // Retargeted at main, the role comes with it.
  changes([fix("main")]);
  await until(() => prAgents("8")?.changed === 1);
  // Once main has the role, the PR's own changes leave .agents/ alone again.
  git(work, "push", "-q", remote, "roles:main");
  await until(() => prAgents("8")?.changed === 0);
  expect(prAgents("8")).toEqual({ head, changed: 0 });
  // While the remote is out of reach, the clone's main may be behind it, and a stale main can
  // hide a change the PR now brings. So the PR counts as not checked until main can be fetched.
  renameSync(remote, `${remote}.away`);
  await until(() => prAgents("8") === null);
  renameSync(`${remote}.away`, remote);
  await until(() => prAgents("8") !== null);
  expect(prAgents("8")).toEqual({ head, changed: 0 });
  // A PR that closed leaves nothing saved behind.
  changes([{ ...fix("main"), state: "closed" }]);
  await until(() => prAgents("8") === null);
});

// A PR from a fork has its branch only on the fork. Its head is still on the repository's
// remote, as GitHub keeps it under refs/pull/, so the poll fetches it by its commit.
test("a PR from a fork that changes .agents/ is found, though its branch isn't on the remote", async () => {
  const work = addApp();
  const remote = join(home, "github", "simon", "app.git");
  git(work, "checkout", "-q", "-b", "theirs");
  mkdirSync(join(work, ".agents", "roles"), { recursive: true });
  writeFileSync(join(work, ".agents", "roles", "builder.md"), "Build it their way.\n");
  git(work, "add", ".");
  git(work, "commit", "-q", "-m", "roles");
  const head = headOf(work);
  git(work, "push", "-q", remote, `${head}:refs/pull/9/head`);
  changes([prItem("9", "Their roles", { head, branch: "theirs", base: "main" })]);
  serve();
  await until(() => prAgents("9") !== null);
  expect(prAgents("9")).toEqual({ head, changed: 1 });
});

test("a lead running from before flows is told of them once", async () => {
  addApp();
  changes([]);
  Bun.spawnSync(["tmux", "-L", socket, "new-session", "-d", "-s", leadName, "sleep 300"]);
  serve();
  // What the daemon told, or saved to tell, app's lead about flows.
  const flowNotes = () => {
    const db = new Database(join(data(), "skelcrew.db"), { readonly: true });
    db.run("PRAGMA busy_timeout = 5000");
    const saved = db.query("SELECT text FROM notes").all();
    db.close();
    const texts = saved.map((row) => String(Object.values(Object(row))[0]));
    const typedIn = read(join(data(), "claude", leadName, "typed")).split("\n");
    return [...texts, ...typedIn].filter((text) => text.includes("each thread now runs a flow"));
  };
  await until(() => flowNotes().length > 0);
  expect(flowNotes()[0]).toContain("refs/skelcrew/agents/approved");
  await morePolls();
  expect(flowNotes()).toHaveLength(1);
});

// A lead already running when Skelcrew learned of briefs keeps the instructions it started with,
// so it is told once how to brief another lead, and when a brief lets it start work.
test("a lead running from before briefs is told of them once", async () => {
  addApp();
  changes([]);
  Bun.spawnSync(["tmux", "-L", socket, "new-session", "-d", "-s", leadName, "sleep 300"]);
  serve();
  // What the daemon told, or saved to tell, app's lead about briefs.
  const briefNotes = () => {
    const db = new Database(join(data(), "skelcrew.db"), { readonly: true });
    db.run("PRAGMA busy_timeout = 5000");
    const saved = db.query("SELECT text FROM notes").all();
    db.close();
    const texts = saved.map((row) => String(Object.values(Object(row))[0]));
    const typedIn = read(join(data(), "claude", leadName, "typed")).split("\n");
    return [...texts, ...typedIn].filter((text) => text.includes("leads can brief each other"));
  };
  await until(() => briefNotes().length > 0);
  expect(briefNotes()[0]).toContain("sc tell lead <repo>");
  expect(briefNotes()[0]).toContain("--asked-file asked.txt");
  expect(briefNotes()[0]).toContain('whose tag says asked="yes"');
  await morePolls();
  expect(briefNotes()).toHaveLength(1);
});

// A repository whose lead isn't running is left untold, as a lead that starts later is told of
// flows in its instructions. Its tab is closed, so the daemon doesn't start its lead.
test("a repository with no lead running gets no note of flows", async () => {
  addApp();
  const closed = new Database(join(data(), "skelcrew.db"));
  closed.run("UPDATE repositories SET tab_closed = 1");
  closed.close();
  changes([]);
  serve();
  await until(() => existsSync(join(data(), "repos", "simon", "app", "README")));
  await morePolls();
  const db = new Database(join(data(), "skelcrew.db"), { readonly: true });
  db.run("PRAGMA busy_timeout = 5000");
  const notes = db.query("SELECT text FROM notes").all();
  const told = db.query("SELECT lead_flows FROM repositories").get();
  db.close();
  expect(JSON.stringify(notes)).not.toContain("each thread now runs a flow");
  expect(told).toEqual({ lead_flows: 0 });
});

// The flows the human approved are in Skelcrew's clone already, so a lead from before flows is
// told how to read them even while the remote can't be reached.
test("a lead running from before flows is told of them while the remote is out of reach", async () => {
  addApp();
  changes([]);
  const remote = join(home, "github", "simon", "app.git");
  git(home, "clone", "-q", remote, join(data(), "repos", "simon", "app"));
  renameSync(remote, `${remote}.away`);
  Bun.spawnSync(["tmux", "-L", socket, "new-session", "-d", "-s", leadName, "sleep 300"]);
  serve();
  const noted = () => {
    const db = new Database(join(data(), "skelcrew.db"), { readonly: true });
    db.run("PRAGMA busy_timeout = 5000");
    const saved = db.query("SELECT text FROM notes").all();
    db.close();
    const texts = saved.map((row) => String(Object.values(Object(row))[0]));
    const typedIn = read(join(data(), "claude", leadName, "typed")).split("\n");
    return [...texts, ...typedIn].some((text) => text.includes("each thread now runs a flow"));
  };
  await until(noted);
  expect(read(daemonLog())).toContain("couldn't update Skelcrew's clone of simon/app");
});

// git can reach the remote while the tracker or forge is down, and builders must not fall
// behind for it.
test("a push straight to main reaches Skelcrew's clone while the forge fails to answer", async () => {
  const work = addApp();
  changes([]);
  serve();
  const skelcrewClone = join(data(), "repos", "simon", "app");
  await until(() => existsSync(join(skelcrewClone, "README")));
  writeFileSync(join(plugin, "fail-changed"), "forge is down");
  const failed = polls();
  await until(() => polls() > failed);
  writeFileSync(join(work, "pushed"), "1\n");
  git(work, "add", ".");
  git(work, "commit", "-q", "-m", "pushed");
  git(work, "push", "-q", join(home, "github", "simon", "app.git"), "main");
  const pushed = git(work, "rev-parse", "HEAD").trim();
  await until(() => git(skelcrewClone, "rev-parse", "HEAD").trim() === pushed);
});

// sc repo rm deletes the clone and the repository's row, and refreshes already asked for must
// not bring the clone back.
test("refreshes waiting their turn when the repository is removed leave no clone behind", () => {
  addApp();
  const skelcrewClone = join(data(), "repos", "simon", "app");
  const code = `import { rmSync } from "node:fs";
import { openDb } from ${JSON.stringify(source("db.ts"))};
import { refreshClone, repositories } from ${JSON.stringify(source("flow/repo.ts"))};
const db = openDb();
const [app] = repositories(db);
if (!app) throw new Error("no repository");
await refreshClone(db, app);
console.log("cloned");
const queued = [refreshClone(db, app), refreshClone(db, app)];
rmSync(${JSON.stringify(skelcrewClone)}, { recursive: true, force: true });
db.run("DELETE FROM repositories");
await Promise.all(queued);`;
  const run = Bun.spawnSync([process.execPath, "-e", code], {
    env: env(),
    stdout: "pipe",
    stderr: "pipe",
  });
  expect(run.stderr.toString()).toBe("");
  expect(run.stdout.toString()).toBe("cloned\n");
  expect(existsSync(skelcrewClone)).toBe(false);
});

// A poll already asking the forge when sc repo rm runs must not bring the clone back.
test("a repository removed while its poll waits on the forge keeps no clone", async () => {
  addApp();
  changes([]);
  serve();
  const skelcrewClone = join(data(), "repos", "simon", "app");
  await until(() => existsSync(join(skelcrewClone, "README")));
  // Hold the next answer, and remove the repository as sc repo rm does while it is held.
  writeFileSync(join(plugin, "hold-changed"), "");
  await until(() => existsSync(join(plugin, "held-changed")));
  const code = `import { removeRepo } from ${JSON.stringify(source("flow/repo.ts"))};
await removeRepo("app", ${JSON.stringify(socket)});`;
  const removed = Bun.spawnSync([process.execPath, "-e", code], { env: env(), stderr: "pipe" });
  expect(removed.stderr.toString()).toBe("");
  expect(existsSync(skelcrewClone)).toBe(false);
  // Let the poll go on, and give it time to finish: a clone would be back within it.
  rmSync(join(plugin, "hold-changed"));
  await Bun.sleep(2000);
  expect(existsSync(skelcrewClone)).toBe(false);
});

// A refresh still asking which forge claims a repository when sc repo rm runs must not clone
// it afterwards.
test("a repository removed while Skelcrew asks which forge claims it gets no clone", async () => {
  addApp();
  const db = new Database(join(data(), "skelcrew.db"));
  db.run("UPDATE repositories SET claimed = 0");
  db.close();
  writeFileSync(join(plugin, "hold-claims"), "");
  serve();
  await until(() => existsSync(join(plugin, "held-claims")));
  const code = `import { removeRepo } from ${JSON.stringify(source("flow/repo.ts"))};
await removeRepo("app", ${JSON.stringify(socket)});`;
  const removed = Bun.spawnSync([process.execPath, "-e", code], { env: env(), stderr: "pipe" });
  expect(removed.stderr.toString()).toBe("");
  // Let the refresh go on, and give it time to finish: a clone would appear within it.
  rmSync(join(plugin, "hold-claims"));
  await Bun.sleep(2000);
  expect(existsSync(join(data(), "repos", "simon", "app"))).toBe(false);
});

// Two machines running Skelcrew on one repository both see the label, and only the one whose
// claim the tracker grants may start it.
test("a labeled task claimed elsewhere starts no thread, and a claim that fails is tried again", async () => {
  addApp();
  const failing = join(plugin, "fail-took");
  writeFileSync(failing, "network is down");
  changes([issue12(true)]);
  serve();
  const took = () => asked(plugin).filter((q) => q.ask === "took");
  // A claim that fails starts nothing, and the next poll asks again.
  await until(() => took().length >= 2);
  expect(thread()).toEqual({});
  // Once the tracker answers that someone else has it, nothing starts, and it isn't asked again.
  answer(plugin, "took", { took: false });
  rmSync(failing);
  const failed = took().length;
  await morePolls();
  const asks = took().length;
  expect(asks).toBeGreaterThan(failed);
  await morePolls();
  expect(took()).toHaveLength(asks);
  expect(thread()).toEqual({});
}, 30_000);

// A labelled task whose round limit isn't valid would fail once work began, so it never starts,
// and the daemon's log says why.
test("a labeled task whose round limit isn't valid starts no thread", async () => {
  addApp();
  writeFileSync(
    join(home, ".config", "skelcrew", "config.yaml"),
    "harness: claude\nmax_rounds: 0\n",
  );
  changes([issue12(true)]);
  serve();
  await until(() => read(daemonLog()).includes("couldn't start 12 in simon/app"));
  expect(read(daemonLog())).toContain("isn't valid");
  expect(thread()).toEqual({});
}, 30_000);
