// The footer across the bottom of the screen: what it says under an agent, and how it draws.
import { expect, test } from "bun:test";
import { agentFooter, drawFooter } from "../src/screen/footer.ts";

test("under an agent the footer says which one you type to and the key back to the list, then move, quit and what Esc stops", () => {
  expect(agentFooter("lead", "claude")).toBe(
    "typing to lead · ⌥Tab switch  ⌥↑↓ move  ⌥W close  ⌥Q quit  Esc stops claude",
  );
  expect(agentFooter("APP-12", "codex")).toBe(
    "typing to APP-12 · ⌥Tab switch  ⌥↑↓ move  ⌥W close  ⌥Q quit  Esc stops codex",
  );
  expect(agentFooter("lead", "")).toBe("typing to lead · ⌥Tab switch  ⌥↑↓ move  ⌥W close  ⌥Q quit");
});

test("the footer is a dim row two columns in", () => {
  const row = drawFooter("⌥↑↓ move  ⌥Q quit", 40, "");
  expect(Bun.stripANSI(row)).toBe("  ⌥↑↓ move  ⌥Q quit");
  expect(row).toStartWith("\x1b[90m");
});

test("a footer too long for the screen is cut, and a forge's control codes never reach it", () => {
  const row = drawFooter("Merge refused:\x1b[31m a conflict in app.ts", 24, "");
  expect(Bun.stripANSI(row)).toBe("  Merge refused: [31m…");
});

test("the machine's load sits at the right end of the footer", () => {
  const row = drawFooter("⌥↑↓ move  ⌥Q quit", 50, "cpu 63%  mem 9.1/32G");
  expect(Bun.stripANSI(row)).toBe(`  ⌥↑↓ move  ⌥Q quit${" ".repeat(9)}cpu 63%  mem 9.1/32G  `);
});

test("on a narrow screen the load gives way before the footer's keys", () => {
  const row = drawFooter("⌥↑↓ move  ⌥Q quit", 40, "cpu 63%  mem 9.1/32G");
  expect(Bun.stripANSI(row)).toBe("  ⌥↑↓ move  ⌥Q quit");
});
