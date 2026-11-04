// GitHub's webhooks to a Sprite: the secret they are signed with, and the listener that has
// the daemon poll a repository at once when a delivery for it comes in. A delivery only wakes
// the daemon early. What happened is always read by polling, so a missed delivery loses
// nothing, and a forged one could at most cause a poll.
import { createHmac, randomBytes, timingSafeEqual } from "node:crypto";
import { linkSync, mkdirSync, readFileSync, rmSync, writeFileSync } from "node:fs";
import { join } from "node:path";
import { z } from "zod";
import { setWebhook } from "./github.ts";
import { configDir } from "./paths.ts";
import { spriteUrl } from "./sprite.ts";

const secretFile = () => join(configDir(), "webhook-secret");

const Secret = z.string().regex(/^[0-9a-f]{64}$/);

// Returns the secret GitHub signs skel's webhook deliveries with, made the first time and
// kept readable only by you. The daemon and skel in your terminal can both ask for it first,
// so it is written beside the file and linked into place, which fails if the other won.
export function webhookSecret(): string {
  mkdirSync(configDir(), { recursive: true });
  const part = `${secretFile()}.${process.pid}`;
  writeFileSync(part, randomBytes(32).toString("hex"), { mode: 0o600 });
  try {
    linkSync(part, secretFile());
  } catch {
    // Already made, by an earlier skel or the other one.
  } finally {
    rmSync(part, { force: true });
  }
  const read = Secret.safeParse(readFileSync(secretFile(), "utf8"));
  if (!read.success)
    throw new Error(
      `${secretFile()} doesn't hold a secret skel made: remove it, and skel makes a new one`,
    );
  return read.data;
}

// Returns whether the body was signed with the secret, as GitHub signs each delivery in its
// X-Hub-Signature-256 header. Compared in constant time, so the answer's timing gives away
// nothing about the right signature.
export function signedBy(secret: string, body: Uint8Array, signature: string | null): boolean {
  if (!signature) return false;
  const right = Buffer.from(`sha256=${createHmac("sha256", secret).update(body).digest("hex")}`);
  const given = Buffer.from(signature);
  return given.length === right.length && timingSafeEqual(given, right);
}

const Delivery = z.object({ repository: z.object({ full_name: z.string() }) });

// Listens on the port for GitHub's deliveries, and has `poll` poll the repository a signed
// one names, by its full GitHub name. It answers once `poll` is done, which must be soon, as
// GitHub gives up after 10 seconds. Anyone can reach a Sprite's URL, so anything unsigned or
// signed with another secret is refused, and a delivery's content is never acted on.
export function listenForWebhooks(
  port: number,
  secret: string,
  poll: (repo: string) => Promise<void>,
): Bun.Server<undefined> {
  return Bun.serve({
    port,
    fetch: async (request) => {
      if (request.method !== "POST") return new Response("Not found\n", { status: 404 });
      const body = new Uint8Array(await request.arrayBuffer());
      if (!signedBy(secret, body, request.headers.get("X-Hub-Signature-256"))) {
        console.log("ignored a webhook delivery that wasn't signed with skel's secret");
        return new Response("Wrong signature\n", { status: 401 });
      }
      // GitHub pings a webhook once it is created, to see it answer.
      if (request.headers.get("X-GitHub-Event") === "ping") return new Response("pong\n");
      let delivery: z.infer<typeof Delivery>;
      try {
        delivery = Delivery.parse(JSON.parse(new TextDecoder().decode(body)));
      } catch {
        return new Response("No repository\n", { status: 400 });
      }
      await poll(delivery.repository.full_name);
      return new Response("Polling\n", { status: 202 });
    },
  });
}

// Sets the webhook that wakes this Sprite on a repository, owner/name, so a label, your
// comment or your merge there reaches skel while the Sprite sleeps.
export async function hookRepository(full: string): Promise<void> {
  await setWebhook(full, spriteUrl(), webhookSecret());
}
