// Wake-ups to a Sprite: the listener that brings a plugin's polls forward when a delivery for
// it arrives.
import { afterEach, expect, test } from "bun:test";
import { listenForWakeUps } from "../src/flow/wake.ts";

let stop = () => {};
afterEach(() => stop());

// Starts the listener on a free port, noting each plugin it wakes. Each wake-up is taken in
// after `takes` milliseconds. The only plugin installed is fake.
function listen(takes = 0): { url: string; woken: string[] } {
  const woken: string[] = [];
  const server = listenForWakeUps(0, async (plugin) => {
    if (plugin !== "fake") return false;
    await Bun.sleep(takes);
    woken.push(plugin);
    return true;
  });
  stop = () => server.stop(true);
  return { url: `http://127.0.0.1:${server.port}/`, woken };
}

// A delivery only says "look now", so it needs no signature and nothing in it is read.
test("a delivery to a plugin's name wakes that plugin's polls", async () => {
  const { url, woken } = listen();
  expect((await fetch(`${url}fake`, { method: "POST", body: "anything" })).status).toBe(202);
  expect(woken).toEqual(["fake"]);
});

// A Sprite sleeps again as soon as the delivery is answered.
test("answers a delivery only once the daemon has taken it in", async () => {
  const { url, woken } = listen(300);
  const sent = Date.now();
  expect((await fetch(`${url}fake`, { method: "POST" })).status).toBe(202);
  expect(Date.now() - sent).toBeGreaterThanOrEqual(300);
  expect(woken).toEqual(["fake"]);
});

// Anyone can reach the Sprite's URL, so only a delivery to a plugin's name does anything.
test("a delivery to no plugin, or a plain request, wakes nothing", async () => {
  const { url, woken } = listen();
  expect((await fetch(`${url}other`, { method: "POST", body: "{}" })).status).toBe(404);
  expect((await fetch(url, { method: "POST", body: "{}" })).status).toBe(404);
  expect((await fetch(`${url}fake`)).status).toBe(404);
  expect(woken).toEqual([]);
});
