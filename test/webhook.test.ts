// GitHub's webhooks to a Sprite: the secret that signs them, checking a delivery's signature,
// and the listener that has the daemon poll the delivery's repository.
import { afterEach, beforeEach, expect, test } from "bun:test";
import { createHmac } from "node:crypto";
import { mkdtempSync, readFileSync, realpathSync, rmSync, statSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { listenForWebhooks, signedBy } from "../src/flow/webhook.ts";
import { source } from "./harness.ts";

const secret = "a".repeat(64);
const body = JSON.stringify({ action: "labeled", repository: { full_name: "simon/app" } });
const sign = (text: string, key = secret) =>
  `sha256=${createHmac("sha256", key).update(text).digest("hex")}`;

test("a delivery signed with the secret is GitHub's", () => {
  expect(signedBy(secret, Buffer.from(body), sign(body))).toBe(true);
});

test("a delivery signed with another secret, or with its body changed, isn't", () => {
  expect(signedBy(secret, Buffer.from(body), sign(body, "b".repeat(64)))).toBe(false);
  expect(signedBy(secret, Buffer.from(`${body} `), sign(body))).toBe(false);
  expect(signedBy(secret, Buffer.from(body), "sha256=short")).toBe(false);
});

test("a delivery with no signature isn't", () => {
  expect(signedBy(secret, Buffer.from(body), null)).toBe(false);
  expect(signedBy(secret, Buffer.from(body), "")).toBe(false);
});

let home = "";
let stop: () => void = () => {};
beforeEach(() => {
  home = realpathSync(mkdtempSync(join(tmpdir(), "skel-webhook-test-")));
});
afterEach(() => {
  stop();
  rmSync(home, { recursive: true, force: true });
});

// Runs webhookSecret in a Skelcrew whose home is the test's, and returns what it printed.
function secretIn(): string {
  const script = `import { webhookSecret } from ${JSON.stringify(source("flow/webhook.ts"))};
process.stdout.write(webhookSecret());`;
  const run = Bun.spawnSync([process.execPath, "-e", script], {
    env: { HOME: home },
    stdout: "pipe",
    stderr: "pipe",
  });
  if (!run.success) throw new Error(run.stderr.toString());
  return run.stdout.toString();
}

test("makes the secret once, and keeps it where only you can read it", () => {
  const made = secretIn();
  expect(made).toMatch(/^[0-9a-f]{64}$/);
  const file = join(home, ".config", "skelcrew", "webhook-secret");
  expect(readFileSync(file, "utf8")).toBe(made);
  expect(statSync(file).mode & 0o777).toBe(0o600);
  expect(secretIn()).toBe(made);
});

// Starts the listener on a free port, noting each repository it is told to poll, and each
// plugin it wakes. Each poll is taken in after `takes` milliseconds. The only plugin installed
// is fake.
function listen(takes = 0): { url: string; polled: string[]; woken: string[] } {
  const polled: string[] = [];
  const woken: string[] = [];
  const server = listenForWebhooks(
    0,
    secret,
    async (repo) => {
      await Bun.sleep(takes);
      polled.push(repo);
    },
    async (plugin) => {
      if (plugin !== "fake") return false;
      woken.push(plugin);
      return true;
    },
  );
  stop = () => server.stop(true);
  return { url: `http://127.0.0.1:${server.port}/`, polled, woken };
}

const deliver = (url: string, event: string, text: string, signature: string | null) =>
  fetch(url, {
    method: "POST",
    headers: {
      "Content-Type": "application/json",
      "X-GitHub-Event": event,
      ...(signature === null ? {} : { "X-Hub-Signature-256": signature }),
    },
    body: text,
  });

test("a signed delivery has the daemon poll its repository, and nothing else", async () => {
  const { url, polled } = listen();
  const answer = await deliver(url, "issues", body, sign(body));
  expect(answer.status).toBe(202);
  expect(polled).toEqual(["simon/app"]);
});

// A Sprite sleeps again as soon as the delivery is answered.
test("answers a delivery only once the daemon has taken it in", async () => {
  const { url, polled } = listen(300);
  const sent = Date.now();
  expect((await deliver(url, "issues", body, sign(body))).status).toBe(202);
  expect(Date.now() - sent).toBeGreaterThanOrEqual(300);
  expect(polled).toEqual(["simon/app"]);
});

test("a delivery with a wrong signature or none polls nothing", async () => {
  const { url, polled } = listen();
  expect((await deliver(url, "issues", body, sign(body, "b".repeat(64)))).status).toBe(401);
  expect((await deliver(url, "issues", body, null)).status).toBe(401);
  expect(polled).toEqual([]);
});

test("answers GitHub's ping, which polls nothing", async () => {
  const { url, polled } = listen();
  const ping = JSON.stringify({ zen: "Keep it logically awesome.", hook_id: 1 });
  expect((await deliver(url, "ping", ping, sign(ping))).status).toBe(200);
  expect(polled).toEqual([]);
});

// Anyone can reach the Sprite's URL, so only a signed delivery gets past the door.
test("answers a plain request without polling", async () => {
  const { url, polled } = listen();
  expect((await fetch(url)).status).toBe(404);
  expect(polled).toEqual([]);
});

// A plugin's delivery only says "look now", so it needs no signature and nothing in it is read.
test("a delivery to a plugin's name wakes that plugin's polls", async () => {
  const { url, polled, woken } = listen();
  expect((await fetch(`${url}fake`, { method: "POST", body: "anything" })).status).toBe(202);
  expect(woken).toEqual(["fake"]);
  expect((await fetch(`${url}other`, { method: "POST", body: "anything" })).status).toBe(401);
  expect((await fetch(`${url}fake`)).status).toBe(404);
  expect(woken).toEqual(["fake"]);
  expect(polled).toEqual([]);
});
