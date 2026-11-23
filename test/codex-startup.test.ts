// Codex startup questions stay out of message delivery and never look like an idle agent.
import { expect, test } from "bun:test";
import { codex } from "../src/agents/codex.ts";
import { quietSince, startupQuestion } from "../src/agents/transport.ts";

const trust = "Folder access\n/tmp/clone\nTrust this folder?\n› 1. Trust and continue\n  2. Quit";

const questions: [string, string][] = [
  [trust, "Codex is asking to trust its folder"],
  ["Update available!\n› 1. Update now\n  2. Skip", "Codex is asking to update"],
  ["Hooks need review\n› 1. Review hooks\n  2. Skip", "Codex is asking to review its hooks"],
  [
    "Welcome to Codex, OpenAI's command-line coding agent\n> 1. Sign in with ChatGPT\n  2. Sign in with Device Code",
    "Codex is asking to sign in",
  ],
];

for (const [screen, reason] of questions) {
  test(reason, () => {
    expect(startupQuestion(screen, codex.marks)).toBe(reason);
    expect(quietSince(screen, screen, codex.marks)).toBe(false);
  });
}

test("ordinary replies about trust do not look like startup questions", () => {
  for (const screen of [
    "Codex may ask: Trust this folder?\n› Ask Codex to do anything",
    `${trust}\n› Ask Codex to do anything`,
    "Folder access\nTrust this folder?\nNo menu here",
  ])
    expect(startupQuestion(screen, codex.marks)).toBeNull();
});
