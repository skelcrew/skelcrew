// Where your typing goes on the screen: Alt-Left and Alt-Right move it between the sidebar and the
// agent on the right side, plain keys work in the sidebar as in sc --list, Enter on a stage's
// heading opens or closes it, and the screen always shows which side has your typing.
import { afterEach, beforeEach, expect, setDefaultTimeout, test } from "bun:test";
import { mkdirSync, writeFileSync } from "node:fs";
import { join } from "node:path";
import {
  endTest,
  footer,
  home,
  onDetails,
  onLead,
  open,
  press,
  read,
  ready,
  seen,
  selected,
  sidebar,
  sql,
  startTest,
  terminal,
  tmux,
  toSecondThread,
  type,
  typingToSidebar,
  until,
} from "./screen.ts";

// Longer than the screen's waits, so a test that fails says what it waited for.
setDefaultTimeout(20_000);
beforeEach(startTest);
afterEach(endTest);

// Returns whether your terminal shows a cursor, as the screen's tmux shows only the cursor of the
// side your typing goes to.
const cursorShows = () =>
  tmux(terminal, "display", "-p", "-t", "=one:", "#{cursor_flag}").out.trim() === "1";
// The sidebar's edge on the line under the top row.
const edge = () => seen().split("\n")[1]?.[sidebar - 1];
// Returns whether a stage's heading shows with rows under it, so it is open.
const isOpen = (heading: string) => {
  const lines = seen()
    .split("\n")
    .map((line) => line.slice(0, sidebar - 1).trimEnd());
  const at = lines.findIndex((line) => line.includes(heading));
  return at >= 0 && /^ [▸▹ ] \S/.test(lines[at + 1] ?? "");
};
// Presses a key and waits until the row you are on is another one, as the next key moves from
// there.
async function step(key: string): Promise<void> {
  const before = selected();
  press(key);
  await until(() => selected() !== before, `${key} to move`);
}

test("Alt-Left moves your typing from the lead to the sidebar, and the screen shows it", async () => {
  open("lead");
  await ready("lead");
  // At the start your typing goes to the lead: the lead's row is only outlined, the edge leans
  // to the right side, the footer says so, and the lead's cursor shows.
  expect(selected()).toMatch(/^▹ ○ lead\b/);
  await until(
    () => footer() === "  typing to lead · ⌥← to list  ⌥↑↓ move  ⌥Q quit  Esc stops claude",
    "the footer under the lead",
  );
  expect(edge()).toBe("▕");
  expect(cursorShows()).toBe(true);
  press("M-Left");
  await until(typingToSidebar, "the sidebar to take your typing");
  await until(
    () => footer() === "  ↑↓ move  ⏎ or ⌥→ to lead  1-6 stages  ⌥Q quit",
    "the sidebar's keys",
  );
  expect(selected()).toMatch(/^▸ ○ lead\b/);
  expect(edge()).toBe("▏");
  expect(cursorShows()).toBe(false);
  // The lead still shows on the right side, only to look at.
  expect(seen()).toContain("I am lead");
});

test("in the sidebar plain keys work as in the list, keep your typing there, and Enter on the lead gives it back", async () => {
  open("lead");
  await ready("lead");
  press("M-Left");
  await until(typingToSidebar, "the sidebar to take your typing");
  type("2");
  await until(() => !isOpen("2 Building"), "Building to close");
  type("2");
  await until(() => isOpen("2 Building") && selected().includes("APP-12"), "Building on APP-12");
  // Up stops on each heading on the way back to the lead, and your typing stays in the sidebar
  // on the lead's row, so a digit there opens a stage rather than reach the lead.
  while (!onLead()) await step("Up");
  await until(() => typingToSidebar() && seen().includes("I am lead"), "the lead on the right");
  type("3");
  await until(() => seen().includes(" 3 Reviewing 0"), "Reviewing");
  await Bun.sleep(300);
  expect(read("lead.typed")).toBe("");
  press("Enter");
  await until(() => !typingToSidebar() && onLead(), "the lead to take your typing");
  type("hi\r");
  await until(() => read("lead.typed") === "hi\n", "the typing to reach the lead");
});

test("Alt-Right gives your typing back to the lead, and digits then reach it", async () => {
  open("lead");
  await ready("lead");
  press("M-Left");
  await until(typingToSidebar, "the sidebar to take your typing");
  press("M-Right");
  await until(() => !typingToSidebar() && onLead(), "the lead to take your typing");
  await until(() => footer().startsWith("  typing to lead"), "the footer under the lead");
  expect(edge()).toBe("▕");
  type("123456\r");
  await until(() => read("lead.typed") === "123456\n", "the digits to reach the lead");
  // None of them opened or closed a stage.
  expect(isOpen("2 Building")).toBe(true);
  expect(isOpen("6 Done")).toBe(false);
});

// A task's details are only to look at, so Alt-Right there does nothing, and your typing stays
// kept in the sidebar after you move back to the lead.
test("Alt-Right on a task's details leaves your typing in the sidebar, onto the lead's row too", async () => {
  open("lead");
  await ready("lead");
  press("M-Left");
  await until(typingToSidebar, "the sidebar to take your typing");
  press("M-S-Down");
  await until(() => selected().includes("APP-12") && onDetails(), "APP-12's details");
  press("M-Right");
  await Bun.sleep(300);
  expect(typingToSidebar()).toBe(true);
  press("M-S-Up");
  await until(onLead, "the lead's row");
  await Bun.sleep(300);
  expect(typingToSidebar()).toBe(true);
  type("3");
  await until(() => seen().includes(" 3 Reviewing 0"), "Reviewing");
  await Bun.sleep(300);
  expect(read("lead.typed")).toBe("");
});

// A Mac terminal often sends Option-Left and Option-Right as Esc b and Esc f.
test("Esc b and Esc f move your typing as Alt-Left and Alt-Right do, and never reach the agent", async () => {
  open("lead");
  await ready("lead");
  type("\x1bb");
  await until(typingToSidebar, "the sidebar to take your typing");
  type("\x1bf");
  await until(() => !typingToSidebar() && onLead(), "the lead to take your typing");
  type("ok\r");
  await until(() => read("lead.typed").endsWith("\n"), "the typing to reach the lead");
  expect(read("lead.typed")).toBe("ok\n");
});

test("from an agent you attached to, Alt-Left reaches the sidebar and Alt-Right goes back to it", async () => {
  open("lead");
  await ready("lead");
  await toSecondThread();
  await until(() => footer().startsWith("  typing to APP-7 · ⌥← to list"), "the agent's footer");
  // Digits typed to the agent reach it.
  type("42\r");
  await until(() => read("app-7.typed") === "42\n", "the digits to reach the builder");
  press("M-Left");
  await until(typingToSidebar, "the sidebar to take your typing");
  await until(() => footer().includes("⌥→ to APP-7"), "the key back to the agent");
  // The agent stays attached on the right side.
  expect(onDetails()).toBe(false);
  expect(seen()).toContain("I am app-7");
  press("M-Right");
  await until(() => !typingToSidebar(), "the agent to take your typing");
  type("go\r");
  await until(() => read("app-7.typed") === "42\ngo\n", "the typing to reach the builder");
});

// Ctrl-\ ends the attachment wherever your typing goes, as the agent is still attached on the
// right side.
test("Ctrl-\\ comes back from an agent you attached to while your typing is in the sidebar", async () => {
  open("lead");
  await ready("lead");
  await toSecondThread();
  press("M-Left");
  await until(typingToSidebar, "the sidebar to take your typing");
  press("C-\\");
  await until(onDetails, "app-7's details");
  expect(selected()).toContain("APP-7");
  expect(typingToSidebar()).toBe(true);
});

// The host takes two seconds to list its sessions, which it must to find a builder whose ID
// Skelcrew hasn't saved. You press Alt-Left meanwhile, so the agent that comes must not take your
// typing.
test("Alt-Left while a slow host attaches keeps your typing in the sidebar", async () => {
  const plugin = join(home, "plugin-slow");
  mkdirSync(plugin, { recursive: true });
  writeFileSync(
    join(plugin, "attach.sh"),
    `echo "I am $1 on slow"; exec cat > ${join(home, "host.typed")}\n`,
  );
  writeFileSync(join(plugin, "session.sh"), `cat > /dev/null; sleep 2; echo '{"sessions":[]}'\n`);
  writeFileSync(
    join(plugin, "skelcrew-plugin.yaml"),
    "name: slow\nversion: 0.1.0\nskelcrew: 0.1.0\nabout: A host\nkind: runtime\nprovides: [sessions]\nsession: [sh, session.sh]\nattach: [sh, attach.sh]\n",
  );
  sql(`INSERT INTO plugins (name, folder) VALUES ('slow', '${plugin}');
UPDATE threads SET host = 'slow', host_id = NULL WHERE folder = 'app-7'`);
  open("lead");
  await ready("lead");
  press("M-S-Down");
  press("M-Down");
  await until(() => selected().includes("APP-7") && onDetails(), "APP-7's details");
  press("Enter");
  await Bun.sleep(300);
  press("M-Left");
  await until(() => seen().includes("I am app-7 on slow"), "the host's attach");
  await until(() => footer().includes("⌥→ to APP-7"), "the key back to the agent");
  expect(typingToSidebar()).toBe(true);
  type("5");
  await Bun.sleep(300);
  expect(read("host.typed")).toBe("");
});

test("Enter on a stage's heading closes it, keeping you there, and opens it on its first row", async () => {
  open("lead");
  await ready("lead");
  press("M-S-Down");
  await until(() => selected().includes("APP-12") && onDetails(), "APP-12's details");
  await step("Up");
  expect(selected()).toStartWith("2 Building");
  await until(
    () => footer() === "  ↑↓ move  ⏎ open/close  1-6 stages  ⌥Q quit",
    "the heading's keys",
  );
  press("Enter");
  await until(() => !isOpen("2 Building"), "Building to close");
  expect(selected()).toStartWith("2 Building");
  press("Enter");
  await until(() => isOpen("2 Building") && selected().includes("APP-12"), "Building on APP-12");
  expect(read("lead.typed")).toBe("");
  expect(read("app-12.typed")).toBe("");
});
