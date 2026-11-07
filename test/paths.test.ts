import { afterEach, beforeEach, describe, expect, test } from "bun:test";
import { userInfo } from "node:os";
import { join } from "node:path";
import { cliSocket, threadSocket } from "../src/paths";
import { dropCapabilities, onSprite } from "../src/sprite";
import { source } from "./harness.ts";

const saved = { runtime: process.env.XDG_RUNTIME_DIR, socket: process.env.SKEL_SOCKET };
// Inside an agent's sandbox, as when skel builds skel, SKEL_SOCKET is set already.
beforeEach(() => {
  delete process.env.SKEL_SOCKET;
});
afterEach(() => {
  process.env.XDG_RUNTIME_DIR = saved.runtime;
  if (saved.socket === undefined) delete process.env.SKEL_SOCKET;
  else process.env.SKEL_SOCKET = saved.socket;
});

// Returns where skel looks for the daemon's socket without XDG_RUNTIME_DIR, run in a
// sandbox whose /run holds only the given folders.
async function socketWith(folders: string[]): Promise<string> {
  const paths = source("paths.ts");
  const made = folders.flatMap((folder) => ["--dir", folder]);
  const argv = [...(onSprite() ? dropCapabilities : []), "bwrap", "--dev-bind", "/", "/"];
  argv.push("--tmpfs", "/run", ...made, "--", process.execPath, "-e");
  argv.push(`import { cliSocket } from ${JSON.stringify(paths)}; console.log(cliSocket());`);
  const run = Bun.spawn(argv, {
    env: { HOME: "/home/someone", PATH: process.env.PATH ?? "" },
    stdout: "pipe",
  });
  return (await new Response(run.stdout).text()).trim();
}

// bubblewrap can't start inside skel's own sandbox, so only there these tests can't run.
describe.skipIf(process.env.SKEL_SANDBOX === "1")("without XDG_RUNTIME_DIR", () => {
  test("finds the daemon's socket where systemd puts it", async () => {
    const uid = userInfo().uid;
    expect(await socketWith([`/run/user/${uid}`])).toBe(`/run/user/${uid}/skel.sock`);
  });

  // As on a Sprite, which has no systemd to make /run/user/<uid>, nor a /run you can write to.
  test("uses a folder in skel's own data folder where systemd made none", async () => {
    expect(await socketWith([])).toBe("/home/someone/.local/share/skel/run/skel.sock");
  });
});

test("uses XDG_RUNTIME_DIR when it is set", () => {
  process.env.XDG_RUNTIME_DIR = "/somewhere";
  expect(cliSocket()).toBe("/somewhere/skel.sock");
});

test("inside an agent's sandbox, uses the socket mounted there", () => {
  process.env.XDG_RUNTIME_DIR = "/somewhere";
  process.env.SKEL_SOCKET = "/run/skel/skel.sock";
  expect(cliSocket()).toBe("/run/skel/skel.sock");
});

// Linux refuses a socket whose path is longer than 108 bytes, and GitHub allows repository
// names of 100 characters.
test("a thread's socket path stays short, however long its repository's name", () => {
  process.env.XDG_RUNTIME_DIR = "/run/user/1000";
  const long = `${"a".repeat(100)}-12`;
  expect(threadSocket(long).length).toBeLessThan(108);
  expect(threadSocket(long)).not.toBe(threadSocket(`${"a".repeat(100)}-13`));
});
