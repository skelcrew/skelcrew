// The live view shows only the agent's output: each harness's input area and status lines are cut
// off the bottom of its screen, found by their shape on screens captured from each harness.
import { expect, test } from "bun:test";
import { join } from "node:path";
import { agentOutput } from "../src/list/live.ts";
import { drawPane } from "../src/list/pane.ts";
import type { Row } from "../src/list/rows.ts";

// Returns a captured screen, colours included, as the session host gives it.
const screen = (name: string) => Bun.file(join(import.meta.dir, "screens", name)).text();

// Returns the last lines of a screen with something on them, without colours.
const bottom = (text: string, count: number) =>
  Bun.stripANSI(text)
    .split("\n")
    .map((line) => line.trimEnd())
    .filter((line) => line !== "")
    .slice(-count);

test("Claude Code's prompt, rules and status line are cut, idle or at work", async () => {
  const idle = agentOutput("claude", await screen("claude-idle.txt"));
  // The notice right-aligned on the input area goes with it.
  expect(idle).not.toContain("/effort");
  expect(bottom(idle, 1)).toEqual(["  than Opus 5.5. Switch with /model."]);
  expect(idle).not.toContain("❯");
  expect(idle).not.toContain("bypass permissions");
  const busy = agentOutput("claude", await screen("claude-busy.txt"));
  expect(bottom(busy, 2)).toEqual([
    "  ⎿  Added 12 lines",
    "✻ Kneading… (42s · ↓ 1.2k tokens · esc to interrupt)",
  ]);
  // The message quoted in the output starts with ❯ too, and stays.
  expect(busy).toContain("❯ Rate limit the API per user");
  expect(busy).not.toContain("─");
});

test("a long message typed into Claude Code is cut with its prompt, over all its lines", async () => {
  const long = agentOutput("claude", await screen("claude-long.txt"));
  expect(long).not.toContain("every file in src");
  expect(long).not.toContain("Please write");
  // A notice that isn't right-aligned can't be told from the agent's output, so it stays.
  expect(bottom(long, 1)).toEqual([expect.stringContaining("tmux focus-events off")]);
});

test("Claude Code's tip under its busy line is cut, and the busy line stays", async () => {
  const tip = agentOutput("claude", await screen("claude-tip.txt"));
  expect(tip).not.toContain("Tip:");
  expect(bottom(tip, 3)).toEqual([
    "⏺ Update(src/api/limit.ts)",
    "  ⎿  Added 12 lines",
    "✻ Forging… (2m 13s · ↓ 3.4k tokens · esc to interrupt)",
  ]);
  // A tool's result is indented as a tip is, and stays when no busy line is over it.
  const idle = (await screen("claude-tip.txt")).replace(/.*Forging.*\n.*Tip:.*\n/, "");
  expect(bottom(agentOutput("claude", idle), 1)).toEqual(["  ⎿  Added 12 lines"]);
  // Output that ends right on the input area, with no blank line between, stays whole.
  const touching = idle.replace(/\n\n(.*─{3,})/, "\n⏺ Done.\n$1");
  expect(bottom(agentOutput("claude", touching), 2)).toEqual(["  ⎿  Added 12 lines", "⏺ Done."]);
  // So does indented output there, such as code, which isn't pushed to the right edge.
  const code = `${" ".repeat(12)}return limit;`;
  const indented = idle.replace(/\n\n(.*─{3,})/, `\n${code}\n$1`);
  expect(bottom(agentOutput("claude", indented), 1)).toEqual([code]);
  // And a value the agent pushed to the right edge, which no notice says.
  const value = `${" ".repeat(70)}Total: 42 req/min`;
  const right = idle.replace(/\n\n(.*─{3,})/, `\n${value}\n$1`);
  expect(bottom(agentOutput("claude", right), 1)).toEqual([value]);
});

test("under Claude Code's busy line, only its tip goes, and indented output stays", async () => {
  const tip = await screen("claude-tip.txt");
  // A line under the tip may be the agent's, a tool's result, indented code or a right-aligned
  // value, or go on a tip too long for one line. Nothing it says tells which, so it stays, and
  // the tip with it.
  const after = ["  ⎿  Added 12 lines", "     return limit;", `${" ".repeat(70)}Total: 42 req/min`];
  for (const line of after) {
    const kept = agentOutput("claude", tip.replace(/(Tip: [^\n]*)\n/, `$1\n${line}\n`));
    expect(bottom(kept, 2)).toEqual([expect.stringContaining("Tip: Use /btw"), line]);
  }
  // A line in the tip's place that isn't one stays.
  const code = "     return limit;";
  const under = tip.replace(/\n[^\n]*Tip: [^\n]*/, `\n${code}`);
  expect(bottom(agentOutput("claude", under), 1)).toEqual([code]);
});

test("Codex's input box and footer are cut, idle, at work or with a long message typed", async () => {
  const idle = agentOutput("codex", await screen("codex-idle.txt"));
  expect(bottom(idle, 1)).toEqual(["• Edited src/api/limit.ts (+12 -0)"]);
  const busy = agentOutput("codex", await screen("codex-busy.txt"));
  expect(bottom(busy, 1)).toEqual(["• Working (42s • esc to interrupt)"]);
  expect(busy).toContain("› Rate limit the API per user");
  expect(busy).not.toContain("context left");
  const long = agentOutput("codex", await screen("codex-long.txt"));
  expect(bottom(long, 1)).toEqual(["• Working (42s • esc to interrupt)"]);
  expect(long).not.toContain("every file in src");
  // A message with a blank line in it is cut whole, its lines after the blank one too.
  const paragraphs = agentOutput("codex", await screen("codex-blank.txt"));
  expect(bottom(paragraphs, 1)).toEqual(["• Working (42s • esc to interrupt)"]);
  expect(paragraphs).not.toContain("what a builder is");
  // tmux can set the box's shade once and carry it over the lines after, as a terminal shows it.
  const once = [
    "• Done.",
    "",
    "\x1b[48;5;236m                    ",
    "› Ask Codex to do anything",
    "                    \x1b[49m",
    "",
    "  \x1b[2m100% context left\x1b[0m",
  ].join("\n");
  expect(bottom(agentOutput("codex", once), 1)).toEqual(["• Done."]);
  // A screen as tmux captured it, the shade on the box's last line carried from the line above.
  const carried = agentOutput("codex", await screen("codex-carried.txt"));
  expect(bottom(carried, 1)).toEqual(["• Done."]);
  // The shade carried over the box can end only at the start of the footer's line.
  const resetLate = [
    "• Done.",
    "",
    "\x1b[48;5;236m                    ",
    "› typed words       ",
    "                    ",
    "\x1b[49m",
    "\x1b[49m  \x1b[2m100% context left\x1b[0m",
  ].join("\n");
  expect(bottom(agentOutput("codex", resetLate), 1)).toEqual(["• Done."]);
  const footerFirst = [...resetLate.split("\n").slice(0, 5), "\x1b[0m  \x1b[2mcontext\x1b[0m"];
  expect(bottom(agentOutput("codex", footerFirst.join("\n")), 1)).toEqual(["• Done."]);
  // A shade in red, green and blue with colons, such as 48:2::10:20:0, is one code, carried too.
  const colons = resetLate.replace("\x1b[48;5;236m", "\x1b[48:2::10:20:0m");
  expect(bottom(agentOutput("codex", colons), 1)).toEqual(["• Done."]);
  const colonsWithMore = resetLate.replace("\x1b[48;5;236m", "\x1b[1;48:2::10:20:0;22m");
  expect(bottom(agentOutput("codex", colonsWithMore), 1)).toEqual(["• Done."]);
  // A box whose empty prompt says other words is still found by its shape.
  const reworded = (await screen("codex-idle.txt")).replace("Ask Codex to do anything", "Ask away");
  expect(bottom(agentOutput("codex", reworded), 1)).toEqual(["• Edited src/api/limit.ts (+12 -0)"]);
});

test("a screen whose input area isn't found shows whole", async () => {
  const unknown = await screen("unknown.txt");
  expect(agentOutput("claude", unknown)).toBe(unknown);
  expect(agentOutput("codex", unknown)).toBe(unknown);
  // A Codex whose input box looks other than it knows, such as after an update, shows whole, even
  // with an earlier message in the output and no • after it.
  const changed = [
    "› Rate limit the API per user",
    "",
    "I'll add the limit in the request handler first.",
    "Edited src/api/limit.ts (+12 -0)",
    "",
    "  └ 12 lines changed",
    "",
    "> Ask Codex to do anything",
    "",
    "  100% context left",
  ].join("\n");
  expect(agentOutput("codex", changed)).toBe(changed);
  // Without the line under its prompt either, it still shows whole.
  const bare = ["› Rate limit the API per user", "", "Working on it.", "Done."].join("\n");
  expect(agentOutput("codex", bare)).toBe(bare);
  // An earlier message in Codex's output, shaded as its box is, with blank and indented lines
  // under it, isn't its input box, such as when an update changed the box: the box's footer is
  // dim, and Codex's output after a message starts with •.
  const shade = (text: string) => `\x1b[48;5;236m${text}\x1b[49m`;
  const dim = (text: string) => `\x1b[2m${text}\x1b[22m`;
  const earlier = ["", shade("› previous request"), "", "  result line", "", "  Ask Codex"];
  expect(agentOutput("codex", earlier.join("\n"))).toBe(earlier.join("\n"));
  const answered = ["", shade("› previous request"), "", "• Done.", "", `  ${dim("Ask Codex")}`];
  expect(agentOutput("codex", answered.join("\n"))).toBe(answered.join("\n"));
  // Nor with an indented dim line under it: the box has shaded blank lines above and below it.
  const dimmed = ["", shade("› previous request"), "", `  ${dim("result line")}`];
  expect(agentOutput("codex", dimmed.join("\n"))).toBe(dimmed.join("\n"));
  // A message not shaded, or a footer with a colour such as 38;5;2 rather than dim, isn't either.
  const plain = ["", "› previous request", "", `  ${dim("100% context left")}`];
  expect(agentOutput("codex", plain.join("\n"))).toBe(plain.join("\n"));
  const green = ["", shade("› previous request"), "", "  \x1b[38;5;2mresult\x1b[39m"];
  expect(agentOutput("codex", green.join("\n"))).toBe(green.join("\n"));
  // Claude Code's box quoted in its output, with more output after it, isn't its input box, which
  // ends the screen.
  const rule = "─".repeat(40);
  const quoted = [
    "⏺ The screen ends like this:",
    rule,
    "❯ hello",
    rule,
    "  ⏵⏵ bypass permissions on",
    "⏺ That box is the prompt.",
    "  ⎿  Read 3 lines",
    "",
    "> a prompt drawn another way",
  ].join("\n");
  expect(agentOutput("claude", quoted)).toBe(quoted);
  // A harness drawn another way, such as Codex's screen read as Claude Code's, keeps its input.
  const codex = await screen("codex-busy.txt");
  expect(agentOutput("claude", codex)).toBe(codex);
  expect(agentOutput(null, codex)).toBe(codex);
});

test("what is left fills the live view from the bottom up", async () => {
  const row: Row = {
    part: "building",
    section: "building",
    name: "app-12",
    label: "12",
    task: "12",
    title: "Rate limit",
    mark: { sign: "●", colour: "green" },
    says: "",
    colour: "green",
    step: "",
    pr: "",
    ci: null,
    review: null,
    when: "4m",
    changed: null,
    needsYou: false,
    session: "app-12",
    running: true,
    working: false,
    tmux: true,
    start: null,
    startNow: null,
    merge: null,
    link: null,
    branch: "skelcrew/12",
    more: 0,
    place: null,
    waits: "",
    ask: null,
  };
  const details = {
    view: {
      task: "app-12",
      stage: "working" as const,
      title: "Rate limit the API",
      issue: null,
      threads: [],
      body: "",
      pr: null,
      review: null,
      prPage: null,
      merge: null,
      filed: null,
      notBlocking: [],
      item: null,
      decisions: [],
      mustStayTrue: [],
    },
    findings: [],
    updates: [],
    events: [],
    changed: "",
    started: "",
    flow: "",
    spinner: "",
  };
  const live = { screen: agentOutput("claude", await screen("claude-busy.txt")) };
  const lines = drawPane(row, details, live, 60, 12, true).lines.map((line) =>
    Bun.stripANSI(line).trimEnd(),
  );
  expect(lines.at(-1)).toBe("✻ Kneading… (42s · ↓ 1.2k tokens · esc to interrupt)");
  expect(lines.join("\n")).not.toContain("bypass permissions");
});
