// Branded IDs. At runtime each is a plain number or string. The brand only
// exists for the typechecker, so a TaskId can't be passed where a SessionId
// is expected. Mixing those up would mean stopping the wrong agent or
// reverting the wrong commit.
//
// Zod adds the brand while it checks an outside value, so no code of ours
// needs an `as` cast. IDs only enter through the boundaries (CLI, MCP server,
// plugins, the database), and each boundary parses them with these schemas.

import * as z from "zod";

// Counts up per repository: 1, 2, 3. Shown as "#12" and typed as "12" in
// commands. The daemon picks the next number; the core never makes one up.
export const TaskId = z.number().int().positive().brand<"TaskId">();
export type TaskId = z.infer<typeof TaskId>;

// A short slug such as "inbox" or "github-plugin", typed as-is in commands.
// Lowercase words joined by single dashes, so it never needs quoting.
export const ProjectId = z
  .string()
  .regex(/^[a-z0-9]+(-[a-z0-9]+)*$/)
  .brand<"ProjectId">();
export type ProjectId = z.infer<typeof ProjectId>;

// Whatever the harness gives. Claude Code uses long IDs nobody types.
export const SessionId = z.string().min(1).brand<"SessionId">();
export type SessionId = z.infer<typeof SessionId>;

// Always the full sha, so two commits can never be confused.
export const CommitSha = z
  .string()
  .regex(/^[0-9a-f]{40}$/)
  .brand<"CommitSha">();
export type CommitSha = z.infer<typeof CommitSha>;
