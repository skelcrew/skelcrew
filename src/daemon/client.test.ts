import { afterEach, describe, expect, test } from "bun:test";
import { existsSync } from "node:fs";
import { createServer, type Server as NetServer } from "node:net";
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
