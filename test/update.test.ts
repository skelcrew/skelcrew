// Updates: a release of Skelcrew installing a newer one in the background, from a fake release
// server, the sidebar's notice that it waits for a restart, Skelcrew restarting the daemon on
// the new release before you attach, and sc restart restarting it when you ask.
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
  writeFileSync,
} from "node:fs";
import { hostname, tmpdir, userInfo } from "node:os";
import { dirname, join } from "node:path";
import type { Subprocess } from "bun";
import { git, homeEnv, source, until, writeScript } from "./harness.ts";

let home = "";
let releases: ReturnType<typeof Bun.serve>;
// What the fake release server has, by path, and the paths it was asked for.
let files = new Map<string, string>();
let asked: string[] = [];
const running: Subprocess[] = [];

// The release file for this machine, as the install script names it.
const asset = `skelcrew-${process.platform === "darwin" ? "darwin" : "linux"}-${process.arch === "arm64" ? "arm64" : "x64"}`;
const sum = (text: string) => new Bun.CryptoHasher("sha256").update(text).digest("hex");
// A stand-in for a Skelcrew binary that says which release it is, and notes any other command.
const binary = (version: string) =>
  `#!/bin/sh\ntest "$1" = --version && echo "skelcrew ${version}" && exit 0\necho "sc $*" >> "$HOME/calls"\n`;
const installed = () => join(home, "bin", "sc");
// The release the daemon noted it installed, from the database, or null with none.
function marker(): string | null {
  const file = join(home, ".local", "share", "skelcrew", "skelcrew.db");
  if (!existsSync(file)) return null;
  const db = new Database(file);
  try {
    const row = db.query("SELECT release FROM installed").get();
    return row && typeof row === "object" && "release" in row ? String(row.release) : null;
  } catch {
    return null;
  } finally {
    db.close();
  }
}

// Puts a release on the fake server as the latest, as GitHub lays one out.
function latest(text: string, listed = sum(text)): void {
  files.set(`/latest/download/${asset}`, text);
  files.set("/latest/download/SHA256SUMS", `${sum("other")}  skel-other\n${listed}  ${asset}\n`);
}

beforeEach(() => {
  home = realpathSync(mkdtempSync(join(tmpdir(), "skel-update-test-")));
  mkdirSync(join(home, "bin"));
  mkdirSync(join(home, "run"), { mode: 0o700 });
  writeFileSync(installed(), binary("0.4.2"), { mode: 0o755 });
  files = new Map();
  asked = [];
  releases = Bun.serve({
    port: 0,
    fetch(request) {
      const path = new URL(request.url).pathname;
      asked.push(path);
      const file = files.get(path);
      return file === undefined ? new Response("no", { status: 404 }) : new Response(file);
    },
  });
});
afterEach(async () => {
  releases.stop(true);
  for (const run of running.splice(0)) {
    run.kill();
    await run.exited;
  }
  rmSync(home, { recursive: true, force: true });
});

// The environment of Skelcrew in these tests. Its PATH holds the test's fakes, bun and the
// system's own folders, and nothing else of this machine's. systemctl and launchctl are in the system's folders, so every test that can
// reach them puts fakes in front.
const env = () => ({
  ...homeEnv(home),
  PATH: `${join(home, "bin")}:${dirname(process.execPath)}:/usr/bin:/bin`,
});

// Runs code that uses Skelcrew's modules in a process of its own with the test's home, as Skelcrew
// stamped with `build` and the fake release server would run it, and returns what it printed.
// `more` adds to its environment.
async function inProcess(code: string, build?: string, more: Record<string, string> = {}) {
  const define =
    build === undefined
      ? []
      : [
          "--define",
          `SKELCREW_BUILD=${JSON.stringify(build)}`,
          "--define",
          `SKELCREW_RELEASES=${JSON.stringify(`http://127.0.0.1:${releases.port}`)}`,
        ];
  const run = Bun.spawn([process.execPath, ...define, "-e", code], {
    env: { ...env(), ...more },
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

// Has Skelcrew look for a newer release and install it over the stand-in Skelcrew.
const installLatest = () =>
  inProcess(`import { installLatest } from ${JSON.stringify(source("machine/update.ts"))};
import { openDb } from ${JSON.stringify(source("db.ts"))};
console.log(await installLatest(${JSON.stringify(installed())}, "http://127.0.0.1:${releases.port}", openDb()));`);

test("installs a newer release over Skelcrew, and notes which one", async () => {
  latest(binary("0.4.3"));
  const done = await installLatest();
  expect(done.err).toBe("");
  expect(done.out).toBe("0.4.3\n");
  expect(readFileSync(installed(), "utf8")).toBe(binary("0.4.3"));
  expect(marker()).toBe("0.4.3");
  // Staged beside Skelcrew and renamed over it, so nothing is left behind.
  expect(readdirSync(join(home, "bin"))).toEqual(["sc"]);
});

// A release may name Skelcrew with a capital, as the spec has it, and still installs.
test("installs a release whose version line names Skelcrew with a capital", async () => {
  latest("#!/bin/sh\necho 'Skelcrew 0.4.3'\n");
  const done = await installLatest();
  expect(done.out).toBe("0.4.3\n");
  expect(marker()).toBe("0.4.3");
});

test("downloads nothing more when Skelcrew already is the latest release", async () => {
  latest(binary("0.4.2"));
  const done = await installLatest();
  expect(done.out).toBe("null\n");
  expect(asked).toEqual(["/latest/download/SHA256SUMS"]);
  expect(marker()).toBeNull();
});

test("installs nothing that fails its checksum", async () => {
  latest(binary("0.4.3"), sum("something else"));
  const done = await installLatest();
  expect(done.code).toBe(1);
  expect(done.err).toContain("checksum");
  expect(readFileSync(installed(), "utf8")).toBe(binary("0.4.2"));
  expect(readdirSync(join(home, "bin"))).toEqual(["sc"]);
});

test("installs nothing that won't start on this machine", async () => {
  latest("#!/bin/sh\nexit 1\n");
  const done = await installLatest();
  expect(done.code).toBe(1);
  expect(readFileSync(installed(), "utf8")).toBe(binary("0.4.2"));
  expect(readdirSync(join(home, "bin"))).toEqual(["sc"]);
  expect(marker()).toBeNull();
});

test("names the address when the release server can't be reached", async () => {
  const done = await installLatest();
  expect(done.code).toBe(1);
  expect(done.err).toContain(`http://127.0.0.1:${releases.port}/latest/download/SHA256SUMS`);
});

// What the list's notice says to a Skelcrew of `build`, from the database.
const notice = async (build: string) =>
  (
    await inProcess(
      `import { updateNotice } from ${JSON.stringify(source("machine/update.ts"))};
import { openDb } from ${JSON.stringify(source("db.ts"))};
console.log(updateNotice(openDb()));`,
      build,
    )
  ).out;

test("the list's notice says a newer release is installed until Skelcrew runs on it", async () => {
  expect(await notice("0.4.2")).toBe("\n");
  const db = new Database(join(home, ".local", "share", "skelcrew", "skelcrew.db"));
  db.run("INSERT INTO installed (release) VALUES ('0.4.3')");
  db.close();
  expect(await notice("0.4.2")).toBe("Skelcrew 0.4.3 installed · restart to use it\n");
  expect(await notice("0.4.3")).toBe("\n");
});

// How Skelcrew restarts the daemon's service on this machine, as the fakes note it, and where it
// says the daemon's log is. A Mac restarts it with launchd, in your login session, which no HOME
// of the test's can keep apart from your own daemon, so it must never reach the real launchctl.
const mac = process.platform === "darwin";
const restartCall = mac
  ? `launchctl kickstart -k gui/${userInfo().uid}/dev.skelcrew.daemon\n`
  : "systemctl --user restart skelcrew\n";
const daemonLog = () =>
  mac ? join(home, "Library", "Logs", "skelcrew.log") : "journalctl --user -u skelcrew";

// Stands in for a daemon on the test's socket, answering what it runs, its release or the
// checkout and commit it started from: `before`, or `after` once the fake systemctl or
// launchctl restarted it. In a process of its own, as one in the test's process got no answer
// while the test waited on Skelcrew, and on Bun.listen, as a node:net server refused connections
// for a moment after it said it was listening.
async function daemon(
  before: object,
  after: object,
  { service = 1, restarts = true } = {},
): Promise<void> {
  const managers: [string, string][] = [
    ["systemctl", "--user restart skelcrew"],
    ["launchctl", `kickstart -k gui/${userInfo().uid}/dev.skelcrew.daemon`],
  ];
  // The service runs the daemon whose process id is `service`, or none for 0. Asking so isn't
  // noted with the calls.
  const asked: Record<string, string> = {
    systemctl: `test "$2" = show && echo ${service} && exit 0`,
    launchctl: `test "$1" = print && echo "pid = ${service}" && exit 0`,
  };
  for (const [name, restart] of managers)
    writeScript(
      home,
      name,
      `${asked[name]}\necho "${name} $*" >> "$HOME/calls"\ntest "$*" = "${restart}" && touch "$HOME/restarted"\nexit 0`,
    );
  const socket = join(home, "run", "skelcrew.sock");
  const restarted = join(home, "restarted");
  // The socket's file comes a moment before it takes connections.
  const ready = join(home, "listening");
  // Once restarted, it makes its socket again, as a new daemon would, unless `restarts` is false:
  // then it stands for a daemon that keeps running, such as one in a terminal.
  const code = `import { existsSync, rmSync } from "node:fs";
const answer = {
  data(connection) {
    const runs = existsSync(${JSON.stringify(restarted)}) ? ${JSON.stringify(after)} : ${JSON.stringify(before)};
    connection.end(JSON.stringify({ running: true, pid: 1, ...runs }) + "\\n");
  },
};
let server = Bun.listen({ unix: ${JSON.stringify(socket)}, socket: answer });
if (${restarts}) {
  const timer = setInterval(() => {
    if (!existsSync(${JSON.stringify(restarted)})) return;
    clearInterval(timer);
    server.stop(true);
    rmSync(${JSON.stringify(socket)}, { force: true });
    server = Bun.listen({ unix: ${JSON.stringify(socket)}, socket: answer });
  }, 20);
}
await Bun.write(${JSON.stringify(ready)}, "");`;
  running.push(Bun.spawn([process.execPath, "-e", code], { stdout: "ignore", stderr: "ignore" }));
  await until(() => existsSync(ready));
}

// Has Skelcrew, stamped with `build`, or run from this checkout without one, make sure the daemon
// runs what it does, as it does before you attach, and returns what it printed and what the
// service manager was asked. `more` adds to its environment.
async function beforeAttaching(build?: string, more: Record<string, string> = {}) {
  const done = await inProcess(
    `import { restartStaleDaemon } from ${JSON.stringify(source("machine/service.ts"))};
await restartStaleDaemon();`,
    build,
    more,
  );
  const calls = existsSync(join(home, "calls")) ? readFileSync(join(home, "calls"), "utf8") : "";
  return { ...done, calls };
}

test("restarts a daemon on an older release before you attach", async () => {
  await daemon({ release: "0.4.2" }, { release: "0.4.3" });
  const done = await beforeAttaching("0.4.3");
  expect(done.err).toBe("");
  expect(done.code).toBe(0);
  expect(done.calls).toBe(restartCall);
  expect(done.out).toContain("0.4.3");
  expect(done.out).toContain("agents keep running");
});

// The service manager doesn't own a daemon you run in a terminal, such as sc serve from an
// older release, which says nothing of where it runs. Restarting the service would only wait for
// a daemon that can't start beside it.
test("asks you to stop an older daemon that runs outside the service", async () => {
  await daemon({ release: "0.4.2", pid: 2 }, { release: "0.4.3" });
  const done = await beforeAttaching("0.4.3");
  expect(done.code).toBe(1);
  expect(done.err).toContain("runs outside its service");
  expect(done.err).toContain("Ctrl-C");
  expect(done.calls).toBe("");
});

test("leaves a daemon on this release running", async () => {
  await daemon({ release: "0.4.3" }, { release: "0.4.3" });
  const done = await beforeAttaching("0.4.3");
  expect(done.code).toBe(0);
  expect(done.calls).toBe("");
});

// The checkout these tests run from, and the commit it is on, as Skelcrew run from it sees them.
const checkout = join(source(), "..");
const head = () => git(checkout, "rev-parse", "--short", "HEAD");

test("after git pull, Skelcrew from a checkout restarts a daemon still on the old commit", async () => {
  await daemon({ folder: checkout, commit: "0000000" }, { folder: checkout, commit: head() });
  const done = await beforeAttaching();
  expect(done.err).toBe("");
  expect(done.code).toBe(0);
  expect(done.calls).toBe(restartCall);
  expect(done.out).toContain(`commit ${head()}`);
  expect(done.out).toContain("agents keep running");
});

test("leaves a daemon on this checkout's commit running", async () => {
  await daemon({ folder: checkout, commit: head() }, { folder: checkout, commit: head() });
  const done = await beforeAttaching();
  expect(done.code).toBe(0);
  expect(done.calls).toBe("");
});

// A restart would only bring back the daemon of the checkout its service runs, such as your
// main one while you run sc from a worktree, so waiting for this one would never end.
test("leaves alone a daemon that runs from another checkout", async () => {
  await daemon({ folder: "/elsewhere/skel", commit: "0000000" }, {});
  expect((await beforeAttaching()).calls).toBe("");
});

test("a checkout leaves alone a daemon that runs a release", async () => {
  await daemon({ release: "0.4.2" }, {});
  expect((await beforeAttaching()).calls).toBe("");
});

test("says where to look when the daemon doesn't come back on the new release", async () => {
  await daemon({ release: "0.4.2" }, { release: "0.4.2" });
  // Skelcrew waits two seconds for it, rather than its usual ten.
  const done = await beforeAttaching("0.4.3", { SKELCREW_RESTART_WAIT_MS: "2000" });
  expect(done.code).toBe(1);
  expect(done.err).toContain("within 2 seconds");
  expect(done.err).toContain(daemonLog());
}, 60_000);

// Runs sc restart as you would in your terminal, and returns what it printed, its exit code and
// what the service manager was asked. You are simon, which Bun reads from USER. `more` adds to
// its environment.
async function restart(more: Record<string, string> = {}) {
  const run = Bun.spawn([process.execPath, source("main.ts"), "restart"], {
    env: { ...env(), USER: "simon", ...more },
    stdout: "pipe",
    stderr: "pipe",
  });
  const [out, err, code] = await Promise.all([
    new Response(run.stdout).text(),
    new Response(run.stderr).text(),
    run.exited,
  ]);
  const calls = existsSync(join(home, "calls")) ? readFileSync(join(home, "calls"), "utf8") : "";
  return { out, err, code, calls };
}

test("sc restart restarts the daemon's service and says so once the new one answers", async () => {
  await daemon({}, {});
  const done = await restart();
  expect(done.err).toBe("");
  expect(done.code).toBe(0);
  expect(done.calls).toBe(restartCall);
  expect(done.out).toBe(`Restarted the daemon on simon@${hostname()}. Agents kept running.\n`);
});

// The service manager can't restart a daemon you run in a terminal, and one it started beside
// it would fail on the lock.
test("sc restart asks you to stop a daemon run in a terminal, and starts no service", async () => {
  await daemon({ pid: 2 }, {});
  const done = await restart();
  expect(done.code).toBe(1);
  expect(done.err).toContain("sc serve");
  expect(done.err).toContain("Ctrl-C");
  expect(done.calls).toBe("");
});

// The old daemon still answering counts as not back.
test("sc restart says where to look when no new daemon answers", async () => {
  await daemon({}, {}, { restarts: false });
  const done = await restart({ SKELCREW_RESTART_WAIT_MS: "2000" });
  expect(done.code).toBe(1);
  expect(done.err).toContain("within 2 seconds");
  expect(done.err).toContain(daemonLog());
}, 60_000);

// A daemon of an older release reports no process id. One that answers while the service runs
// none runs in a terminal.
test("sc restart asks you to stop an older daemon run in a terminal, with no service running", async () => {
  await daemon({ pid: 0 }, {}, { service: 0 });
  const done = await restart();
  expect(done.code).toBe(1);
  expect(done.err).toContain("Ctrl-C");
  expect(done.calls).toBe("");
});

// The service can run an older installed Skelcrew than this sc, whose new daemon reports no id
// either.
test("sc restart restarts an older daemon the service runs, which reports no process id", async () => {
  await daemon({ pid: 0 }, { pid: 0 });
  const done = await restart();
  expect(done.err).toBe("");
  expect(done.code).toBe(0);
  expect(done.calls).toBe(restartCall);
});

// The service manager can run a process of its own beside an older daemon in a terminal, such
// as one retrying on the lock. The old daemon keeps answering on its old socket.
test("sc restart doesn't take an older daemon in a terminal for the new one", async () => {
  await daemon({ pid: 0 }, { pid: 0 }, { restarts: false });
  const done = await restart({ SKELCREW_RESTART_WAIT_MS: "2000" });
  expect(done.code).toBe(1);
  expect(done.err).toContain("within 2 seconds");
  expect(done.err).toContain("Ctrl-C");
}, 60_000);

// --remote runs the command on a server, where Skelcrew can't tell that an agent asked, so agents
// can't run any command there.
test("sc --remote is only for your own terminal, not for agents", async () => {
  const run = Bun.spawn(
    [process.execPath, source("main.ts"), "--remote", "simon@workbox", "restart"],
    {
      env: { ...env(), SKELCREW_SANDBOX: "1" },
      stdout: "pipe",
      stderr: "pipe",
    },
  );
  const [err, code] = await Promise.all([new Response(run.stderr).text(), run.exited]);
  expect(code).toBe(1);
  expect(err).toBe(
    "Skelcrew: running sc on a server is only for your own terminal, not for agents\n",
  );
});

test("sc restart is only for your own terminal, not for agents", async () => {
  const done = await restart({ SKELCREW_SANDBOX: "1" });
  expect(done.code).toBe(1);
  expect(done.err).toBe(
    "Skelcrew: restarting the daemon is only for your own terminal, not for agents\n",
  );
  expect(done.calls).toBe("");
});

// Runs sc update as a release of 0.4.2 at the stand-in Skelcrew would, and returns what it
// printed and what the service manager was asked.
async function update() {
  const done = await inProcess(
    `import { updateItself } from ${JSON.stringify(source("machine/update.ts"))};
await updateItself(${JSON.stringify(installed())});`,
    "0.4.2",
  );
  const calls = existsSync(join(home, "calls")) ? readFileSync(join(home, "calls"), "utf8") : "";
  return { ...done, calls };
}

// The new release itself points the service at its file and restarts the daemon on it, as the
// service could run another copy of Skelcrew than the one updated.
test("sc update installs the latest release over Skelcrew and restarts the daemon on it", async () => {
  latest(binary("0.4.3"));
  await daemon({}, {});
  const done = await update();
  expect(done.err).toBe("");
  expect(done.code).toBe(0);
  expect(readFileSync(installed(), "utf8")).toBe(binary("0.4.3"));
  expect(done.calls).toBe("sc serve --bg\n");
  expect(done.out).toBe("Updated Skelcrew 0.4.2 → 0.4.3.\n");
});

// Such as the arm64 build replacing an x64 one under Rosetta: the daemon runs the same release,
// so only a restart moves it to the new file.
test("sc update restarts the daemon on a new build of the same release", async () => {
  latest(`${binary("0.4.2")}# the native build\n`);
  await daemon({ release: "0.4.2" }, {});
  const done = await update();
  expect(done.err).toBe("");
  expect(done.code).toBe(0);
  expect(done.calls).toBe("sc serve --bg\nsc restart\n");
});

// sc serve --bg goes by the daemon's release, which can be newer than the sc you run.
test("sc update restarts a daemon already on the release it installs", async () => {
  latest(`${binary("0.4.3")}# the native build\n`);
  await daemon({ release: "0.4.3" }, {});
  const done = await update();
  expect(done.err).toBe("");
  expect(done.code).toBe(0);
  expect(done.calls).toBe("sc serve --bg\nsc restart\n");
});

test("sc update says how to restart the daemon when the new release can't", async () => {
  latest(`${binary("0.4.3")}exit 1\n`);
  await daemon({}, {});
  const done = await update();
  expect(done.code).toBe(1);
  expect(done.out).toBe("Updated Skelcrew 0.4.2 → 0.4.3.\n");
  expect(done.err).toContain("sc serve --bg");
});

// The next sc starts the daemon on the new release.
test("sc update starts no daemon when none runs", async () => {
  latest(binary("0.4.3"));
  const done = await update();
  expect(done.err).toBe("");
  expect(done.out).toBe("Updated Skelcrew 0.4.2 → 0.4.3.\n");
  expect(readFileSync(installed(), "utf8")).toBe(binary("0.4.3"));
  expect(done.calls).toBe("");
});

test("sc update changes nothing when Skelcrew already is the latest release", async () => {
  latest(binary("0.4.2"));
  await daemon({}, {});
  const done = await update();
  expect(done.err).toBe("");
  expect(done.out).toBe("Skelcrew 0.4.2 is the latest.\n");
  expect(asked).toEqual(["/latest/download/SHA256SUMS"]);
  expect(done.calls).toBe("");
});

test("sc update keeps Skelcrew as it was when the download fails its checksum", async () => {
  latest(binary("0.4.3"), sum("something else"));
  await daemon({}, {});
  const done = await update();
  expect(done.code).toBe(1);
  expect(done.err).toContain("failed its checksum");
  expect(readFileSync(installed(), "utf8")).toBe(binary("0.4.2"));
  expect(readdirSync(join(home, "bin")).filter((file) => file.startsWith("."))).toEqual([]);
  expect(done.calls).toBe("");
});

// Runs sc from this checkout, as you would in your terminal, and returns what it printed and its
// exit code. `more` adds to its environment.
async function sc(args: string[], more: Record<string, string> = {}) {
  const run = Bun.spawn([process.execPath, source("main.ts"), ...args], {
    env: { ...env(), ...more },
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

// Writing over the file it runs from would replace Bun, or nothing a checkout tracks.
test("sc update from a checkout says to git pull, and downloads nothing", async () => {
  latest(binary("0.4.3"));
  const done = await sc(["update"]);
  expect(done.code).toBe(1);
  expect(done.err).toContain("git pull");
  expect(asked).toEqual([]);
});

test("sc update is only for your own terminal, not for agents", async () => {
  const done = await sc(["update"], { SKELCREW_SANDBOX: "1" });
  expect(done.code).toBe(1);
  expect(done.err).toBe(
    "Skelcrew: updating Skelcrew is only for your own terminal, not for agents\n",
  );
  expect(asked).toEqual([]);
});

// Runs sc stamped with `build` on a server, as --remote from a laptop on `laptop` runs it. The
// server has a home of its own with a finished first run, since Skelcrew there says it isn't set
// up before it looks at its build.
async function onServer(build: string, laptop: string) {
  const server = join(home, "server");
  const config = join(server, ".config", "skelcrew");
  const codex = join(server, ".local", "share", "skelcrew", "codex");
  const units = join(server, ".config", "systemd", "user");
  for (const folder of [config, codex, units]) mkdirSync(folder, { recursive: true });
  writeFileSync(join(config, "config.yaml"), "harness: codex\n");
  writeFileSync(join(codex, "auth.json"), "login\n");
  writeFileSync(join(units, "skelcrew.service"), "");
  const run = Bun.spawn(
    [process.execPath, "--define", `SKELCREW_BUILD="${build}"`, source("main.ts"), "--help"],
    {
      env: {
        ...env(),
        HOME: server,
        SKELCREW_LAPTOP_BUILD: laptop,
        SKELCREW_REMOTE_NAME: "simon@workbox",
      },
      stdout: "pipe",
      stderr: "pipe",
    },
  );
  const [out, code] = await Promise.all([new Response(run.stdout).text(), run.exited]);
  return { out, code };
}

test("a server on an older release than the laptop asks to be updated, and a newer one doesn't", async () => {
  const older = await onServer("0.4.2", "0.4.3");
  expect(older.code).toBe(98);
  expect(older.out).toContain("Skelcrew on simon@workbox is from 0.4.2, yours is 0.4.3.");
  // It updates itself in the background, and the laptop catches up on its own.
  expect((await onServer("0.4.4", "0.4.3")).code).toBe(0);
  expect((await onServer("0.4.3", "0.4.3")).code).toBe(0);
  // From a checkout, the laptop's commit still differs from any release.
  expect((await onServer("0.4.3", "abc1234")).code).toBe(98);
});
