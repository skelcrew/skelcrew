// Wake-ups on a Sprite: the listener that has a plugin's next polls come at once when a
// delivery for it arrives, and asking a repository's tracker and forge to send them. A
// delivery only says "look now": what happened is always read by polling, so a missed
// delivery loses nothing, and a forged one could at most cause a poll.
import type { Database } from "bun:sqlite";
import type { Repository } from "../db.ts";
import { spriteUrl } from "../machine/sprite.ts";
import { pluginsOf, wake } from "../plugins/ask.ts";

// Listens on the port for deliveries to /<name>, and has `wake` bring that plugin's polls
// forward. `wake` says whether a plugin has that name. Anyone can reach a Sprite's URL, so a
// delivery is never read, and one to no plugin's name is refused. It answers once `wake` has
// taken it in, as the Sprite sleeps again once the delivery is answered.
export function listenForWakeUps(
  port: number,
  wakePlugin: (plugin: string) => Promise<boolean>,
): Bun.Server<undefined> {
  return Bun.serve({
    port,
    fetch: async (request) => {
      // The path names the plugin, and the body is left unread: only that a delivery came
      // matters. Anything else gets the same answer as an unknown plugin, so a stranger learns
      // nothing about which plugins run here.
      if (request.method !== "POST") return new Response("Not found\n", { status: 404 });
      const plugin = new URL(request.url).pathname.slice(1);
      if (plugin && (await wakePlugin(plugin))) return new Response("Polling\n", { status: 202 });
      return new Response("Not found\n", { status: 404 });
    },
  });
}

// Asks each of the repository's tracker and forge to pass its wake-ups to this Sprite's URL,
// at /<plugin>, or with `stop` to stop. A plugin with no wake-ups does nothing.
export async function wakeRepository(
  db: Database,
  repository: Repository,
  stop = false,
): Promise<void> {
  for (const { plugin } of pluginsOf(db, repository))
    await wake(db, plugin, repository, `${spriteUrl()}/${plugin}`, stop);
}
