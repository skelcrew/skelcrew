// The daemon, run by skel serve: keeps the lead running and answers the CLI on its socket.
// Plain skel makes sure it runs, then attaches to the lead.
import { rmSync } from "node:fs";
import { createConnection, createServer, type Server } from "node:net";
import { z } from "zod";
import { openDb } from "./db.ts";
import { startLead } from "./lead.ts";
import { cliSocket } from "./paths.ts";
import { setupDone } from "./setup.ts";
import { attach } from "./tmux.ts";

const Request = z.object({ command: z.enum(["status", "lead"]) });
const Status = z.object({ running: z.literal(true), pid: z.number() });
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

export async function daemonRunning(): Promise<boolean> {
  return Status.safeParse(await ask({ command: "status" }, 1000)).success;
}

function listen(server: Server, path: string): Promise<boolean> {
  return new Promise((done, failed) => {
    const refused = (error: Error) =>
      "code" in error && error.code === "EADDRINUSE" ? done(false) : failed(error);
    server.once("error", refused);
    server.listen(path, () => {
      server.off("error", refused);
      done(true);
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
  const server = createServer((connection) => {
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
          () => reply({ lead: true }),
          (error) => reply({ error: error instanceof Error ? error.message : String(error) }),
        );
    });
    connection.on("error", () => {});
  });
  // Listening first decides which of two daemons started together runs: only one can hold
  // the socket. A socket nobody answers on is left from a daemon that was killed.
  const path = cliSocket();
  const running = "skel's daemon is already running. Run skel to attach to the lead.";
  if (!(await listen(server, path))) {
    if (await daemonRunning()) throw new Error(running);
    rmSync(path, { force: true });
    if (!(await listen(server, path))) throw new Error(running);
  }
  // The tmux sessions are left running: agents keep working while the daemon is down.
  for (const signal of ["SIGTERM", "SIGINT"])
    process.on(signal, () => {
      rmSync(path, { force: true });
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
