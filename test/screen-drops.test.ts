// Files dropped onto the screen reach the agent your typing goes to as copies in its own folder,
// which its sandbox lets it read, through the screen's real tmux servers.
import { afterEach, beforeEach, expect, setDefaultTimeout, test } from "bun:test";
import { existsSync, readFileSync, writeFileSync } from "node:fs";
import { join } from "node:path";
import {
  attachTo,
  daemon,
  endTest,
  home,
  onDetails,
  open,
  press,
  read,
  ready,
  startTest,
  type,
  until,
} from "./screen.ts";

// Longer than the screen's waits, so a test that fails says what it waited for.
setDefaultTimeout(20_000);
beforeEach(startTest);
afterEach(endTest);

const skelcrew = () => join(home, ".local", "share", "skelcrew");

// Drops a file onto the terminal, as a terminal pastes its path, and sends it to the agent.
// Keys don't wait for a drop's files, so as a person would, it presses Enter a moment after the
// copy is in `folder`, the agent's, or at once for a drop that copies nothing.
async function drop(path: string, folder: string | null): Promise<void> {
  type(`\x1b[200~${path.replaceAll(" ", "\\ ")}\x1b[201~`);
  if (folder !== null) {
    await until(() => existsSync(join(folder, ".skelcrew-drops")), "the copy");
    await Bun.sleep(300);
  }
  press("Enter");
}

// Waits for the line the agent got, and returns it.
async function got(agent: string): Promise<string> {
  await until(() => read(`${agent}.typed`).endsWith("\n"), `${agent} to get the paste`);
  return read(`${agent}.typed`).trim();
}

test("a file dropped onto the lead reaches it as a copy in the lead's folder", async () => {
  const shot = join(home, "Screen Shot.png");
  writeFileSync(shot, "pixels");
  open("lead");
  await ready("lead");
  // app's lead is the one kept from before, in Skelcrew's folder named lead.
  await drop(shot, join(skelcrew(), "lead"));
  const line = await got("lead");
  expect(line.startsWith(`${join(skelcrew(), "lead", ".skelcrew-drops")}/`)).toBe(true);
  expect(line.endsWith("/Screen\\ Shot.png")).toBe(true);
  expect(readFileSync(line.replaceAll("\\ ", " "), "utf8")).toBe("pixels");
});

test("a file dropped onto a builder you attached to reaches it in its clone", async () => {
  daemon();
  const notes = join(home, "notes.txt");
  writeFileSync(notes, "notes");
  open("lead");
  await ready("lead");
  press("M-S-Down");
  await attachTo("app-12");
  await drop(notes, join(skelcrew(), "threads", "app-12"));
  const line = await got("app-12");
  expect(line.startsWith(`${join(skelcrew(), "threads", "app-12", ".skelcrew-drops")}/`)).toBe(
    true,
  );
  expect(readFileSync(line, "utf8")).toBe("notes");
});

test("right after Ctrl-\\ back from a builder, a drop goes to its details, and nothing is copied", async () => {
  daemon();
  const notes = join(home, "notes.txt");
  writeFileSync(notes, "notes");
  open("lead");
  await ready("lead");
  press("M-S-Down");
  await attachTo("app-12");
  const clone = join(skelcrew(), "threads", "app-12");
  press("C-\\");
  await until(onDetails, "APP-12's details");
  await drop(notes, null);
  await Bun.sleep(500);
  expect(existsSync(join(clone, ".skelcrew-drops"))).toBe(false);
  expect(read("app-12.typed")).toBe("");
});

test("a drop right after a key that moves off the lead goes with that move, so nothing is copied", async () => {
  const notes = join(home, "notes.txt");
  writeFileSync(notes, "notes");
  open("lead");
  await ready("lead");
  // Alt-Shift-Down moves to APP-12's details, where your typing goes to the sidebar. The drop
  // comes in the same breath, before the sidebar has acted on the key.
  type(`\x1b[1;4B\x1b[200~${notes}\x1b[201~`);
  await until(onDetails, "APP-12's details");
  await Bun.sleep(500);
  expect(existsSync(join(skelcrew(), "lead", ".skelcrew-drops"))).toBe(false);
  expect(read("lead.typed")).toBe("");
});

test("text pasted onto the screen reaches the agent as it was", async () => {
  open("lead");
  await ready("lead");
  type("\x1b[200~/tmp and more\x1b[201~");
  press("Enter");
  expect(await got("lead")).toBe("/tmp and more");
});
