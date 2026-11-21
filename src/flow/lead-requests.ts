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

// Returns the requests you said yes to that a stop of the daemon cut short, in the order you
// answered them, with their repository, when you answered, in milliseconds, and what the yes's
// start said, when it changed the task already, or null. A no is never left here, as it goes in
// one step.
export function answeredRequests(db: Database): (LeadRequest & {
  owner: string;
  repo: string;
  answered: number;
  outcome: string | null;
})[] {
  return db
    .query(
      "SELECT id, owner, repo, action, says, answered, outcome FROM lead_requests WHERE answered IS NOT NULL ORDER BY answered, id",
    )
    .all()
    .flatMap((row) => {
      const { owner, repo, answered, outcome } = z
        .object({
          owner: z.string(),
          repo: z.string(),
          answered: z.number(),
          outcome: z.string().nullable(),
        })
        .parse(row);
      return readBack(row).map((request) => ({ ...request, owner, repo, answered, outcome }));
    });
}

// Keeps what your yes to a request's start said, such as `Started APP-12.`, in the step that
// changes the task, so a stop of the daemon before the lead hears never has the yes done again.
export function requestStarted(db: Database, id: number, outcome: string): void {
  db.run("UPDATE lead_requests SET outcome = ? WHERE id = ?", [outcome, id]);
}

// Saves on a request you said yes to the start of the task its yes filed, in place of the new
// task it asked for, so doing the yes again starts that task rather than filing a second one.
export function nameFiledTask(db: Database, id: number, action: LeadAction): void {
  db.run("UPDATE lead_requests SET action = ? WHERE id = ?", [JSON.stringify(action), id]);
}

// Takes a request that waits for your answer away as you say no, and has `tell` tell its lead, in
// one step, so a stop of the daemon never leaves a no half done. Returns the request's line, or
// null when it was answered already.
export function refuseRequest(
  db: Database,
  owner: string,
  repo: string,
  id: number,
  tell: (says: string) => void,
): string | null {
  return db.transaction(() => {
    const taken = db
      .query(
        "DELETE FROM lead_requests WHERE owner = ? AND repo = ? AND id = ? AND answered IS NULL RETURNING says",
      )
      .get(owner, repo, id);
    if (taken === null) return null;
    const { says } = z.object({ says: z.string() }).parse(taken);
    tell(says);
    return says;
  })();
}
