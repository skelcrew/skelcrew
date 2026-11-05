// What the sidebar shows and which row a key or click picks, given the rows it was handed.
import { expect, test } from "bun:test";
import { draw, picked, type Row, stepped } from "../src/sidebar.ts";

const lead: Row = { name: "lead", session: "lead", status: null, needsYou: false, running: true };
const thread = (name: string, more: Partial<Row> = {}): Row => ({
  name,
  session: name,
  status: "working",
  needsYou: false,
  running: true,
  ...more,
});

const size = { width: 28, height: 10 };
// Removes the colours, to read a row as text.
const plain = (screen: string) => Bun.stripANSI(screen);

test("lists the lead first, then each thread with a mark, its name and its status", () => {
  const rows = [lead, thread("app-12"), thread("site-7", { status: "waiting" })];
  expect(plain(draw(rows, "lead", size)).split("\n")).toEqual([
    "› lead",
    "  ● app-12          working",
    "  ○ site-7          waiting",
  ]);
});

test("a thread that needs you reads so in yellow, whatever its status", () => {
  const screen = draw([lead, thread("app-12", { needsYou: true })], "lead", size);
  expect(plain(screen)).toContain("  ? app-12        needs you");
  expect(screen).toContain("\x1b[33m?");
  expect(screen).toContain("\x1b[33mneeds you");
});

test("colour comes with a mark: blue for working, green for done", () => {
  expect(draw([thread("app-12")], "lead", size)).toContain("\x1b[34m●");
  expect(draw([thread("app-12", { status: "done" })], "lead", size)).toContain("\x1b[32m✓");
});

test("marks the row you are looking at, and nothing when it isn't listed", () => {
  const rows = [lead, thread("app-12")];
  expect(plain(draw(rows, "app-12", size)).split("\n")[1]).toStartWith("› ●");
  expect(plain(draw(rows, "gone", size))).not.toContain("›");
});

test("a long name keeps its task number and leaves room for the status", () => {
  const screen = plain(draw([thread("a-very-long-repository-name-1234")], "lead", size));
  expect(screen).toBe("  ● a-very-l…-1234  working");
  expect([...screen].length).toBeLessThanOrEqual(size.width);
});

test("a pane too narrow for a status shows the mark and name, at any width", () => {
  const rows = [lead, thread("a-very-long-repository-name-1234")];
  expect(plain(draw(rows, "lead", { width: 15, height: 10 })).split("\n")[1]).toBe(
    "  ● a-ve…-1234",
  );
  for (let width = 0; width < 28; width++)
    expect(() => draw(rows, "lead", { width, height: 10 })).not.toThrow();
});

test("scrolls so the row you are looking at stays on screen", () => {
  const rows = [lead, ...[1, 2, 3, 4, 5].map((n) => thread(`app-${n}`))];
  const short = { width: 28, height: 3 };
  const lines = plain(draw(rows, "app-4", short)).split("\n");
  expect(lines).toHaveLength(3);
  expect(lines.at(-1)).toContain("› ● app-4");
  expect(picked(rows, "app-4", short, 1)).toBe("app-3");
});

test("Alt-Up and Alt-Down move one row, stop at the ends, and skip agents that aren't running", () => {
  const rows = [lead, thread("app-1"), thread("app-2", { running: false }), thread("app-3")];
  expect(stepped(rows, "lead", 1)).toBe("app-1");
  expect(stepped(rows, "app-1", 1)).toBe("app-3");
  expect(stepped(rows, "app-3", -1)).toBe("app-1");
  expect(stepped(rows, "lead", -1)).toBeNull();
  expect(stepped(rows, "app-3", 1)).toBeNull();
});

test("moving from an agent that isn't listed goes to the lead", () => {
  expect(stepped([lead, thread("app-1")], "gone", 1)).toBe("lead");
});

test("a click picks the row under it, but no row, nor an agent that isn't running", () => {
  const rows = [lead, thread("app-1"), thread("app-2", { running: false })];
  expect(picked(rows, "lead", size, 1)).toBe("app-1");
  expect(picked(rows, "lead", size, 2)).toBeNull();
  expect(picked(rows, "lead", size, 7)).toBeNull();
});
