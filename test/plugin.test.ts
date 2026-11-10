// Plugins: skel plugin install, update, rm and ls run as you would run them, and the daemon's
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

const plugins = () => join(home, ".local", "share", "skel", "plugins");
const settings = (name: string) => join(home, ".config", "skel", "plugins", name);
const onGitHub = (full: string) => join(home, "github", full);

// The fake plugin's files. Its build runs on Bun and its setup in your terminal, and each
// leaves a mark of what it was handed. Its call answers what it is asked, or fails, hangs or
// answers in the wrong shape when asked to.
function fakePlugin(folder: string, version: string, more = ""): void {
  mkdirSync(folder, { recursive: true });
  writeFileSync(
    join(folder, "skel-plugin.yaml"),
    `name: fake
version: ${version}
skel: 0.4.0
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
    `await Bun.write("built", JSON.stringify({ plugin: process.env.SKEL_PLUGIN, config: process.env.SKEL_PLUGIN_CONFIG, version: ${JSON.stringify(version)} }));\n`,
  );
  writeFileSync(
    join(folder, "setup.sh"),
    'echo "setting up $SKEL_PLUGIN"\necho secret > "$SKEL_PLUGIN_CONFIG/token"\n',
  );
  writeFileSync(
    join(folder, "call.ts"),
    `const question = JSON.parse(await Bun.stdin.text());
if (question.ask === "fail") {
  console.error("starting");
  console.error("the token expired");
  process.exit(1);
}
if (question.ask === "slow") await Bun.sleep(30_000);
// A plugin that hangs in a program it started, which keeps its output open after it ends.
if (question.ask === "stuck") {
  Bun.spawn(["sleep", "30"], { stdout: "inherit", stderr: "inherit" });
  await Bun.sleep(30_000);
}
if (question.ask === "bad") console.log(JSON.stringify({ number: "twelve" }));
else console.log(JSON.stringify({ number: 12, asked: question, folder: process.cwd(), plugin: process.env.SKEL_PLUGIN, config: process.env.SKEL_PLUGIN_CONFIG }));
`,
  );
  writeFileSync(
    join(folder, "credentials.sh"),
    'test "$1" = get || exit 0\ncat > /dev/null\necho username=x-access-token\necho "password=token-of-$SKEL_PLUGIN"\n',
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
  home = realpathSync(mkdtempSync(join(tmpdir(), "skel-plugin-test-")));
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

// Runs skel as the release given, or as a build from a checkout, with what you type.
async function skel(args: string[], typed = "", release = "", more: Record<string, string> = {}) {
  const stamp = release ? ["--define", `SKEL_BUILD=${JSON.stringify(release)}`] : [];
  const run = Bun.spawn([process.execPath, ...stamp, source("main.ts"), ...args], {
    cwd: home,
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

// Runs code against skel's own modules in a process of its own, with this test's home, as the
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

test("installing from GitHub shows what the plugin runs, asks, and installs its newest tag", async () => {
  publish("skelcrew/skel-plugin-fake", "0.1.0", "0.9.0", "0.10.0");
  const { out, err, code } = await skel(["plugin", "install", "skelcrew/skel-plugin-fake"], "y\n");
  expect(err).toBe("");
  expect(code).toBe(0);
  expect(out).toContain("fake 0.10.0");
  expect(out).toContain("Tasks from a fake tracker");
  expect(out).toContain("tracker, forge");
  for (const command of ["bun build.ts", "sh setup.sh", "bun call.ts", "sh credentials.sh"])
    expect(out).toContain(command);
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
      from: "skelcrew/skel-plugin-fake",
    },
  ]);
});

test("answering no installs nothing and leaves no clone behind", async () => {
  publish("skelcrew/skel-plugin-fake", "0.1.0");
  const { out, code } = await skel(["plugin", "install", "skelcrew/skel-plugin-fake"], "n\n");
  expect(code).toBe(0);
  expect(out).toContain("skel didn't install fake.");
  expect(existsSync(join(plugins(), "fake"))).toBe(false);
  expect((await skel(["plugin", "ls"])).out).toBe("No plugins installed.\n");
  expect(readdirSync(plugins())).toEqual([]);
});

test("a plugin that needs a newer skel is refused before anything runs", async () => {
  publish("skelcrew/skel-plugin-fake", "0.1.0");
  const { err, code } = await skel(
    ["plugin", "install", "skelcrew/skel-plugin-fake"],
    "y\n",
    "0.3.9",
  );
  expect(code).toBe(1);
  expect(err).toContain("fake 0.1.0 needs skel 0.4.0 or newer, and this is skel 0.3.9");
  expect(existsSync(join(plugins(), "fake"))).toBe(false);
  expect(
    (await skel(["plugin", "install", "skelcrew/skel-plugin-fake"], "y\n", "0.4.0")).code,
  ).toBe(0);
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
    join(broken, "skel-plugin.yaml"),
    "name: broken\nversion: 0.1.0\nskel: 0.4.0\nabout: x\njobs: [forge]\ncall: [bun, call.ts]\n",
  );
  const invalid = await skel(["plugin", "install", broken], "y\n");
  expect(invalid.code).toBe(1);
  expect(invalid.err).toContain("skel-plugin.yaml isn't valid");
  expect(invalid.err).toContain("git_credentials");

  // The tag says which version is installed, so a manifest that says otherwise is wrong.
  publish("simon/mislabeled", "0.1.0");
  git(onGitHub("simon/mislabeled"), "tag", "v0.2.0");
  const mislabeled = await skel(["plugin", "install", "simon/mislabeled"], "y\n");
  expect(mislabeled.code).toBe(1);
  expect(mislabeled.err).toContain("its tag v0.2.0 says 0.2.0, and its skel-plugin.yaml 0.1.0");
});

test("a plugin from a folder is used where it is, and update builds it again", async () => {
  const folder = join(home, "skel-plugin-fake");
  fakePlugin(folder, "0.1.0");
  const installed = await skel(["plugin", "install", "./skel-plugin-fake"], "y\n");
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
  publish("skelcrew/skel-plugin-fake", "0.1.0");
  await skel(["plugin", "install", "skelcrew/skel-plugin-fake"], "y\n");
  const again = await skel(["plugin", "install", "skelcrew/skel-plugin-fake"], "y\n");
  expect(again.code).toBe(1);
  expect(again.err).toContain("fake is installed already: run skel plugin update fake");
});

test("update moves a plugin to its newest tag after asking, and removes the old version", async () => {
  publish("skelcrew/skel-plugin-fake", "0.1.0");
  await skel(["plugin", "install", "skelcrew/skel-plugin-fake"], "y\n");
  const current = await skel(["plugin", "update"]);
  expect(current.out).toContain("fake is at its newest version, 0.1.0.");

  publish("skelcrew/skel-plugin-fake", "0.2.0");
  const declined = await skel(["plugin", "update", "fake"], "n\n");
  expect(declined.out).toContain("skel didn't update fake.");
  expect((await skel(["plugin", "ls"])).out).toBe("fake 0.1.0 tracker, forge\n");

  const updated = await skel(["plugin", "update", "fake"], "y\n");
  expect(updated.err).toBe("");
  expect(updated.out).toContain("bun build.ts");
  expect(updated.out).toContain("Updated fake from 0.1.0 to 0.2.0.");
  expect((await skel(["plugin", "ls"])).out).toBe("fake 0.2.0 tracker, forge\n");
  expect(existsSync(join(plugins(), "fake", "0.1.0"))).toBe(false);
  expect(JSON.parse(readFileSync(join(plugins(), "fake", "0.2.0", "built"), "utf8")).version).toBe(
    "0.2.0",
  );
  expect((await skel(["plugin", "update", "nothing"])).err).toContain("no plugin named nothing");
});

test("rm removes a plugin's folders and settings, and refuses for a repository's tracker", async () => {
  publish("skelcrew/skel-plugin-fake", "0.1.0");
  await skel(["plugin", "install", "skelcrew/skel-plugin-fake"], "y\n");
  // A repository skel has, whose skelcrew.yaml names fake as its tracker.
  const db = new Database(join(home, ".local", "share", "skel", "skel.db"));
  db.run("INSERT INTO repositories (owner, repo, name) VALUES ('simon', 'app', 'app')");
  db.close();
  const clone = join(home, ".local", "share", "skel", "repos", "simon", "app");
  mkdirSync(clone, { recursive: true });
  writeFileSync(join(clone, "skelcrew.yaml"), "tracker: fake\n");
  const refused = await skel(["plugin", "rm", "fake"]);
  expect(refused.code).toBe(1);
  expect(refused.err).toContain("fake is the tracker of app");
  expect(existsSync(join(plugins(), "fake", "0.1.0"))).toBe(true);

  writeFileSync(join(clone, "skelcrew.yaml"), "tracker: github\n");
  const removed = await skel(["plugin", "rm", "fake"]);
  expect(removed.err).toBe("");
  expect(removed.out).toContain("Removed fake, with its settings and tokens.");
  expect(existsSync(join(plugins(), "fake"))).toBe(false);
  expect(existsSync(settings("fake"))).toBe(false);
});

test("agents can't run skel plugin", async () => {
  for (const sub of ["install", "update", "rm", "ls"]) {
    const { err, code } = await skel(["plugin", sub, "x"], "", "", { SKEL_SANDBOX: "1" });
    expect(code).toBe(1);
    expect(err).toContain("is only for your own terminal, not for agents");
  }
});

test("a call hands the plugin one question and checks its one answer", async () => {
  publish("skelcrew/skel-plugin-fake", "0.1.0");
  await skel(["plugin", "install", "skelcrew/skel-plugin-fake"], "y\n");
  const ask = (question: string, timeout = 60_000) =>
    // Zod by its path in skel's checkout, as the test's home has no node_modules to find it in.
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
  expect((await ask('{ ask: "bad" }')).out).toContain(
    "error: fake answered in a way skel doesn't understand",
  );
  const started = Date.now();
  expect((await ask('{ ask: "slow" }', 500)).out).toBe(
    "error: fake didn't answer within 0.5 seconds\n",
  );
  expect(Date.now() - started).toBeLessThan(10_000);
});

test("a call that hangs in a program it started still ends at its timeout, with that program", async () => {
  publish("skelcrew/skel-plugin-fake", "0.1.0");
  await skel(["plugin", "install", "skelcrew/skel-plugin-fake"], "y\n");
  const started = Date.now();
  const { out } =
    await asDaemon(`import { z } from ${JSON.stringify(Bun.resolveSync("zod", import.meta.dir))};
import { openDb } from ${JSON.stringify(source("db.ts"))};
import { callPlugin } from ${JSON.stringify(source("plugins/plugin.ts"))};
try {
  await callPlugin(openDb(), "fake", { ask: "stuck" }, z.object({}), 500);
} catch (error) {
  console.log("error: " + error.message);
}`);
  expect(out).toBe("error: fake didn't answer within 0.5 seconds\n");
  expect(Date.now() - started).toBeLessThan(4000);
}, 40_000);

test("git asks a forge's git_credentials for its login, which is never saved", async () => {
  publish("skelcrew/skel-plugin-fake", "0.1.0");
  await skel(["plugin", "install", "skelcrew/skel-plugin-fake"], "y\n");
  const { out, err } = await asDaemon(`import { openDb } from ${JSON.stringify(source("db.ts"))};
import { gitCredentials } from ${JSON.stringify(source("plugins/plugin.ts"))};
const fill = Bun.spawnSync(["git", ...gitCredentials(openDb(), "fake"), "credential", "fill"], {
  stdin: new Blob(["protocol=https\\nhost=github.com\\npath=simon/app.git\\n\\n"]),
  env: { ...process.env, GIT_TERMINAL_PROMPT: "0" },
});
console.log(fill.stdout.toString());
console.error(fill.stderr.toString().trim());`);
  expect(err.trim()).toBe("");
  expect(out).toContain("username=x-access-token\n");
  expect(out).toContain("password=token-of-fake\n");
  expect(readFileSync(join(home, ".gitconfig"), "utf8")).not.toContain("credential");
});
