// What the sidebar says of a builder at work, as each harness reads it from its conversation
// file: the step it is on, the tokens it used and how far through its plan it is.
import { expect, test } from "bun:test";
import { claude } from "../src/agents/claude.ts";
import { codex } from "../src/agents/codex.ts";
import { noProgress } from "../src/agents/progress.ts";
import { tokenText } from "../src/screen/progress.ts";

// A line of Claude Code's conversation file: one part of an answer, with the answer's whole
// usage, as Claude Code writes each part.
const usage = {
  input_tokens: 2,
  cache_creation_input_tokens: 30_000,
  cache_read_input_tokens: 900_000,
  output_tokens: 500,
};
const answer = (id: string, part: Record<string, unknown>) =>
  JSON.stringify({ type: "assistant", message: { id, usage, content: [part] } });
const tool = (name: string, input: Record<string, unknown>) => ({
  type: "tool_use",
  id: "t",
  name,
  input,
});
// The step Claude Code's builder is on after one tool call.
const claudeStep = (name: string, input: Record<string, unknown> = {}) =>
  claude.progress([answer("m", tool(name, input))], noProgress).step;

test("Claude Code: an answer's tokens count once, without cache reads, even across two reads", () => {
  const lines = [
    JSON.stringify({ type: "user", message: { content: "Add export" } }),
    answer("msg_1", { type: "thinking", thinking: "" }),
    answer("msg_1", tool("Bash", { command: "ls", description: "List files" })),
    answer("msg_2", { type: "text", text: "Done" }),
    "not json",
  ];
  const read = claude.progress(lines, noProgress);
  expect(read.tokens).toBe(2 * 30_502);
  // The file is read a piece at a time, so an answer split over two pieces is counted once.
  expect(claude.progress([answer("msg_2", { type: "text", text: "" })], read).tokens).toBe(
    2 * 30_502,
  );
});

test("Claude Code: the step is the last tool call, and the plan the last TodoWrite", () => {
  const todos = (...statuses: string[]) =>
    tool("TodoWrite", { todos: statuses.map((status) => ({ content: "x", status })) });
  const lines = [
    answer("m1", todos("pending", "pending", "pending")),
    answer("m2", tool("Edit", { file_path: "/work/src/screen/rows.ts" })),
    answer("m3", todos("completed", "completed", "in_progress")),
    answer("m4", tool("Bash", { command: "bun test", description: "Run the sidebar tests" })),
  ];
  const read = claude.progress(lines, noProgress);
  expect(read.step).toBe("Run the sidebar tests");
  expect(read.plan).toEqual({ done: 2, total: 3 });
  // A conversation with no tool call yet has neither.
  expect(claude.progress([answer("m", { type: "text", text: "" })], noProgress)).toMatchObject({
    step: null,
    plan: null,
  });
});

test("Claude Code: each tool says its step in its own way", () => {
  expect(claudeStep("Edit", { file_path: "/work/src/screen/rows.ts" })).toBe("Editing rows.ts");
  expect(claudeStep("Write", { file_path: "/work/docs/spec.md" })).toBe("Editing spec.md");
  expect(claudeStep("NotebookEdit", { notebook_path: "/w/a.ipynb" })).toBe("Editing a.ipynb");
  expect(claudeStep("Read", { file_path: "/work/src/main.ts" })).toBe("Reading main.ts");
  expect(claudeStep("Agent", { description: "Find the hooks", prompt: "" })).toBe("Find the hooks");
  expect(claudeStep("WebSearch", { query: "x" })).toBe("Web search");
  expect(claudeStep("mcp__github__get_issue")).toBe("Github get issue");
});

// A command is the agent's own shell text, such as a cd and a heredoc, which reads as noise in a
// row. Only its description says the step in words, so a command without one gives no step, not
// even the step before it, which it no longer is.
test("Claude Code: a command says its step only by its description", () => {
  expect(claudeStep("Bash", { command: "cd /work; python3 - <<EOF" })).toBeNull();
  const lines = [
    answer("m1", tool("Edit", { file_path: "/work/src/screen/rows.ts" })),
    answer("m2", tool("Bash", { command: "bun test" })),
  ];
  expect(claude.progress(lines, noProgress).step).toBeNull();
});

test("a step is one line, however long the description", () => {
  const said = claudeStep("Bash", { command: "x", description: `${"word ".repeat(100)}\nmore` });
  expect(said).not.toContain("\n");
  expect(said?.length).toBeLessThanOrEqual(200);
});

// A line of Codex's conversation file with its running count of tokens, with the cached input
// inside its input.
const counted = (input: number, cached: number, output: number) =>
  JSON.stringify({
    type: "event_msg",
    payload: {
      type: "token_count",
      info: {
        total_token_usage: {
          input_tokens: input,
          cached_input_tokens: cached,
          output_tokens: output,
          total_tokens: input + output,
        },
      },
    },
  });
// A line of Codex's conversation file with a function call, whose arguments are JSON text.
const call = (name: string, args: unknown) =>
  JSON.stringify({
    type: "response_item",
    payload: { type: "function_call", name, arguments: JSON.stringify(args), call_id: "c" },
  });
const codexStep = (line: string) => codex.progress([line], noProgress).step;

test("Codex: the tokens are its newest running count, without cached input", () => {
  const lines = [
    JSON.stringify({ type: "session_meta", payload: { id: "x" } }),
    counted(10_000, 8_000, 300),
    JSON.stringify({ type: "event_msg", payload: { type: "token_count", info: null } }),
    counted(50_000, 40_000, 1_000),
  ];
  const read = codex.progress(lines, noProgress);
  expect(read.tokens).toBe(11_000);
  // A piece with no count keeps what was counted before.
  expect(codex.progress(["{}"], read).tokens).toBe(11_000);
});

test("Codex: the step is the last tool call, and the plan the last update_plan", () => {
  const plan = (...statuses: string[]) =>
    call("update_plan", { plan: statuses.map((status) => ({ step: "x", status })) });
  const lines = [
    plan("in_progress", "pending"),
    call("view_image", { path: "a.png" }),
    plan("completed", "completed", "in_progress", "pending"),
  ];
  const read = codex.progress(lines, noProgress);
  expect(read.step).toBe("View image");
  expect(read.plan).toEqual({ done: 2, total: 4 });
});

// Codex gives a command no description, and its shell text reads as noise in a row, so a command
// gives no step, not even the step before it, which it no longer is.
test("Codex: a command gives no step", () => {
  const patch = "*** Begin Patch\n*** Update File: src/a.ts\n*** End Patch";
  const edit = JSON.stringify({
    type: "response_item",
    payload: { type: "custom_tool_call", name: "apply_patch", input: patch, call_id: "c" },
  });
  for (const command of [
    call("shell", { command: ["bash", "-lc", "cd /work; python3 - <<EOF"] }),
    call("shell", { command: ["git", "status"] }),
    call("shell_command", { command: "rg needs_you src" }),
    call("exec_command", { cmd: "bun run check" }),
  ])
    expect(codex.progress([edit, command], noProgress).step).toBeNull();
});

test("Codex: each kind of call says its step in its own way", () => {
  const patch = "*** Begin Patch\n*** Update File: src/screen/rows.ts\n@@\n-a\n+b\n*** End Patch";
  const custom = JSON.stringify({
    type: "response_item",
    payload: { type: "custom_tool_call", name: "apply_patch", input: patch, call_id: "c" },
  });
  expect(codexStep(custom)).toBe("Editing rows.ts");
  expect(codexStep(call("view_image", { path: "a.png" }))).toBe("View image");
});

test("tokens show in the fewest letters, rounded down", () => {
  expect(tokenText(0)).toBe("0");
  expect(tokenText(850)).toBe("850");
  expect(tokenText(1_250)).toBe("1.2k");
  expect(tokenText(48_900)).toBe("48k");
  expect(tokenText(999_999)).toBe("999k");
  expect(tokenText(1_000_000)).toBe("1M");
  expect(tokenText(1_290_000)).toBe("1.2M");
  expect(tokenText(25_000_000)).toBe("25M");
});

// The file is the agent's to write, so a reader must take anything there without failing.
test("Codex: lines that aren't what Codex writes give nothing", () => {
  const nonsense = [
    "",
    "not json",
    "null",
    '{"type":"event_msg","payload":{"type":"token_count","info":{"total_token_usage":"x"}}}',
    '{"type":"response_item","payload":{"type":"function_call","name":"shell","arguments":"{not json"}}',
    '{"type":"response_item","payload":{"type":"function_call","name":"update_plan","arguments":"{\\"plan\\":7}"}}',
    '{"type":"response_item","payload":{"type":"local_shell_call"}}',
    '{"type":"response_item","payload":{"type":"custom_tool_call","name":"apply_patch","input":"no files"}}',
  ];
  const read = codex.progress(nonsense, noProgress);
  expect(read.tokens).toBeNull();
  expect(read.plan).toBeNull();
  // A call with nothing better to say is named by its tool.
  expect(read.step).toBe("Apply patch");
});
