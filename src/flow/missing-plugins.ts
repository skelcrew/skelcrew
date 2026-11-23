// A missing session host makes its live threads need the human without changing hosts.
import type { Database } from "bun:sqlite";
import { installedPlugins } from "../plugins/plugin.ts";
import { hostMissing, record, type Thread } from "./thread.ts";

export function markMissingPlugin(db: Database, thread: Thread): string | null {
  if (thread.status !== "working" && thread.status !== "waiting") return null;
  const host = thread.host;
  const missing =
    host !== null && host !== "tmux" && !installedPlugins(db).some((p) => p.name === host)
      ? hostMissing(host)
      : null;
  if (missing !== null && thread.needs_you_for !== missing)
    record(db, thread.folder, { needs_you_for: missing }, missing);
  else if (
    missing === null &&
    /^run sc install: its session host .+ is missing$/.test(thread.needs_you_for ?? "")
  )
    record(db, thread.folder, { needs_you_for: null }, "its missing plugins are installed again");
  return missing;
}
