// Updates: a release of skel installing a newer one in the background, from a fake release
// server, and the sidebar's notice that it waits for a restart.
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
import { tmpdir } from "node:os";
import { join } from "node:path";
import { homeEnv, source } from "./harness.ts";

let home = "";
let releases: ReturnType<typeof Bun.serve>;
// What the fake release server has, by path, and the paths it was asked for.
let files = new Map<string, string>();
let asked: string[] = [];

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
afterEach(() => {
  releases.stop(true);
  rmSync(home, { recursive: true, force: true });
});

// Runs code that uses skel's modules in a process of its own with the test's home, as skel
// stamped with `build` would run it, and returns what it printed.
async function inProcess(code: string, build?: string) {
  const define = build === undefined ? [] : ["--define", `SKEL_BUILD=${JSON.stringify(build)}`];
  const run = Bun.spawn([process.execPath, ...define, "-e", code], {
    env: homeEnv(home),
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
