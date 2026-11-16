// Your setup copied from the laptop to a server by sc --remote: config.yaml, the agents' Claude
// Code token and your plugins. A laptop and a server each get a home folder of the test. A fake
// ssh and scp reach the server's, where the real Skelcrew of this checkout runs, and a folder of
// git repositories with version tags stands in for GitHub.
import { afterEach, beforeEach, expect, test } from "bun:test";
import {
  existsSync,
  mkdirSync,
  mkdtempSync,
  readFileSync,
  realpathSync,
  rmSync,
  statSync,
  writeFileSync,
} from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { z } from "zod";
import { git, source } from "./harness.ts";

let root = "";
const laptop = () => join(root, "laptop");
const server = () => join(root, "server");
const laptopConfig = () => join(laptop(), ".config", "skelcrew");
const serverConfig = () => join(server(), ".config", "skelcrew");

beforeEach(() => {
  root = realpathSync(mkdtempSync(join(tmpdir(), "skel-copy-setup-test-")));
  for (const home of [laptop(), server()]) {
    mkdirSync(join(home, "run"), { recursive: true, mode: 0o700 });
    // git reaches the fake GitHub for every https://github.com/ URL, on both machines.
    writeFileSync(
      join(home, ".gitconfig"),
      `[url "file://${root}/github/"]\n\tinsteadOf = https://github.com/\n`,
    );
  }
  mkdirSync(join(root, "bin"));
  mkdirSync(join(root, "serverbin"));
  const log = join(root, "calls");
  // Like ssh, it joins the words after the host into one line for the server's shell, which
  // runs in the server's home.
  writeFileSync(
    join(root, "bin", "ssh"),
    `#!/bin/sh
echo "ssh $*" >> "${log}"
test "$1" = -t && shift
shift
cd "${server()}" && HOME="${server()}" XDG_RUNTIME_DIR="${server()}/run" PATH="${root}/serverbin:/usr/bin:/bin" exec sh -c "$*"`,
    { mode: 0o755 },
  );
  writeFileSync(
    join(root, "bin", "scp"),
    `#!/bin/sh\necho "scp $*" >> "${log}"\ncp "$1" "${server()}/\${2#*:}"\n`,
    { mode: 0o755 },
  );
  // The server's Skelcrew is this checkout's, as one copied there would be.
  writeFileSync(
    join(root, "serverbin", "sc"),
    `#!/bin/sh\nexec "${process.execPath}" "${source("main.ts")}" "$@"\n`,
    { mode: 0o755 },
  );
});
afterEach(() => {
  rmSync(root, { recursive: true, force: true });
});

// Puts a plugin named fake on the fake GitHub as owner/<repo>, with a commit and a tag for each
// version. Its setup says it ran, and leaves a sign-in of the machine it ran on. `machine` makes
// it a machine plugin, which belongs on the laptop.
function publish(versions: string[], machine = false, repo = "fake"): void {
  const jobs = machine ? '[machine]\nadd: ["true"]\nexec: ["true"]\npush: ["true"]' : "[tracker]";
  const folder = join(root, "github", "owner", repo);
  mkdirSync(folder, { recursive: true });
  for (const version of versions) {
    writeFileSync(
      join(folder, "skelcrew-plugin.yaml"),
      `name: fake\nversion: ${version}\nskelcrew: 0.1.0\nabout: A fake tracker\njobs: ${jobs}\nsetup: [sh, setup.sh]\ncall: ["true"]\n`,
    );
    writeFileSync(
      join(folder, "setup.sh"),
      'echo "setting up fake"\necho "$HOME" > "$SKELCREW_PLUGIN_CONFIG/signed-in"\n',
    );
    if (!existsSync(join(folder, ".git"))) git(folder, "init", "-q", "-b", "main");
    git(folder, "add", ".");
    git(folder, "commit", "-q", "-m", version);
    git(folder, "tag", `v${version}`);
  }
}

// Gives the laptop a finished setup: a harness in config.yaml and the agents' token.
function setUpLaptop(config = "harness: claude\n"): void {
  mkdirSync(laptopConfig(), { recursive: true });
  writeFileSync(join(laptopConfig(), "config.yaml"), config);
  writeFileSync(join(laptopConfig(), "claude-token"), "sk-ant-oat01-laptop\n", { mode: 0o600 });
}

// Runs sc on a machine with this home, with what you type, and returns what it said.
async function skel(home: string, args: string[], typed = "") {
  const run = Bun.spawn([process.execPath, source("main.ts"), ...args], {
    cwd: home,
    env: {
      HOME: home,
      XDG_RUNTIME_DIR: join(home, "run"),
      PATH: `${join(root, home === server() ? "serverbin" : "bin")}:/usr/bin:/bin`,
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

// Runs sc --remote from the laptop. The server's first run never finishes in these tests, so
// each run ends saying it isn't set up, after the setup is copied.
const remote = (...args: string[]) => skel(laptop(), ["--remote", "simon@workbox", ...args]);

const calls = () =>
  existsSync(join(root, "calls")) ? readFileSync(join(root, "calls"), "utf8") : "";
const serverFile = (file: string) => readFileSync(join(serverConfig(), file), "utf8");
const serverPlugins = async () => (await skel(server(), ["plugin", "ls"])).out;
// Returns the repository each plugin on the server came from, by name.
const serverSources = async () =>
  Object.fromEntries(
    z
      .array(z.object({ name: z.string(), from: z.string() }))
      .parse(JSON.parse((await skel(server(), ["plugin", "ls", "--json"])).out))
      .map((plugin) => [plugin.name, plugin.from]),
  );

test("the first sc --remote copies your config, token and plugins, and runs each plugin's setup there", async () => {
  setUpLaptop();
  publish(["0.1.0"]);
  expect((await skel(laptop(), ["plugin", "install", "owner/fake"], "\n")).code).toBe(0);
  const run = await remote("ps");
  expect(run.out).toContain("setting up fake");
  expect(serverFile("config.yaml")).toBe("harness: claude\n");
  expect(serverFile("claude-token")).toBe("sk-ant-oat01-laptop\n");
  expect(statSync(join(serverConfig(), "claude-token")).mode & 0o777).toBe(0o600);
  expect(await serverPlugins()).toBe("fake 0.1.0 tracker\n");
  // The plugin signed in on the server by itself, and the laptop's sign-in stayed home.
  expect(serverFile("plugins/fake/signed-in")).toBe(`${server()}\n`);
  // What was sent over is gone once it is taken.
  expect(existsSync(join(serverConfig(), "laptop-setup.json"))).toBe(false);
});

test("a plugin goes there at the laptop's version, not its newest", async () => {
  setUpLaptop();
  publish(["0.1.0"]);
  await skel(laptop(), ["plugin", "install", "owner/fake"], "\n");
  publish(["0.2.0"]);
  await remote("ps");
  expect(await serverPlugins()).toBe("fake 0.1.0 tracker\n");
  // The laptop moving to a new version moves the server too.
  await skel(laptop(), ["plugin", "update", "fake"], "\n");
  await remote("ps");
  expect(await serverPlugins()).toBe("fake 0.2.0 tracker\n");
});

test("nothing is copied again until the laptop's setup changes, and a plugin's setup runs there once", async () => {
  setUpLaptop();
  publish(["0.1.0"]);
  await skel(laptop(), ["plugin", "install", "owner/fake"], "\n");
  await remote("ps");
  rmSync(join(root, "calls"));
  const again = await remote("ps");
  expect(again.out).not.toContain("setting up fake");
  expect(calls()).not.toContain("scp");
  expect(calls().trim().split("\n")).toHaveLength(1);
  setUpLaptop("harness: claude\nmodel: opus\n");
  await remote("ps");
  expect(serverFile("config.yaml")).toBe("harness: claude\nmodel: opus\n");
});

test("a plugin removed on the laptop is removed there", async () => {
  setUpLaptop();
  publish(["0.1.0"]);
  await skel(laptop(), ["plugin", "install", "owner/fake"], "\n");
  await remote("ps");
  await skel(laptop(), ["plugin", "rm", "fake"]);
  await remote("ps");
  expect(await serverPlugins()).toBe("No plugins installed.\n");
});

test("a change made on the server is replaced by the laptop's setup", async () => {
  setUpLaptop();
  await remote("ps");
  writeFileSync(join(serverConfig(), "config.yaml"), "harness: codex\n");
  await remote("ps");
  expect(serverFile("config.yaml")).toBe("harness: claude\n");
});

test("a plugin installed from a folder isn't copied", async () => {
  setUpLaptop();
  publish(["0.1.0"]);
  const folder = join(root, "github", "owner", "fake");
  expect((await skel(laptop(), ["plugin", "install", folder], "\n")).code).toBe(0);
  await remote("ps");
  expect(serverFile("config.yaml")).toBe("harness: claude\n");
  expect(await serverPlugins()).toBe("No plugins installed.\n");
});

// A plugin is the code of the repository it came from, so one of the same name from another
// repository is never kept or updated in its place.
test("a plugin there of the same name from another repository is replaced by the laptop's", async () => {
  setUpLaptop();
  publish(["0.1.0"]);
  publish(["0.1.0"], false, "other");
  await skel(laptop(), ["plugin", "install", "owner/fake"], "\n");
  expect((await skel(server(), ["plugin", "install", "owner/other"], "\n")).code).toBe(0);
  await remote("ps");
  expect(await serverSources()).toEqual({ fake: "owner/fake" });
});

test("a plugin there from another repository that is a forge stays, says so, and isn't updated", async () => {
  setUpLaptop();
  publish(["0.1.0"]);
  publish(["0.1.0", "0.2.0"], false, "other");
  await skel(laptop(), ["plugin", "install", "owner/fake"], "\n");
  await skel(server(), ["plugin", "install", "owner/other"], "\n");
  // The server's plugin is the forge of a repository there, so it can't be removed.
  const code = `import { openDb } from ${JSON.stringify(source("db.ts"))};
openDb().run("INSERT INTO repositories (owner, repo, name, forge) VALUES ('simon', 'app', 'app', 'fake')");`;
  const env = { HOME: server(), PATH: "/usr/bin:/bin" };
  expect(Bun.spawnSync([process.execPath, "-e", code], { env }).success).toBe(true);
  const run = await remote("ps");
  expect(run.out).toContain(
    "Skelcrew couldn't replace fake from owner/other here with the one from owner/fake on your laptop",
  );
  expect(run.out).toContain("Your command still runs.");
  expect(await serverSources()).toEqual({ fake: "owner/other" });
  expect(await serverPlugins()).toBe("fake 0.2.0 tracker\n");
});

test("a machine plugin stays on the laptop", async () => {
  setUpLaptop();
  publish(["0.1.0"], true);
  expect((await skel(laptop(), ["plugin", "install", "owner/fake"], "\n")).code).toBe(0);
  await remote("ps");
  expect(serverFile("config.yaml")).toBe("harness: claude\n");
  expect(await serverPlugins()).toBe("No plugins installed.\n");
});

test("a laptop with no setup copies nothing", async () => {
  const run = await remote("ps");
  expect(run.err).toContain("simon@workbox isn't set up");
  expect(calls()).not.toContain("scp");
  expect(existsSync(join(serverConfig(), "config.yaml"))).toBe(false);
});
