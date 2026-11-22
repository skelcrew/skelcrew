// The harnesses Skelcrew runs agents on, found by the name your config uses. Each harness lives in
// a module of its own, so the flow never names one.
import { z } from "zod";
import { claude } from "./claude.ts";
import { codex } from "./codex.ts";
import { renewLogin, sweepLogins, sweepReviewLogins } from "./codex-login.ts";

// A harness's name, as your config and Skelcrew's database write it.
export const HarnessName = z.enum(["claude", "codex"]);
export type HarnessName = z.infer<typeof HarnessName>;

const harnesses = { claude, codex } satisfies Record<HarnessName, { name: HarnessName }>;

// Returns the harness your config names, such as "claude", with how to start it and what its
// screen shows. The type follows the name, so a caller sees exactly what that harness offers.
export function harnessNamed<Name extends HarnessName>(name: Name): (typeof harnesses)[Name] {
  return harnesses[name];
}

// Keeps the copies of Skelcrew's logins its agents get: renews the login when due, and removes
// the copy of each session `runs` says ended. Only Codex agents get copies.
export async function keepLogins(home: string, runs: (name: string) => Promise<boolean>) {
  await renewLogin(home);
  await sweepLogins(home, runs);
}

// Removes every review's copy of a login, as the daemon starts, before any review runs.
export const dropReviewLogins = (home: string) => sweepReviewLogins(home);
