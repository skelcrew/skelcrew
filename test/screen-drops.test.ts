// Files dropped onto the screen reach the agent your typing goes to as copies in its own folder,
// which its sandbox lets it read, through the screen's real tmux servers.
import { afterEach, beforeEach, expect, setDefaultTimeout, test } from "bun:test";
import { existsSync, mkdirSync, readFileSync, writeFileSync } from "node:fs";
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
  screen,
  screenSessions,
  seen,
  startTest,
  tmux,
  type,
  until,
} from "./screen.ts";

// Longer than the screen's waits, so a test that fails says what it waited for.
setDefaultTimeout(20_000);
beforeEach(startTest);
afterEach(endTest);

const skelcrew = () => join(home, ".local", "share", "skelcrew");

// Drops a file onto the terminal, as a terminal pastes its path, and presses Enter right after.
// Enter waits for the paste, so the agent gets the path.
function drop(path: string): void {
  type(`\x1b[200~${path.replaceAll(" ", "\\ ")}\x1b[201~`);
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
  drop(shot);
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
  drop(notes);
  const line = await got("app-12");
  expect(line.startsWith(`${join(skelcrew(), "threads", "app-12", ".skelcrew-drops")}/`)).toBe(
    true,
  );
  expect(readFileSync(line, "utf8")).toBe("notes");
});

test("a file dropped onto a builder you opened full screen reaches it in its clone", async () => {
  daemon();
  const notes = join(home, "notes.txt");
  writeFileSync(notes, "notes");
  open("lead");
  await ready("lead");
  press("M-S-Down");
  await until(onDetails, "APP-12's details");
  type("a");
  // tmux zooms the right side, so it fills the terminal.
  const zoomed = () =>
    tmux(screen, "display", "-p", "-t", `=${screenSessions()[0]}:`, "#{window_zoomed_flag}").out;
  await until(() => zoomed().trim() === "1", "app-12 full screen");
  drop(notes);
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
  drop(notes);
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

test("a file dropped while your typing goes to the sidebar presses none of its keys", async () => {
  // 2 closes Building and a attaches full screen, and the test's own folder adds more such
  // letters and digits, so any key pressed would show.
  const dir = join(home, "2a");
  mkdirSync(dir);
  const notes = join(dir, "notes.txt");
  writeFileSync(notes, "notes");
  open("lead");
  await ready("lead");
  press("M-S-Down");
  await until(onDetails, "APP-12's details");
  // Everything but the last line, whose load changes on its own.
  const shown = () => seen().trimEnd().split("\n").slice(0, -1).join("\n");
  const before = shown();
  type(`\x1b[200~${notes}\x1b[201~`);
  await Bun.sleep(500);
  expect(shown()).toBe(before);
  expect(existsSync(join(skelcrew(), "threads", "app-12", ".skelcrew-drops"))).toBe(false);
});

test("a right click on the top row does what it did before a drop could ask there", async () => {
  open("lead");
  await ready("lead");
  type("\x1b[<2;3;1M\x1b[<2;3;1m");
  type("hello\r");
  expect(await got("lead")).toBe("hello");
  const session = `=${screenSessions()[0] ?? ""}:`;
  expect(tmux(screen, "show", "-qv", "-t", session, "@drop-answer").out.trim()).toBe("");
});

test("a screen opened from a laptop with sc --remote leaves a drop to the laptop", async () => {
  // The path names a file on this machine too, which must never reach the agent in its place.
  const shot = join(home, "shot.png");
  writeFileSync(shot, "pixels");
  open("lead", "one", "xterm-256color", "120", "simon@workbox");
  await ready("lead");
  drop(shot);
  expect(await got("lead")).toBe(shot);
  expect(existsSync(join(skelcrew(), "lead", ".skelcrew-drops"))).toBe(false);
});

test("text pasted onto the screen reaches the agent as it was", async () => {
  open("lead");
  await ready("lead");
  type("\x1b[200~/tmp and more\x1b[201~");
  press("Enter");
  expect(await got("lead")).toBe("/tmp and more");
});
