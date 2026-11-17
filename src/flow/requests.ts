// The requests the daemon takes on its sockets, and who may make which. The daemon and the
// commands that ask it both go by these.
import { z } from "zod";
import { TaskId } from "./copy.ts";
import type { Thread } from "./thread.ts";

// Only what a branch name holds: it goes into what git fetches, where a : or * would ask
// for something else.
const Branch = z.string().regex(/^(?!-)(?!.*\.\.)[\w./-]+$/);

// A task's body, which is all a builder sees of the task besides its title, so one with only
// blanks is refused. A body that passes keeps its spaces as they were.
const TaskBody = z.string().regex(/\S/);

// A thread's short title for the sidebar, which says nothing when blank, so one is refused.
const ShortTitle = z.string().trim().min(1);

// A request's `repo` names a repository the way a command does: by its name in Skelcrew or its
// owner/name. It keeps that word because clients on other machines send it.
export const DaemonRequest = z.discriminatedUnion("command", [
  z.object({ command: z.literal("status") }),
  // `tab` comes from the screen's tabs, and from plain sc away from a checkout with a remote.
  // Neither may open a tab you closed.
  z.object({
    command: z.literal("lead"),
    from: z.string().optional(),
    tab: z.literal(true).optional(),
  }),
  z.object({ command: z.literal("repo ls") }),
  z.object({ command: z.literal("ps"), repo: z.string().optional() }),
  z.object({ command: z.literal("task ls"), repo: z.string().optional() }),
  z.object({
    command: z.literal("task show"),
    repo: z.string(),
    task: TaskId,
  }),
  // A PR is named by its number or by its thread's task. With a number, `from` is the remote
  // of the checkout sc ran in, which names the repository when `repo` doesn't.
  z.object({
    command: z.literal("pr show"),
    repo: z.string().optional(),
    from: z.string().optional(),
    pr: z.number().int().positive().optional(),
    task: TaskId.optional(),
  }),
  z.object({
    command: z.literal("task create"),
    repo: z.string(),
    title: z.string().min(1),
    body: TaskBody,
  }),
  z.object({
    command: z.literal("start"),
    repo: z.string(),
    task: TaskId,
    from: Branch.optional(),
    short: ShortTitle.optional(),
  }),
  z.object({
    command: z.literal("start new"),
    repo: z.string(),
    title: z.string().min(1),
    body: TaskBody,
    short: ShortTitle.optional(),
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
    command: z.literal("peek"),
    repo: z.string(),
    task: TaskId,
  }),
  z.object({
    command: z.literal("interrupt"),
    repo: z.string(),
    task: TaskId,
  }),
  z.object({
    command: z.literal("rm preview"),
    repo: z.string(),
    task: TaskId,
  }),
  z.object({
    command: z.literal("rm"),
    repo: z.string(),
    task: TaskId,
    reason: z.string().min(1).optional(),
  }),
  z.object({
    command: z.literal("tell"),
    repo: z.string(),
    task: TaskId,
    text: z.string().min(1),
  }),
  // `commit` is the PR's head you saw approved: the forge merges only while it is still the head.
  z.object({
    command: z.literal("merge"),
    repo: z.string(),
    pr: z.number().int().positive(),
    commit: z.string().regex(/^[0-9a-f]{40,64}$/),
  }),
  z.object({ command: z.literal("tell lead"), text: z.string().min(1) }),
  z.object({ command: z.literal("submit"), summary: z.string().min(1) }),
  z.object({ command: z.literal("question asked") }),
  z.object({ command: z.literal("question answered") }),
  z.object({ command: z.literal("question closed") }),
  // `said` is the first line of the builder's last message, for the lead's note, when the
  // harness gives it. `head` is the commit the builder's clone has checked out, sent only when
  // nothing in it is left uncommitted.
  z.object({
    command: z.literal("turn ended"),
    said: z.string().optional(),
    head: z.string().optional(),
  }),
  // `error` is the kind of error Claude Code's StopFailure hook gives, such as rate_limit, and
  // `message` what it said, such as when the limit resets.
  z.object({
    command: z.literal("turn failed"),
    error: z.string().optional(),
    message: z.string().optional(),
  }),
  z.object({ command: z.literal("turn interrupted") }),
]);
export type DaemonRequest = z.infer<typeof DaemonRequest>;

// Who is on the other end of a socket: you, a repository's lead, or a thread's builder. An
// agent may ask only for what its commands and its harness's hooks need. Trusting a repository
// is never a request: only you can, in your own terminal. A builder may tell only its
// repository's lead, never another thread, and may ask for a review of its own thread only. You
// and a lead may look at a builder's screen and stop its turn, but a builder may not, as it has
// only its own. You type to a builder yourself in the sidebar, so you have no tell. Merging is
// yours alone, from the screen: no agent may merge, as merging stays a human's choice.
export type Caller = "you" | { lead: { owner: string; repo: string } } | Thread;
// The requests each kind of caller may make. The daemon refuses any other before acting.
export const allowed = {
  you: [
    "status",
    "lead",
    "repo ls",
    "ps",
    "task ls",
    "task show",
    "pr show",
    "task create",
    "start",
    "start new",
    "review",
    "stop",
    "peek",
    "interrupt",
    "rm preview",
    "rm",
    "merge",
  ],
  lead: [
    "status",
    "repo ls",
    "ps",
    "task ls",
    "task show",
    "pr show",
    "task create",
    "start",
    "start new",
    "review",
    "stop",
    "peek",
    "interrupt",
    "rm preview",
    "rm",
    "tell",
    "question asked",
    "question answered",
    "question closed",
    "turn ended",
    "turn failed",
    "turn interrupted",
  ],
  builder: [
    "status",
    "submit",
    "review",
    "tell lead",
    "question asked",
    "question answered",
    "question closed",
    "turn ended",
    "turn failed",
    "turn interrupted",
  ],
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
