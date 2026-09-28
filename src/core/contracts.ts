// Contracts: small pure checks that decide calls before a task may leave a
// phase. Each returns every reason it failed, in plain words, because the
// reasons become inbox text and record entries.

import type { Check, Spec } from "./types";

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
