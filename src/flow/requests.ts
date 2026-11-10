// The requests the daemon takes on its sockets, and who may make which. The daemon and the
// commands that ask it both go by these.
import { z } from "zod";
import { TaskId } from "./copy.ts";
import type { Thread } from "./thread.ts";

// Only what a branch name holds: it goes into what git fetches, where a : or * would ask
// for something else.
const Branch = z.string().regex(/^(?!-)(?!.*\.\.)[\w./-]+$/);

// A request's `repo` names a repository the way a command does: by its name in Skelcrew or its
// owner/name. It keeps that word because clients on other machines send it.
export const DaemonRequest = z.discriminatedUnion("command", [
  z.object({ command: z.literal("status") }),
  z.object({ command: z.literal("lead"), from: z.string().optional() }),
  z.object({ command: z.literal("repo ls") }),
  z.object({ command: z.literal("ps"), repo: z.string().optional() }),
  z.object({ command: z.literal("task ls"), repo: z.string().optional() }),
  z.object({
    command: z.literal("task show"),
    repo: z.string(),
    task: TaskId,
  }),
  z.object({
    command: z.literal("task create"),
    repo: z.string(),
    title: z.string().min(1),
    body: z.string(),
  }),
  z.object({
    command: z.literal("start"),
    repo: z.string(),
    task: TaskId,
    from: Branch.optional(),
  }),
  z.object({
    command: z.literal("start new"),
    repo: z.string(),
    title: z.string().min(1),
    body: z.string(),
  }),
  z.object({
    command: z.literal("review"),
    repo: z.string(),
    task: TaskId,
  }),
  z.object({
    command: z.literal("stop"),
    repo: z.string(),
    task: TaskId,
  }),
  z.object({
    command: z.literal("tell"),
    repo: z.string(),
    task: TaskId,
    text: z.string().min(1),
  }),
  z.object({ command: z.literal("tell lead"), text: z.string().min(1) }),
  z.object({ command: z.literal("submit"), summary: z.string().min(1) }),
  z.object({ command: z.literal("question asked") }),
  z.object({ command: z.literal("question answered") }),
  z.object({ command: z.literal("turn ended") }),
]);
export type DaemonRequest = z.infer<typeof DaemonRequest>;

// Who is on the other end of a socket: you, a repository's lead, or a thread's builder. An
// agent may ask only for what its commands need. Trusting a repository is never a request:
// only you can, in your own terminal. A builder may tell only its repository's lead, never
// another thread, and you type to a builder yourself in the sidebar, so you have no tell.
export type Caller = "you" | { lead: { owner: string; repo: string } } | Thread;
export const allowed = {
  you: [
    "status",
    "lead",
    "repo ls",
    "ps",
    "task ls",
    "task show",
    "task create",
    "start",
    "start new",
    "review",
    "stop",
  ],
  lead: [
    "status",
    "repo ls",
    "ps",
    "task ls",
    "task show",
    "task create",
    "start",
    "start new",
    "review",
    "stop",
    "tell",
  ],
  builder: ["status", "submit", "tell lead", "question asked", "question answered", "turn ended"],
};

// Returns a decoded socket message, or undefined so invalid JSON can be rejected without
// crashing.
export function parseJson(text: string): unknown {
  try {
    return JSON.parse(text);
  } catch {
    return undefined;
  }
}
