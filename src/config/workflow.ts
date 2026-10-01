// Reads .skelcrew/workflow.yml: the repository's rules for the core, and the
// commands the local gate runs. Every field is checked before the core sees
// it, and a file that doesn't fit is refused with every reason at once.

import * as z from "zod";
import type { Config } from "../core/types";

// `mainBranch` is the branch tasks start from and merge into. `setup`
// prepares a fresh copy of a task's code, such as installing its
// dependencies, before the checks run there.
export type Workflow = {
  config: Config;
  checks: string[];
  setup: string[];
  mainBranch: string;
  // Whether Skelcrew starts agents itself, and the runner that holds them.
  background: boolean;
  sessions: "basic" | "tmux" | "herdr";
};

export type ParsedWorkflow = { ok: true; workflow: Workflow } | { ok: false; reasons: string[] };

// The file `skelcrew init` writes, with the checks it found in the
// repository. Every path is critical, so nothing merges without your
// approval until auto-merge is earned (build plan, step 6).
//
// Each command is written as a JSON string, which YAML reads as a quoted
// string. So a command with ":" or "#" in it reads back exactly.
export function workflowFile(checks: [string, ...string[]], setup: string[] = []): string {
  const list = (items: string[]) =>
    items.map((command) => `  - ${JSON.stringify(command)}`).join("\n");
  const setupPart =
    setup.length === 0
      ? ""
      : `
# These prepare a fresh copy of the task's code, such as installing its
# dependencies, before the checks run there.
setup:
${list(setup)}
`;
  return `# Skelcrew's rules for this repository.
${setupPart}
# The local gate runs these in a fresh copy of the task's code. Each must pass.
checks:
${list(checks)}

# Failed rounds (gates or merges) before a task is blocked.
max_attempts: 3

# Agents working at once, spec and develop together, yours included.
max_running: 2

# always: only you make a spec Ready. never: a complete spec is Ready at once.
spec_approval: always

# A merge that changes a file matching one of these waits for your approval.
# "**" matches every file, so every merge waits for you.
critical_paths:
  - "**"

# A task that uses this much since its last retry is blocked. It catches an
# agent stuck in a loop.
safety_cap:
  tokens: 2000000
  minutes: 120
`;
}

const wholeNumber = "must be a whole number, 1 or more.";
const count = z
  .number({ error: wholeNumber })
  .int({ error: wholeNumber })
  .min(1, { error: wholeNumber });

const schema = z.strictObject({
  checks: z
    .array(
      z
        .string()
        .refine((command) => command.trim() !== "", { error: "each check must be a command." }),
      {
        error: "list at least one command, such as the one that runs your tests.",
      },
    )
    .min(1, { error: "list at least one command, such as the one that runs your tests." }),
  max_attempts: count.default(3),
  max_running: count.default(2),
  spec_approval: z
    .enum(["always", "never"], { error: "must be always or never." })
    .default("always"),
  critical_paths: z
    .array(z.string(), { error: "must be a list of file patterns." })
    .default(["**"]),
  // How much one task may use since its last retry before it is blocked.
  // It catches an agent stuck in a loop.
  safety_cap: z
    .strictObject({ tokens: count, minutes: count })
    .default({ tokens: 2_000_000, minutes: 120 }),
  setup: z
    .array(
      z.string().refine((command) => command.trim() !== "", {
        error: "each setup step must be a command.",
      }),
      { error: "must be a list of commands." },
    )
    .default([]),
  main_branch: z
    .string({ error: "must be a branch name, such as main." })
    .refine((name) => name.trim() !== "", { error: "must be a branch name, such as main." })
    .default("main"),
  // Whether Skelcrew starts agents itself. With false, a task waits until
  // the developer claims it.
  background: z.boolean({ error: "must be true or false." }).default(true),
  // In the spec's example. Not used until the review gate exists.
  review: z.strictObject({ model: z.string() }).optional(),
  // `sessions` picks the session runner. Others, such as `work_source`,
  // are read but not used until their plugins exist.
  plugins: z
    .looseObject({
      sessions: z
        .enum(["basic", "tmux", "herdr"], { error: "must be basic, tmux or herdr." })
        .default("basic"),
    })
    .default({ sessions: "basic" }),
});

export function parseWorkflow(text: string): ParsedWorkflow {
  let data: unknown;
  try {
    data = Bun.YAML.parse(text);
  } catch (error) {
    const message = error instanceof Error ? error.message : String(error);
    return { ok: false, reasons: [`workflow.yml isn't valid YAML: ${message}`] };
  }

  // An empty file parses to null. It is read as a file with no settings.
  const result = schema.safeParse(data ?? {});
  if (!result.success) {
    const reasons = result.error.issues.flatMap((issue) =>
      issue.code === "unrecognized_keys"
        ? issue.keys.map((key) => `${key} isn't a setting Skelcrew knows.`)
        : [`${issue.path.join(".") || "workflow.yml"}: ${issue.message}`],
    );
    return { ok: false, reasons };
  }

  const file = result.data;
  return {
    ok: true,
    workflow: {
      checks: file.checks,
      setup: file.setup,
      mainBranch: file.main_branch,
      background: file.background,
      sessions: file.plugins.sessions,
      config: {
        gates: ["local"],
        maxAttempts: file.max_attempts,
        maxRunning: file.max_running,
        specApproval: file.spec_approval,
        criticalPaths: file.critical_paths,
        safetyCap: { tokens: file.safety_cap.tokens, ms: file.safety_cap.minutes * 60_000 },
      },
    },
  };
}
