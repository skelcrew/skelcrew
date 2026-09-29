// Zod schemas for stored events, and for commands saved until they are
// carried out. Both are read back from SQLite, where anything could have
// happened to them, so each one is checked before it is used.
//
// Every schema is annotated with the core's own type, so the typechecker
// fails if the two drift apart. Objects are strict: an unknown field is
// refused rather than dropped without a word, since a stored event is kept
// forever and must read back exactly as it was written.

import * as z from "zod";
import { CommitSha, ProjectId, SessionId, TaskId } from "../core/ids";
import type {
  BlockReason,
  BranchFacts,
  Brief,
  Command,
  EventBody,
  Failure,
  GateName,
  ProjectEvent,
  ProjectEventBody,
  Question,
  SourceRef,
  Spec,
  TaskEvent,
  Usage,
  Worktree,
} from "../core/types";

// ---------------------------------------------------------------------------
// The shapes events carry
// ---------------------------------------------------------------------------

const gateName: z.ZodType<GateName> = z.enum(["local", "remote", "review"]);

export const spec: z.ZodType<Spec> = z.strictObject({
  scope: z.string(),
  acceptance: z.array(z.string()),
  openQuestions: z.array(z.string()),
});

const question: z.ZodType<Question> = z.strictObject({
  from: z.enum(["spec", "develop"]),
  text: z.string(),
  options: z.array(z.string()),
  askedAt: z.number(),
});

const failure: z.ZodType<Failure> = z.strictObject({
  step: z.enum(["local", "remote", "review", "merge"]),
  summary: z.string(),
});

const usage: z.ZodType<Usage> = z.strictObject({ tokens: z.number(), ms: z.number() });

const blockReason: z.ZodType<BlockReason> = z.discriminatedUnion("kind", [
  z.strictObject({ kind: z.literal("out_of_attempts"), failure }),
  z.strictObject({ kind: z.literal("safety_cap"), usage }),
  z.strictObject({ kind: z.literal("agent_gave_up"), message: z.string() }),
  z.strictObject({ kind: z.literal("worktree_failed"), message: z.string() }),
  z.strictObject({ kind: z.literal("session_failed"), message: z.string() }),
]);

const worktree: z.ZodType<Worktree> = z.strictObject({ path: z.string(), branch: z.string() });

const sourceRef: z.ZodType<SourceRef> = z.strictObject({ label: z.string(), url: z.string() });

const branchFacts: z.ZodType<BranchFacts> = z.strictObject({
  head: CommitSha,
  commits: z.number().int().min(0),
  changedFiles: z.array(z.string()),
});

const brief: z.ZodType<Brief> = z.strictObject({
  failure: failure.nullable(),
  note: z.string().nullable(),
  blocked: blockReason.nullable(),
});

// ---------------------------------------------------------------------------
// Task events
// ---------------------------------------------------------------------------

// Fields every task event carries, next to its own.
const stamp = { v: z.literal(1), taskId: TaskId, at: z.number() };

// Each event type's own fields, keyed by the core's event names. The key
// type makes the typechecker fail if a name is missing or misspelled.
const taskEvents = {
  "task.created": {
    title: z.string(),
    project: ProjectId.nullable(),
    source: sourceRef.nullable(),
  },
  "task.project_changed": { project: ProjectId.nullable() },
  "task.spec_requested": {},
  "task.spec_session_started": { session: SessionId },
  "task.specced": { spec, by: z.enum(["agent", "human"]) },
  "task.spec_sent_back": { note: z.string() },
  "task.ready": {},
  "task.dispatch_started": { request: z.number().int().positive() },
  "task.worktree_created": { worktree, request: z.number().int().positive() },
  "task.dispatched": { session: SessionId },
  "task.claimed": { session: SessionId, request: z.number().int().positive().nullable() },
  "task.question_asked": { question },
  "task.question_answered": { text: z.string() },
  "task.done_reported": {
    branch: branchFacts,
    gate: gateName,
    request: z.number().int().positive(),
  },
  "task.gate_passed": {
    gate: gateName,
    next: z.strictObject({ gate: gateName, request: z.number().int().positive() }).nullable(),
  },
  "task.gate_failed": { failure },
  "task.checks_passed": {},
  "task.merge_approval_requested": { criticalFiles: z.array(z.string()) },
  "task.merge_sent_back": { note: z.string() },
  "task.merge_started": { request: z.number().int().positive() },
  "task.merge_failed": { failure },
  "task.merged": { commit: CommitSha },
  "task.revert_started": { reason: z.string(), request: z.number().int().positive() },
  "task.revert_failed": { summary: z.string() },
  "task.reverted": { commit: CommitSha, reason: z.string() },
  "task.blocked": { reason: blockReason },
  "task.unblocked": {},
  "task.dropped": {},
  "task.usage_recorded": { usage },
} satisfies Record<EventBody["type"], z.ZodRawShape>;

// One strict object per event type: its own fields, the stamp, and a
// literal `type`.
function task<K extends keyof typeof taskEvents>(type: K) {
  return z.strictObject({ ...taskEvents[type], ...stamp, type: z.literal(type) });
}

const taskEventUnion = z.discriminatedUnion("type", [
  task("task.created"),
  task("task.project_changed"),
  task("task.spec_requested"),
  task("task.spec_session_started"),
  task("task.specced"),
  task("task.spec_sent_back"),
  task("task.ready"),
  task("task.dispatch_started"),
  task("task.worktree_created"),
  task("task.dispatched"),
  task("task.claimed"),
  task("task.question_asked"),
  task("task.question_answered"),
  task("task.done_reported"),
  task("task.gate_passed"),
  task("task.gate_failed"),
  task("task.checks_passed"),
  task("task.merge_approval_requested"),
  task("task.merge_sent_back"),
  task("task.merge_started"),
  task("task.merge_failed"),
  task("task.merged"),
  task("task.revert_started"),
  task("task.revert_failed"),
  task("task.reverted"),
  task("task.blocked"),
  task("task.unblocked"),
  task("task.dropped"),
  task("task.usage_recorded"),
]);

// Fails to typecheck if an event type is missing from the union above, and
// the error names the missing type.
type MissingTaskEvent = Exclude<EventBody["type"], z.output<typeof taskEventUnion>["type"]>;
const everyTaskEvent: [MissingTaskEvent] extends [never] ? true : MissingTaskEvent = true;
void everyTaskEvent;

const taskEvent: z.ZodType<TaskEvent> = taskEventUnion;

// ---------------------------------------------------------------------------
// Project events
// ---------------------------------------------------------------------------

const projectStamp = { v: z.literal(1), projectId: ProjectId, at: z.number() };

const projectEvents = {
  "project.created": { name: z.string(), goal: z.string() },
  "project.parked": {},
  "project.activated": {},
} satisfies Record<ProjectEventBody["type"], z.ZodRawShape>;

function project<K extends keyof typeof projectEvents>(type: K) {
  return z.strictObject({ ...projectEvents[type], ...projectStamp, type: z.literal(type) });
}

const projectEventUnion = z.discriminatedUnion("type", [
  project("project.created"),
  project("project.parked"),
  project("project.activated"),
]);

type MissingProjectEvent = Exclude<
  ProjectEventBody["type"],
  z.output<typeof projectEventUnion>["type"]
>;
const everyProjectEvent: [MissingProjectEvent] extends [never] ? true : MissingProjectEvent = true;
void everyProjectEvent;

const projectEvent: z.ZodType<ProjectEvent> = projectEventUnion;

// ---------------------------------------------------------------------------
// Commands
// ---------------------------------------------------------------------------

const request = z.number().int().min(1);

const commands = {
  start_spec_session: { taskId: TaskId, request, note: z.string().nullable() },
  create_worktree: { taskId: TaskId, request, build: z.number().int().min(1) },
  start_develop_session: { taskId: TaskId, request, worktree, spec, brief },
  send_to_session: { session: SessionId, text: z.string() },
  stop_session: { session: SessionId },
  run_gate: { taskId: TaskId, request, gate: gateName, worktree, head: CommitSha },
  merge: { taskId: TaskId, request, worktree, head: CommitSha },
  remove_worktree: { worktree },
  revert: { taskId: TaskId, request, commit: CommitSha },
} satisfies Record<Command["type"], z.ZodRawShape>;

function command<K extends keyof typeof commands>(type: K) {
  return z.strictObject({ type: z.literal(type), ...commands[type] });
}

const commandUnion = z.discriminatedUnion("type", [
  command("start_spec_session"),
  command("create_worktree"),
  command("start_develop_session"),
  command("send_to_session"),
  command("stop_session"),
  command("run_gate"),
  command("merge"),
  command("remove_worktree"),
  command("revert"),
]);

// Fails to typecheck if a command type has no schema in the union.
type MissingCommand = Exclude<Command["type"], z.output<typeof commandUnion>["type"]>;
const everyCommand: [MissingCommand] extends [never] ? true : MissingCommand = true;
void everyCommand;

const commandSchema: z.ZodType<Command> = commandUnion;

// ---------------------------------------------------------------------------
// Reading
// ---------------------------------------------------------------------------

export type Parsed<T> = { ok: true; value: T } | { ok: false; reason: string };

export function parseTaskEvent(value: unknown): Parsed<TaskEvent> {
  return parse(taskEvent, value);
}

export function parseProjectEvent(value: unknown): Parsed<ProjectEvent> {
  return parse(projectEvent, value);
}

function parse<T>(schema: z.ZodType<T>, value: unknown): Parsed<T> {
  const result = schema.safeParse(value);
  if (result.success) return { ok: true, value: result.data };
  const reason = result.error.issues
    .map((issue) => `${issue.path.join(".") || "event"}: ${issue.message}`)
    .join("; ");
  return { ok: false, reason };
}

export function parseCommand(value: unknown): Parsed<Command> {
  return parse(commandSchema, value);
}
