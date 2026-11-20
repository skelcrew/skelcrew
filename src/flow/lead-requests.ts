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
// are answering is left out, as is one whose action can't be read, such as one an older release
// saved in another shape.
export function requestsOf(db: Database, owner: string, repo: string): LeadRequest[] {
  return db
    .query(
      "SELECT id, action, says FROM lead_requests WHERE owner = ? AND repo = ? AND answering = 0 ORDER BY id DESC",
    )
    .all(owner, repo)
    .flatMap((row) => {
      const saved = Saved.parse(row);
      const action = readJson("lead_requests.action", saved.action, LeadAction.nullable(), null);
      return action === null ? [] : [{ id: saved.id, action, says: saved.says }];
    });
}

// Marks a request as being answered, as you answer it, and returns it, or null when it was answered
// already, such as by another list a moment before. Marking it in one step means two answers never
// both act on it. It stays saved until requestAnswered, so a daemon that stops while a start is
// under way loses neither the request nor your answer.
export function answerRequest(
  db: Database,
  owner: string,
  repo: string,
  id: number,
): LeadRequest | null {
  const taken = db
    .query(
      "UPDATE lead_requests SET answering = 1 WHERE owner = ? AND repo = ? AND id = ? AND answering = 0 RETURNING id, action, says",
    )
    .get(owner, repo, id);
  if (taken === null) return null;
  const saved = Saved.parse(taken);
  const action = readJson("lead_requests.action", saved.action, LeadAction.nullable(), null);
  return action === null ? null : { id: saved.id, action, says: saved.says };
}

// Deletes a request once what your answer does is done and the lead's note about it is saved.
export function requestAnswered(db: Database, id: number): void {
  db.run("DELETE FROM lead_requests WHERE id = ?", [id]);
}

// Puts every request whose answer a daemon's stop cut short back among those that wait, as the
// daemon starts, so you see it again and can answer it again. Its lead never heard that answer.
export function answerAgain(db: Database): void {
  db.run("UPDATE lead_requests SET answering = 0 WHERE answering = 1");
}
