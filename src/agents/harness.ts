// The harnesses Skelcrew runs agents on, found by the name your config uses. Each harness lives in
// a module of its own, so the flow never names one.
import { z } from "zod";
import { claude } from "./claude.ts";
import { codex } from "./codex.ts";
import { pi } from "./pi.ts";

// A harness's name, as your config and Skelcrew's database write it.
export const HarnessName = z.enum(["claude", "codex", "pi"]);
export type HarnessName = z.infer<typeof HarnessName>;

const harnesses = { claude, codex, pi } satisfies Record<HarnessName, { name: HarnessName }>;

// Returns the harness your config names, such as "claude", with how to start it and what its
// screen shows. The type follows the name, so a caller sees exactly what that harness offers.
export function harnessNamed<Name extends HarnessName>(name: Name): (typeof harnesses)[Name] {
  return harnesses[name];
}
