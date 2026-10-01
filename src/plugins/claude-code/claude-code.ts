// The Claude Code profile: the one place that knows the agent is Claude
// Code. It says how to start an agent on a task, and reads what the agent
// used from Claude Code's transcript of the session.
//
// Starting, as a spike on Claude Code 2.1.286 showed:
// - `--session-id` sets Claude Code's own ID for the session, so its
//   transcript can be found again.
// - `dontAsk` mode refuses anything the developer's settings don't allow,
//   so the agent never stops at a question nobody can answer. Its other
//   modes stop and wait.
// - Every agent may run `skelcrew`, so it can report. The daemon refuses
//   the developer's commands from an agent, and the ask rules
//   `skelcrew init` adds for approve and reject refuse them here.
// - A develop agent also gets edits in its own worktree, since building is
//   its job. `Edit(//path/**)` covers editing, creating and overwriting
//   files there, and nowhere else. A spec agent gets no edits.
// - The prompt runs the agent's skill on the task, such as
//   "/develop 12 --background". The marker tells the skill nobody is
//   watching, without a shell command to read the environment.

import { randomUUID } from "node:crypto";
import { existsSync, readdirSync, readFileSync } from "node:fs";
import { homedir } from "node:os";
import { join } from "node:path";
import * as z from "zod";
import type { AgentToStart, AgentUsage, Harness, Launch } from "../harness";
import type { Done } from "../version-control";

export type ClaudeCodeOptions = {
  // Claude Code's own folder, ~/.claude unless CLAUDE_CONFIG_DIR moves it.
  configDir?: string;
  // Makes Claude Code's session ID, a UUID.
  newId?: () => string;
};

export class ClaudeCode implements Harness {
  readonly name = "claude-code";
  private readonly configDir: string;
  private readonly newId: () => string;

  constructor(options: ClaudeCodeOptions = {}) {
    this.configDir =
      options.configDir ?? process.env.CLAUDE_CONFIG_DIR ?? join(homedir(), ".claude");
    this.newId = options.newId ?? randomUUID;
  }

  launch(agent: AgentToStart): Launch {
    const id = this.newId();
    // Every agent may run skelcrew, to report. A develop agent may also edit
    // in its worktree. "//" starts an absolute path in a permission rule.
    const allow = ["Bash(skelcrew *)"];
    if (agent.kind === "develop") allow.push(`Edit(/${agent.cwd}/**)`);
    return {
      command: [
        "claude",
        "--session-id",
        id,
        "--permission-mode",
        "dontAsk",
        "--settings",
        JSON.stringify({ permissions: { allow } }),
        // "--background" tells the skill nobody is watching, before it does
        // anything else.
        `/${agent.kind} ${agent.taskId} --background`,
      ],
      env: { SKELCREW_TASK: String(agent.taskId), SKELCREW_SESSION: agent.session },
      harnessSession: id,
    };
  }

  async usage(_cwd: string, harnessSession: string): Promise<Done<AgentUsage>> {
    try {
      const path = this.transcriptOf(harnessSession);
      if (path === null) return { ok: true, value: { tokens: 0, cacheReads: 0, workingMs: 0 } };
      return { ok: true, value: usageIn(readFileSync(path, "utf8")) };
    } catch (error) {
      const message = error instanceof Error ? error.message : String(error);
      return { ok: false, message: `Claude Code's transcript couldn't be read: ${message}` };
    }
  }

  // Claude Code keeps each session's transcript in a folder named after
  // the folder it ran in. How it turns a path into that name is its own
  // business, so the transcript is found by the session's ID, which is
  // unique.
  private transcriptOf(harnessSession: string): string | null {
    const projects = join(this.configDir, "projects");
    if (!existsSync(projects)) return null;
    for (const folder of readdirSync(projects)) {
      const path = join(projects, folder, `${harnessSession}.jsonl`);
      if (existsSync(path)) return path;
    }
    return null;
  }
}

// The parts of a transcript line that matter here. Anything else in a line
// is ignored, and a line that doesn't fit is skipped.
const line = z.object({
  type: z.string(),
  timestamp: z.string().optional(),
  message: z
    .object({
      id: z.string().optional(),
      content: z.unknown().optional(),
      usage: z
        .object({
          input_tokens: z.number().optional(),
          output_tokens: z.number().optional(),
          cache_creation_input_tokens: z.number().optional(),
          cache_read_input_tokens: z.number().optional(),
        })
        .optional(),
    })
    .optional(),
});

// Adds up a transcript. A reply can span several lines with the same
// message ID, so each is counted once. Working time runs from each prompt
// to the last line before the next one, so time spent waiting for the
// developer's next prompt, such as an answer, isn't counted.
function usageIn(text: string): AgentUsage {
  const replies = new Map<string, { tokens: number; cacheReads: number }>();
  let workingMs = 0;
  let turnStart: number | null = null;
  let turnEnd: number | null = null;
  const closeTurn = () => {
    if (turnStart !== null && turnEnd !== null) workingMs += turnEnd - turnStart;
  };

  for (const raw of text.split("\n")) {
    if (raw.trim() === "") continue;
    let json: unknown;
    try {
      json = JSON.parse(raw);
    } catch {
      continue;
    }
    const parsed = line.safeParse(json);
    if (!parsed.success) continue;
    const { type, timestamp, message } = parsed.data;
    const time = timestamp === undefined ? Number.NaN : Date.parse(timestamp);

    // A prompt is a user line with plain text. A tool's result is a user
    // line too, but its content is a list.
    if (type === "user" && typeof message?.content === "string" && !Number.isNaN(time)) {
      closeTurn();
      turnStart = time;
      turnEnd = time;
    } else if (!Number.isNaN(time) && turnStart !== null) {
      turnEnd = Math.max(turnEnd ?? time, time);
    }

    const usage = message?.usage;
    if (type === "assistant" && message?.id !== undefined && usage !== undefined) {
      replies.set(message.id, {
        tokens:
          (usage.input_tokens ?? 0) +
          (usage.output_tokens ?? 0) +
          (usage.cache_creation_input_tokens ?? 0),
        cacheReads: usage.cache_read_input_tokens ?? 0,
      });
    }
  }
  closeTurn();

  let tokens = 0;
  let cacheReads = 0;
  for (const reply of replies.values()) {
    tokens += reply.tokens;
    cacheReads += reply.cacheReads;
  }
  return { tokens, cacheReads, workingMs };
}
