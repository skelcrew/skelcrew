// The event store: every event, in the order it happened, in one SQLite file.
// The log is the only thing saved. Tasks and projects are rebuilt from it by
// replaying their events through evolveTask and evolveProject.
//
// Each event is checked twice: against its schema before it is written, so
// nothing malformed gets in, and again when read back, since anything could
// have happened to the file in between.

import { Database } from "bun:sqlite";
import { evolveTask } from "../core/evolve";
import { evolveProject } from "../core/projects";
import type { Project, ProjectEvent, ProjectId, Task, TaskEvent, TaskId } from "../core/types";
import { parseProjectEvent, parseTaskEvent } from "./schema";

export type Saved = { ok: true } | { ok: false; reason: string };

// A damaged log is reported with the position of the first event that
// couldn't be read or didn't fit, so it can be found and looked at.
export type Loaded<T> = ({ ok: true } & T) | { ok: false; seq: number; reason: string };

// Each change to the table layout is one step, run once, in order. The
// file's user_version says how many have run.
const migrations = [
  `CREATE TABLE events (
     seq    INTEGER PRIMARY KEY AUTOINCREMENT,
     stream TEXT NOT NULL CHECK (stream IN ('task', 'project')),
     body   TEXT NOT NULL
   );`,
];

type Row = { seq: number; body: string };

export class EventStore {
  private constructor(private readonly db: Database) {}

  // Opens the file, creating it and its table when it's new. ":memory:" gives
  // a store that lives only as long as the process, for tests.
  static open(path: string): EventStore {
    const db = new Database(path, { create: true, strict: true });
    // Wait for another connection's write instead of failing at once:
    // bun:sqlite's default wait is zero, which gave "database is locked".
    db.run("PRAGMA busy_timeout = 10000");
    db.run("PRAGMA journal_mode = WAL");
    const version = db.query<{ user_version: number }, []>("PRAGMA user_version").get();
    const done = version?.user_version ?? 0;
    for (const [i, step] of migrations.entries()) {
      if (i < done) continue;
      db.transaction(() => {
        db.run(step);
        db.run(`PRAGMA user_version = ${i + 1}`);
      })();
    }
    return new EventStore(db);
  }

  close(): void {
    this.db.close();
  }

  // Saves one decision's events together: all of them, or none if any fails
  // its schema.
  appendTask(events: TaskEvent[]): Saved {
    return this.append("task", events, parseTaskEvent);
  }

  appendProject(events: ProjectEvent[]): Saved {
    return this.append("project", events, parseProjectEvent);
  }

  loadTasks(): Loaded<{ tasks: Map<TaskId, Task> }> {
    const tasks = new Map<TaskId, Task>();
    for (const row of this.rows("task")) {
      const parsed = parseTaskEvent(readJson(row.body));
      if (!parsed.ok) return { ok: false, seq: row.seq, reason: parsed.reason };
      const { event } = parsed;
      const result = evolveTask(tasks.get(event.taskId) ?? null, event);
      if (!result.ok) return { ok: false, seq: row.seq, reason: result.reason };
      tasks.set(event.taskId, result.task);
    }
    return { ok: true, tasks };
  }

  loadProjects(): Loaded<{ projects: Map<ProjectId, Project> }> {
    const projects = new Map<ProjectId, Project>();
    for (const row of this.rows("project")) {
      const parsed = parseProjectEvent(readJson(row.body));
      if (!parsed.ok) return { ok: false, seq: row.seq, reason: parsed.reason };
      const { event } = parsed;
      const result = evolveProject(projects.get(event.projectId) ?? null, event);
      if (!result.ok) return { ok: false, seq: row.seq, reason: result.reason };
      projects.set(event.projectId, result.project);
    }
    return { ok: true, projects };
  }

  private append<T>(
    stream: "task" | "project",
    events: T[],
    parse: (value: unknown) => { ok: true } | { ok: false; reason: string },
  ): Saved {
    for (const event of events) {
      const parsed = parse(readJson(JSON.stringify(event)));
      if (!parsed.ok) return { ok: false, reason: parsed.reason };
    }
    const insert = this.db.query("INSERT INTO events (stream, body) VALUES ($stream, $body)");
    this.db.transaction(() => {
      for (const event of events) insert.run({ stream, body: JSON.stringify(event) });
    })();
    return { ok: true };
  }

  private rows(stream: "task" | "project"): Row[] {
    return this.db
      .query<Row, { stream: string }>(
        "SELECT seq, body FROM events WHERE stream = $stream ORDER BY seq",
      )
      .all({ stream });
  }
}

// A row that isn't JSON at all is read as a value no schema accepts, so it
// is reported like any other damaged event.
function readJson(text: string): unknown {
  try {
    return JSON.parse(text);
  } catch {
    return undefined;
  }
}
