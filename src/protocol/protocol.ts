// The protocol between the CLI and the daemon: one JSON message per line,
// over the daemon's local socket. The CLI sends a request, and the daemon
// answers it with a reply carrying the same id.
//
// Everything read from the socket is checked here before the daemon acts
// on it. Objects are strict, so a field with a typo is refused rather than
// ignored.

import * as z from "zod";
import { SessionId, TaskId } from "../core/ids";
import { spec } from "../store/schema";

// Longer lines are refused, so a client that never ends its line can't
// make the daemon read without end.
export const MAX_LINE = 1_000_000;

// Your commands carry no identity: the protocol can't prove a call comes
// from you (see the spec's "Architecture"). An agent's reports carry the
// session its claim handed out, and only the task's current session is
// heard.
const command = z.discriminatedUnion("type", [
  // `skelcrew add "<task>"`, with `--spec` and `--project <name>`.
  z.strictObject({
    type: z.literal("add"),
    title: z.string().min(1),
    spec: z.boolean(),
    project: z.string().min(1).nullable(),
  }),
  z.strictObject({ type: z.literal("spec"), task: TaskId }),
  // A spec or a critical merge. `sendBack` returns it with a note instead.
  z.strictObject({
    type: z.literal("approve"),
    task: TaskId,
    sendBack: z.string().min(1).nullable(),
  }),
  // Sends back the spec or the critical merge that waits for you, with a
  // note that says what to change.
  z.strictObject({
    type: z.literal("reject"),
    task: TaskId,
    note: z.string().refine((note) => note.trim() !== "", { error: "Say what to change." }),
  }),
  z.strictObject({ type: z.literal("drop"), task: TaskId }),
  // Clears a block, so the task can be claimed again.
  z.strictObject({ type: z.literal("retry"), task: TaskId }),
  z.strictObject({ type: z.literal("status") }),
  z.strictObject({ type: z.literal("log"), task: TaskId }),
  z.strictObject({ type: z.literal("claim"), task: TaskId }),
  z.strictObject({ type: z.literal("submit"), task: TaskId, session: SessionId, spec }),
  z.strictObject({ type: z.literal("done"), task: TaskId, session: SessionId }),
  z.strictObject({
    type: z.literal("give_up"),
    task: TaskId,
    session: SessionId,
    message: z.string().min(1),
  }),
]);

const request = z.strictObject({ id: z.string().min(1), command });

// What each command answers with is decided by the daemon. It is checked
// here as JSON, and against each command's own shape where the CLI reads it.
const reply = z.union([
  z.strictObject({ id: z.string().min(1), ok: z.literal(true), result: z.json() }),
  z.strictObject({ id: z.string().min(1), ok: z.literal(false), message: z.string() }),
]);

export type Command = z.infer<typeof command>;
export type Request = z.infer<typeof request>;
export type Reply = z.infer<typeof reply>;

export type Parsed<T> = { ok: true; value: T } | { ok: false; message: string };

export function parseRequest(line: string): Parsed<Request> {
  return parseLine(line, request, "request");
}

export function parseReply(line: string): Parsed<Reply> {
  return parseLine(line, reply, "reply");
}

// One message as one line, ending in a newline. JSON never contains a raw
// newline, so a line is always one whole message.
export function encode(message: Request | Reply): string {
  return `${JSON.stringify(message)}\n`;
}

function parseLine<T>(line: string, schema: z.ZodType<T>, what: string): Parsed<T> {
  if (Buffer.byteLength(line) > MAX_LINE) {
    return { ok: false, message: `The ${what} is longer than ${MAX_LINE} bytes.` };
  }
  let data: unknown;
  try {
    data = JSON.parse(line);
  } catch {
    return { ok: false, message: `The ${what} isn't valid JSON.` };
  }
  const result = schema.safeParse(data);
  if (result.success) return { ok: true, value: result.data };
  const reasons = result.error.issues.map(
    (issue) => `${issue.path.join(".") || what}: ${issue.message}`,
  );
  return { ok: false, message: `The ${what} doesn't fit the protocol. ${reasons.join("; ")}` };
}
