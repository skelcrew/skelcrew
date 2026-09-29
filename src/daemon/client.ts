// The client: sends one command to a repository's daemon and returns its
// answer as a value. It never throws.
//
// If no daemon is running, it starts one through the function it is given,
// and waits for the socket to answer. The CLI gives a function that runs
// `skelcrew serve` in the background.

import { randomUUID } from "node:crypto";
import { Socket } from "node:net";
import { type Command, encode, MAX_LINE, parseReply } from "../protocol/protocol";
import type { Answer } from "./daemon";
import { daemonPaths } from "./paths";

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

  const id = (options.newId ?? randomUUID)();
  const line = encode({ id, command });
  if (Buffer.byteLength(line) - 1 > MAX_LINE) {
    return {
      ok: false,
      message: `The request is longer than ${MAX_LINE} bytes, so the daemon would refuse it.`,
    };
  }

  let connected = await open(path);
  if (!connected.ok && connected.missing) {
    connected = await startAndWait(path, options);
  }
  if (!connected.ok) return { ok: false, message: connected.message };
  return exchange(connected.socket, line, id);
}

async function startAndWait(path: string, options: ClientOptions): Promise<Connected> {
  let started: Started;
  try {
    started = await options.start();
  } catch (error) {
    return { ok: false, missing: true, message: describe(error) };
  }
  if (!started.ok) return { ok: false, missing: true, message: started.message };

  const limit = options.startTimeoutMs ?? defaultStartTimeoutMs;
  const giveUpAt = Date.now() + limit;
  let exitedAt: number | null = null;
  let why = "";
  for (;;) {
    const connected = await open(path);
    if (connected.ok || !connected.missing) return connected;
    if (exitedAt === null && started.exited !== undefined) {
      const reason = started.exited();
      if (reason !== null) {
        exitedAt = Date.now();
        why = reason;
      }
    }
    if (exitedAt !== null && Date.now() - exitedAt > afterExitMs) {
      return { ok: false, missing: true, message: `The daemon stopped while starting. ${why}` };
    }
    if (Date.now() >= giveUpAt) {
      const message =
        exitedAt !== null
          ? `The daemon stopped while starting. ${why}`
          : `The daemon didn't answer within ${limit / 1000} seconds of starting it.`;
      return { ok: false, missing: true, message };
    }
    await sleep(pollMs);
  }
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
