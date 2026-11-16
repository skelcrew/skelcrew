// The footer across the bottom of the screen: what it says under an agent and under a list or a
// page, and how it draws with the list of keys above it.
import { expect, test } from "bun:test";
import { agentFooter, drawFooter, listFooter } from "../src/screen/footer.ts";
import { keyLines } from "../src/screen/keys.ts";

const plain = (lines: string[]) => lines.map((line) => Bun.stripANSI(line));

test("under an agent the footer starts with move and quit, then back and what Esc stops", () => {
  expect(agentFooter("claude")).toBe("⌥↑↓ move  ⌥Q quit  ⌃6 back  Esc stops claude");
  expect(agentFooter("codex")).toBe("⌥↑↓ move  ⌥Q quit  ⌃6 back  Esc stops codex");
  expect(agentFooter("")).toBe("⌥↑↓ move  ⌥Q quit");
});

test("under a list or page it adds ? keys, then s or m only while the row can be started or merged", () => {
  expect(listFooter(null)).toBe("⌥↑↓ move  ⌥Q quit  ? keys");
  expect(listFooter("s")).toBe("⌥↑↓ move  ⌥Q quit  ? keys  s start");
  expect(listFooter("m")).toBe("⌥↑↓ move  ⌥Q quit  ? keys  m merge");
});

test("the footer is a dim row two columns in, under a thin line across the screen", () => {
  const lines = drawFooter(listFooter(null), [], 40, true);
  expect(plain(lines)).toEqual(["─".repeat(40), "  ⌥↑↓ move  ⌥Q quit  ? keys"]);
  expect(lines[1]).toStartWith("\x1b[90m");
});

test("where tmux's border is a thin line already, the footer draws no line of its own", () => {
  expect(plain(drawFooter("⌥↑↓ move  ⌥Q quit", [], 40, false))).toEqual(["  ⌥↑↓ move  ⌥Q quit"]);
});

test("the keys go above the footer, dim, under a thin line of their own", () => {
  const keys = keyLines(120).slice(0, 2);
  const lines = drawFooter("⌥↑↓ move  ⌥Q quit", keys, 120, true);
  expect(plain(lines)).toEqual(["─".repeat(120), ...keys, "─".repeat(120), "  ⌥↑↓ move  ⌥Q quit"]);
  expect(lines[1]).toStartWith("\x1b[90m");
});

test("a footer too long for the screen is cut, and a forge's control codes never reach it", () => {
  const [, row] = plain(drawFooter("Merge refused:\x1b[31m a conflict in app.ts", [], 24, true));
  expect(row).toBe("  Merge refused: [31m…");
});
