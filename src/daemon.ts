// The daemon, run by skel serve: keeps the lead running and answers the CLI on its socket.
// Plain skel makes sure it runs, then attaches to the lead.
import { dlopen, FFIType } from "bun:ffi";
import { mkdirSync, openSync, rmSync } from "node:fs";
import { createConnection, createServer, type Server, type Socket } from "node:net";
import { dirname } from "node:path";
import { z } from "zod";
import { openDb } from "./db.ts";
import { startLead } from "./lead.ts";
import { cliSocket, leadSocket } from "./paths.ts";
import { refreshClones } from "./repo.ts";
import { setupDone } from "./setup.ts";
import { attach } from "./tmux.ts";

const Request = z.object({ command: z.enum(["status", "lead"]) });
const LeadReply = z.union([z.object({ lead: z.literal(true) }), z.object({ error: z.string() })]);

function parseJson(text: string): unknown {
  try {
    return JSON.parse(text);
  } catch {
    return undefined;
  }
}

// What the daemon replies, or null when nothing answers. A socket file alone proves nothing:
// a daemon that was killed leaves it behind.
function ask(request: z.infer<typeof Request>, timeout: number): Promise<unknown> {
  return new Promise((done) => {
    const connection = createConnection(cliSocket());
    const timer = setTimeout(() => connection.destroy(), timeout);
    let reply = "";
    connection.on("connect", () => connection.write(`${JSON.stringify(request)}\n`));
    connection.on("data", (data) => {
      reply += data.toString();
      if (reply.includes("\n")) connection.end();
    });
    connection.on("error", () => {});
    connection.on("close", () => {
      clearTimeout(timer);
      done(reply ? parseJson(reply) : null);
    });
  });
}

// Whether this process now owns the lock. The kernel lets go of it when the process ends,
// however it ends, so a daemon that was killed never leaves it held. Node has no flock, so
// it comes from libc.
function lock(path: string): boolean {
  const libc = dlopen("libc.so.6", {
    flock: { args: [FFIType.i32, FFIType.i32], returns: FFIType.i32 },
  });
  const LOCK_EX = 2;
  const LOCK_NB = 4;
  // Never closed: closing it would let go of the lock.
  const fd = openSync(path, "a", 0o600);
  return libc.symbols.flock(fd, LOCK_EX | LOCK_NB) === 0;
}

function listen(server: Server, path: string): Promise<void> {
  return new Promise((done, failed) => {
    server.once("error", failed);
    server.listen(path, () => {
      server.off("error", failed);
      done();
    });
  });
}

// It never asks anything: under systemd there is nobody to answer.
export async function serve(tmux: string): Promise<void> {
  if (!setupDone()) throw new Error("the first run isn't done on this machine: run skel first");
  const db = openDb();
  // One start at a time, so two requests can't both find the lead gone and start it twice.
  let starting: Promise<void> = Promise.resolve();
  const lead = () => {
    starting = starting.catch(() => {}).then(() => startLead(db, tmux));
    return starting;
  };
  const answer = (connection: Socket) => {
    let request = "";
    const reply = (answer: object) => connection.end(`${JSON.stringify(answer)}\n`);
    connection.on("data", (data) => {
      request += data.toString();
      const end = request.indexOf("\n");
      if (end === -1) return;
      const asked = Request.safeParse(parseJson(request.slice(0, end)));
      if (!asked.success) reply({ error: "skel's daemon doesn't know that request" });
      else if (asked.data.command === "status") reply({ running: true, pid: process.pid });
      else
        lead().then(
          () => {
            reply({ lead: true });
            // After the reply, so attaching never waits on GitHub.
            refreshClones(db).catch((error) => console.log(String(error)));
          },
          (error) => reply({ error: error instanceof Error ? error.message : String(error) }),
        );
    });
    connection.on("error", () => {});
  };
  // The lock decides which of two daemons started together runs. The socket can't: both
  // could find one left by a daemon that was killed, and each remove the other's new one.
  const path = cliSocket();
  if (!lock(`${path}.lock`))
    throw new Error("skel's daemon is already running. Run skel to attach to the lead.");
  // The lead runs the same commands you do, so its socket answers the same requests.
  const sockets = [path, leadSocket()];
  for (const socket of sockets) {
    mkdirSync(dirname(socket), { recursive: true, mode: 0o700 });
    rmSync(socket, { force: true });
    await listen(createServer(answer), socket);
  }
  // The tmux sessions are left running: agents keep working while the daemon is down.
  for (const signal of ["SIGTERM", "SIGINT"])
    process.on(signal, () => {
      for (const socket of sockets) rmSync(socket, { force: true });
      process.exit(0);
    });
  console.log(`Listening on ${path}.`);
  await lead().catch((error) => console.log(error instanceof Error ? error.message : error));
}

// Returns when you detach with Ctrl-].
export async function attachToLead(tmux: string): Promise<void> {
  // Asking for the lead brings it back if it ended while the daemon kept running.
  let reply = await ask({ command: "lead" }, 15_000);
  if (reply === null) {
    const start = Bun.spawnSync(["systemctl", "--user", "start", "skel"], {
      stdio: ["inherit", "inherit", "inherit"],
    });
    if (!start.success) throw new Error("systemctl couldn't start skel's daemon");
    const deadline = Date.now() + 10_000;
    while (reply === null) {
      if (Date.now() > deadline)
        throw new Error(
          "skel's daemon didn't answer within 10 seconds: journalctl --user -u skel shows why",
        );
      await Bun.sleep(100);
      reply = await ask({ command: "lead" }, 15_000);
    }
  }
  const lead = LeadReply.safeParse(reply);
  if (!lead.success)
    throw new Error("skel's daemon answered in a way this skel doesn't understand");
  if ("error" in lead.data) throw new Error(lead.data.error);
  await attach(tmux, "lead");
}
