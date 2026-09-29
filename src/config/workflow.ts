// Reads .skelcrew/workflow.yml: the repository's rules for the core, and the
// commands the local gate runs. Every field is checked before the core sees
// it, and a file that doesn't fit is refused with every reason at once.

import * as z from "zod";
import type { Config, Usage } from "../core/types";

export type Workflow = { config: Config; checks: string[] };

export type ParsedWorkflow = { ok: true; workflow: Workflow } | { ok: false; reasons: string[] };

// The file `skelcrew init` writes, with the checks it found in the
// repository. Every path is critical, so nothing merges without your
// approval until auto-merge is earned (build plan, step 6).
//
// Each command is written as a JSON string, which YAML reads as a quoted
// string. So a command with ":" or "#" in it reads back exactly.
export function workflowFile(checks: [string, ...string[]]): string {
  const commands = checks.map((command) => `  - ${JSON.stringify(command)}`).join("\n");
  return `# Skelcrew's rules for this repository.

# The local gate runs these in the task's worktree. Each must pass.
checks:
${commands}

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
`;
}

// One default limit per task, until the cap shows what the right numbers
// are. The spec leaves the values open.
const safetyCap: Usage = { tokens: 2_000_000, ms: 2 * 60 * 60_000 };

const wholeNumber = "must be a whole number, 1 or more.";
const count = z
  .number({ error: wholeNumber })
  .int({ error: wholeNumber })
  .min(1, { error: wholeNumber });

const schema = z.strictObject({
  checks: z
    .array(z.string().min(1, { error: "each check must be a command." }), {
      error: "list at least one command, such as `bun test`.",
    })
    .min(1, { error: "list at least one command, such as `bun test`." }),
  max_attempts: count.default(3),
  max_running: count.default(2),
  spec_approval: z
    .enum(["always", "never"], { error: "must be always or never." })
    .default("always"),
  critical_paths: z
    .array(z.string(), { error: "must be a list of file patterns." })
    .default(["**"]),
  // In the spec's example. Not used until the review gate and plugins exist.
  review: z.strictObject({ model: z.string() }).optional(),
  plugins: z.record(z.string(), z.string()).optional(),
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
      config: {
        gates: ["local"],
        maxAttempts: file.max_attempts,
        maxRunning: file.max_running,
        specApproval: file.spec_approval,
        criticalPaths: file.critical_paths,
        safetyCap,
      },
    },
  };
}
