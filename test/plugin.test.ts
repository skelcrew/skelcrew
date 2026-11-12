// Plugins: sc plugin install, update, rm and ls run as you would run them, and the daemon's
// calls and git logins through a plugin. A folder of git repositories with version tags stands
// in for GitHub, and a small fake plugin for a real one.
import { Database } from "bun:sqlite";
import { afterEach, beforeEach, expect, test } from "bun:test";
import {
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
import { git, source } from "./harness.ts";

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
jobs: [tracker, forge]
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

// Runs sc as the release given, or as a build from a checkout, with what you type.
async function skel(
  args: string[],
  typed = "",
  release = "",
  more: Record<string, string> = {},
  cwd = home,
) {
  const stamp = release ? ["--define", `SKELCREW_BUILD=${JSON.stringify(release)}`] : [];
  const run = Bun.spawn([process.execPath, ...stamp, source("main.ts"), ...args], {
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

test("installing from GitHub warns in one line, asks, and installs its newest tag", async () => {
  publish("skelcrew/skelcrew-fake", "0.1.0", "0.9.0", "0.10.0");
  const { out, err, code } = await skel(["plugin", "install", "skelcrew/skelcrew-fake"], "y\n");
  expect(err).toBe("");
  expect(code).toBe(0);
  expect(out).toStartWith(
    "fake 0.10.0 from skelcrew/skelcrew-fake runs as you, outside Skelcrew's sandbox. Install it? [y/N]",
  );
  expect(out).not.toContain("Tasks from a fake tracker");
  expect(out).not.toContain("bun call.ts");
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
  expect(listed.out).toBe("fake 0.10.0 tracker, forge\n");
  const json = await skel(["plugin", "ls", "--json"]);
  expect(JSON.parse(json.out)).toEqual([
    {
      name: "fake",
      version: "0.10.0",
      jobs: ["tracker", "forge"],
      from: "skelcrew/skelcrew-fake",
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

test("a plugin from a folder is used where it is, and update builds it again", async () => {
  const folder = join(home, "skelcrew-fake");
  fakePlugin(folder, "0.1.0");
  const installed = await skel(["plugin", "install", "./skelcrew-fake"], "y\n");
  expect(installed.err).toBe("");
  expect(installed.out).toContain("Installed fake 0.1.0.");
  expect(JSON.parse(readFileSync(join(folder, "built"), "utf8")).version).toBe("0.1.0");
  expect(existsSync(join(plugins(), "fake"))).toBe(false);
  expect(JSON.parse((await skel(["plugin", "ls", "--json"])).out)[0].from).toBe(folder);

  fakePlugin(folder, "0.2.0");
  const updated = await skel(["plugin", "update", "fake"]);
  expect(updated.err).toBe("");
  expect(updated.out).toContain(`Built fake 0.2.0 again from ${folder}.`);
  expect(JSON.parse(readFileSync(join(folder, "built"), "utf8")).version).toBe("0.2.0");

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
  expect(again.err).toContain("fake is installed already: run sc plugin update fake");
});

test("update moves a plugin to its newest tag after asking, and removes the old version", async () => {
  publish("skelcrew/skelcrew-fake", "0.1.0");
  await skel(["plugin", "install", "skelcrew/skelcrew-fake"], "y\n");
  const current = await skel(["plugin", "update"]);
  expect(current.out).toContain("fake is at its newest version, 0.1.0.");

  publish("skelcrew/skelcrew-fake", "0.2.0");
  const declined = await skel(["plugin", "update", "fake"], "n\n");
  expect(declined.out).toContain("Skelcrew didn't update fake.");
  expect((await skel(["plugin", "ls"])).out).toBe("fake 0.1.0 tracker, forge\n");

  const updated = await skel(["plugin", "update", "fake"], "y\n");
  expect(updated.err).toBe("");
  expect(updated.out).toContain(
    "fake 0.2.0 from skelcrew/skelcrew-fake runs as you, outside Skelcrew's sandbox. Update it? [y/N]",
  );
  expect(updated.out).toContain("Updated fake from 0.1.0 to 0.2.0.");
  expect((await skel(["plugin", "ls"])).out).toBe("fake 0.2.0 tracker, forge\n");
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
    "error: fake failed: your sign-in ran out. Run sc plugin setup fake to set it up again.\n",
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
