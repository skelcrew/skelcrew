// The footer across the bottom of the screen: what it says under an agent, and how it draws.
import { expect, test } from "bun:test";
import { agentFooter, drawFooter } from "../src/screen/footer.ts";

const plain = (lines: string[]) => lines.map((line) => Bun.stripANSI(line));

test("under an agent the footer says which one you type to and the key back to the list, then move, quit and what Esc stops", () => {
  expect(agentFooter("lead", "claude")).toBe(
    "typing to lead · ⌃\\ to list  ⌥↑↓ move  ⌥W close  ⌥Q quit  Esc stops claude",
  );
  expect(agentFooter("APP-12", "codex")).toBe(
    "typing to APP-12 · ⌃\\ to list  ⌥↑↓ move  ⌥W close  ⌥Q quit  Esc stops codex",
  );
  expect(agentFooter("lead", "")).toBe("typing to lead · ⌃\\ to list  ⌥↑↓ move  ⌥W close  ⌥Q quit");
});

test("the footer is a dim row two columns in, under a thin line across the screen", () => {
  const lines = drawFooter("⌥↑↓ move  ⌥Q quit", 40, true, "");
  expect(plain(lines)).toEqual(["─".repeat(40), "  ⌥↑↓ move  ⌥Q quit"]);
  expect(lines[1]).toStartWith("\x1b[90m");
});

test("where tmux's border is a thin line already, the footer draws no line of its own", () => {
  expect(plain(drawFooter("⌥↑↓ move  ⌥Q quit", 40, false, ""))).toEqual(["  ⌥↑↓ move  ⌥Q quit"]);
});

test("a footer too long for the screen is cut, and a forge's control codes never reach it", () => {
  const [, row] = plain(drawFooter("Merge refused:\x1b[31m a conflict in app.ts", 24, true, ""));
  expect(row).toBe("  Merge refused: [31m…");
});

test("the machine's load sits at the right end of the footer", () => {
  const [, row] = plain(drawFooter("⌥↑↓ move  ⌥Q quit", 50, true, "cpu 63%  mem 9.1/32G"));
  expect(row).toBe(`  ⌥↑↓ move  ⌥Q quit${" ".repeat(9)}cpu 63%  mem 9.1/32G  `);
});

test("on a narrow screen the load gives way before the footer's keys", () => {
  const [, row] = plain(drawFooter("⌥↑↓ move  ⌥Q quit", 40, true, "cpu 63%  mem 9.1/32G"));
  expect(row).toBe("  ⌥↑↓ move  ⌥Q quit");
});
