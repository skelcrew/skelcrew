import { describe, expect, test } from "bun:test";
import { defaultWorkflow, parseWorkflow } from "./workflow";

// The example from the spec's "Configuration and repository layout".
const specExample = `
checks:
  - bun test
  - bun run typecheck
  - bun run lint
max_attempts: 3
max_running: 2
spec_approval: always
review:
  model: different
critical_paths:
  - src/auth/**
  - migrations/**
plugins:
  sessions: herdr
  work_source: github
`;

describe("parseWorkflow", () => {
  test("reads the spec's example into the core's config and the check commands", () => {
    const parsed = parseWorkflow(specExample);
    if (!parsed.ok) throw new Error(parsed.reasons.join(" "));
    expect(parsed.workflow.checks).toEqual(["bun test", "bun run typecheck", "bun run lint"]);
    expect(parsed.workflow.config).toMatchObject({
      gates: ["local"],
      maxAttempts: 3,
      maxRunning: 2,
      specApproval: "always",
      criticalPaths: ["src/auth/**", "migrations/**"],
    });
  });

  test("fills in the defaults for what a file leaves out", () => {
    const parsed = parseWorkflow("checks:\n  - bun test\n");
    if (!parsed.ok) throw new Error(parsed.reasons.join(" "));
    expect(parsed.workflow.config).toMatchObject({
      gates: ["local"],
      maxAttempts: 3,
      maxRunning: 2,
      specApproval: "always",
    });
  });

  // Until auto-merge is earned, a file that says nothing merges nothing
  // without your approval.
  test("makes every path critical when critical_paths is left out", () => {
    const parsed = parseWorkflow("checks:\n  - bun test\n");
    expect(parsed.ok && parsed.workflow.config.criticalPaths).toEqual(["**"]);
  });

  test("refuses a file with no checks, since the local gate would check nothing", () => {
    expect(parseWorkflow("max_running: 2\n")).toEqual({
      ok: false,
      reasons: ["checks: list at least one command, such as `bun test`."],
    });
    expect(parseWorkflow("checks: []\n")).toEqual({
      ok: false,
      reasons: ["checks: list at least one command, such as `bun test`."],
    });
  });

  test("refuses a field it doesn't know, so a typo can't be silently ignored", () => {
    expect(parseWorkflow("checks:\n  - bun test\ncritical_path:\n  - src/auth/**\n")).toEqual({
      ok: false,
      reasons: ["critical_path isn't a setting Skelcrew knows."],
    });
  });

  test("names every bad value", () => {
    expect(
      parseWorkflow("checks:\n  - bun test\nmax_running: 0\nspec_approval: sometimes\n"),
    ).toEqual({
      ok: false,
      reasons: [
        "max_running: must be a whole number, 1 or more.",
        "spec_approval: must be always or never.",
      ],
    });
  });

  test("says so when the file isn't valid YAML", () => {
    const parsed = parseWorkflow("checks: [bun test\n");
    expect(parsed.ok).toBe(false);
    expect(!parsed.ok && parsed.reasons[0]).toStartWith("workflow.yml isn't valid YAML:");
  });

  test("refuses an empty file", () => {
    expect(parseWorkflow("")).toEqual({
      ok: false,
      reasons: ["checks: list at least one command, such as `bun test`."],
    });
  });
});

describe("defaultWorkflow", () => {
  test("is the file init writes: it reads back, and every path is critical", () => {
    const parsed = parseWorkflow(defaultWorkflow);
    if (!parsed.ok) throw new Error(parsed.reasons.join(" "));
    expect(parsed.workflow.config.criticalPaths).toEqual(["**"]);
    expect(parsed.workflow.checks.length).toBeGreaterThan(0);
  });
});
