// The harnesses Skelcrew runs agents on, found by the name your config uses. Each harness lives in
// a module of its own, so the flow never names one.
import { z } from "zod";
import { claude } from "./claude.ts";
import { codex } from "./codex.ts";
import { pi, removeLoginCopies, removeLoginCopy } from "./pi.ts";

// A harness's name, as your config and Skelcrew's database write it.
export const HarnessName = z.enum(["claude", "codex", "pi"]);
export type HarnessName = z.infer<typeof HarnessName>;

const harnesses = { claude, codex, pi } satisfies Record<HarnessName, { name: HarnessName }>;

// Returns the harness your config names, such as "claude", with how to start it and what its
// screen shows. The type follows the name, so a caller sees exactly what that harness offers.
export function harnessNamed<Name extends HarnessName>(name: Name): (typeof harnesses)[Name] {
  return harnesses[name];
}

// Removes what a harness kept of your login for the session `name`, a lead or a builder, once
// Skelcrew ends it: Pi's copy of it, which the next start writes again. Claude Code and Codex
// keep none per session.
export function forgetLogin(name: string): void {
  removeLoginCopy(name);
}

// Starts the session `name` with `start`, which writes the harness's copy of your login before
// the session starts. Any failure removes the copy before it goes on, so a session that never
// ran keeps none.
export async function startHoldingLogin<T>(name: string, start: () => Promise<T>): Promise<T> {
  try {
    return await start();
  } catch (error) {
    forgetLogin(name);
    throw error;
  }
}

// Removes the copy of your login of every session but the `live` ones, the leads and builders
// that may run now, whatever path left one behind.
export function sweepLogins(live: Iterable<string>): void {
  removeLoginCopies(new Set(live));
}
