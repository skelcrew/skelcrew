// sc ask, as the lead runs it: what it sends the daemon for each of its forms, read by a stand-in
// daemon on the test's own socket, and the forms it refuses before asking anything.
import { afterEach, beforeEach, expect, test } from "bun:test";
import { mkdtempSync, realpathSync, rmSync } from "node:fs";
import { createServer, type Server } from "node:net";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { runSkel } from "./harness.ts";

let home = "";
let daemon: Server | null = null;
// What the stand-in daemon was asked, other than whether a word names a repository.
const requests: unknown[] = [];

// The stand-in names one repository, app, and answers each request as the daemon answers a lead.
beforeEach(async () => {
  home = realpathSync(mkdtempSync(join(tmpdir(), "skel-ask-test-")));
  daemon = createServer((connection) =>
    connection.on("data", (data) => {
      const request = JSON.parse(data.toString());
      if (request.command === "repo named") {
        connection.end(`${JSON.stringify({ named: request.word === "app" })}\n`);
        return;
      }
      requests.push(request);
      connection.end(`${JSON.stringify({ asked: "Asked the human in the list." })}\n`);
    }),
  );
  const listening = daemon;
  await new Promise<void>((done) => listening.listen(join(home, "daemon.sock"), done));
});
afterEach(() => {
  daemon?.close();
  daemon = null;
  requests.length = 0;
  rmSync(home, { recursive: true, force: true });
});

// Runs sc as the lead, from its sandbox, with `input` on its stdin when given.
const asLead = (args: string[], input?: string) =>
  runSkel(
    args,
    {
      HOME: home,
      PATH: process.env.PATH ?? "",
      SKELCREW_SANDBOX: "1",
      SKELCREW_SOCKET: join(home, "daemon.sock"),
    },
    input,
  );

test("sc ask start takes what sc start takes, and asks for it in the list", async () => {
  const issue = await asLead(["ask", "start", "APP-31", "--short", "CSV", "--flow", "quick"]);
  await asLead(["ask", "start", "APP-31", "--from", "dev"]);
  expect(issue).toMatchObject({ out: "Asked the human in the list.\n", err: "", code: 0 });
  await asLead(["ask", "start", "app", "CSV export", "Add a CSV export."]);
  await asLead(["ask", "start", "app"], "# CSV export\n\nAdd a CSV export.\n");
  expect(requests).toEqual([
    {
      command: "ask",
      repo: "APP",
      action: { kind: "start", task: "31", short: "CSV", flow: "quick" },
    },
    { command: "ask", repo: "APP", action: { kind: "start", task: "31", from: "dev" } },
    {
      command: "ask",
      repo: "app",
      action: { kind: "start new", title: "CSV export", body: "Add a CSV export." },
    },
    {
      command: "ask",
      repo: "app",
      action: { kind: "start new", title: "CSV export", body: "Add a CSV export.\n" },
    },
  ]);
});

test("sc ask repo add asks to add a repository, naming no repository of the lead's", async () => {
  expect((await asLead(["ask", "repo", "add", "simon/site"])).code).toBe(0);
  expect(requests).toEqual([
    { command: "ask", action: { kind: "repo add", repository: "simon/site" } },
  ]);
});

// A request carries only what y does, so a form sc ask doesn't take asks nothing.
test("sc ask refuses what it doesn't take, and asks the daemon nothing", async () => {
  for (const args of [
    ["ask"],
    ["ask", "stop", "app-31"],
    ["ask", "start", "app", "--from", "dev"],
    ["ask", "repo", "add"],
    ["ask", "repo", "rm", "simon/site"],
    ["ask", "start", "app", "CSV export", "  "],
  ]) {
    const run = await asLead(args);
    expect(run.code).toBe(1);
    expect(run.err).toStartWith("Skelcrew: ");
  }
  expect(requests).toEqual([]);
});
