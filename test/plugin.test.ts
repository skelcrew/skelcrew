// Plugins: sc plugin install, update, rm and ls run as you would run them, and the daemon's
// calls and git logins through a plugin. A folder of git repositories with version tags stands
// in for GitHub, and a small fake plugin for a real one.
import { Database } from "bun:sqlite";
import { afterEach, beforeEach, expect, test } from "bun:test";
import {
  chmodSync,
  existsSync,
  mkdirSync,
  mkdtempSync,
  readdirSync,
  readFileSync,
  realpathSync,
  rmSync,
  statSync,
  writeFileSync,
} from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { parse } from "yaml";
import { git, inTerminal, source } from "./harness.ts";

let home = "";

const plugins = () => join(home, ".local", "share", "skelcrew", "plugins");
const settings = (name: string) => join(home, ".config", "skelcrew", "plugins", name);
const onGitHub = (full: string) => join(home, "github", full);

// The fake plugin's files. Its build runs on Bun and its setup in your terminal, and each
// leaves a mark of what it was handed. Its call answers what it is asked, or fails, hangs or
// answers in the wrong shape when asked to.
function fakePlugin(folder: string, version: string, more = ""): void {
  mkdirSync(folder, { recursive: true });
  writeFileSync(
    join(folder, "skelcrew-plugin.yaml"),
    `name: fake
version: ${version}
skelcrew: 0.4.0
about: Tasks from a fake tracker
kind: io
provides: [tracker, forge]
build: [[bun, build.ts]]
setup: [sh, setup.sh]
call: [bun, call.ts]
git_credentials: [sh, credentials.sh]
${more}`,
  );
  writeFileSync(
    join(folder, "build.ts"),
    `await Bun.write("built", JSON.stringify({ plugin: process.env.SKELCREW_PLUGIN, config: process.env.SKELCREW_PLUGIN_CONFIG, version: ${JSON.stringify(version)} }));\n`,
  );
  writeFileSync(
    join(folder, "setup.sh"),
    'echo "setting up $SKELCREW_PLUGIN"\necho secret > "$SKELCREW_PLUGIN_CONFIG/token"\necho "$SKELCREW_REMOTE" > "$SKELCREW_PLUGIN_CONFIG/remote"\n',
  );
  writeFileSync(
    join(folder, "call.ts"),
    `const question = JSON.parse(await Bun.stdin.text());
if (question.ask === "fail") {
  console.error("starting");
  console.error("the token expired");
  process.exit(1);
}
// A plugin whose sign-in lapsed says so with its own exit code.
if (question.ask === "lapsed") {
  console.error("your sign-in ran out");
  process.exit(2);
}
if (question.ask === "slow") await Bun.sleep(30_000);
// A plugin that hangs in a program it started, which keeps its output open after it ends.
if (question.ask === "stuck") {
  Bun.spawn(["sleep", "30"], { stdout: "inherit", stderr: "inherit" });
  await Bun.sleep(30_000);
}
if (question.ask === "bad") console.log(JSON.stringify({ number: "twelve" }));
else console.log(JSON.stringify({ number: 12, asked: question, folder: process.cwd(), plugin: process.env.SKELCREW_PLUGIN, config: process.env.SKELCREW_PLUGIN_CONFIG }));
`,
  );
  writeFileSync(
    join(folder, "credentials.sh"),
    'test "$1" = get || exit 0\npath=$(sed -n "s/^path=//p")\necho username=x-access-token\necho "password=token-of-$SKELCREW_PLUGIN-for-$path"\n',
  );
}

// Puts the fake plugin on the fake GitHub, with a commit and a tag for each version.
function publish(full: string, ...versions: string[]): void {
  const folder = onGitHub(full);
  for (const version of versions) {
    fakePlugin(folder, version);
    if (!existsSync(join(folder, ".git"))) git(folder, "init", "-q", "-b", "main");
    git(folder, "add", ".");
    git(folder, "commit", "-q", "-m", version);
    git(folder, "tag", `v${version}`);
  }
}

beforeEach(() => {
  home = realpathSync(mkdtempSync(join(tmpdir(), "skelcrew-test-")));
  mkdirSync(join(home, "bin"));
  mkdirSync(join(home, "run"), { mode: 0o700 });
  // git reaches the fake GitHub for every https://github.com/ URL.
  writeFileSync(
    join(home, ".gitconfig"),
    `[url "file://${home}/github/"]\n\tinsteadOf = https://github.com/\n`,
  );
});
afterEach(() => {
  rmSync(home, { recursive: true, force: true });
});

// Runs sc as the release given, or as a build from a checkout. What you type goes in at a
// terminal, as only an answer there installs a plugin, unless `terminal` says it is piped in.
async function skel(
  args: string[],
  typed = "",
  release = "",
  more: Record<string, string> = {},
  cwd = home,
  terminal = typed !== "",
) {
  const stamp = release ? ["--define", `SKELCREW_BUILD=${JSON.stringify(release)}`] : [];
  const argv = [process.execPath, ...stamp, source("main.ts"), ...args];
  const env = {
    PATH: `${join(home, "bin")}:${process.env.PATH ?? ""}`,
    HOME: home,
    XDG_RUNTIME_DIR: join(home, "run"),
    ...more,
  };
  if (terminal) return inTerminal(argv, { typed, env, cwd });
  const run = Bun.spawn(argv, {
    cwd,
    env,
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

// Runs code against Skelcrew's own modules in a process of its own, with this test's home, as the
// daemon would, and returns what it printed. homedir() keeps the HOME a process started with.
async function asDaemon(code: string) {
  const run = Bun.spawn([process.execPath, "-e", code], {
    cwd: home,
    env: { PATH: process.env.PATH ?? "", HOME: home, XDG_RUNTIME_DIR: join(home, "run") },
    stdout: "pipe",
    stderr: "pipe",
  });
  const [out, err, code_] = await Promise.all([
    new Response(run.stdout).text(),
    new Response(run.stderr).text(),
    run.exited,
  ]);
  return { out, err, code: code_ };
}

test("installing from GitHub shows what the plugin runs, asks, and on a bare Enter installs its newest tag", async () => {
  publish("skelcrew/skelcrew-fake", "0.1.0", "0.9.0", "0.10.0");
  const { out, err, code } = await skel(["plugin", "install", "skelcrew/skelcrew-fake"], "\n");
  expect(err).toBe("");
  expect(code).toBe(0);
  expect(
    out,
  ).toStartWith(`fake 0.10.0 from skelcrew/skelcrew-fake is an I/O plugin that provides tracker, forge. It runs these as you, outside Skelcrew's sandbox:
  bun build.ts
  sh setup.sh
  bun call.ts
  sh credentials.sh
Install it? [Y/n]`);
  expect(out).not.toContain("Tasks from a fake tracker");
  expect(out).toContain("setting up fake");
  expect(out).toContain("Installed fake 0.10.0.");
  const folder = join(plugins(), "fake", "0.10.0");
  expect(JSON.parse(readFileSync(join(folder, "built"), "utf8"))).toEqual({
    plugin: "fake",
    config: settings("fake"),
    version: "0.10.0",
  });
  expect(readFileSync(join(settings("fake"), "token"), "utf8")).toBe("secret\n");
  expect(statSync(settings("fake")).mode & 0o777).toBe(0o700);
  const listed = await skel(["plugin", "ls"]);
  expect(listed.out).toBe("fake 0.10.0 io: tracker, forge\n");
  const json = await skel(["plugin", "ls", "--json"]);
  expect(JSON.parse(json.out)).toEqual([
    {
      name: "fake",
      version: "0.10.0",
      kind: "io",
      provides: ["tracker", "forge"],
      // Tools written before kinds read jobs, so it stays.
      jobs: ["tracker", "forge"],
      from: "skelcrew/skelcrew-fake",
      change: null,
    },
  ]);
});

test("answering no installs nothing and leaves no clone behind", async () => {
  publish("skelcrew/skelcrew-fake", "0.1.0");
  const { out, code } = await skel(["plugin", "install", "skelcrew/skelcrew-fake"], "n\n");
  expect(code).toBe(0);
  expect(out).toContain("Skelcrew didn't install fake.");
  expect(existsSync(join(plugins(), "fake"))).toBe(false);
  expect((await skel(["plugin", "ls"])).out).toBe("No plugins installed.\n");
  expect(readdirSync(plugins())).toEqual([]);
});

test("a plugin that needs a newer Skelcrew is refused before anything runs", async () => {
  publish("skelcrew/skelcrew-fake", "0.1.0");
  const { err, code } = await skel(["plugin", "install", "skelcrew/skelcrew-fake"], "y\n", "0.3.9");
  expect(code).toBe(1);
  expect(err).toContain("fake 0.1.0 needs Skelcrew 0.4.0 or newer, and this is Skelcrew 0.3.9");
  expect(existsSync(join(plugins(), "fake"))).toBe(false);
  expect((await skel(["plugin", "install", "skelcrew/skelcrew-fake"], "y\n", "0.4.0")).code).toBe(
    0,
  );
});

test("a repository with no version tag, or a manifest that isn't valid, is refused", async () => {
  const untagged = onGitHub("simon/untagged");
  fakePlugin(untagged, "0.1.0");
  git(untagged, "init", "-q", "-b", "main");
  git(untagged, "add", ".");
  git(untagged, "commit", "-q", "-m", "start");
  const none = await skel(["plugin", "install", "simon/untagged"], "y\n");
  expect(none.code).toBe(1);
  expect(none.err).toContain("simon/untagged has no version tag");

  // A forge must lend git its login.
  const broken = join(home, "broken");
  fakePlugin(broken, "0.1.0");
  writeFileSync(
    join(broken, "skelcrew-plugin.yaml"),
    "name: broken\nversion: 0.1.0\nskelcrew: 0.4.0\nabout: x\njobs: [forge]\ncall: [bun, call.ts]\n",
  );
  const invalid = await skel(["plugin", "install", broken], "y\n");
  expect(invalid.code).toBe(1);
  expect(invalid.err).toContain("skelcrew-plugin.yaml isn't valid");
  expect(invalid.err).toContain("git_credentials");

  // skelcrew.yaml's tracker: none means no tracker, so no plugin may take that name.
  const named = join(home, "none");
  fakePlugin(named, "0.1.0");
  writeFileSync(
    join(named, "skelcrew-plugin.yaml"),
    "name: none\nversion: 0.1.0\nskelcrew: 0.4.0\nabout: x\njobs: [tracker]\ncall: [bun, call.ts]\n",
  );
  const reserved = await skel(["plugin", "install", named], "y\n");
  expect(reserved.code).toBe(1);
  expect(reserved.err).toContain("can't be none, which skelcrew.yaml uses for no tracker");

  // The tag says which version is installed, so a manifest that says otherwise is wrong.
  publish("simon/mislabeled", "0.1.0");
  git(onGitHub("simon/mislabeled"), "tag", "v0.2.0");
  const mislabeled = await skel(["plugin", "install", "simon/mislabeled"], "y\n");
  expect(mislabeled.code).toBe(1);
  expect(mislabeled.err).toContain("its tag v0.2.0 says 0.2.0, and its skelcrew-plugin.yaml 0.1.0");
});

test("a manifest written before kinds, with jobs:, still reads as the kind its jobs make", async () => {
  const folder = join(home, "skelcrew-fake");
  fakePlugin(folder, "0.1.0");
  const manifest = join(folder, "skelcrew-plugin.yaml");
  writeFileSync(
    manifest,
    readFileSync(manifest, "utf8").replace(
      "kind: io\nprovides: [tracker, forge]",
      "jobs: [tracker, forge]",
    ),
  );
  expect((await skel(["plugin", "install", "./skelcrew-fake"], "y\n")).code).toBe(0);
  expect((await skel(["plugin", "ls"])).out).toBe("fake 0.1.0 io: tracker, forge\n");
});

// jobs: let a plugin mix machine with I/O jobs, so one installed that way must keep working.
test("a manifest with jobs: that mixes machine with tracker still reads, as I/O", async () => {
  const folder = join(home, "skelcrew-fake");
  fakePlugin(folder, "0.1.0", 'add: ["true"]\nexec: ["true"]\npush: ["true"]\n');
  const manifest = join(folder, "skelcrew-plugin.yaml");
  writeFileSync(
    manifest,
    readFileSync(manifest, "utf8").replace(
      "kind: io\nprovides: [tracker, forge]",
      "jobs: [tracker, forge, machine]",
    ),
  );
  expect((await skel(["plugin", "install", "./skelcrew-fake"], "y\n")).code).toBe(0);
  expect((await skel(["plugin", "ls"])).out).toBe("fake 0.1.0 io: tracker, forge, machine\n");
});

// The shape of a runtime plugin such as herdr, which phase 5 builds on.
test("a runtime plugin can provide sessions, transport and status, with their commands", async () => {
  const folder = join(home, "skelcrew-fake");
  fakePlugin(folder, "0.1.0", "session: [sh, session.sh]\nattach: [sh, attach.sh]\n");
  const manifest = join(folder, "skelcrew-plugin.yaml");
  const runtime = "kind: runtime\nprovides: [sessions, transport, status]";
  writeFileSync(
    manifest,
    readFileSync(manifest, "utf8").replace("kind: io\nprovides: [tracker, forge]", runtime),
  );
  // Its session and attach commands run as you too, so the question shows them.
  const installed = await skel(["plugin", "install", "./skelcrew-fake"], "y\n");
  expect(installed.code).toBe(0);
  expect(installed.out).toContain("  sh session.sh\n  sh attach.sh\nInstall it? [Y/n]");
  expect((await skel(["plugin", "ls"])).out).toBe(
    "fake 0.1.0 runtime: sessions, transport, status\n",
  );
  // A change to either is asked about before it builds again, so with no terminal it doesn't.
  for (const [from, to] of [
    ["session.sh", "other-session.sh"],
    ["attach.sh", "other-attach.sh"],
  ]) {
    writeFileSync(manifest, readFileSync(manifest, "utf8").replace(`[sh, ${from}]`, `[sh, ${to}]`));
    const unasked = await skel(["update", "-g", "fake"], "", "", {}, home, false);
    expect(unasked.code).toBe(1);
    expect(unasked.err).toContain("Skelcrew left out fake");
    writeFileSync(manifest, readFileSync(manifest, "utf8").replace(`[sh, ${to}]`, `[sh, ${from}]`));
  }
  expect((await skel(["plugin", "rm", "fake"])).code).toBe(0);

  // Sessions need a way to attach your terminal.
  writeFileSync(manifest, readFileSync(manifest, "utf8").replace("attach: [sh, attach.sh]\n", ""));
  const refused = await skel(["plugin", "install", "./skelcrew-fake"], "y\n");
  expect(refused.code).toBe(1);
  expect(refused.err).toContain("a sessions plugin needs attach");
});

test("a manifest whose kind doesn't fit what it provides, or that mixes both shapes, is refused", async () => {
  const folder = join(home, "skelcrew-fake");
  const manifest = join(folder, "skelcrew-plugin.yaml");
  for (const [lines, said] of [
    ["kind: runtime\nprovides: [tracker, forge]", "tracker isn't for a plugin of kind runtime"],
    ["kind: io\nprovides: [tracker]\njobs: [tracker]", "goes with neither kind nor provides"],
    ["provides: [tracker]", "needs kind and provides"],
  ] as const) {
    fakePlugin(folder, "0.1.0");
    writeFileSync(
      manifest,
      readFileSync(manifest, "utf8").replace("kind: io\nprovides: [tracker, forge]", lines),
    );
    const refused = await skel(["plugin", "install", "./skelcrew-fake"], "y\n");
    expect(refused.code).toBe(1);
    expect(refused.err).toContain(said);
  }
});

test("a plugin from a folder is used where it is, and update builds it again", async () => {
  const folder = join(home, "skelcrew-fake");
  fakePlugin(folder, "0.1.0");
  const installed = await skel(["plugin", "install", "./skelcrew-fake"], "y\n");
  expect(installed.err).toBe("");
  expect(installed.out).toContain(
    "Installed fake 0.1.0.\nA plugin from a folder is on this machine only, so your config.yaml and lock leave it out.\n",
  );
  // Its path means nothing on another machine, so your files don't name it.
  expect(existsSync(join(home, ".config", "skelcrew", "config.yaml"))).toBe(false);
  expect(JSON.parse(readFileSync(join(folder, "built"), "utf8")).version).toBe("0.1.0");
  expect(existsSync(join(plugins(), "fake"))).toBe(false);
  expect(JSON.parse((await skel(["plugin", "ls", "--json"])).out)[0].from).toBe(folder);

  // With the commands you approved, it builds again without asking, even with no terminal.
  fakePlugin(folder, "0.2.0");
  const unchanged = await skel(["update", "-g", "fake"], "", "", {}, home, false);
  expect(unchanged.err).toBe("");
  expect(unchanged.code).toBe(0);
  expect(unchanged.out).not.toContain("Build it?");
  expect(unchanged.out).toContain(`Built fake 0.2.0 again from ${folder}.`);
  expect(JSON.parse(readFileSync(join(folder, "built"), "utf8")).version).toBe("0.2.0");

  // Changed commands are shown and asked about first, which needs a terminal.
  const manifest = join(folder, "skelcrew-plugin.yaml");
  fakePlugin(folder, "0.3.0");
  writeFileSync(
    manifest,
    readFileSync(manifest, "utf8").replace(
      "build: [[bun, build.ts]]",
      'build: [[bun, build.ts], ["true"]]',
    ),
  );
  const unasked = await skel(["plugin", "update", "fake"], "y\n", "", {}, home, false);
  expect(unasked.code).toBe(1);
  expect(unasked.err).toContain(
    "Skelcrew left out fake, as each runs its commands, which needs your yes at a terminal",
  );
  expect(JSON.parse(readFileSync(join(folder, "built"), "utf8")).version).toBe("0.2.0");
  const updated = await skel(["plugin", "update", "fake"], "y\n");
  expect(updated.err).toBe("");
  expect(updated.out).toContain(`fake 0.3.0 from ${folder} is an I/O plugin`);
  expect(updated.out).toContain("  true\n");
  expect(updated.out).toContain("Build it? [Y/n]");
  expect(updated.out).toContain(`Built fake 0.3.0 again from ${folder}.`);
  expect(JSON.parse(readFileSync(join(folder, "built"), "utf8")).version).toBe("0.3.0");
  // Once approved, the new commands build again without asking.
  const again = await skel(["update", "-g", "fake"], "", "", {}, home, false);
  expect(again.code).toBe(0);
  expect(again.out).not.toContain("Build it?");
  // A command whose words differ is a change, even when they read the same joined with spaces.
  writeFileSync(
    manifest,
    readFileSync(manifest, "utf8").replace("[bun, build.ts]", '["bun build.ts"]'),
  );
  const regrouped = await skel(["update", "-g", "fake"], "", "", {}, home, false);
  expect(regrouped.code).toBe(1);
  expect(regrouped.err).toContain("Skelcrew left out fake");
  // The question shows where each word ends, so you can see what changed.
  const shown = await skel(["update", "-g", "fake"], "n\n");
  expect(shown.out).toContain("\n  'bun build.ts'\n  true\n  sh setup.sh\n");
  expect(shown.out).toContain("Skelcrew didn't build fake again.");

  const removed = await skel(["plugin", "rm", "fake"]);
  expect(removed.out).toContain("Removed fake");
  expect(existsSync(folder)).toBe(true);
  expect(existsSync(settings("fake"))).toBe(false);
  expect((await skel(["plugin", "ls"])).out).toBe("No plugins installed.\n");
});

test("installing a plugin twice is refused, and points to update", async () => {
  publish("skelcrew/skelcrew-fake", "0.1.0");
  await skel(["plugin", "install", "skelcrew/skelcrew-fake"], "y\n");
  const again = await skel(["plugin", "install", "skelcrew/skelcrew-fake"], "y\n");
  expect(again.code).toBe(1);
  expect(again.err).toContain("fake is installed already: run sc update -g fake");
});

test("update moves a plugin to its newest tag after asking, and removes the old version", async () => {
  publish("skelcrew/skelcrew-fake", "0.1.0");
  await skel(["plugin", "install", "skelcrew/skelcrew-fake"], "y\n");
  const current = await skel(["plugin", "update"]);
  expect(current.out).toContain("fake is at its newest version, 0.1.0.");

  publish("skelcrew/skelcrew-fake", "0.2.0");
  const declined = await skel(["plugin", "update", "fake"], "n\n");
  expect(declined.out).toContain("Skelcrew didn't update fake.");
  expect((await skel(["plugin", "ls"])).out).toBe("fake 0.1.0 io: tracker, forge\n");

  const updated = await skel(["plugin", "update", "fake"], "\n");
  expect(updated.err).toBe("");
  expect(updated.out).toContain(
    "fake 0.2.0 from skelcrew/skelcrew-fake is an I/O plugin that provides tracker, forge.",
  );
  expect(updated.out).toContain("\nUpdate it? [Y/n]");
  expect(updated.out).toContain("Updated fake from 0.1.0 to 0.2.0.");
  expect((await skel(["plugin", "ls"])).out).toBe("fake 0.2.0 io: tracker, forge\n");
  expect(existsSync(join(plugins(), "fake", "0.1.0"))).toBe(false);
  expect(JSON.parse(readFileSync(join(plugins(), "fake", "0.2.0", "built"), "utf8")).version).toBe(
    "0.2.0",
  );
  expect((await skel(["plugin", "update", "nothing"])).err).toContain("no plugin named nothing");
});

test("rm removes a plugin's folders and settings, and refuses for a repository's tracker or forge", async () => {
  publish("skelcrew/skelcrew-fake", "0.1.0");
  await skel(["plugin", "install", "skelcrew/skelcrew-fake"], "y\n");
  // A repository Skelcrew has, whose skelcrew.yaml names fake as its tracker.
  const db = new Database(join(home, ".local", "share", "skelcrew", "skelcrew.db"));
  db.run("INSERT INTO repositories (owner, repo, name) VALUES ('simon', 'app', 'app')");
  db.close();
  const clone = join(home, ".local", "share", "skelcrew", "repos", "simon", "app");
  mkdirSync(clone, { recursive: true });
  writeFileSync(join(clone, "skelcrew.yaml"), "tracker: fake\n");
  const refused = await skel(["plugin", "rm", "fake"]);
  expect(refused.code).toBe(1);
  expect(refused.err).toContain("fake is the tracker of app");
  expect(existsSync(join(plugins(), "fake", "0.1.0"))).toBe(true);

  writeFileSync(join(clone, "skelcrew.yaml"), "tracker: github\n");
  const forged = new Database(join(home, ".local", "share", "skelcrew", "skelcrew.db"));
  forged.run("UPDATE repositories SET forge = 'fake'");
  forged.close();
  const forge = await skel(["plugin", "rm", "fake"]);
  expect(forge.code).toBe(1);
  expect(forge.err).toContain("fake is the forge of app");
  const unforged = new Database(join(home, ".local", "share", "skelcrew", "skelcrew.db"));
  unforged.run("UPDATE repositories SET forge = NULL");
  unforged.close();
  const removed = await skel(["plugin", "rm", "fake"]);
  expect(removed.err).toBe("");
  expect(removed.out).toContain("Removed fake, with its settings and tokens.");
  expect(existsSync(join(plugins(), "fake"))).toBe(false);
  expect(existsSync(settings("fake"))).toBe(false);
});

test("setup runs an installed plugin's setup again in your terminal, and nothing else", async () => {
  publish("skelcrew/skelcrew-fake", "0.1.0");
  await skel(["plugin", "install", "skelcrew/skelcrew-fake"], "y\n");
  const built = join(plugins(), "fake", "0.1.0", "built");
  rmSync(built);
  rmSync(join(settings("fake"), "token"));
  const { out, err, code } = await skel(["plugin", "setup", "fake"]);
  expect(err).toBe("");
  expect(code).toBe(0);
  expect(out).toBe("setting up fake\nRan fake's setup.\n");
  expect(readFileSync(join(settings("fake"), "token"), "utf8")).toBe("secret\n");
  // Its build ran once, at install, and setup doesn't run it again.
  expect(existsSync(built)).toBe(false);
  const none = await skel(["plugin", "setup", "nothing"]);
  expect(none.code).toBe(1);
  expect(none.err).toContain("no plugin named nothing");
});

// So the GitHub plugin can install its app on the repository you are working on.
test("setup is handed the remote of the checkout sc ran in, and nothing outside one", async () => {
  publish("skelcrew/skelcrew-fake", "0.1.0");
  const app = join(home, "app");
  mkdirSync(join(app, "src"), { recursive: true });
  git(app, "init", "-q", "-b", "main");
  git(app, "remote", "add", "origin", "git@github.com:simon/app.git");
  const remote = () => readFileSync(join(settings("fake"), "remote"), "utf8");
  const installed = await skel(
    ["plugin", "install", "skelcrew/skelcrew-fake"],
    "y\n",
    "",
    {},
    join(app, "src"),
  );
  expect(installed.err).toBe("");
  expect(remote()).toBe("git@github.com:simon/app.git\n");
  await skel(["plugin", "setup", "fake"]);
  expect(remote()).toBe("\n");
  await skel(["plugin", "setup", "fake"], "", "", {}, app);
  expect(remote()).toBe("git@github.com:simon/app.git\n");
});

test("setup says so for a plugin with no setup, and when its setup fails", async () => {
  const folder = join(home, "skelcrew-fake");
  fakePlugin(folder, "0.1.0");
  await skel(["plugin", "install", "./skelcrew-fake"], "y\n");
  writeFileSync(join(folder, "setup.sh"), "exit 1\n");
  const failed = await skel(["plugin", "setup", "fake"]);
  expect(failed.code).toBe(1);
  expect(failed.err).toBe("Skelcrew: fake's sh setup.sh failed\n");
  const manifest = join(folder, "skelcrew-plugin.yaml");
  writeFileSync(manifest, readFileSync(manifest, "utf8").replace("setup: [sh, setup.sh]\n", ""));
  const none = await skel(["plugin", "setup", "fake"]);
  expect(none.code).toBe(1);
  expect(none.err).toBe("Skelcrew: fake has no setup to run\n");
});

test("agents can't run sc plugin", async () => {
  for (const sub of ["install", "update", "setup", "rm", "ls"]) {
    const { err, code } = await skel(["plugin", sub, "x"], "", "", { SKELCREW_SANDBOX: "1" });
    expect(code).toBe(1);
    expect(err).toContain("is only for your own terminal, not for agents");
  }
});

test("a call hands the plugin one question and checks its one answer", async () => {
  publish("skelcrew/skelcrew-fake", "0.1.0");
  await skel(["plugin", "install", "skelcrew/skelcrew-fake"], "y\n");
  const ask = (question: string, timeout = 60_000) =>
    // Zod by its path in Skelcrew's checkout, as the test's home has no node_modules to find it in.
    asDaemon(`import { z } from ${JSON.stringify(Bun.resolveSync("zod", import.meta.dir))};
import { openDb } from ${JSON.stringify(source("db.ts"))};
import { callPlugin } from ${JSON.stringify(source("plugins/plugin.ts"))};
const Answer = z.looseObject({ number: z.number() });
try {
  console.log(JSON.stringify(await callPlugin(openDb(), "fake", ${question}, Answer, ${timeout})));
} catch (error) {
  console.log("error: " + error.message);
}`);
  const answered = await ask('{ ask: "changed", repository: "app" }');
  expect(answered.err).toBe("");
  expect(JSON.parse(answered.out)).toEqual({
    number: 12,
    asked: { ask: "changed", repository: "app" },
    folder: join(plugins(), "fake", "0.1.0"),
    plugin: "fake",
    config: settings("fake"),
  });
  expect((await ask('{ ask: "fail" }')).out).toBe("error: fake failed: the token expired\n");
  expect((await ask('{ ask: "lapsed" }')).out).toBe(
    "error: fake failed: your sign-in ran out. Run sc setup fake to set it up again.\n",
  );
  expect((await ask('{ ask: "bad" }')).out).toContain(
    "error: fake answered in a way Skelcrew doesn't understand",
  );
  const started = Date.now();
  expect((await ask('{ ask: "slow" }', 500)).out).toBe(
    "error: fake didn't answer within 0.5 seconds\n",
  );
  expect(Date.now() - started).toBeLessThan(10_000);
});

test("a call that hangs in a program it started still ends at its timeout, with that program", async () => {
  publish("skelcrew/skelcrew-fake", "0.1.0");
  await skel(["plugin", "install", "skelcrew/skelcrew-fake"], "y\n");
  // The call itself is timed, inside the daemon's process, as starting that process can take
  // seconds on a busy machine.
  const { out } =
    await asDaemon(`import { z } from ${JSON.stringify(Bun.resolveSync("zod", import.meta.dir))};
import { openDb } from ${JSON.stringify(source("db.ts"))};
import { callPlugin } from ${JSON.stringify(source("plugins/plugin.ts"))};
const started = Date.now();
try {
  await callPlugin(openDb(), "fake", { ask: "stuck" }, z.object({}), 500);
} catch (error) {
  console.log("error: " + error.message);
}
console.log(Date.now() - started);`);
  const [said, took] = out.split("\n");
  expect(said).toBe("error: fake didn't answer within 0.5 seconds");
  expect(Number(took)).toBeLessThan(4000);
}, 60_000);

test("git asks a forge's git_credentials for its login, which is never saved", async () => {
  publish("skelcrew/skelcrew-fake", "0.1.0");
  await skel(["plugin", "install", "skelcrew/skelcrew-fake"], "y\n");
  const { out, err } = await asDaemon(`import { openDb } from ${JSON.stringify(source("db.ts"))};
import { gitCredentials } from ${JSON.stringify(source("plugins/plugin.ts"))};
const fill = Bun.spawnSync(["git", ...gitCredentials(openDb(), "fake"), "credential", "fill"], {
  stdin: new Blob(["url=https://github.com/simon/app.git\\n\\n"]),
  env: { ...process.env, GIT_TERMINAL_PROMPT: "0" },
});
console.log(fill.stdout.toString());
console.error(fill.stderr.toString().trim());`);
  expect(err.trim()).toBe("");
  expect(out).toContain("username=x-access-token\n");
  // git hands it the repository's path, as a forge's login can be for one repository alone.
  expect(out).toContain("password=token-of-fake-for-simon/app.git\n");
  expect(readFileSync(join(home, ".gitconfig"), "utf8")).not.toContain("credential");
});

const yourConfig = () => join(home, ".config", "skelcrew", "config.yaml");
const yourLockFile = () => join(home, ".config", "skelcrew", "skelcrew.lock");
// Returns the commit a version tag of the fake GitHub's plugin is at.
const tagCommit = (full: string, version: string) =>
  git(onGitHub(full), "rev-parse", `v${version}^{commit}`).trim();

test("sc add -g installs after asking, names the plugin in your config and pins it in your lock", async () => {
  publish("skelcrew/skelcrew-fake", "0.1.0", "0.2.0");
  mkdirSync(join(home, ".config", "skelcrew"), { recursive: true });
  writeFileSync(yourConfig(), "harness: claude # mine\n");
  const added = await skel(["add", "-g", "skelcrew/skelcrew-fake"], "y\n");
  expect(added.err).toBe("");
  expect(added.out).toContain("Install it? [Y/n]");
  expect(added.out).toContain("Installed fake 0.2.0.");
  expect(readFileSync(yourConfig(), "utf8")).toBe(
    "harness: claude # mine\nplugins:\n  - skelcrew/skelcrew-fake\n",
  );
  expect(parse(readFileSync(yourLockFile(), "utf8"))).toEqual({
    "skelcrew/skelcrew-fake": {
      name: "fake",
      version: "0.2.0",
      commit: tagCommit("skelcrew/skelcrew-fake", "0.2.0"),
    },
  });
  expect((await skel(["plugins"])).out).toBe("fake 0.2.0 io: tracker, forge\n");
});

test("without a terminal nothing installs, even with a yes piped in", async () => {
  publish("skelcrew/skelcrew-fake", "0.1.0");
  const run = await skel(["add", "-g", "skelcrew/skelcrew-fake"], "y\n", "", {}, home, false);
  // It fails, so a script running it can tell the plugin isn't installed.
  expect(run.code).toBe(1);
  expect(run.out).toContain("Install it? [Y/n] There is no terminal to answer in.\n");
  expect(run.err).toContain(
    "installing fake runs its commands, which needs your yes at a terminal, so Skelcrew didn't run them",
  );
  expect(existsSync(join(plugins(), "fake"))).toBe(false);
  expect(existsSync(yourLockFile())).toBe(false);
  expect(existsSync(yourConfig())).toBe(false);
});

test("sc update -g without a terminal fails, and leaves the plugin and lock as they were", async () => {
  publish("skelcrew/skelcrew-fake", "0.1.0");
  await skel(["add", "-g", "skelcrew/skelcrew-fake"], "y\n");
  publish("skelcrew/skelcrew-fake", "0.2.0");
  const run = await skel(["update", "-g", "fake"], "y\n", "", {}, home, false);
  expect(run.code).toBe(1);
  expect(run.err).toContain(
    "Skelcrew left out fake, as each runs its commands, which needs your yes at a terminal",
  );
  expect((await skel(["plugins"])).out).toBe("fake 0.1.0 io: tracker, forge\n");
  expect(parse(readFileSync(yourLockFile(), "utf8"))["skelcrew/skelcrew-fake"].version).toBe(
    "0.1.0",
  );
});

test("sc update -g rewrites the lock only when you say yes", async () => {
  publish("skelcrew/skelcrew-fake", "0.1.0");
  await skel(["add", "-g", "skelcrew/skelcrew-fake"], "y\n");
  publish("skelcrew/skelcrew-fake", "0.2.0");
  const locked = () => parse(readFileSync(yourLockFile(), "utf8"));
  await skel(["update", "-g", "fake"], "n\n");
  expect(locked()["skelcrew/skelcrew-fake"].version).toBe("0.1.0");
  const updated = await skel(["update", "-g"], "y\n");
  expect(updated.out).toContain("Updated fake from 0.1.0 to 0.2.0.");
  expect(locked()["skelcrew/skelcrew-fake"]).toEqual({
    name: "fake",
    version: "0.2.0",
    commit: tagCommit("skelcrew/skelcrew-fake", "0.2.0"),
  });
});

test("sc remove -g takes the plugin out of your config, your lock and this machine", async () => {
  publish("skelcrew/skelcrew-fake", "0.1.0");
  await skel(["add", "-g", "skelcrew/skelcrew-fake"], "y\n");
  const removed = await skel(["remove", "-g", "fake"]);
  expect(removed.err).toBe("");
  expect(removed.out).toContain("Removed fake, with its settings and tokens.");
  expect(readFileSync(yourConfig(), "utf8")).toBe("plugins: []\n");
  expect(readFileSync(yourLockFile(), "utf8")).not.toContain("fake");
  expect(existsSync(join(plugins(), "fake"))).toBe(false);
  // One your config names that isn't installed here goes from the files alone.
  writeFileSync(yourConfig(), "plugins: [skelcrew/skelcrew-other]\n");
  const named = await skel(["remove", "-g", "skelcrew/skelcrew-other"]);
  expect(named.out).toBe("Removed skelcrew/skelcrew-other from your plugins.\n");
  expect(readFileSync(yourConfig(), "utf8")).toBe("plugins: []\n");
  expect((await skel(["remove", "-g", "nothing"])).err).toContain("no plugin named nothing");
});

test("sc plugins says what sc install would change", async () => {
  publish("skelcrew/skelcrew-fake", "0.1.0", "0.2.0");
  await skel(["add", "-g", "skelcrew/skelcrew-fake"], "y\n");
  const pinned = tagCommit("skelcrew/skelcrew-fake", "0.1.0");
  writeFileSync(
    yourLockFile(),
    `skelcrew/skelcrew-fake: { name: fake, version: 0.1.0, commit: ${pinned} }\n`,
  );
  writeFileSync(yourConfig(), "plugins: [skelcrew/skelcrew-fake, skelcrew/skelcrew-new]\n");
  expect((await skel(["plugins"])).out).toBe(
    [
      "fake 0.2.0 io: tracker, forge. sc install moves it to 0.1.0.",
      "skelcrew/skelcrew-new from skelcrew/skelcrew-new isn't installed. sc install installs its newest version.",
      "",
    ].join("\n"),
  );
});

// Only a lock makes a plugin yours, so a machine with none gets none written from the plugins it
// has, and sc install removes those no repository uses.
test("a machine with no lock gets none written from its plugins", async () => {
  publish("skelcrew/skelcrew-fake", "0.1.0");
  await skel(["add", "-g", "skelcrew/skelcrew-fake"], "y\n");
  rmSync(yourLockFile());
  rmSync(yourConfig());
  const listed = await skel(["plugins"]);
  expect(listed.out).toBe("fake 0.1.0 io: tracker, forge. sc install removes it.\n");
  expect(existsSync(yourConfig())).toBe(false);
  expect(existsSync(yourLockFile())).toBe(false);
});

test("sc remove and update without -g refuse, as a repository's plugins can't be removed or updated yet", async () => {
  for (const command of ["remove", "update"]) {
    const run = await skel([command, "skelcrew/skelcrew-fake"]);
    expect(run.code).toBe(1);
    expect(run.err).toContain(`sc ${command} -g is for your own`);
  }
});

// Returns a new checkout of simon/app in home/app, with a skelcrew.yaml of its own.
function appCheckout(): string {
  const folder = join(home, "app");
  mkdirSync(folder, { recursive: true });
  git(folder, "init", "-q", "-b", "main");
  git(folder, "remote", "add", "origin", "git@example.com:simon/app.git");
  writeFileSync(join(folder, "skelcrew.yaml"), "# Shared.\nsetup: [bun install]\n");
  return folder;
}

test("sc add without -g names the plugin in the checkout's skelcrew.yaml and pins it in its skelcrew.lock", async () => {
  publish("skelcrew/skelcrew-fake", "0.1.0", "0.2.0");
  const app = appCheckout();
  const added = await skel(["add", "skelcrew/skelcrew-fake"], "y\n", "", {}, app);
  expect(added.err).toBe("");
  expect(added.out).toContain("Install it? [Y/n]");
  expect(added.out).toContain("Installed fake 0.2.0.");
  expect(added.out).toContain(
    "Added fake 0.2.0 to skelcrew.yaml and skelcrew.lock. They count once you commit and push them.",
  );
  // The file keeps its comment and other lines.
  expect(readFileSync(join(app, "skelcrew.yaml"), "utf8")).toBe(
    "# Shared.\nsetup: [bun install]\nplugins:\n  - skelcrew/skelcrew-fake\n",
  );
  const lock = readFileSync(join(app, "skelcrew.lock"), "utf8");
  expect(lock).toStartWith("# Written by sc add and sc update. Commit it.\n");
  expect(parse(lock)).toEqual({
    "skelcrew/skelcrew-fake": {
      name: "fake",
      version: "0.2.0",
      commit: tagCommit("skelcrew/skelcrew-fake", "0.2.0"),
    },
  });
  // It is the repository's, never yours.
  expect(existsSync(yourConfig())).toBe(false);
  expect(existsSync(yourLockFile())).toBe(false);
  // Adding it again changes nothing, and asks nothing.
  const again = await skel(["add", "skelcrew/skelcrew-fake"], "", "", {}, app, false);
  expect(again.err).toBe("");
  expect(again.out).not.toContain("[Y/n]");
  expect(readFileSync(join(app, "skelcrew.lock"), "utf8")).toBe(lock);
  expect(readFileSync(join(app, "skelcrew.yaml"), "utf8")).toContain(
    "plugins:\n  - skelcrew/skelcrew-fake\n",
  );
  expect(readFileSync(join(app, "skelcrew.yaml"), "utf8").match(/skelcrew-fake/g)?.length).toBe(1);
});

// You approved the installed version already, and the lock must say what this machine runs.
test("sc add without -g pins a plugin installed here already at its version, asking nothing", async () => {
  publish("skelcrew/skelcrew-fake", "0.1.0");
  await skel(["add", "-g", "skelcrew/skelcrew-fake"], "y\n");
  publish("skelcrew/skelcrew-fake", "0.2.0");
  const app = appCheckout();
  rmSync(join(app, "skelcrew.yaml"));
  const added = await skel(["add", "skelcrew/skelcrew-fake"], "", "", {}, app, false);
  expect(added.err).toBe("");
  expect(added.out).toBe(
    "Added fake 0.1.0 to skelcrew.yaml and skelcrew.lock, at the version installed here. They count once you commit and push them.\n",
  );
  expect(parse(readFileSync(join(app, "skelcrew.yaml"), "utf8"))).toEqual({
    plugins: ["skelcrew/skelcrew-fake"],
  });
  expect(parse(readFileSync(join(app, "skelcrew.lock"), "utf8"))["skelcrew/skelcrew-fake"]).toEqual(
    { name: "fake", version: "0.1.0", commit: tagCommit("skelcrew/skelcrew-fake", "0.1.0") },
  );
});

// One name can't be two plugins, and a folder has no version a repository could pin.
test("sc add without -g refuses a plugin whose name is installed here from a folder or another source", async () => {
  publish("skelcrew/skelcrew-fake", "0.1.0");
  publish("simon/other-fake", "0.1.0");
  await skel(["add", "-g", "simon/other-fake"], "y\n");
  const app = appCheckout();
  const other = await skel(["add", "skelcrew/skelcrew-fake"], "", "", {}, app, false);
  expect(other.code).toBe(1);
  expect(other.err).toContain(
    "fake is installed here from simon/other-fake, another plugin with the same name, and one name can't be two plugins",
  );
  await skel(["remove", "-g", "fake"]);
  const folder = join(home, "skelcrew-fake");
  fakePlugin(folder, "0.1.0");
  await skel(["add", "-g", "./skelcrew-fake"], "y\n");
  const fromFolder = await skel(["add", "skelcrew/skelcrew-fake"], "", "", {}, app, false);
  expect(fromFolder.code).toBe(1);
  expect(fromFolder.err).toContain(
    `fake is installed here from the folder ${folder}, which has no version a repository could pin`,
  );
  expect(readFileSync(join(app, "skelcrew.yaml"), "utf8")).toBe(
    "# Shared.\nsetup: [bun install]\n",
  );
  expect(existsSync(join(app, "skelcrew.lock"))).toBe(false);
});

test("sc add without -g refuses outside a checkout, and for a folder, and a no writes nothing", async () => {
  publish("skelcrew/skelcrew-fake", "0.1.0");
  const outside = await skel(["add", "skelcrew/skelcrew-fake"]);
  expect(outside.code).toBe(1);
  expect(outside.err).toContain(
    "this folder isn't in a checkout of one. sc add -g adds it as yours",
  );
  const app = appCheckout();
  const folder = await skel(["add", "./skelcrew-fake"], "", "", {}, app);
  expect(folder.code).toBe(1);
  expect(folder.err).toContain("a plugin from a folder is on this machine only");
  const no = await skel(["add", "skelcrew/skelcrew-fake"], "n\n", "", {}, app);
  expect(no.out).toContain("Skelcrew didn't install fake.");
  expect(readFileSync(join(app, "skelcrew.yaml"), "utf8")).toBe(
    "# Shared.\nsetup: [bun install]\n",
  );
  expect(existsSync(join(app, "skelcrew.lock"))).toBe(false);
});

// A repository's plugin isn't yours, so sc update -g leaves it to the repository's lock.
test("sc update -g leaves a plugin only a repository names alone", async () => {
  publish("skelcrew/skelcrew-fake", "0.1.0");
  const app = appCheckout();
  await skel(["add", "skelcrew/skelcrew-fake"], "y\n", "", {}, app);
  publish("skelcrew/skelcrew-fake", "0.2.0");
  const run = await skel(["update", "-g"], "y\n");
  expect(run.out).not.toContain("Update it?");
  expect((await skel(["plugins"], "", "", {}, app, false)).out).toBe(
    "fake 0.1.0 io: tracker, forge\n",
  );
});

test("agents can't run the plugin commands", async () => {
  for (const words of [
    ["install"],
    ["add", "-g", "x"],
    ["remove", "-g", "x"],
    ["update", "-g"],
    ["setup", "x"],
    ["plugins"],
  ]) {
    const { err, code } = await skel(words, "", "", { SKELCREW_SANDBOX: "1" });
    expect(code).toBe(1);
    expect(err).toContain("is only for your own terminal, not for agents");
  }
});

// A lock copied from another machine can pin an older version than this machine has.
test("sc update -g at the newest version pins it in your lock, so sc install doesn't move it back", async () => {
  publish("skelcrew/skelcrew-fake", "0.1.0", "0.2.0");
  await skel(["add", "-g", "skelcrew/skelcrew-fake"], "y\n");
  const older = tagCommit("skelcrew/skelcrew-fake", "0.1.0");
  writeFileSync(
    yourLockFile(),
    `skelcrew/skelcrew-fake: { name: fake, version: 0.1.0, commit: ${older} }\n`,
  );
  const updated = await skel(["update", "-g", "fake"]);
  expect(updated.out).toBe("fake is at its newest version, 0.2.0.\n");
  expect(parse(readFileSync(yourLockFile(), "utf8"))["skelcrew/skelcrew-fake"]).toEqual({
    name: "fake",
    version: "0.2.0",
    commit: tagCommit("skelcrew/skelcrew-fake", "0.2.0"),
  });
  expect((await skel(["plugins"])).out).toBe("fake 0.2.0 io: tracker, forge\n");
});

// Such as when a release's tag was deleted: the newest tag left is what update moves to.
test("sc update -g moves a plugin newer than every tag back to the newest one, after asking", async () => {
  publish("skelcrew/skelcrew-fake", "0.1.0", "0.2.0");
  await skel(["add", "-g", "skelcrew/skelcrew-fake"], "y\n");
  git(onGitHub("skelcrew/skelcrew-fake"), "tag", "-d", "v0.2.0");
  const locked = () => parse(readFileSync(yourLockFile(), "utf8"))["skelcrew/skelcrew-fake"];
  const declined = await skel(["update", "-g", "fake"], "n\n");
  expect(declined.out).toContain("Skelcrew didn't update fake.");
  expect(locked().version).toBe("0.2.0");
  const updated = await skel(["update", "-g", "fake"], "y\n");
  expect(updated.err).toBe("");
  expect(updated.out).toContain("Updated fake from 0.2.0 to 0.1.0.");
  expect(locked()).toEqual({
    name: "fake",
    version: "0.1.0",
    commit: tagCommit("skelcrew/skelcrew-fake", "0.1.0"),
  });
});

// A plugin is never left running with your files saying otherwise.
test("when your lock can't be written, add and update leave the plugin and your files as they were", async () => {
  publish("skelcrew/skelcrew-fake", "0.1.0");
  mkdirSync(join(home, ".config", "skelcrew"), { recursive: true });
  writeFileSync(yourConfig(), "harness: claude\n");
  writeFileSync(yourLockFile(), "# Mine.\n");
  chmodSync(yourLockFile(), 0o444);
  const added = await skel(["add", "-g", "skelcrew/skelcrew-fake"], "y\n");
  expect(added.code).toBe(1);
  expect(readFileSync(yourConfig(), "utf8")).toBe("harness: claude\n");
  expect(readFileSync(yourLockFile(), "utf8")).toBe("# Mine.\n");
  expect(existsSync(join(plugins(), "fake"))).toBe(false);
  expect((await skel(["plugins"])).out).toBe("No plugins installed.\n");

  chmodSync(yourLockFile(), 0o644);
  await skel(["add", "-g", "skelcrew/skelcrew-fake"], "y\n");
  const pinned = readFileSync(yourLockFile(), "utf8");
  publish("skelcrew/skelcrew-fake", "0.2.0");
  chmodSync(yourLockFile(), 0o444);
  const updated = await skel(["update", "-g", "fake"], "y\n");
  expect(updated.code).toBe(1);
  expect(readFileSync(yourLockFile(), "utf8")).toBe(pinned);
  expect((await skel(["plugins"])).out).toBe("fake 0.1.0 io: tracker, forge\n");
  expect(existsSync(join(plugins(), "fake", "0.2.0"))).toBe(false);
  chmodSync(yourLockFile(), 0o644);
});

test("when your files can't be written, sc remove -g leaves the plugin installed and named", async () => {
  publish("skelcrew/skelcrew-fake", "0.1.0");
  await skel(["add", "-g", "skelcrew/skelcrew-fake"], "y\n");
  const config = readFileSync(yourConfig(), "utf8");
  const pinned = readFileSync(yourLockFile(), "utf8");
  for (const file of [yourLockFile(), yourConfig()]) {
    chmodSync(file, 0o444);
    const refused = await skel(["remove", "-g", "fake"]);
    expect(refused.code).toBe(1);
    chmodSync(file, 0o644);
    expect(readFileSync(yourConfig(), "utf8")).toBe(config);
    expect(readFileSync(yourLockFile(), "utf8")).toBe(pinned);
    expect((await skel(["plugins"])).out).toBe("fake 0.1.0 io: tracker, forge\n");
    expect(existsSync(settings("fake"))).toBe(true);
  }
  const removed = await skel(["remove", "-g", "fake"]);
  expect(removed.err).toBe("");
  expect((await skel(["plugins"])).out).toBe("No plugins installed.\n");
  expect(existsSync(settings("fake"))).toBe(false);
});

// A machine with no lock yet has nothing pinned to take out, only the line in your config.
test("sc remove -g on a machine with no lock yet takes the plugin out of your config", async () => {
  publish("skelcrew/skelcrew-fake", "0.1.0");
  await skel(["add", "-g", "skelcrew/skelcrew-fake"], "y\n");
  rmSync(yourLockFile());
  writeFileSync(yourConfig(), "harness: claude\nplugins: [skelcrew/skelcrew-fake]\n");
  const removed = await skel(["remove", "-g", "fake"]);
  expect(removed.err).toBe("");
  expect(parse(readFileSync(yourConfig(), "utf8"))).toEqual({ harness: "claude", plugins: [] });
  expect(readFileSync(yourLockFile(), "utf8")).not.toContain("fake");
  expect((await skel(["plugins"])).out).toBe("No plugins installed.\n");
});

test("sc remove -g refuses a plugin only a repository names, and keeps its settings", async () => {
  publish("skelcrew/skelcrew-fake", "0.1.0");
  const app = appCheckout();
  await skel(["add", "skelcrew/skelcrew-fake"], "y\n", "", {}, app);
  const run = await skel(["remove", "-g", "fake"]);
  expect(run.code).toBe(1);
  expect(run.err).toContain(
    "fake isn't one of your plugins, as only a repository's skelcrew.yaml names it, so Skelcrew keeps it",
  );
  expect(existsSync(join(plugins(), "fake"))).toBe(true);
  expect(existsSync(join(settings("fake"), "token"))).toBe(true);
});

test("sc plugins says what sc install would change for the repository you are in", async () => {
  publish("skelcrew/skelcrew-fake", "0.1.0", "0.2.0");
  const app = appCheckout();
  const pinned = tagCommit("skelcrew/skelcrew-fake", "0.1.0");
  writeFileSync(join(app, "skelcrew.yaml"), "plugins: [skelcrew/skelcrew-fake, simon/loose]\n");
  writeFileSync(
    join(app, "skelcrew.lock"),
    `skelcrew/skelcrew-fake: { name: fake, version: 0.1.0, commit: ${pinned} }\n`,
  );
  expect((await skel(["plugins"], "", "", {}, app, false)).out).toBe(
    [
      "fake 0.1.0 from skelcrew/skelcrew-fake isn't installed. sc install installs 0.1.0 for This checkout.",
      "simon/loose from simon/loose isn't installed. This checkout's skelcrew.lock doesn't pin it, so sc install leaves it out.",
      "",
    ].join("\n"),
  );
  // Yours at another version, the two pins disagree, so sc install leaves it.
  await skel(["add", "-g", "skelcrew/skelcrew-fake"], "y\n");
  const newest = tagCommit("skelcrew/skelcrew-fake", "0.2.0").slice(0, 12);
  expect((await skel(["plugins"], "", "", {}, app, false)).out).toStartWith(
    `fake 0.2.0 io: tracker, forge. sc install leaves it, as it is pinned at 0.2.0 at commit ${newest} by your lock, 0.1.0 at commit ${pinned.slice(0, 12)} by This checkout.\n`,
  );
  // No longer yours, it moves to the repository's pin.
  writeFileSync(yourConfig(), "");
  writeFileSync(yourLockFile(), "");
  expect((await skel(["plugins"], "", "", {}, app, false)).out).toStartWith(
    `fake 0.2.0 io: tracker, forge. sc install moves it to 0.1.0 at commit ${pinned.slice(0, 12)} for This checkout.\n`,
  );
});

test("a repository can't name a runtime plugin", async () => {
  const folder = onGitHub("skelcrew/skelcrew-runtime");
  fakePlugin(folder, "0.1.0", "session: [sh, session.sh]\nattach: [sh, attach.sh]\n");
  const manifest = join(folder, "skelcrew-plugin.yaml");
  writeFileSync(
    manifest,
    readFileSync(manifest, "utf8").replace(
      "kind: io\nprovides: [tracker, forge]",
      "kind: runtime\nprovides: [sessions]",
    ),
  );
  git(folder, "init", "-q", "-b", "main");
  git(folder, "add", ".");
  git(folder, "commit", "-q", "-m", "0.1.0");
  git(folder, "tag", "v0.1.0");
  const app = appCheckout();
  // Refused before it asks, so nothing of it runs.
  const fresh = await skel(["add", "skelcrew/skelcrew-runtime"], "y\n", "", {}, app);
  expect(fresh.code).toBe(1);
  expect(fresh.out).not.toContain("Install it?");
  expect(fresh.err).toContain(
    "fake is a runtime plugin, which is always yours and never a repository's. sc add -g adds it as yours",
  );
  expect(existsSync(join(plugins(), "fake"))).toBe(false);
  // Installed as yours, it still can't go into the repository's files.
  await skel(["add", "-g", "skelcrew/skelcrew-runtime"], "y\n");
  const yours = await skel(["add", "skelcrew/skelcrew-runtime"], "", "", {}, app, false);
  expect(yours.code).toBe(1);
  expect(yours.err).toContain("fake is a runtime plugin");
  expect(readFileSync(join(app, "skelcrew.yaml"), "utf8")).toBe(
    "# Shared.\nsetup: [bun install]\n",
  );
  expect(existsSync(join(app, "skelcrew.lock"))).toBe(false);
});

// The files and the machine change together, so an add whose files can't be written takes back
// the plugin it installed.
test("sc add without -g removes the plugin it installed when the repository's files can't be written", async () => {
  publish("skelcrew/skelcrew-fake", "0.1.0");
  const app = appCheckout();
  // skelcrew.yaml can be written, and the folder can't take a new skelcrew.lock.
  chmodSync(app, 0o555);
  try {
    const run = await skel(["add", "skelcrew/skelcrew-fake"], "y\n", "", {}, app);
    expect(run.code).not.toBe(0);
    expect(run.out).toContain("Installed fake 0.1.0.");
    expect(run.err).toContain("skelcrew.lock");
  } finally {
    chmodSync(app, 0o755);
  }
  expect(readFileSync(join(app, "skelcrew.yaml"), "utf8")).toBe(
    "# Shared.\nsetup: [bun install]\n",
  );
  expect(existsSync(join(app, "skelcrew.lock"))).toBe(false);
  expect(existsSync(join(plugins(), "fake"))).toBe(false);
  expect(existsSync(settings("fake"))).toBe(false);
  expect((await skel(["plugins"])).out).toBe("No plugins installed.\n");
});

// You approved the version installed for the repository, so making it yours asks nothing.
test("sc add -g makes a plugin installed for a repository yours, at its version, asking nothing", async () => {
  publish("skelcrew/skelcrew-fake", "0.1.0");
  const app = appCheckout();
  await skel(["add", "skelcrew/skelcrew-fake"], "y\n", "", {}, app);
  publish("skelcrew/skelcrew-fake", "0.2.0");
  const run = await skel(["add", "-g", "skelcrew/skelcrew-fake"], "", "", {}, home, false);
  expect(run.err).toBe("");
  expect(run.out).toBe("Added fake 0.1.0 to your plugins, at the version installed here.\n");
  expect(parse(readFileSync(yourConfig(), "utf8")).plugins).toEqual(["skelcrew/skelcrew-fake"]);
  expect(parse(readFileSync(yourLockFile(), "utf8"))["skelcrew/skelcrew-fake"]).toEqual({
    name: "fake",
    version: "0.1.0",
    commit: tagCommit("skelcrew/skelcrew-fake", "0.1.0"),
  });
  // Yours already, it points to sc update -g as before.
  const again = await skel(["add", "-g", "skelcrew/skelcrew-fake"], "", "", {}, home, false);
  expect(again.err).toContain("run sc update -g fake");
});

// A repository still needs it, so it keeps its folder, settings and tokens, such as its login.
test("sc remove -g keeps a plugin a repository still names installed, with its settings", async () => {
  publish("skelcrew/skelcrew-fake", "0.1.0");
  await skel(["add", "-g", "skelcrew/skelcrew-fake"], "y\n");
  const app = appCheckout();
  await skel(["add", "skelcrew/skelcrew-fake"], "", "", {}, app, false);
  // From a checkout of another repository, the one that names it is still found by its clone.
  const db = new Database(join(home, ".local", "share", "skelcrew", "skelcrew.db"));
  db.run("INSERT INTO repositories (owner, repo, name) VALUES ('simon', 'app', 'app')");
  db.close();
  const clone = join(home, ".local", "share", "skelcrew", "repos", "simon", "app");
  mkdirSync(clone, { recursive: true });
  for (const file of ["skelcrew.yaml", "skelcrew.lock"])
    writeFileSync(join(clone, file), readFileSync(join(app, file), "utf8"));
  const other = join(home, "other");
  mkdirSync(other);
  git(other, "init", "-q", "-b", "main");
  const run = await skel(["remove", "-g", "fake"], "", "", {}, other, false);
  expect(run.err).toBe("");
  expect(run.out).toBe(
    "Removed fake from your plugins. It stays installed, as app's skelcrew.yaml names it.\n",
  );
  expect(parse(readFileSync(yourConfig(), "utf8")).plugins).toEqual([]);
  expect(readFileSync(yourLockFile(), "utf8")).not.toContain("fake");
  expect(existsSync(join(plugins(), "fake", "0.1.0"))).toBe(true);
  expect(existsSync(join(settings("fake"), "token"))).toBe(true);
});

// One repository's broken lock can't hide every other plugin: sc plugins still lists them all, and
// says sc install keeps them, as what that repository needs can't be told.
test("sc plugins lists every plugin while a repository's skelcrew.lock isn't valid", async () => {
  publish("skelcrew/skelcrew-fake", "0.1.0");
  await skel(["add", "-g", "skelcrew/skelcrew-fake"], "y\n");
  writeFileSync(yourConfig(), "plugins: []\n");
  const db = new Database(join(home, ".local", "share", "skelcrew", "skelcrew.db"));
  db.run("INSERT INTO repositories (owner, repo, name) VALUES ('simon', 'app', 'app')");
  db.close();
  const clone = join(home, ".local", "share", "skelcrew", "repos", "simon", "app");
  mkdirSync(clone, { recursive: true });
  writeFileSync(join(clone, "skelcrew.lock"), "skelcrew/skelcrew-fake: [\n");
  const listed = await skel(["plugins"]);
  expect(listed.err).toBe("");
  expect(listed.out).toStartWith(
    "fake 0.1.0 io: tracker, forge. sc install keeps it, as Skelcrew can't read the plugins of app:",
  );
});

// sc install leaves a plugin whose pins disagree as it is, so sc plugins says that, not a move.
test("sc plugins shows a disagreement over the move your lock alone would make", async () => {
  publish("skelcrew/skelcrew-fake", "0.1.0", "0.2.0");
  // Installed at 0.2.0, the newest then.
  await skel(["add", "-g", "skelcrew/skelcrew-fake"], "y\n");
  publish("skelcrew/skelcrew-fake", "0.3.0");
  const app = appCheckout();
  const commit = (version: string) => tagCommit("skelcrew/skelcrew-fake", version);
  writeFileSync(join(app, "skelcrew.yaml"), "plugins: [skelcrew/skelcrew-fake]\n");
  writeFileSync(
    join(app, "skelcrew.lock"),
    `skelcrew/skelcrew-fake: { name: fake, version: 0.1.0, commit: ${commit("0.1.0")} }\n`,
  );
  // Your lock pins 0.3.0, which alone would move the plugin there.
  const pinYours = () =>
    writeFileSync(
      yourLockFile(),
      `skelcrew/skelcrew-fake: { name: fake, version: 0.3.0, commit: ${commit("0.3.0")} }\n`,
    );
  pinYours();
  const leaves = `sc install leaves it, as it is pinned at 0.3.0 at commit ${commit("0.3.0").slice(0, 12)} by your lock, 0.1.0 at commit ${commit("0.1.0").slice(0, 12)} by This checkout.`;
  expect((await skel(["plugins"], "", "", {}, app, false)).out).toBe(
    `fake 0.2.0 io: tracker, forge. ${leaves}\n`,
  );
  // Not installed here, it would be installed at 0.3.0 but for the disagreement.
  await skel(["remove", "-g", "fake"]);
  writeFileSync(yourConfig(), "plugins: [skelcrew/skelcrew-fake]\n");
  pinYours();
  expect((await skel(["plugins"], "", "", {}, app, false)).out).toBe(
    `fake 0.3.0 from skelcrew/skelcrew-fake isn't installed. ${leaves}\n`,
  );
});
