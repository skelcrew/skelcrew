// The harnesses Skelcrew runs agents on, found by the name your config uses. Each harness lives in
// a module of its own, so the flow never names one.
import { z } from "zod";
import { claude } from "./claude.ts";
import { codex } from "./codex.ts";
import { loginCopies, pi, removeLoginCopy } from "./pi.ts";

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

// The sessions whose start runs in this daemon now, whose copy of your login no sweep removes.
const starting = new Set<string>();

// Starts the session `name` with `start`, which writes the harness's copy of your login before
// the session starts. Any failure removes the copy before it goes on, so a session that never
// ran keeps none.
export async function startHoldingLogin<T>(name: string, start: () => Promise<T>): Promise<T> {
  starting.add(name);
  try {
    return await start();
  } catch (error) {
    forgetLogin(name);
    throw error;
  } finally {
    starting.delete(name);
  }
}

// Removes each session's copy of your login unless `runs` says its session runs, or its start
// runs in this daemon. A copy written once the sweep began is a start's that just finished, so
// it stays. A session whose host can't say keeps its copy, for the next sweep.
export async function sweepLogins(runs: (name: string) => Promise<boolean>): Promise<void> {
  const began = Date.now();
  for (const { name, written } of loginCopies()) {
    if (starting.has(name) || written >= began) continue;
    const live = await runs(name).catch(() => true);
    if (!live && !starting.has(name)) forgetLogin(name);
  }
}
