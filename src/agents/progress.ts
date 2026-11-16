// A builder's progress, as each harness reads it from its own session files for the sidebar:
// the step it is on, the tokens it used and how far through its plan it is.
import { basename } from "node:path";

// What a builder's session files said so far. Each part is null while the harness hasn't given
// it: a builder that has run no tool yet has no step, and one that made no plan has no plan.
// `last` is whatever a harness carries from one read to the next, such as the last answer it
// counted, as the file is read a piece at a time while it grows.
export type Progress = {
  step: string | null;
  tokens: number | null;
  plan: { done: number; total: number } | null;
  last: string;
};

// Progress before anything was read.
export const noProgress: Progress = { step: null, tokens: null, plan: null, last: "" };

// Returns a step for the sidebar from a text of any length: its first line, cut short, as the
// row has one line for it and an agent can write anything there. Empty text gives null.
export function stepText(text: string): string | null {
  const line = (text.trim().split("\n")[0] ?? "").trim().slice(0, 200);
  return line || null;
}

// Returns the step for a change to a file, such as "Editing rows.ts", naming the file without
// its folder.
export const editing = (file: string) => stepText(`Editing ${basename(file.trim())}`);

// Returns a tool's name in words, such as "Web search" for WebSearch or "Github get issue" for
// an MCP server's mcp__github__get_issue, for a tool with nothing better to say. Words are split
// where a capital or an underscore starts one, and only the first keeps its capital.
export function toolWords(tool: string): string | null {
  const words = tool
    .replace(/^mcp__/, "")
    .replace(/[_.]+/g, " ")
    .replace(/([a-z0-9])([A-Z])/g, "$1 $2")
    .trim()
    .toLowerCase();
  return stepText(words.charAt(0).toUpperCase() + words.slice(1));
}
