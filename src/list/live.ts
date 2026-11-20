// The live view in the list's details pane: the screen of the agent on the row you are on, read
// without attaching, as sc peek reads it, so it works on tmux and on a runtime plugin's host.
import type { Database } from "bun:sqlite";
import { readSession } from "../agents/sessions.ts";
import { builderSession, readThread } from "../flow/thread.ts";
import type { Live } from "./pane.ts";
import type { Row } from "./rows.ts";

// Returns the line the live view shows on a task's row with no agent running, such as an issue
// not started or a builder that stopped, or null when its builder runs and its screen can be
// read. It reads nothing, so the pane says it at once.
export function liveNote(row: Row): string | null {
  if (row.part === "backlog") return "No builder yet";
  if (row.session === null || !row.running) return "Builder not running";
  return null;
}

// Returns what the live view shows of the builder on a task's row now: its screen, colours kept,
// or the line saying why there is none, such as a builder whose session ended a moment ago, or
// one on a host no longer installed. `agents` is the sessions' tmux server. Reading never
// attaches, so the agent's session keeps its size, and nothing typed in the list reaches it.
export async function readLive(db: Database, agents: string, row: Row): Promise<Live> {
  const note = liveNote(row);
  if (note !== null || row.session === null) return { note: note ?? "" };
  try {
    const { host, id } = await builderSession(db, agents, readThread(db, row.session));
    return { screen: await readSession(host, id, true) };
  } catch {
    return { note: "Builder not running" };
  }
}
