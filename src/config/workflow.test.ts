import { describe, expect, test } from "bun:test";
import { parseWorkflow, workflowFile } from "./workflow";

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

  test("runs no setup when the file doesn't say", () => {
    const parsed = parseWorkflow("checks:\n  - bun test\n");
    expect(parsed.ok && parsed.workflow.setup).toEqual([]);
  });

  test("reads the setup commands, run before the checks in a fresh copy", () => {
    const parsed = parseWorkflow("setup:\n  - bun install\nchecks:\n  - bun test\n");
    expect(parsed.ok && parsed.workflow.setup).toEqual(["bun install"]);
  });

  test("refuses a setup command that is blank", () => {
    expect(parseWorkflow('setup:\n  - " "\nchecks:\n  - bun test\n')).toEqual({
      ok: false,
      reasons: ["setup.0: each setup step must be a command."],
    });
  });

  test("uses main as the main branch when the file doesn't say", () => {
    const parsed = parseWorkflow("checks:\n  - bun test\n");
    expect(parsed.ok && parsed.workflow.mainBranch).toBe("main");
  });

  test("reads the main branch from main_branch", () => {
    const parsed = parseWorkflow("checks:\n  - bun test\nmain_branch: master\n");
    expect(parsed.ok && parsed.workflow.mainBranch).toBe("master");
  });

  test("refuses a main_branch that is blank", () => {
    expect(parseWorkflow('checks:\n  - bun test\nmain_branch: " "\n')).toEqual({
      ok: false,
      reasons: ["main_branch: must be a branch name, such as main."],
    });
  });

  // Until auto-merge is earned, a file that says nothing merges nothing
  // without your approval.
  test("makes every path critical when critical_paths is left out", () => {
    const parsed = parseWorkflow("checks:\n  - bun test\n");
    expect(parsed.ok && parsed.workflow.config.criticalPaths).toEqual(["**"]);
  });

  test("reads the safety cap, in tokens and minutes", () => {
    const parsed = parseWorkflow(
      "checks:\n  - bun test\nsafety_cap:\n  tokens: 500000\n  minutes: 30\n",
    );
    expect(parsed.ok && parsed.workflow.config.safetyCap).toEqual({
      tokens: 500_000,
      ms: 30 * 60_000,
    });
  });

  test("uses 2,000,000 tokens and 2 hours when the safety cap is left out", () => {
    const parsed = parseWorkflow("checks:\n  - bun test\n");
    expect(parsed.ok && parsed.workflow.config.safetyCap).toEqual({
      tokens: 2_000_000,
      ms: 120 * 60_000,
    });
  });

  test("refuses a safety cap with a part missing or not a positive whole number", () => {
    expect(parseWorkflow("checks:\n  - bun test\nsafety_cap:\n  tokens: 0\n")).toEqual({
      ok: false,
      reasons: [
        "safety_cap.tokens: must be a whole number, 1 or more.",
        "safety_cap.minutes: must be a whole number, 1 or more.",
      ],
    });
  });

  test("refuses a file with no checks, since the local gate would check nothing", () => {
    expect(parseWorkflow("max_running: 2\n")).toEqual({
      ok: false,
      reasons: ["checks: list at least one command, such as the one that runs your tests."],
    });
    expect(parseWorkflow("checks: []\n")).toEqual({
      ok: false,
      reasons: ["checks: list at least one command, such as the one that runs your tests."],
    });
  });

  // Found by review: a check of only spaces ran nothing, and passed.
  test("refuses a check that is blank", () => {
    expect(parseWorkflow('checks:\n  - bun test\n  - "   "\n')).toEqual({
      ok: false,
      reasons: ["checks.1: each check must be a command."],
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
      reasons: ["checks: list at least one command, such as the one that runs your tests."],
    });
  });
});

describe("workflowFile", () => {
  // Init detects the repository's checks. The file only writes them down.
  test("writes the checks init found, and reads back with every path critical", () => {
    const parsed = parseWorkflow(workflowFile(["npm test", "npm run lint"]));
    if (!parsed.ok) throw new Error(parsed.reasons.join(" "));
    expect(parsed.workflow.checks).toEqual(["npm test", "npm run lint"]);
    expect(parsed.workflow.config.criticalPaths).toEqual(["**"]);
  });

  test("writes the default safety cap, so you can see and change it", () => {
    const text = workflowFile(["npm test"]);
    expect(text).toContain("safety_cap:\n  tokens: 2000000\n  minutes: 120\n");
  });

  test("keeps a command exactly, even with characters YAML treats specially", () => {
    const checks: [string, ...string[]] = ['echo "a: b" # not a comment', "make -j4 test"];
    const parsed = parseWorkflow(workflowFile(checks));
    expect(parsed.ok && parsed.workflow.checks).toEqual(checks);
  });
});
