// The harnesses Skelcrew runs agents on, found by the name your config uses. Each harness lives in
// a module of its own, so the flow never names one.
import { z } from "zod";
import { claude } from "./claude.ts";
import { codex, codexHome } from "./codex.ts";
import {
  sharedLoginLeft as codexSharedLoginLeft,
  takeSharedLogin as codexTakeSharedLogin,
  renewLogin,
  startedShared,
} from "./codex-login.ts";
import { sweepLogins, sweepReviewLogins } from "./login-copies.ts";
import { pi } from "./pi.ts";

// A harness's name, as your config and Skelcrew's database write it.
export const HarnessName = z.enum(["claude", "codex", "pi"]);
export type HarnessName = z.infer<typeof HarnessName>;

const harnesses = { claude, codex, pi } satisfies Record<HarnessName, { name: HarnessName }>;

// The harnesses whose agents get a copy of Skelcrew's login, each with how it renews it.
// Claude Code's agents log in with a token that never renews, so it has none.
const withCopies = [codex, pi];

// Returns the harness your config names, such as "claude", with how to start it and what its
// screen shows. The type follows the name, so a caller sees exactly what that harness offers.
export function harnessNamed<Name extends HarnessName>(name: Name): (typeof harnesses)[Name] {
  return harnesses[name];
}

// Keeps the copies of Skelcrew's logins its agents get: removes the copy of each session `runs`
// says ended, and renews each login when due. They all run side by side, so a host slow to
// answer never holds up a renewal, nor a login that can't be renewed the sweep.
export async function keepLogins(home: string, runs: (name: string) => Promise<boolean>) {
  const outcomes = await Promise.allSettled(
    withCopies.flatMap((h) => [sweepLogins(home, h.name, runs), h.renewLogin(home)]),
  );
  for (const outcome of outcomes) if (outcome.status === "rejected") throw outcome.reason;
}

// Removes every review's copy of a login, as the daemon starts, before any review runs.
export function dropReviewLogins(home: string): void {
  for (const h of withCopies) sweepReviewLogins(home, h.name);
}

// Returns whether the login an earlier release shared with every Codex agent is still there.
export const sharedLoginLeft = (home: string) => codexSharedLoginLeft(home);

// Returns whether the session with this name, on this harness, may run on the login an earlier
// release shared.
export const sharesLogin = (harness: HarnessName, home: string, name: string) =>
  harness === "codex" && startedShared(home, name);

// Takes the login an earlier release shared, once no agent runs on it, and renews it, so the
// refresh token those agents knew is spent.
export async function takeSharedLogin(home: string): Promise<void> {
  codexTakeSharedLogin(home, codexHome(home));
  await renewLogin(home);
}
