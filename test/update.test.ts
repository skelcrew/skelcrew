// Updates: a release of skel installing a newer one in the background, from a fake release
// server, the sidebar's notice that it waits for a restart, and skel restarting the daemon on
// the new release before you attach.
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
import { tmpdir, userInfo } from "node:os";
import { dirname, join } from "node:path";
import type { Subprocess } from "bun";
import { homeEnv, source, until, writeScript } from "./harness.ts";

let home = "";
let releases: ReturnType<typeof Bun.serve>;
// What the fake release server has, by path, and the paths it was asked for.
let files = new Map<string, string>();
let asked: string[] = [];
const running: Subprocess[] = [];

// The release file for this machine, as the install script names it.
const asset = `skel-${process.platform === "darwin" ? "darwin" : "linux"}-${process.arch === "arm64" ? "arm64" : "x64"}`;
const sum = (text: string) => new Bun.CryptoHasher("sha256").update(text).digest("hex");
// A stand-in for a skel binary that says which release it is.
const binary = (version: string) => `#!/bin/sh\necho "skel ${version}"\n`;
const installed = () => join(home, "bin", "skel");
const marker = () => join(home, ".local", "share", "skel", "installed");

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

// The environment of skel in these tests. Its PATH holds the test's fakes, bun and the
// system's own folders, and nothing else of this machine's, so the real sprite-env of a Sprite
// is never found. systemctl and launchctl are in the system's folders, so every test that can
// reach them puts fakes in front.
const env = () => ({
  ...homeEnv(home),
  PATH: `${join(home, "bin")}:${dirname(process.execPath)}:/usr/bin:/bin`,
});

// Runs code that uses skel's modules in a process of its own with the test's home, as skel
// stamped with `build` would run it, and returns what it printed.
async function inProcess(code: string, build?: string) {
  const define = build === undefined ? [] : ["--define", `SKEL_BUILD=${JSON.stringify(build)}`];
  const run = Bun.spawn([process.execPath, ...define, "-e", code], {
    env: env(),
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

// Has skel look for a newer release and install it over the stand-in skel.
const installLatest = () =>
  inProcess(`import { installLatest } from ${JSON.stringify(source("machine/update.ts"))};
console.log(await installLatest(${JSON.stringify(installed())}, "http://127.0.0.1:${releases.port}"));`);

test("installs a newer release over skel, and notes which one", async () => {
  latest(binary("0.4.3"));
  const done = await installLatest();
  expect(done.err).toBe("");
  expect(done.out).toBe("0.4.3\n");
  expect(readFileSync(installed(), "utf8")).toBe(binary("0.4.3"));
  expect(readFileSync(marker(), "utf8")).toBe("0.4.3\n");
  // Staged beside skel and renamed over it, so nothing is left behind.
  expect(readdirSync(join(home, "bin"))).toEqual(["skel"]);
});

test("downloads nothing more when skel already is the latest release", async () => {
  latest(binary("0.4.2"));
  const done = await installLatest();
  expect(done.out).toBe("null\n");
  expect(asked).toEqual(["/latest/download/SHA256SUMS"]);
  expect(existsSync(marker())).toBe(false);
});

test("installs nothing that fails its checksum", async () => {
  latest(binary("0.4.3"), sum("something else"));
  const done = await installLatest();
  expect(done.code).toBe(1);
  expect(done.err).toContain("checksum");
  expect(readFileSync(installed(), "utf8")).toBe(binary("0.4.2"));
  expect(readdirSync(join(home, "bin"))).toEqual(["skel"]);
});

test("installs nothing that won't start on this machine", async () => {
  latest("#!/bin/sh\nexit 1\n");
  const done = await installLatest();
  expect(done.code).toBe(1);
  expect(readFileSync(installed(), "utf8")).toBe(binary("0.4.2"));
  expect(readdirSync(join(home, "bin"))).toEqual(["skel"]);
  expect(existsSync(marker())).toBe(false);
});

test("names the address when the release server can't be reached", async () => {
  const done = await installLatest();
  expect(done.code).toBe(1);
  expect(done.err).toContain(`http://127.0.0.1:${releases.port}/latest/download/SHA256SUMS`);
});

// What the sidebar's notice says to a skel of `build`.
const notice = async (build: string) =>
  (
    await inProcess(
      `import { updateNotice } from ${JSON.stringify(source("machine/update.ts"))};
console.log(updateNotice());`,
      build,
    )
  ).out;

test("the sidebar's notice says a newer release is installed until skel runs on it", async () => {
  expect(await notice("0.4.2")).toBe("\n");
  mkdirSync(join(home, ".local", "share", "skel"), { recursive: true });
  writeFileSync(marker(), "0.4.3\n");
  expect(await notice("0.4.2")).toBe("skel 0.4.3 installed · restart to use it\n");
  expect(await notice("0.4.3")).toBe("\n");
});

// How skel restarts the daemon's service on this machine, as the fakes note it, and where it
// says the daemon's log is. A Mac restarts it with launchd, in your login session, which no HOME
// of the test's can keep apart from your own daemon, so it must never reach the real launchctl.
const mac = process.platform === "darwin";
const restartCall = mac
  ? `launchctl kickstart -k gui/${userInfo().uid}/run.skel.daemon\n`
  : "systemctl --user restart skel\n";
const daemonLog = () =>
  mac ? join(home, "Library", "Logs", "skel.log") : "journalctl --user -u skel";

// Stands in for a daemon on the test's socket, answering which release it runs: `before`, or
// `after` once the fake systemctl or launchctl restarted it. In a process of its own, as one in the test's
// process got no answer while the test waited on skel, and on Bun.listen, as a node:net server
// refused connections for a moment after it said it was listening.
async function daemon(before: string, after: string): Promise<void> {
  const managers: [string, string][] = [
    ["systemctl", "--user restart skel"],
    ["launchctl", `kickstart -k gui/${userInfo().uid}/run.skel.daemon`],
  ];
  for (const [name, restart] of managers)
    writeScript(
      home,
      name,
      `echo "${name} $*" >> "$HOME/calls"\ntest "$*" = "${restart}" && touch "$HOME/restarted"\nexit 0`,
    );
  const socket = join(home, "run", "skel.sock");
  // The socket's file comes a moment before it takes connections.
  const ready = join(home, "listening");
  const code = `import { existsSync } from "node:fs";
Bun.listen({
  unix: ${JSON.stringify(socket)},
  socket: {
    data(connection) {
      const release = existsSync(${JSON.stringify(join(home, "restarted"))}) ? ${JSON.stringify(after)} : ${JSON.stringify(before)};
      connection.end(JSON.stringify({ running: true, pid: 1, release }) + "\\n");
    },
  },
});
await Bun.write(${JSON.stringify(ready)}, "");`;
  running.push(Bun.spawn([process.execPath, "-e", code], { stdout: "ignore", stderr: "ignore" }));
  await until(() => existsSync(ready));
}

// Has skel, stamped with `build`, make sure the daemon runs its release, as it does before you
// attach, and returns what it printed and what the service manager was asked.
async function beforeAttaching(build?: string) {
  const done = await inProcess(
    `import { onThisRelease } from ${JSON.stringify(source("client.ts"))};
await onThisRelease();`,
    build,
  );
  const calls = existsSync(join(home, "calls")) ? readFileSync(join(home, "calls"), "utf8") : "";
  return { ...done, calls };
}

test("restarts a daemon on an older release before you attach", async () => {
  await daemon("0.4.2", "0.4.3");
  const done = await beforeAttaching("0.4.3");
  expect(done.err).toBe("");
  expect(done.code).toBe(0);
  expect(done.calls).toBe(restartCall);
  expect(done.out).toContain("0.4.3");
  expect(done.out).toContain("agents keep running");
});

test("leaves a daemon on this release running", async () => {
  await daemon("0.4.3", "0.4.3");
  const done = await beforeAttaching("0.4.3");
  expect(done.code).toBe(0);
  expect(done.calls).toBe("");
});

test("a build from a checkout never restarts the daemon", async () => {
  await daemon("0.4.2", "0.4.2");
  const done = await beforeAttaching();
  expect(done.code).toBe(0);
  expect(done.calls).toBe("");
});

test("says where to look when the daemon doesn't come back on the new release", async () => {
  await daemon("0.4.2", "0.4.2");
  const done = await beforeAttaching("0.4.3");
  expect(done.code).toBe(1);
  expect(done.err).toContain(daemonLog());
}, 15_000);

// Runs skel stamped with `build` on a server, as --remote from a laptop on `laptop` runs it.
async function onServer(build: string, laptop: string) {
  const run = Bun.spawn(
    [process.execPath, "--define", `SKEL_BUILD="${build}"`, source("main.ts"), "--help"],
    {
      env: { ...env(), SKEL_LAPTOP_BUILD: laptop, SKEL_REMOTE_NAME: "simon@workbox" },
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
  expect(older.out).toContain("skel on simon@workbox is from 0.4.2, yours is 0.4.3.");
  // It updates itself in the background, and the laptop catches up on its own.
  expect((await onServer("0.4.4", "0.4.3")).code).toBe(0);
  expect((await onServer("0.4.3", "0.4.3")).code).toBe(0);
  // From a checkout, the laptop's commit still differs from any release.
  expect((await onServer("0.4.3", "abc1234")).code).toBe(98);
});
