import { afterEach, beforeEach, describe, expect, test } from "bun:test";
import {
  chmodSync,
  existsSync,
  lstatSync,
  mkdirSync,
  mkdtempSync,
  rmdirSync,
  symlinkSync,
  unlinkSync,
} from "node:fs";
import { createServer, type Server as NetServer } from "node:net";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { type Command, MAX_LINE } from "../protocol/protocol";
import { type ClientOptions, request, type Started } from "./client";
import { daemonPaths } from "./paths";
import { type Server, serve } from "./server";
import { cleanUp, daemonInAnotherProcess, throwawayRepo } from "./testing";

const dirs: string[] = [];
const servers: Server[] = [];
const fakes: NetServer[] = [];
afterEach(async () => {
  for (const server of servers.splice(0)) await server.stop();
  for (const fake of fakes.splice(0)) fake.close();
  cleanUp(dirs);
});

async function started(repo: string): Promise<Server> {
  const served = await serve(repo);
  if (!served.ok) throw new Error(served.message);
  servers.push(served.server);
  return served.server;
}

// Counts the starts, and starts nothing.
function noStart() {
  const counted = { starts: 0 };
  const options: ClientOptions = {
    start: () => {
      counted.starts += 1;
      return { ok: false, message: "No daemon here." };
    },
  };
  return { counted, options };
}

// Starts the daemon in this process, the way `skelcrew serve` would in
// another one.
function startsInProcess(repo: string) {
  const counted = { starts: 0 };
  const options: ClientOptions = {
    start: (): Started => {
      counted.starts += 1;
      void serve(repo).then((served) => {
        if (served.ok) servers.push(served.server);
      });
      return { ok: true };
    },
  };
  return { counted, options };
}

// A stand-in for the daemon that does what it's told with each line.
async function fakeDaemon(
  repo: string,
  onLine: (line: string, reply: (text: string) => void, close: () => void) => void,
) {
  const found = daemonPaths(repo);
  if (!found.ok) throw new Error(found.message);
  const fake = createServer((socket) => {
    socket.setEncoding("utf8");
    socket.on("data", (line: string) =>
      onLine(
        line.trim(),
        (text) => socket.write(`${text}\n`),
        () => socket.destroy(),
      ),
    );
  });
  fakes.push(fake);
  await new Promise<void>((resolve) => fake.listen(found.paths.socket, resolve));
}

const add = (title: string): Command => ({ type: "add", title, spec: false, project: null });

describe("the client", () => {
  // Under `bun test`, the first connection a process makes to a missing
  // socket fails at once, inside connect(). This test must stay first in
  // the file to see that: it once threw instead of returning a failure.
  test("returns a failure, never throws, when no daemon runs and none can start", async () => {
    const repo = throwawayRepo(dirs);
    const { counted, options } = noStart();
    expect(await request(repo, add("CSV export"), options)).toEqual({
      ok: false,
      message: "No daemon here.",
    });
    expect(counted.starts).toBe(1);
  });

  test("sends a command to the running daemon and returns its answer", async () => {
    const repo = throwawayRepo(dirs);
    await started(repo);
    const { counted, options } = noStart();
    expect(await request(repo, add("CSV export"), options)).toEqual({
      ok: true,
      result: { task: 1 },
    });
    expect(counted.starts).toBe(0);
  });

  test("gives each of several clients at once its own answer", async () => {
    const repo = throwawayRepo(dirs);
    await started(repo);
    const { options } = noStart();
    const titles = ["a", "b", "c", "d", "e", "f", "g", "h"];
    const answers = await Promise.all(titles.map((title) => request(repo, add(title), options)));
    const numbers = answers.map((answer) => JSON.stringify(answer.ok ? answer.result : null));
    expect(numbers.sort()).toEqual(titles.map((_, i) => JSON.stringify({ task: i + 1 })));
  });

  test("starts a missing daemon through the function it's given, then sends", async () => {
    const repo = throwawayRepo(dirs);
    const { counted, options } = startsInProcess(repo);
    expect(await request(repo, add("CSV export"), options)).toEqual({
      ok: true,
      result: { task: 1 },
    });
    expect(counted.starts).toBe(1);
    expect(await request(repo, add("PDF export"), options)).toEqual({
      ok: true,
      result: { task: 2 },
    });
    expect(counted.starts).toBe(1);
  });

  test("starts a daemon when all that's left of the last one is its socket file", async () => {
    const repo = throwawayRepo(dirs);
    const child = await daemonInAnotherProcess(repo);
    child.kill("SIGKILL");
    await child.exited;
    const found = daemonPaths(repo);
    if (!found.ok) throw new Error(found.message);
    expect(existsSync(found.paths.socket)).toBe(true);

    const { counted, options } = startsInProcess(repo);
    expect(await request(repo, add("CSV export"), options)).toMatchObject({ ok: true });
    expect(counted.starts).toBe(1);
  });

  test("passes on why the daemon couldn't be started", async () => {
    const repo = throwawayRepo(dirs);
    const { options } = noStart();
    expect(await request(repo, add("CSV export"), options)).toEqual({
      ok: false,
      message: "No daemon here.",
    });
  });

  test("says why the daemon stopped while it was starting", async () => {
    const repo = throwawayRepo(dirs);
    const answer = await request(repo, add("CSV export"), {
      start: () => ({ ok: true, exited: () => "workflow.yml doesn't fit." }),
      startTimeoutMs: 5_000,
    });
    expect(answer).toEqual({
      ok: false,
      message: "The daemon stopped while starting. workflow.yml doesn't fit.",
    });
  });

  // Found by review: a command sent while the daemon was stopping started
  // a new one, which found the old one still holding the lock. The user
  // was told it was "already running", though it was on its way out.
  test("starts the daemon again when the old one was still stopping", async () => {
    const repo = throwawayRepo(dirs);
    let starts = 0;
    const answer = await request(
      repo,
      { type: "status" },
      {
        start: (): Started => {
          starts += 1;
          if (starts === 1) {
            return {
              ok: true,
              exited: () =>
                "The daemon is already running for this repository, as process 123. If skelcrew can't reach it, stop that process and try again.",
            };
          }
          void serve(repo).then((served) => {
            if (served.ok) servers.push(served.server);
          });
          return { ok: true };
        },
        startTimeoutMs: 5_000,
      },
    );
    expect(answer).toEqual({ ok: true, result: { tasks: [] } });
    expect(starts).toBe(2);
  });

  // Found by review: after starting again, the time limit could run out
  // before the new daemon exited. The user then lost the advice to stop
  // the daemon that holds the lock.
  test("keeps the advice to stop a daemon it can't reach, however the time runs out", async () => {
    const running =
      "The daemon is already running for this repository, as process 123. If skelcrew can't reach it, stop that process and try again.";
    for (const limit of [1_400, 2_700]) {
      const answer = await request(
        throwawayRepo(dirs),
        { type: "status" },
        {
          start: (): Started => {
            const began = Date.now();
            return { ok: true, exited: () => (Date.now() - began > 300 ? running : null) };
          },
          startTimeoutMs: limit,
        },
      );
      expect(answer).toEqual({
        ok: false,
        message: `The daemon stopped while starting. ${running}`,
      });
    }
  }, 15_000);

  test("gives up when the daemon doesn't answer in time after starting it", async () => {
    const repo = throwawayRepo(dirs);
    const answer = await request(repo, add("CSV export"), {
      start: () => ({ ok: true }),
      startTimeoutMs: 200,
    });
    expect(answer).toEqual({
      ok: false,
      message: "The daemon didn't answer within 0.2 seconds of starting it.",
    });
  });

  // `done` waits for the checks, which can take many minutes.
  test("waits for a slow answer once the request is sent", async () => {
    const repo = throwawayRepo(dirs);
    await fakeDaemon(repo, (line, reply) => {
      const { id } = JSON.parse(line);
      setTimeout(() => reply(JSON.stringify({ id, ok: true, result: "slow" })), 400);
    });
    const answer = await request(repo, add("CSV export"), {
      start: () => ({ ok: false, message: "unused" }),
      startTimeoutMs: 50,
    });
    expect(answer).toEqual({ ok: true, result: "slow" });
  });

  test("refuses a request too long for the daemon, without sending it", async () => {
    const repo = throwawayRepo(dirs);
    const { counted, options } = noStart();
    expect(await request(repo, add("x".repeat(MAX_LINE)), options)).toEqual({
      ok: false,
      message: `The request is longer than ${MAX_LINE} bytes, so the daemon would refuse it.`,
    });
    expect(counted.starts).toBe(0);
  });

  test("returns a daemon that hangs up without answering as a failure", async () => {
    const repo = throwawayRepo(dirs);
    await fakeDaemon(repo, (_line, _reply, close) => close());
    const { options } = noStart();
    expect(await request(repo, add("CSV export"), options)).toEqual({
      ok: false,
      message: "The daemon closed the connection without answering.",
    });
  });

  test("returns an answer to another request as a failure", async () => {
    const repo = throwawayRepo(dirs);
    await fakeDaemon(repo, (_line, reply) =>
      reply(JSON.stringify({ id: "someone-else", ok: true, result: 1 })),
    );
    const { options } = noStart();
    expect(await request(repo, add("CSV export"), options)).toEqual({
      ok: false,
      message: "The daemon answered a different request.",
    });
  });

  test("returns a reply that doesn't fit the protocol as a failure", async () => {
    const repo = throwawayRepo(dirs);
    await fakeDaemon(repo, (_line, reply) => reply("nonsense"));
    const { options } = noStart();
    expect(await request(repo, add("CSV export"), options)).toEqual({
      ok: false,
      message: "The daemon's reply isn't valid JSON.",
    });
  });
});

// Found by review: the client connected to any socket in the shared folder
// in /tmp. Another user who made that folder first could answer in the
// daemon's place, and see every command.
describe("the socket folder in /tmp", () => {
  const deep = "a-folder-with-a-rather-long-name".repeat(3);
  // A socket folder of the tests' own, not yet made, in place of the real
  // one: other daemons on this machine may be using that.
  let base = "";
  beforeEach(() => {
    const parent = mkdtempSync("/tmp/sk-");
    dirs.push(parent);
    base = join(parent, "sockets");
  });

  // A daemon for the repository, with its socket in `base`.
  async function startedHere(repo: string) {
    const served = await serve(repo, { socketFolder: base });
    if (!served.ok) throw new Error(served.message);
    servers.push(served.server);
  }

  // A client that starts nothing, looking in `base`.
  function lookingHere() {
    const { counted, options } = noStart();
    return { counted, options: { ...options, socketFolder: base } };
  }

  test("isn't used while other users can change it", async () => {
    const repo = throwawayRepo(dirs, deep);
    await startedHere(repo);
    chmodSync(base, 0o777);
    const { counted, options } = lookingHere();
    expect(await request(repo, { type: "status" }, options)).toEqual({
      ok: false,
      message: `${base} is open to other users, so skelcrew won't use it. Run \`chmod 700 ${base}\`, then try again.`,
    });
    expect(counted.starts).toBe(0);
  });

  test("is used once only its user can change it", async () => {
    const repo = throwawayRepo(dirs, deep);
    await startedHere(repo);
    const { options } = lookingHere();
    expect(await request(repo, { type: "status" }, options)).toMatchObject({ ok: true });
  });

  // Found by review: a missing folder counted as safe. While the client
  // waited for the daemon it started, another user could make the folder
  // and answer in the daemon's place.
  test("is made for its user alone before the client first connects", async () => {
    const repo = throwawayRepo(dirs, deep);
    const { options } = lookingHere();
    await request(repo, { type: "status" }, options);
    const made = lstatSync(base);
    expect(made.isDirectory()).toBe(true);
    expect(made.uid).toBe(process.getuid?.() ?? -1);
    expect(made.mode & 0o777).toBe(0o700);
  });

  test("isn't used when it is a link, even one of the user's own", async () => {
    const repo = throwawayRepo(dirs, deep);
    const elsewhere = mkdtempSync(join(tmpdir(), "sk-elsewhere-"));
    dirs.push(elsewhere);
    symlinkSync(elsewhere, base);
    const { counted, options } = lookingHere();
    expect(await request(repo, { type: "status" }, options)).toEqual({
      ok: false,
      message: `${base} isn't a folder, so skelcrew won't use it. Remove it, then try again.`,
    });
    expect(counted.starts).toBe(0);
  });
});

function isLink(path: string): boolean {
  try {
    return lstatSync(path).isSymbolicLink();
  } catch {
    return false;
  }
}
