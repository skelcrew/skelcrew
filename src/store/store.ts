// The event store: every event, in the order it happened, in one SQLite file.
// The log is the only thing saved. Tasks and projects are rebuilt from it by
// replaying their events through evolveTask and evolveProject.
//
// Each event is checked twice: against its schema before it is written, so
// nothing malformed gets in, and again when read back, since anything could
// have happened to the file in between.

import { Database } from "bun:sqlite";
import { evolveTask } from "../core/evolve";
import { TaskId } from "../core/ids";
import { evolveProject } from "../core/projects";
import type { Command, Project, ProjectEvent, ProjectId, Task, TaskEvent } from "../core/types";
import { type AgentLog, type AgentRecord, agentRecord } from "../daemon/agents";
import { OpenPullRequest, type PullRequestLog } from "../daemon/pull-requests";
import type {
  Loaded,
  Queued,
  ReadableLog,
  Saved,
  SavedCommand,
  StartRef,
  Starts,
} from "../loop/loop";
import { parseCommand, parseProjectEvent, parseTaskEvent } from "./schema";

// Each change to the table layout is one step, run once, in order. The
// file's user_version says how many have run.
const migrations = [
  `CREATE TABLE events (
     seq    INTEGER PRIMARY KEY AUTOINCREMENT,
     stream TEXT NOT NULL CHECK (stream IN ('task', 'project')),
     body   TEXT NOT NULL
   );`,
  // Starts sent out and not yet answered. Kept apart from the events: a late
  // reply that is only cleaned up records no event, but still answers its
  // start.
  `CREATE TABLE starts (
     task_id INTEGER NOT NULL,
     request INTEGER NOT NULL,
     PRIMARY KEY (task_id, request)
   );`,
  // Commands saved with their decision and not yet carried out. If the
  // daemon dies before a command goes out, it goes out after the restart.
  `CREATE TABLE commands (
     id   INTEGER PRIMARY KEY AUTOINCREMENT,
     body TEXT NOT NULL
   );`,
  // The draft pull request each task has open for reading, if any. Not an
  // event: the core never hears of them.
  `CREATE TABLE pull_requests (
     task_id INTEGER PRIMARY KEY,
     body    TEXT NOT NULL
   );`,
  // The agents Skelcrew started itself, by session name. Not events: the
  // core only hears that an agent started or ended. The daemon needs them
  // to tell its agents from your sessions, and after a restart.
  `CREATE TABLE agents (
     session TEXT PRIMARY KEY,
     body    TEXT NOT NULL
   );`,
];

type Row = { seq: number; body: string };

export class EventStore implements ReadableLog, PullRequestLog, AgentLog {
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

  // Saves one decision's events, starts and commands together: all of them,
  // or none if any event or command fails its schema. Returns the id of each
  // command, in order, to mark it carried out later.
  appendTask(
    events: TaskEvent[],
    starts: Starts = { sent: [], answered: [] },
    commands: Command[] = [],
  ): Queued {
    for (const command of commands) {
      const parsed = parseCommand(readJson(JSON.stringify(command)));
      if (!parsed.ok) return { ok: false, reason: parsed.reason };
    }
    return this.append("task", events, parseTaskEvent, starts, commands);
  }

  // A command has been carried out, so a restart won't repeat it.
  carriedOut(id: number): Saved {
    this.db.query("DELETE FROM commands WHERE id = $id").run({ id });
    return { ok: true };
  }

  // The commands saved and not yet carried out, oldest first. A damaged one
  // is reported with its id, like a damaged event.
  loadCommands(): Loaded<{ commands: SavedCommand[] }> {
    const rows = this.db
      .query<{ id: number; body: string }, []>("SELECT id, body FROM commands ORDER BY id")
      .all();
    const commands: SavedCommand[] = [];
    for (const row of rows) {
      const parsed = parseCommand(readJson(row.body));
      if (!parsed.ok) return { ok: false, seq: row.id, reason: parsed.reason };
      commands.push({ id: row.id, command: parsed.value });
    }
    return { ok: true, commands };
  }

  // The pull requests opened for reading and not yet closed, by task. A
  // damaged one is reported with its task number.
  loadPullRequests(): Loaded<{ pullRequests: OpenPullRequest[] }> {
    const rows = this.db
      .query<{ task_id: number; body: string }, []>(
        "SELECT task_id, body FROM pull_requests ORDER BY task_id",
      )
      .all();
    const pullRequests: OpenPullRequest[] = [];
    for (const row of rows) {
      const parsed = OpenPullRequest.safeParse(readJson(row.body));
      if (!parsed.success) {
        return { ok: false, seq: row.task_id, reason: parsed.error.message };
      }
      pullRequests.push(parsed.data);
    }
    return { ok: true, pullRequests };
  }

  savePullRequest(pullRequest: OpenPullRequest): Saved {
    this.db
      .query("INSERT OR REPLACE INTO pull_requests (task_id, body) VALUES ($task, $body)")
      .run({ task: pullRequest.task, body: JSON.stringify(pullRequest) });
    return { ok: true };
  }

  forgetPullRequest(task: TaskId): Saved {
    this.db.query("DELETE FROM pull_requests WHERE task_id = $task").run({ task });
    return { ok: true };
  }

  // The agents Skelcrew started, in the order it started them. A damaged
  // one is reported by its place in that order.
  loadAgents(): Loaded<{ agents: AgentRecord[] }> {
    const rows = this.db
      .query<{ body: string }, []>("SELECT body FROM agents ORDER BY rowid")
      .all();
    const agents: AgentRecord[] = [];
    for (const [i, row] of rows.entries()) {
      const parsed = agentRecord.safeParse(readJson(row.body));
      if (!parsed.success) return { ok: false, seq: i + 1, reason: parsed.error.message };
      agents.push(parsed.data);
    }
    return { ok: true, agents };
  }

  saveAgent(agent: AgentRecord): Saved {
    this.db
      .query(
        "INSERT INTO agents (session, body) VALUES ($session, $body) ON CONFLICT (session) DO UPDATE SET body = $body",
      )
      .run({ session: agent.session, body: JSON.stringify(agent) });
    return { ok: true };
  }

  // The starts sent out and not yet answered, oldest first.
  loadStarts(): StartRef[] {
    return this.db
      .query<{ task_id: number; request: number }, []>(
        "SELECT task_id, request FROM starts ORDER BY rowid",
      )
      .all()
      .map((row) => ({ taskId: TaskId.parse(row.task_id), request: row.request }));
  }

  appendProject(events: ProjectEvent[]): Saved {
    const saved = this.append("project", events, parseProjectEvent);
    return saved.ok ? { ok: true } : saved;
  }

  loadTasks(): Loaded<{ tasks: Map<TaskId, Task> }> {
    const tasks = new Map<TaskId, Task>();
    for (const row of this.rows("task")) {
      const parsed = parseTaskEvent(readJson(row.body));
      if (!parsed.ok) return { ok: false, seq: row.seq, reason: parsed.reason };
      const event = parsed.value;
      const result = evolveTask(tasks.get(event.taskId) ?? null, event);
      if (!result.ok) return { ok: false, seq: row.seq, reason: result.reason };
      tasks.set(event.taskId, result.task);
    }
    return { ok: true, tasks };
  }

  // One task's events, oldest first, for `skelcrew log`. None for a task
  // that doesn't exist. A damaged event is reported with its position. A
  // row that isn't JSON can't say which task it belongs to, so it is left
  // out here. loadTasks reports it, so the daemon won't start on it.
  loadTaskEvents(taskId: TaskId): Loaded<{ events: TaskEvent[] }> {
    const rows = this.db
      .query<Row, { taskId: number }>(
        `SELECT seq, body FROM events
         WHERE stream = 'task' AND json_valid(body) AND json_extract(body, '$.taskId') = $taskId
         ORDER BY seq`,
      )
      .all({ taskId });
    const events: TaskEvent[] = [];
    for (const row of rows) {
      const parsed = parseTaskEvent(readJson(row.body));
      if (!parsed.ok) return { ok: false, seq: row.seq, reason: parsed.reason };
      events.push(parsed.value);
    }
    return { ok: true, events };
  }

  loadProjects(): Loaded<{ projects: Map<ProjectId, Project> }> {
    const projects = new Map<ProjectId, Project>();
    for (const row of this.rows("project")) {
      const parsed = parseProjectEvent(readJson(row.body));
      if (!parsed.ok) return { ok: false, seq: row.seq, reason: parsed.reason };
      const event = parsed.value;
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
    starts: Starts = { sent: [], answered: [] },
    commands: Command[] = [],
  ): Queued {
    for (const event of events) {
      const parsed = parse(readJson(JSON.stringify(event)));
      if (!parsed.ok) return { ok: false, reason: parsed.reason };
    }
    const insert = this.db.query("INSERT INTO events (stream, body) VALUES ($stream, $body)");
    const sent = this.db.query(
      "INSERT OR IGNORE INTO starts (task_id, request) VALUES ($taskId, $request)",
    );
    const answered = this.db.query(
      "DELETE FROM starts WHERE task_id = $taskId AND request = $request",
    );
    const queue = this.db.query<{ id: number }, { body: string }>(
      "INSERT INTO commands (body) VALUES ($body) RETURNING id",
    );
    const ids = this.db.transaction(() => {
      for (const event of events) insert.run({ stream, body: JSON.stringify(event) });
      for (const start of starts.answered) answered.run(start);
      for (const start of starts.sent) sent.run(start);
      return commands.map((command) => {
        const row = queue.get({ body: JSON.stringify(command) });
        if (row === null) throw new Error("SQLite returned no id for a saved command.");
        return row.id;
      });
    })();
    return { ok: true, ids };
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
