// The client: sends one command to a repository's daemon and returns its
// answer as a value. It never throws.
//
// If no daemon is running, it starts one through the function it is given,
// and waits for the socket to answer. The CLI gives a function that runs
// `skelcrew serve` in the background.

import { randomUUID } from "node:crypto";
import { lstatSync } from "node:fs";
import { Socket } from "node:net";
import { type Command, encode, MAX_LINE, parseReply } from "../protocol/protocol";
import type { Answer } from "./daemon";
import { ALREADY_RUNNING } from "./lock";
import { daemonPaths, ownSocketFolder } from "./paths";

// What starting the daemon gave. `exited` says why the daemon stopped, or
// null while it still runs, so a daemon that can't start is reported at
// once rather than after the time limit.
export type Started = { ok: true; exited?: () => string | null } | { ok: false; message: string };

export type ClientOptions = {
  start: () => Started | Promise<Started>;
  // How long to wait for a daemon that was just started. A request, once
  // sent, has no time limit: `done` waits for the checks.
  startTimeoutMs?: number;
  newId?: () => string;
};

const defaultStartTimeoutMs = 10_000;
const pollMs = 50;

// After a started daemon exits, another may still be on its way up. Two
// commands at once can each start one, and the second refuses because the
// first holds the lock. So the client keeps trying for this long.
const afterExitMs = 1_000;

type Connected = { ok: true; socket: Socket } | { ok: false; missing: boolean; message: string };

export async function request(
  repo: string,
  command: Command,
  options: ClientOptions,
): Promise<Answer> {
  const found = daemonPaths(repo);
  if (!found.ok) return found;
  const path = found.paths.socket;
  const shared = found.paths.sharedSocketFolder;
  if (shared !== null) {
    const unsafe = unsafeFolder(shared);
    if (unsafe !== null) return { ok: false, message: unsafe };
  }
  // Each try checks the socket first, when it is in the folder in /tmp.
  const connect = () => (shared === null ? open(path) : openIfOwn(path));

  const id = (options.newId ?? randomUUID)();
  const line = encode({ id, command });
  if (Buffer.byteLength(line) - 1 > MAX_LINE) {
    return {
      ok: false,
      message: `The request is longer than ${MAX_LINE} bytes, so the daemon would refuse it.`,
    };
  }

  let connected = await connect();
  if (!connected.ok && connected.missing) {
    connected = await startAndWait(connect, options);
  }
  if (!connected.ok) return { ok: false, message: connected.message };
  return exchange(connected.socket, line, id);
}

async function startAndWait(
  connect: () => Promise<Connected>,
  options: ClientOptions,
): Promise<Connected> {
  const first = await start(options);
  if (!first.ok) return first;
  let started = first.started;

  const limit = options.startTimeoutMs ?? defaultStartTimeoutMs;
  const giveUpAt = Date.now() + limit;
  let exitedAt: number | null = null;
  let why = "";
  // The last "already running" refusal, kept for the final message: it
  // says how to get past a daemon nobody can reach.
  let running: string | null = null;
  for (;;) {
    const connected = await connect();
    if (connected.ok || !connected.missing) return connected;
    if (exitedAt === null && started.exited !== undefined) {
      const reason = started.exited();
      if (reason !== null) {
        exitedAt = Date.now();
        why = reason;
      }
    }
    if (exitedAt !== null && Date.now() - exitedAt > afterExitMs) {
      // The daemon that holds the lock may be stopping. If so, a daemon
      // started once it has gone takes over. Otherwise it is a real one
      // nobody can reach, and the start time limit reports it.
      if (!why.startsWith(ALREADY_RUNNING)) {
        return { ok: false, missing: true, message: `The daemon stopped while starting. ${why}` };
      }
      running = why;
      const again = await start(options);
      if (!again.ok) return again;
      started = again.started;
      exitedAt = null;
    }
    if (Date.now() >= giveUpAt) {
      const reason = exitedAt !== null ? why : running;
      const message =
        reason !== null
          ? `The daemon stopped while starting. ${reason}`
          : `The daemon didn't answer within ${limit / 1000} seconds of starting it.`;
      return { ok: false, missing: true, message };
    }
    await sleep(pollMs);
  }
}

// Why the shared folder in /tmp can't be trusted, or null if it can. It
// is made first if it isn't there, so nobody else can make it while a
// daemon starts. A folder of the user's that others can change is refused
// too: someone may have put a socket in it.
function unsafeFolder(folder: string): string | null {
  const unsafe = ownSocketFolder(folder);
  if (unsafe !== null) return unsafe;
  try {
    if ((lstatSync(folder).mode & 0o077) === 0) return null;
  } catch (error) {
    return `${folder} couldn't be checked: ${describe(error)}`;
  }
  return `${folder} is open to other users, so skelcrew won't use it. Run \`chmod 700 ${folder}\`, then try again.`;
}

async function start(
  options: ClientOptions,
): Promise<{ ok: true; started: Started & { ok: true } } | (Connected & { ok: false })> {
  let started: Started;
  try {
    started = await options.start();
  } catch (error) {
    return { ok: false, missing: true, message: describe(error) };
  }
  if (!started.ok) return { ok: false, missing: true, message: started.message };
  return { ok: true, started };
}

// Connects only to a socket of the user's own. Someone else's could answer
// in the daemon's place and see every command. No socket yet is fine: the
// connect then says nobody is there.
async function openIfOwn(path: string): Promise<Connected> {
  let owner: number | null = null;
  try {
    owner = lstatSync(path).uid;
  } catch {
    // Not there. The connect below finds that too.
  }
  if (owner !== null && owner !== process.getuid?.()) {
    return {
      ok: false,
      missing: false,
      message: `${path} belongs to another user, so skelcrew won't use it. Remove it, then try again.`,
    };
  }
  return open(path);
}

// A socket that doesn't exist, or has nobody listening, means no daemon
// is running. Any other error is a real problem, and is reported.
//
// The error listener goes on before connecting. Under `bun test`, a
// missing socket can fail inside connect() itself, before a listener added
// afterwards would hear it, and the error was thrown instead.
function open(path: string): Promise<Connected> {
  return new Promise((resolve) => {
    const socket = new Socket();
    const failed = (error: Error) => {
      const code = "code" in error ? error.code : undefined;
      const missing = code === "ENOENT" || code === "ECONNREFUSED";
      resolve({
        ok: false,
        missing,
        message: `The daemon's socket ${path} couldn't be reached: ${error.message}`,
      });
    };
    socket.once("error", failed);
    socket.once("connect", () => {
      socket.off("error", failed);
      resolve({ ok: true, socket });
    });
    try {
      socket.connect(path);
    } catch (error) {
      failed(error instanceof Error ? error : new Error(String(error)));
    }
  });
}

function exchange(socket: Socket, line: string, id: string): Promise<Answer> {
  return new Promise((resolve) => {
    let buffer = Buffer.alloc(0);
    let settled = false;
    const finish = (answer: Answer) => {
      if (settled) return;
      settled = true;
      socket.destroy();
      resolve(answer);
    };
    socket.on("data", (chunk: Buffer) => {
      buffer = Buffer.concat([buffer, chunk]);
      const end = buffer.indexOf(10);
      if (end === -1) return;
      finish(read(buffer.subarray(0, end).toString("utf8"), id));
    });
    socket.on("error", (error) =>
      finish({ ok: false, message: `The connection to the daemon failed: ${error.message}` }),
    );
    socket.on("close", () =>
      finish({ ok: false, message: "The daemon closed the connection without answering." }),
    );
    socket.write(line);
  });
}

function read(line: string, id: string): Answer {
  const parsed = parseReply(line);
  if (!parsed.ok)
    return { ok: false, message: parsed.message.replace("The reply", "The daemon's reply") };
  const reply = parsed.value;
  if (reply.id !== id) return { ok: false, message: "The daemon answered a different request." };
  return reply.ok ? { ok: true, result: reply.result } : { ok: false, message: reply.message };
}

function sleep(ms: number): Promise<void> {
  return new Promise((resolve) => setTimeout(resolve, ms));
}

function describe(error: unknown): string {
  return error instanceof Error ? error.message : String(error);
}
