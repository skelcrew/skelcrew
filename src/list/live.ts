// The live view in the list's details pane: the screen of the agent on the row you are on, read
// without attaching, as sc peek reads it, so it works on tmux and on a runtime plugin's host.
import type { Database } from "bun:sqlite";
import { type HarnessName, harnessNamed } from "../agents/harness.ts";
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

// Returns the agent's output from its screen: the screen without its harness's own input area and
// status lines at the bottom. Nobody can type there from the live view, so it would read like a
// broken input. A screen whose input area isn't found, or one of an unknown harness, is given
// back whole, so an update to a harness never hides the agent's output.
export function agentOutput(harness: HarnessName | null, screen: string): string {
  if (harness === null) return screen;
  const lines = screen.split("\n");
  const start = harnessNamed(harness).inputStart(lines);
  return start === null ? screen : lines.slice(0, start).join("\n");
}

// Returns what the live view shows of the builder on a task's row now: its screen, colours kept,
// or the line saying why there is none, such as a builder whose session ended a moment ago, or
// one on a host no longer installed. The screen goes without its harness's input area. `agents`
// is the sessions' tmux server. Reading never attaches, so the agent's session keeps its size,
// and nothing typed in the list reaches it.
export async function readLive(db: Database, agents: string, row: Row): Promise<Live> {
  const note = liveNote(row);
  if (note !== null || row.session === null) return { note: note ?? "" };
  try {
    const thread = readThread(db, row.session);
    const { host, id } = await builderSession(db, agents, thread);
    return { screen: agentOutput(thread.harness, await readSession(host, id, true)) };
  } catch {
    return { note: "Builder not running" };
  }
}
