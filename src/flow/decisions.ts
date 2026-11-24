// A task's decisions and what its change must keep true: the lead records them on the task, and
// every reviewer of the task gets them, so a fresh reviewer never reopens what is settled.
import type { Database } from "bun:sqlite";
import { yourName } from "../config.ts";
import { findThread, record, type Thread, threadName } from "./thread.ts";

function threadToBound(db: Database, repository: string, task: string): Thread {
  const thread = findThread(db, repository, task);
  if (thread.status === "done") throw new Error(`${threadName(db, thread)} is done already`);
  return thread;
}

export function decide(
  db: Database,
  repository: string,
  task: string,
  text: string,
  asked: string | undefined,
): string {
  const thread = threadToBound(db, repository, task);
  const decision = {
    by: asked === undefined ? ("lead" as const) : ("human" as const),
    at: Date.now(),
    text: text.trim(),
    ...(asked === undefined ? {} : { words: asked }),
  };
  const name = threadName(db, thread);
  const who = asked === undefined ? "the lead" : (yourName() ?? "you");
  record(
    db,
    thread.folder,
    { decisions: [...thread.decisions, decision] },
    `${who} decided: ${decision.text}`,
  );
  return `Recorded the decision on ${name}. Every review of it from now on gets it.`;
}

export function keepTrue(db: Database, repository: string, task: string, items: string[]): string {
  const thread = threadToBound(db, repository, task);
  const kept = items.map((item) => item.trim());
  const name = threadName(db, thread);
  record(db, thread.folder, { stay_true: kept }, `must stay true: ${kept.join("; ")}`);
  return `Set what ${name} must keep true. Every review of it from now on checks each one.`;
}
