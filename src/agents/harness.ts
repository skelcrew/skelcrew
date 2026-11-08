// The harnesses skel runs agents on, found by the name your config uses. Each harness lives in
// a module of its own, so the flow never names one.
import { z } from "zod";
import { claude } from "./claude.ts";
import { codex } from "./codex.ts";

// A harness's name, as your config and skel's database write it.
export const HarnessName = z.enum(["claude", "codex"]);
export type HarnessName = z.infer<typeof HarnessName>;

const harnesses = { claude, codex } satisfies Record<HarnessName, { name: HarnessName }>;

// Returns the harness your config names, such as "claude", with how to start it and what its
// screen shows. The type follows the name, so a caller sees exactly what that harness offers.
export function harnessNamed<Name extends HarnessName>(name: Name): (typeof harnesses)[Name] {
  return harnesses[name];
}

// Returns the name of the harness a review runs on: the one your config names, or else Codex
// when it is installed, for a second view on another model, and Claude Code when it isn't.
// The thread saves it as the review starts, so you can see which agent has the thread while
// it waits and runs.
export const reviewerHarness = (configured: HarnessName | undefined, path: string) =>
  configured ?? (Bun.which(codex.name, { PATH: path }) ? codex.name : claude.name);
