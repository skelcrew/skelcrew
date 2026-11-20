// The lead's requests that wait for your yes, such as starting a task: kept in the database until
// you answer one with y or n on its row in the list, which shows them under the lead.
import type { Database } from "bun:sqlite";
import { z } from "zod";
import { type Repository, readJson } from "../db.ts";
import { filedTask } from "./backlog.ts";
import { openTasks } from "./copy.ts";
import { LeadAction } from "./requests.ts";
import { taskName, threadOn } from "./thread.ts";

// A request as the list shows it and the daemon answers it: its ID, what y does, and its line.
export type LeadRequest = { id: number; action: LeadAction; says: string };

// What the database keeps of a request. The action is JSON, so it is checked as it is read back.
const Saved = z.object({ id: z.number(), action: z.string(), says: z.string() });

// Returns the line a request shows in the list, as a question, such as `Start APP-12 Fix login?`.
// A task is named with its title, from Skelcrew's copy of the tracker, its backlog or its thread,
// so you see what you say yes to. One it can't find a title for shows by its name alone. A start
// from another branch than the default names it.
function requestLine(db: Database, repository: Repository, action: LeadAction): string {
  if (action.kind === "repo add") return `Add the repository ${action.repository}?`;
  if (action.kind === "start new") return `Start a new task: ${action.title}?`;
  const { owner, repo } = repository;
  const title =
    openTasks(db, owner, repo).find((issue) => issue.id === action.task)?.title ??
    filedTask(db, owner, repo, action.task)?.title ??
    threadOn(db, `${owner}/${repo}`, action.task)?.title ??
    "";
  const name = taskName(repository.name, action.task);
  const from = action.from ? ` from the branch ${action.from}` : "";
  return `Start ${name}${title ? ` ${title}` : ""}${from}?`;
}

// Saves a request of the repository's lead, which shows in the list at once, and returns its line.
export function saveRequest(
  db: Database,
  repository: Repository,
  action: LeadAction,
  made: number,
): string {
  const says = requestLine(db, repository, action);
  db.run("INSERT INTO lead_requests (owner, repo, action, says, made) VALUES (?, ?, ?, ?, ?)", [
    repository.owner,
    repository.repo,
    JSON.stringify(action),
    says,
    made,
  ]);
  return says;
}

// Returns the requests of a repository's lead that wait for your answer, newest first. One you
// answered is left out, as is one whose action can't be read, such as one an older release saved
// in another shape.
export function requestsOf(db: Database, owner: string, repo: string): LeadRequest[] {
  return db
    .query(
      "SELECT id, action, says FROM lead_requests WHERE owner = ? AND repo = ? AND answered IS NULL ORDER BY id DESC",
    )
    .all(owner, repo)
    .flatMap((row) => readBack(row));
}

// Returns a request read back from the database, or nothing when its action can't be read.
function readBack(row: unknown): LeadRequest[] {
  const saved = Saved.parse(row);
  const action = readJson("lead_requests.action", saved.action, LeadAction.nullable(), null);
  return action === null ? [] : [{ id: saved.id, action, says: saved.says }];
}

// Marks a request as answered at a moment in milliseconds, as you answer it, and returns it, or
// null when it was answered already, such as by another list a moment before. Marking it in one
// step means two answers never both act on it. It stays saved until requestAnswered, so a daemon
// that stops while a start is under way finds it again, as answeredRequests says.
export function answerRequest(
  db: Database,
  owner: string,
  repo: string,
  id: number,
  at: number,
): LeadRequest | null {
  const taken = db
    .query(
      "UPDATE lead_requests SET answered = ? WHERE owner = ? AND repo = ? AND id = ? AND answered IS NULL RETURNING id, action, says",
    )
    .get(at, owner, repo, id);
  return taken === null ? null : (readBack(taken)[0] ?? null);
}

// Deletes a request once what your answer does is done and the lead's note about it is saved.
export function requestAnswered(db: Database, id: number): void {
  db.run("DELETE FROM lead_requests WHERE id = ?", [id]);
}

// Returns the requests you said yes to whose start a stop of the daemon cut short, with their
// repository and when you said yes. A no and a yes to adding a repository finish in one step, so
// only a start is ever left here.
export function answeredRequests(
  db: Database,
): (LeadRequest & { owner: string; repo: string; answered: number })[] {
  return db
    .query(
      "SELECT id, owner, repo, action, says, answered FROM lead_requests WHERE answered IS NOT NULL",
    )
    .all()
    .flatMap((row) => {
      const { owner, repo, answered } = z
        .object({ owner: z.string(), repo: z.string(), answered: z.number() })
        .parse(row);
      return readBack(row).map((request) => ({ ...request, owner, repo, answered }));
    });
}

// Returns the name of the task a yes started, such as APP-12, when the start took effect before a
// stop of the daemon cut it short, or null when it didn't, so the start runs once and only once.
// An issue's start took effect when its thread is at work, started or changed since the yes. A new
// task's took effect when the repository has a thread with its title and description that
// started since.
export function startedBy(
  db: Database,
  repository: Repository,
  action: LeadAction,
  answered: number,
): string | null {
  const { owner, repo } = repository;
  if (action.kind === "start") {
    const thread = threadOn(db, `${owner}/${repo}`, action.task);
    const live = thread !== null && ["working", "waiting", "queued"].includes(thread.status);
    const since = Math.max(thread?.started ?? 0, thread?.changed ?? 0) >= answered;
    return live && since ? taskName(repository.name, action.task) : null;
  }
  if (action.kind === "repo add") return null;
  const found = db
    .query(`SELECT task FROM task_threads WHERE owner = ? AND repo = ? AND title = ? AND body = ?
      AND started >= ? ORDER BY started DESC LIMIT 1`)
    .get(owner, repo, action.title, action.body, answered);
  return found === null
    ? null
    : taskName(repository.name, z.object({ task: z.string() }).parse(found).task);
}
