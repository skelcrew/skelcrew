// Files dropped onto the screen reach the agent your typing goes to as copies in its own folder,
// which its sandbox lets it read, through the screen's real tmux servers.
import { afterEach, beforeEach, expect, setDefaultTimeout, test } from "bun:test";
import { readFileSync, writeFileSync } from "node:fs";
import { join } from "node:path";
import {
  attachTo,
  daemon,
  endTest,
  home,
  open,
  press,
  read,
  ready,
  screen,
  screenSessions,
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

// Drops a file onto the terminal, as a terminal pastes its path, and sends it to the agent.
function drop(path: string): void {
  type(`\x1b[200~${path.replaceAll(" ", "\\ ")}\x1b[201~`);
  press("Enter");
}

// Waits until the sidebar has told the screen that dropped files go to the agent in `folder`,
// which it does at its next look after your typing moved.
const toldFolder = (folder: string) =>
  until(() => {
    const session = `=${screenSessions()[0] ?? ""}:`;
    return tmux(screen, "show", "-qv", "-t", session, "@agent-folder").out.trim() === folder;
  }, `dropped files to go to ${folder}`);

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
  await toldFolder(join(skelcrew(), "lead"));
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
  await toldFolder(join(skelcrew(), "threads", "app-12"));
  drop(notes);
  const line = await got("app-12");
  expect(line.startsWith(`${join(skelcrew(), "threads", "app-12", ".skelcrew-drops")}/`)).toBe(
    true,
  );
  expect(readFileSync(line, "utf8")).toBe("notes");
});

test("text pasted onto the screen reaches the agent as it was", async () => {
  open("lead");
  await ready("lead");
  type("\x1b[200~/tmp and more\x1b[201~");
  press("Enter");
  expect(await got("lead")).toBe("/tmp and more");
});
