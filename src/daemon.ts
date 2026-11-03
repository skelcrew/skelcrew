// The daemon, run by skel serve: keeps the lead running and answers the CLI on its socket.
import { rmSync } from "node:fs";
import { createConnection, createServer } from "node:net";
import { z } from "zod";
import { openDb } from "./db.ts";
import { startLead } from "./lead.ts";
import { cliSocket } from "./paths.ts";
import { setupDone } from "./setup.ts";

const Request = z.object({ command: z.literal("status") });
const Status = z.object({ running: z.literal(true), pid: z.number() });

function parseJson(text: string): unknown {
  try {
    return JSON.parse(text);
  } catch {
    return undefined;
  }
}

// A socket file alone proves nothing: a daemon that was killed leaves it behind.
export function daemonRunning(): Promise<boolean> {
  return new Promise((done) => {
    const connection = createConnection(cliSocket());
    const timer = setTimeout(() => connection.destroy(), 1000);
    let reply = "";
    connection.on("connect", () => connection.write(`${JSON.stringify({ command: "status" })}\n`));
    connection.on("data", (data) => {
      reply += data.toString();
      if (reply.includes("\n")) connection.end();
    });
    connection.on("error", () => {});
    connection.on("close", () => {
      clearTimeout(timer);
      done(Status.safeParse(parseJson(reply)).success);
    });
  });
}

function answer(line: string) {
  if (!Request.safeParse(parseJson(line)).success)
    return { error: "skel's daemon doesn't know that request" };
  return { running: true, pid: process.pid };
}

// It never asks anything: under systemd there is nobody to answer.
export async function serve(tmux: string): Promise<void> {
  if (!setupDone()) throw new Error("the first run isn't done on this machine: run skel first");
  if (await daemonRunning())
    throw new Error("skel's daemon is already running. Run skel to attach to the lead.");
  startLead(openDb(), tmux);
  const path = cliSocket();
  rmSync(path, { force: true });
  const server = createServer((connection) => {
    let request = "";
    connection.on("data", (data) => {
      request += data.toString();
      const end = request.indexOf("\n");
      if (end !== -1) connection.end(`${JSON.stringify(answer(request.slice(0, end)))}\n`);
    });
    connection.on("error", () => {});
  });
  await new Promise<void>((listening, failed) => {
    server.once("error", failed);
    server.listen(path, listening);
  });
  console.log(`Listening on ${path}.`);
  // The tmux sessions are left running: agents keep working while the daemon is down.
  for (const signal of ["SIGTERM", "SIGINT"])
    process.on(signal, () => {
      rmSync(path, { force: true });
      process.exit(0);
    });
}
