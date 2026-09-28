// Contracts: small pure checks that decide calls before a task may leave a
// phase. Each returns every reason it failed, in plain words, because the
// reasons become inbox text and record entries.

import picomatch from "picomatch";
import type { BranchFacts, Check, Spec } from "./types";

// Spec to Ready: the spec has a scope, acceptance criteria and no open
// questions. Approval is checked separately, by decide.
export function specComplete(spec: Spec): Check {
  const reasons: string[] = [];
  if (isBlank(spec.scope)) {
    reasons.push("The spec has no scope.");
  }
  if (spec.acceptance.every(isBlank)) {
    reasons.push("The spec has no acceptance criteria.");
  }
  const open = spec.openQuestions;
  if (open.length > 0) {
    const noun = open.length === 1 ? "question" : "questions";
    reasons.push(`The spec has ${open.length} open ${noun}: ${open.join(" ")}`);
  }
  return reasons.length === 0 ? { ok: true } : { ok: false, reasons };
}

function isBlank(text: string): boolean {
  return text.trim() === "";
}

// Merge policy: a branch that changes a file on a critical path needs the
// developer's approval before it merges. The reasons name each file and the
// pattern it matched, so the inbox can say why approval is needed.
//
// `dot: true` makes ** match hidden files like src/auth/.env, which
// picomatch skips by default. `windows: false` fixes the separator to "/"
// on every machine, so the same inputs always give the same answer.
export function mergeAllowed(branch: BranchFacts, criticalPaths: string[]): Check {
  const matchers = criticalPaths.map((pattern) => ({
    pattern,
    matches: picomatch(pattern, { dot: true, windows: false }),
  }));
  const reasons: string[] = [];
  for (const file of branch.changedFiles) {
    const hit = matchers.find((m) => m.matches(file));
    if (hit) {
      reasons.push(`${file} matches the critical path ${hit.pattern}`);
    }
  }
  return reasons.length === 0 ? { ok: true } : { ok: false, reasons };
}

// Attempts: after a failed gate or merge, the task goes back to the agent
// if attempts remain. Otherwise decide blocks it with the last failure.
export function attemptsLeft(attempts: number, maxAttempts: number): Check {
  if (attempts < maxAttempts) {
    return { ok: true };
  }
  const reason =
    maxAttempts === 1 ? "The only attempt failed." : `All ${maxAttempts} attempts failed.`;
  return { ok: false, reasons: [reason] };
}
