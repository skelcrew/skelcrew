// Contracts: small pure checks that decide calls before a task may leave a
// phase. Each returns every reason it failed, in plain words, because the
// reasons become inbox text and record entries.

import picomatch from "picomatch";
import type { BranchFacts, Check, Spec, Usage } from "./types";

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
export function mergeAllowed(branch: BranchFacts, criticalPaths: string[]): Check {
  const reasons = criticalMatches(branch, criticalPaths).map(
    ({ file, pattern }) => `${file} matches the critical path ${pattern}`,
  );
  return reasons.length === 0 ? { ok: true } : { ok: false, reasons };
}

// The changed files that match a critical path, so the inbox can list what
// needs the developer's eye.
export function criticalFiles(branch: BranchFacts, criticalPaths: string[]): string[] {
  return criticalMatches(branch, criticalPaths).map(({ file }) => file);
}

// Each changed file that matches, with the first pattern it matches.
//
// `dot: true` makes ** match hidden files like src/auth/.env, which
// picomatch skips by default. `windows: false` fixes the separator to "/"
// on every machine, so the same inputs always give the same answer.
function criticalMatches(
  branch: BranchFacts,
  criticalPaths: string[],
): { file: string; pattern: string }[] {
  const matchers = criticalPaths.map((pattern) => ({
    pattern,
    matches: picomatch(pattern, { dot: true, windows: false }),
  }));
  const found: { file: string; pattern: string }[] = [];
  for (const file of branch.changedFiles) {
    const hit = matchers.find((m) => m.matches(file));
    if (hit) found.push({ file, pattern: hit.pattern });
  }
  return found;
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

// Safety cap: a task that reaches the token or time limit since its last
// retry is blocked. It catches an agent stuck in a loop within a session.
export function withinSafetyCap(usage: Usage, usageAtRetry: Usage, cap: Usage): Check {
  const tokens = usage.tokens - usageAtRetry.tokens;
  const ms = usage.ms - usageAtRetry.ms;
  const reasons: string[] = [];
  if (tokens >= cap.tokens) {
    reasons.push(
      `Used ${withCommas(tokens)} tokens since the last retry. The cap is ${withCommas(cap.tokens)}.`,
    );
  }
  if (ms >= cap.ms) {
    reasons.push(
      `Ran for ${minutes(ms)} minutes since the last retry. The cap is ${minutes(cap.ms)} minutes.`,
    );
  }
  return reasons.length === 0 ? { ok: true } : { ok: false, reasons };
}

// By hand, not toLocaleString, which depends on the computer's language
// setting. 1234567 becomes "1,234,567".
function withCommas(n: number): string {
  return String(Math.floor(n)).replace(/\B(?=(\d{3})+(?!\d))/g, ",");
}

function minutes(ms: number): number {
  return Math.floor(ms / 60_000);
}
