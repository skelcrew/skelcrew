// The daemon's socket: `skelcrew serve` for one repository. It reads the
// repository's workflow.yml, opens its event store and the daemon, and
// answers requests on a local socket, one JSON message per line.
//
// Many connections can be open at once, and each may send many requests.
// The daemon's own queue still decides them one at a time.

import { existsSync, readFileSync, rmSync } from "node:fs";
import { createServer, type Socket } from "node:net";
import * as z from "zod";
import { parseWorkflow } from "../config/workflow";
import { encode, MAX_LINE, parseRequest, type Reply } from "../protocol/protocol";
import { EventStore } from "../store/store";
import { type Answer, Daemon, type DaemonOptions } from "./daemon";
import { takeLock } from "./lock";
import { daemonPaths } from "./paths";

export type ServeOptions = {
  // How long stopping waits for requests already being answered. Past
  // this, they are refused.
  graceMs?: number;
  newSession?: () => string;
};

export type Server = {
  socket: string;
  // Stops listening, finishes or refuses what is in flight, closes the
  // store and removes the socket file.
  stop(): Promise<void>;
};

export type Served = { ok: true; server: Server } | { ok: false; message: string };

// A reply must carry an id. When a line is too broken to read one from,
// the refusal carries this instead.
const UNKNOWN_ID = "unknown";

const defaultGraceMs = 30_000;

export async function serve(repo: string, options: ServeOptions = {}): Promise<Served> {
  const found = daemonPaths(repo);
  if (!found.ok) return found;
  const paths = found.paths;

  const workflow = readWorkflow(repo, paths.workflow);
  if (!workflow.ok) return workflow;

  const locked = takeLock(paths.folder);
  if (!locked.ok) return locked;
  const lock = locked.lock;
  // Holding the lock means no other daemon runs here. So a socket file
  // still there was left by one that died, and nobody answers on it.
  try {
    rmSync(paths.socket, { force: true });
  } catch (error) {
    lock.release();
    return {
      ok: false,
      message: `${paths.socket} couldn't be cleared for the daemon's socket: ${describe(error)}`,
    };
  }

  let store: EventStore;
  try {
    store = EventStore.open(paths.store);
  } catch (error) {
    lock.release();
    return { ok: false, message: `.skelcrew/skelcrew.db couldn't be opened: ${describe(error)}` };
  }
  const daemonOptions: DaemonOptions = { config: workflow.config, log: store };
  if (options.newSession !== undefined) daemonOptions.newSession = options.newSession;
  const opened = Daemon.open(daemonOptions);
  if (!opened.ok) {
    store.close();
    lock.release();
    return opened;
  }

  const listener = new Listener(opened.value, options.graceMs ?? defaultGraceMs);
  const listening = await listener.listen(paths.socket);
  if (!listening.ok) {
    await opened.value.close();
    store.close();
    lock.release();
    return listening;
  }
  return {
    ok: true,
    server: {
      socket: paths.socket,
      stop: async () => {
        await listener.stop();
        // Retries of unsaved replies stop here, before the store closes.
        // Otherwise they would keep failing against a closed store, and
        // keep the process from exiting.
        await opened.value.close();
        store.close();
        try {
          rmSync(paths.socket, { force: true });
        } catch {
          // The next daemon clears it, or says why it can't.
        }
        lock.release();
      },
    },
  };
}

export type Running =
  | { ok: true; socket: string; stopped: Promise<void> }
  | { ok: false; message: string };

// `skelcrew serve`: serves until SIGTERM or SIGINT, then stops cleanly.
// `stopped` resolves once it has.
export async function serveUntilSignalled(
  repo: string,
  options: ServeOptions = {},
): Promise<Running> {
  const served = await serve(repo, options);
  if (!served.ok) return served;
  const server = served.server;
  const stopped = new Promise<void>((resolve) => {
    const onSignal = () => {
      process.off("SIGTERM", onSignal);
      process.off("SIGINT", onSignal);
      void server.stop().then(resolve);
    };
    process.on("SIGTERM", onSignal);
    process.on("SIGINT", onSignal);
  });
  return { ok: true, socket: server.socket, stopped };
}

function readWorkflow(
  repo: string,
  path: string,
): { ok: true; config: DaemonOptions["config"] } | { ok: false; message: string } {
  if (!existsSync(path)) {
    return {
      ok: false,
      message: `${repo} has no .skelcrew/workflow.yml. Run \`skelcrew init\` there first.`,
    };
  }
  let text: string;
  try {
    text = readFileSync(path, "utf8");
  } catch (error) {
    return { ok: false, message: `.skelcrew/workflow.yml couldn't be read: ${describe(error)}` };
  }
  const parsed = parseWorkflow(text);
  if (!parsed.ok) {
    const reasons = parsed.reasons.map((reason) => `- ${reason}`);
    return { ok: false, message: [".skelcrew/workflow.yml doesn't fit:", ...reasons].join("\n") };
  }
  return { ok: true, config: parsed.workflow.config };
}

// A request being answered, so stopping can wait for it or refuse it.
type InFlight = { socket: Socket; id: string; answered: boolean; done: Promise<void> };

class Listener {
  private readonly server = createServer((socket) => this.connection(socket));
  private readonly sockets = new Set<Socket>();
  private readonly inFlight = new Set<InFlight>();
  private stopping: Promise<void> | null = null;

  constructor(
    private readonly daemon: Daemon,
    private readonly graceMs: number,
  ) {}

  listen(path: string): Promise<{ ok: true } | { ok: false; message: string }> {
    return new Promise((resolve) => {
      this.server.once("error", (error) =>
        resolve({ ok: false, message: `The socket ${path} couldn't be opened: ${error.message}` }),
      );
      this.server.listen(path, () => resolve({ ok: true }));
    });
  }

  stop(): Promise<void> {
    this.stopping ??= this.shutDown();
    return this.stopping;
  }

  private async shutDown(): Promise<void> {
    const closed = new Promise<void>((resolve) => this.server.close(() => resolve()));
    const pending = [...this.inFlight].map((request) => request.done);
    await Promise.race([Promise.all(pending), sleep(this.graceMs)]);
    for (const request of this.inFlight) {
      this.answer(request, { ok: false, message: "The daemon stopped before this finished." });
    }
    for (const socket of this.sockets) socket.end();
    await Promise.race([closed, sleep(1_000)]);
    for (const socket of this.sockets) socket.destroy();
  }

  private connection(socket: Socket): void {
    this.sockets.add(socket);
    socket.on("close", () => this.sockets.delete(socket));
    socket.on("error", () => socket.destroy());
    let buffer = Buffer.alloc(0);
    socket.on("data", (chunk: Buffer) => {
      buffer = Buffer.concat([buffer, chunk]);
      let end = buffer.indexOf(10);
      while (end !== -1 && !socket.writableEnded) {
        this.line(socket, buffer.subarray(0, end).toString("utf8"));
        buffer = buffer.subarray(end + 1);
        end = buffer.indexOf(10);
      }
      if (buffer.length > MAX_LINE && !socket.writableEnded) {
        this.refuseAndClose(socket, UNKNOWN_ID);
        buffer = Buffer.alloc(0);
      }
    });
  }

  private line(socket: Socket, text: string): void {
    if (Buffer.byteLength(text) > MAX_LINE) {
      this.refuseAndClose(socket, UNKNOWN_ID);
      return;
    }
    const parsed = parseRequest(text);
    if (!parsed.ok) {
      send(socket, { id: readableId(text), ok: false, message: parsed.message });
      return;
    }
    const { id, command } = parsed.value;
    if (this.stopping !== null) {
      send(socket, { id, ok: false, message: "The daemon is stopping." });
      return;
    }
    const request: InFlight = { socket, id, answered: false, done: Promise.resolve() };
    this.inFlight.add(request);
    request.done = this.daemon
      .handle(command)
      .catch(failed)
      .then((answer) => this.answer(request, answer));
  }

  private answer(request: InFlight, answer: Answer): void {
    this.inFlight.delete(request);
    if (request.answered) return;
    request.answered = true;
    send(request.socket, toReply(request.id, answer));
  }

  private refuseAndClose(socket: Socket, id: string): void {
    send(socket, { id, ok: false, message: `The request is longer than ${MAX_LINE} bytes.` });
    socket.end();
  }
}

function failed(error: unknown): Answer {
  return { ok: false, message: `The daemon failed: ${describe(error)}` };
}

function toReply(id: string, answer: Answer): Reply {
  if (!answer.ok) return { id, ok: false, message: answer.message };
  const result = z.json().safeParse(answer.result);
  if (!result.success) {
    return { id, ok: false, message: "The daemon's answer couldn't be sent as JSON." };
  }
  return { id, ok: true, result: result.data };
}

function send(socket: Socket, reply: Reply): void {
  if (socket.writable) socket.write(encode(reply));
}

// The id of a line that isn't a request, if it has one, so the client can
// still tell which request was refused.
function readableId(text: string): string {
  try {
    const parsed = z.object({ id: z.string().min(1) }).safeParse(JSON.parse(text));
    return parsed.success ? parsed.data.id : UNKNOWN_ID;
  } catch {
    return UNKNOWN_ID;
  }
}

function sleep(ms: number): Promise<void> {
  return new Promise((resolve) => setTimeout(resolve, ms).unref());
}

function describe(error: unknown): string {
  return error instanceof Error ? error.message : String(error);
}
