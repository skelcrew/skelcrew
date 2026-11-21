// Where your typing goes on the screen: Ctrl-\ brings it to the sidebar, Enter gives it to the
// agent of the row you are on, Shift-Enter or a gives that agent the whole terminal, plain keys
// work in the sidebar as in sc --list, Enter on a stage's heading opens or closes it, and the
// screen always shows which side has your typing.
import { afterEach, beforeEach, expect, test } from "bun:test";
import { mkdirSync, writeFileSync } from "node:fs";
import { join } from "node:path";
import { itemSql } from "./harness.ts";
import {
  endTest,
  footer,
  given,
  home,
  litBox,
  onDetails,
  onLead,
  open,
  press,
  read,
  ready,
  screen,
  screenSessions,
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

beforeEach(startTest);
afterEach(endTest);

// Returns whether your terminal shows a cursor, as the screen's tmux shows only the cursor of the
// side your typing goes to.
const cursorShows = () =>
  tmux(terminal, "display", "-p", "-t", "=one:", "#{cursor_flag}").out.trim() === "1";
// Returns whether the right side has the whole terminal, as tmux shows only its pane then.
const fullScreen = () =>
  tmux(
    screen,
    "display",
    "-p",
    "-t",
    `=${screenSessions()[0]}:`,
    "#{window_zoomed_flag}",
  ).out.trim() === "1";
// Returns whether the top row is lit end to end, with no corner, which is how it shows that your
// typing goes to an agent that fills the terminal.
const topLit = () => {
  const row = tmux(terminal, "capture-pane", "-p", "-e", "-t", "=one:").out.split("\n")[0] ?? "";
  const plain = Bun.stripANSI(row);
  return plain.startsWith("─── Skelcrew") && !plain.includes("┬") && !row.includes("\x1b[90m─");
};
// Returns whether a stage's heading shows with rows under it, so it is open.
const isOpen = (heading: string) => {
  const lines = seen()
    .split("\n")
    .map((line) => line.slice(2, sidebar).trimEnd());
  const at = lines.findIndex((line) => line.includes(heading));
  return at >= 0 && /^ [▸ ] \S/.test(lines[at + 1] ?? "");
};
// Presses a key and waits until the row you are on is another one, as the next key moves from
// there.
async function step(key: string): Promise<void> {
  const before = selected();
  press(key);
  await until(() => selected() !== before, `${key} to move`);
}

test("the screen opens with your typing in the lead, Ctrl-\\ moves it to the sidebar, and the screen shows it", async () => {
  open("lead");
  await ready("lead");
  // At the start your typing goes to the lead, with no key pressed: the box round the right side
  // is the lit one, the footer says so, and the lead's cursor shows.
  expect(selected()).toMatch(/^▸ ○ lead\b/);
  await until(() => litBox() === "right", "the right side's box");
  await until(
    () => footer() === "  typing to lead · ⌃\\ to list  ⌥↑↓ move  ⌥Q quit  Esc stops claude",
    "the footer under the lead",
  );
  expect(cursorShows()).toBe(true);
  type("hi\r");
  await until(() => read("lead.typed") === "hi\n", "the typing to reach the lead");
  press("C-\\");
  await until(typingToSidebar, "the sidebar to take your typing");
  await until(
    () => footer() === "  ↑↓ move  ⏎ to lead  ⇧⏎/a full screen  1-6 stages  ⌥Q quit",
    "the sidebar's keys",
  );
  expect(selected()).toMatch(/^▸ ○ lead\b/);
  await until(() => litBox() === "sidebar", "the sidebar's box to light up");
  expect(cursorShows()).toBe(false);
  // The lead still shows on the right side, only to look at, and never saw the key.
  expect(seen()).toContain("I am lead");
  expect(read("lead.typed")).toBe("hi\n");
});

test("in the sidebar plain keys work as in the list, keep your typing there, and Enter on the lead gives it back", async () => {
  open("lead");
  await ready("lead");
  press("C-\\");
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
  await until(() => footer().startsWith("  typing to lead"), "the footer under the lead");
  await until(() => litBox() === "right", "the right side's box to light up");
  // Digits then reach the lead, and open or close no stage.
  type("123456\r");
  await until(() => read("lead.typed") === "123456\n", "the digits to reach the lead");
  expect(isOpen("2 Building")).toBe(true);
  expect(isOpen("6 Done")).toBe(false);
});

// A question asked in the sidebar stays open, as Ctrl-\ only brings your typing there.
test("Ctrl-\\ in the sidebar leaves a question there open", async () => {
  sql(itemSql("app", "task", 31, "Export as CSV", "2026-11-05T10:00:00Z"));
  open("lead");
  await ready("lead");
  press("M-1");
  await until(() => selected().includes("APP-31") && onDetails(), "APP-31 in Backlog");
  type("s");
  await until(() => footer().includes("Start APP-31? y/n"), "the question");
  press("C-\\");
  await Bun.sleep(300);
  expect(footer()).toContain("Start APP-31? y/n");
  expect(typingToSidebar()).toBe(true);
});

// A task's details are only to look at, so Enter on the lead after them gives the lead your
// typing, but moving there with Alt keys keeps it in the sidebar once you kept it there.
test("your typing stays in the sidebar on a task's details, and onto the lead's row", async () => {
  open("lead");
  await ready("lead");
  press("C-\\");
  await until(typingToSidebar, "the sidebar to take your typing");
  press("M-S-Down");
  await until(() => selected().includes("APP-12") && onDetails(), "APP-12's details");
  press("M-S-Up");
  await until(onLead, "the lead's row");
  await Bun.sleep(300);
  expect(typingToSidebar()).toBe(true);
  type("3");
  await until(() => seen().includes(" 3 Reviewing 0"), "Reviewing");
  await Bun.sleep(300);
  expect(read("lead.typed")).toBe("");
});

test("Enter on a task gives its builder your typing, and Ctrl-\\ brings it back to the sidebar", async () => {
  open("lead");
  await ready("lead");
  await toSecondThread();
  await until(() => footer().startsWith("  typing to APP-7 · ⌃\\ to list"), "the agent's footer");
  await until(() => litBox() === "right", "the right side's box to light up");
  expect(fullScreen()).toBe(false);
  // Digits typed to the agent reach it.
  type("42\r");
  await until(() => read("app-7.typed") === "42\n", "the digits to reach the builder");
  press("C-\\");
  await until(onDetails, "app-7's details");
  await until(typingToSidebar, "the sidebar to take your typing");
  expect(selected()).toContain("APP-7");
  // The footer is a pane of its own, told what to say a moment after the sidebar redraws.
  await until(() => footer().includes("⏎ attach  ⇧⏎/a full screen"), "the sidebar's footer");
});

for (const [key, how] of [
  ["S-Enter", "Shift-Enter"],
  ["a", "a"],
] as const)
  test(`${how} on the lead's row gives the lead the whole terminal, and Ctrl-\\ comes back`, async () => {
    given.extendedKeys = true;
    open("lead");
    await ready("lead");
    press("C-\\");
    await until(typingToSidebar, "the sidebar to take your typing");
    press(key);
    await until(fullScreen, "the lead to fill the terminal");
    await until(() => !seen().includes("Needs you"), "the sidebar to hide");
    await until(topLit, "the top row to light up");
    type("hi\r");
    await until(() => read("lead.typed") === "hi\n", "the typing to reach the lead");
    press("C-\\");
    await until(() => !fullScreen() && typingToSidebar(), "the sidebar again");
    await until(() => !topLit(), "the top row's corners again");
    expect(read("lead.typed")).toBe("hi\n");
  });

test("a on a task's row attaches full screen to its builder, and Ctrl-\\ comes back to its details", async () => {
  open("lead");
  await ready("lead");
  press("M-S-Down");
  press("M-Down");
  await until(() => selected().includes("APP-7") && onDetails(), "APP-7's details");
  type("a");
  await until(() => fullScreen() && seen().includes("I am app-7"), "app-7 full screen");
  await until(topLit, "the top row to light up");
  type("go\r");
  await until(() => read("app-7.typed") === "go\n", "the typing to reach the builder");
  press("C-\\");
  await until(() => !fullScreen() && onDetails() && typingToSidebar(), "app-7's details again");
  expect(selected()).toContain("APP-7");
});

// Shift-Enter typed to an agent is a new line in its prompt, so it reaches the agent.
test("Shift-Enter while typing to the lead reaches the lead, which keeps its place", async () => {
  given.extendedKeys = true;
  open("lead");
  await ready("lead");
  press("S-Enter");
  await Bun.sleep(300);
  expect(fullScreen()).toBe(false);
  expect(typingToSidebar()).toBe(false);
});

// The host takes two seconds to list its sessions, which it must to find a builder whose ID
// Skelcrew hasn't saved. You press Ctrl-\\ meanwhile, so the agent that comes must not take your
// typing.
test("Ctrl-\\ while a slow host attaches keeps your typing in the sidebar", async () => {
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
  press("C-\\");
  await until(() => seen().includes("I am app-7 on slow"), "the host's attach");
  await Bun.sleep(300);
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

// A request of the lead's is answered with y or n, so on its row Enter only says so, and Shift-Enter
// and a give the lead nothing. Your typing stays in the sidebar there, as on a task's details.
test("on a request of the lead's, the focus keys keep your typing in the sidebar for y and n", async () => {
  sql(`INSERT INTO lead_requests (owner, repo, action, says, made) VALUES
  ('simon', 'app', '{"kind":"start","task":"31"}', 'Start APP-31 Export as CSV?', 1);`);
  given.extendedKeys = true;
  open("lead");
  await ready("lead");
  press("C-\\");
  await until(typingToSidebar, "the sidebar to take your typing");
  await step("Down");
  expect(selected()).toContain("Start APP-31");
  await until(
    () => footer() === "  ↑↓ move  y yes  n no  1-6 stages  ⌥Q quit",
    "the request's keys",
  );
  for (const key of ["a", "S-Enter", "C-\\"]) {
    press(key);
    await Bun.sleep(300);
    expect(fullScreen()).toBe(false);
    expect(typingToSidebar()).toBe(true);
  }
  press("Enter");
  await until(
    () => footer().includes("Press y to say yes to the lead, or n to say no."),
    "how to answer",
  );
  await step("Up");
  expect(onLead()).toBe(true);
  press("Enter");
  await until(() => !typingToSidebar(), "the lead to take your typing");
  expect(read("lead.typed")).toBe("");
});
