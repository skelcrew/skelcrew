// The requests the daemon takes on its sockets, and who may make which. The daemon and the
// commands that ask it both go by these.
import { z } from "zod";
import { FlowName } from "../flows.ts";
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
  // Neither may open a tab you closed. `asked` is the owner/repo whose .agents/ plain sc just
  // asked you about, so its lead may start whatever you answered.
  z.object({
    command: z.literal("lead"),
    from: z.string().optional(),
    tab: z.literal(true).optional(),
    asked: z.string().optional(),
  }),
  z.object({ command: z.literal("repo ls") }),
  // Whether a word names a repository Skelcrew has. It isn't `repo`, as a word that names none
  // is no request about another repository.
  z.object({ command: z.literal("repo named"), word: z.string() }),
  z.object({ command: z.literal("ps"), repo: z.string().optional() }),
  z.object({ command: z.literal("task ls"), repo: z.string().optional() }),
  // A task is named by its ID, or by its PR's number for sc pr show. With a number, `from` is
  // the remote of the checkout sc ran in, which names the repository when `repo` doesn't.
  z.object({
    command: z.literal("task show"),
    repo: z.string().optional(),
    from: z.string().optional(),
    task: TaskId.optional(),
    pr: z.number().int().positive().optional(),
  }),
  // `asked` is the human's words asking for the issue, exactly, which a lead must give.
  z.object({
    command: z.literal("task create"),
    repo: z.string(),
    title: z.string().min(1),
    body: TaskBody,
    asked: z.string().regex(/\S/).optional(),
  }),
  z.object({
    command: z.literal("task add"),
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
    flow: FlowName.optional(),
  }),
  z.object({
    command: z.literal("start new"),
    repo: z.string(),
    title: z.string().min(1),
    body: TaskBody,
    short: ShortTitle.optional(),
    flow: FlowName.optional(),
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
  // A merge when ready, or without Skelcrew's approval, names its thread by its task, or by its
  // PR's number. With a number, `from` is the remote of the checkout sc ran in, which names the
  // repository when `repo` doesn't. Arming one carries what you said y to, `seen`: the PR's number
  // and when its thread started, so a thread started over meanwhile, with another PR, is never
  // armed. Skipping the review it also carries the PR's head you saw, the only commit it merges. A
  // lead you let arm merges sends `asked` instead: your words in the conversation, exactly.
  z.object({
    command: z.enum(["merge preview", "merge when ready", "merge skip review", "merge cancel"]),
    repo: z.string().optional(),
    from: z.string().optional(),
    task: TaskId.optional(),
    pr: z.number().int().positive().optional(),
    seen: z
      .object({
        pr: z.number().int().positive(),
        started: z.number().nullable(),
        head: z.string().optional(),
      })
      .optional(),
    asked: z.string().optional(),
  }),
  // Marks a thread as needing you, with the action you must take, or with a null `reason`, clears
  // its mark.
  z.object({
    command: z.literal("needs you"),
    repo: z.string(),
    task: TaskId,
    reason: z.string().regex(/\S/).nullable(),
  }),
  z.object({ command: z.literal("tell lead"), text: z.string().min(1) }),
  // A lead's brief for another repository's lead. `to` names that repository. It isn't `repo`,
  // which every other request a lead makes must name as its own. `asked` is the human's words,
  // exactly, when they asked for the work the brief hands over.
  z.object({
    command: z.literal("brief lead"),
    to: z.string().min(1),
    text: z.string().min(1),
    asked: z.string().regex(/\S/).optional(),
  }),
  z.object({ command: z.literal("submit"), summary: z.string().min(1) }),
  // `from` is the remote of the checkout you ran sc check in, which names the repository whose
  // test command it runs. An agent's own socket names its repository instead.
  z.object({ command: z.literal("check"), from: z.string().optional() }),
  z.object({ command: z.literal("question asked") }),
  // `prompt` is what was typed into the agent, when its harness says.
  z.object({ command: z.literal("question answered"), prompt: z.string().optional() }),
  z.object({ command: z.literal("question closed") }),
  // `head` is the commit the builder's clone has checked out, sent only when nothing in it is
  // left uncommitted, and `message` the builder's last message, when the harness gives it.
  z.object({
    command: z.literal("turn ended"),
    head: z.string().optional(),
    message: z.string().optional(),
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

// Who is on the other end of a socket: you, a repository's lead, a thread's builder, or a thread's
// reviewer, which may only run sc check. An agent may ask only for what its commands and its
// harness's hooks need. Trusting a repository is never a request: only you can, in your own
// terminal. A builder may tell only its repository's lead, never another thread, and may ask for a
// review of its own thread only. You and a lead may look at a builder's screen and stop its turn,
// but a builder may not, as it has only its own. You type to a builder yourself in the sidebar, so
// you have no tell. Merging is yours alone: no agent may merge, as merging stays a human's choice.
// A lead may arm a merge, when ready or without Skelcrew's approval, only while your config lets it,
// which the daemon checks at each one, and only when you ask it to. The lead may cancel one, which
// is always safe. Builders and reviewers can't. Only you and the lead may mark a thread as
// needing you, or clear it: a builder brings what it needs to the lead. Only a lead may brief another repository's lead, as
// each lead plans its own repository's work.
export type Caller =
  | "you"
  | { lead: { owner: string; repo: string } }
  | Thread
  | { review: Thread };
// The requests each kind of caller may make. The daemon refuses any other before acting.
export const allowed = {
  you: [
    "status",
    "lead",
    "repo ls",
    "repo named",
    "ps",
    "task ls",
    "task show",
    "task create",
    "task add",
    "start",
    "start new",
    "review",
    "stop",
    "peek",
    "interrupt",
    "rm preview",
    "rm",
    "merge",
    "merge preview",
    "merge when ready",
    "merge skip review",
    "merge cancel",
    "needs you",
    "check",
  ],
  lead: [
    "status",
    "repo ls",
    "repo named",
    "ps",
    "task ls",
    "task show",
    "task create",
    "task add",
    "start",
    "start new",
    "review",
    "stop",
    "peek",
    "interrupt",
    "rm preview",
    "rm",
    "merge when ready",
    "merge skip review",
    "merge cancel",
    "needs you",
    "tell",
    "brief lead",
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
    "check",
    "review",
    "tell lead",
    "question asked",
    "question answered",
    "question closed",
    "turn ended",
    "turn failed",
    "turn interrupted",
  ],
  review: ["check"],
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
