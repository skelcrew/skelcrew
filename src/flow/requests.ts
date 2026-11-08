// The requests the daemon takes on its sockets, and who may make which. The daemon and the
// commands that ask it both go by these.
import { z } from "zod";
import { PageUrl } from "./page.ts";
import type { Thread } from "./thread.ts";

// Only what a branch name holds: it goes into what git fetches, where a : or * would ask
// for something else.
const Branch = z.string().regex(/^(?!-)(?!.*\.\.)[\w./-]+$/);

// A request's `repo` names a repository the way a command does: by its name in skel or its
// full GitHub name. It keeps that word because clients on other machines send it.
export const DaemonRequest = z.discriminatedUnion("command", [
  z.object({ command: z.literal("status") }),
  z.object({ command: z.literal("lead"), from: z.string().optional() }),
  z.object({ command: z.literal("repo ls") }),
  z.object({ command: z.literal("ps"), repo: z.string().optional() }),
  z.object({ command: z.literal("task ls"), repo: z.string().optional() }),
  z.object({
    command: z.literal("task show"),
    repo: z.string(),
    task: z.number().int().positive(),
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
    task: z.number().int().positive(),
    from: Branch.optional(),
  }),
  z.object({
    command: z.literal("review"),
    repo: z.string(),
    task: z.number().int().positive(),
  }),
  z.object({
    command: z.literal("stop"),
    repo: z.string(),
    task: z.number().int().positive(),
  }),
  z.object({ command: z.literal("submit"), summary: z.string().min(1) }),
  z.object({ command: z.literal("question asked") }),
  z.object({ command: z.literal("question answered") }),
  z.object({ command: z.literal("attached") }),
  z.object({ command: z.literal("screen opened") }),
  z.object({ command: z.literal("page"), url: PageUrl }),
  z.object({ command: z.literal("reply"), to: z.string().min(1), text: z.string().min(1) }),
]);
export type DaemonRequest = z.infer<typeof DaemonRequest>;

// Who is on the other end of a socket: you, the lead, or a thread's builder. An agent may ask
// only for what its commands need. Trusting a repository is never a request: only you can,
// in your own terminal.
export type Caller = "you" | "lead" | Thread;
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
    "review",
    "stop",
    "screen opened",
    "page",
    "reply",
  ],
  lead: [
    "status",
    "repo ls",
    "ps",
    "task ls",
    "task show",
    "task create",
    "start",
    "review",
    "stop",
    "attached",
    "reply",
  ],
  builder: ["status", "submit", "question asked", "question answered"],
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
