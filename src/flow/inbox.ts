// The inbox: what the lead asks you, as items in Needs you. The lead posts one per thread, or one
// for its repository, and your answer goes back to it as a note, with the words it may act on.
import type { Database } from "bun:sqlite";
import { mkdirSync, writeFileSync } from "node:fs";
import { join } from "node:path";
import { z } from "zod";
import { backlogOf } from "./backlog.ts";
import { openTasks } from "./copy.ts";
import { leadOf } from "./lead.ts";
import { noteForLead, typeLeadNotes } from "./messages.ts";
import { noticeItem } from "./notify.ts";
import { type Act, handedKey, ownItem, pickingWords } from "./own-items.ts";
import { findRepository } from "./repo.ts";
import { letters } from "./requests.ts";
import { reportStatus } from "./status.ts";
import {
  findThread,
  log,
  readThread,
  record,
  type Thread,
  taskName,
  threadName,
  threadOn,
} from "./thread.ts";

// The options of a yes or no item, and of one saved before every item had options.
export const yesNo = ["yes", "no"];

// Returns an item's short title from its text when the lead gave none: its first few words, cut
// at a word boundary.
export function titleOf(text: string): string {
  const words = text.split(" ").filter(Boolean);
  let title = "";
  for (const word of words.slice(0, 5)) {
    if (title !== "" && title.length + word.length >= 30) break;
    title = title === "" ? word : `${title} ${word}`;
  }
  return title.length < text.length ? `${title}…` : title;
}

// An item as the database keeps it. `task` is empty for an item about the repository.
export const Item = z
  .object({
    owner: z.string(),
    repo: z.string(),
    task: z.string(),
    title: z.string().default(""),
    text: z.string(),
    options: z.string().transform((saved) => z.array(z.string()).parse(JSON.parse(saved))),
    posted: z.number(),
  })
  .transform((item) => ({
    ...item,
    title: item.title || titleOf(item.text),
    options: item.options.length > 0 ? item.options : yesNo,
  }));
export type Item = z.infer<typeof Item>;

// Returns the item open for a task, or for the repository with an empty task, or null.
export function itemOf(db: Database, owner: string, repo: string, task: string): Item | null {
  const row = db
    .query("SELECT * FROM asks WHERE owner = ? AND repo = ? AND task = ?")
    .get(owner, repo, task);
  return Item.nullable().parse(row);
}

// Returns the repository's open items, the newest first.
export const itemsOf = (db: Database, owner: string, repo: string): Item[] =>
  z
    .array(Item)
    .parse(
      db
        .query("SELECT * FROM asks WHERE owner = ? AND repo = ? ORDER BY posted DESC")
        .all(owner, repo),
    );

// Returns whether the thread's task has an item open.
export const itemOpen = (db: Database, thread: Thread) =>
  itemOf(db, thread.owner, thread.repo, thread.task) !== null;

// Returns text as one line with no control codes, as an item's text and options show in the list.
const oneLine = (text: string) => text.replace(/[\s\p{Cc}]+/gu, " ").trim();

// Returns what an item is about, such as APP-12, or the repository's name.
function aboutOf(db: Database, owner: string, repo: string, task: string): string {
  const { name } = findRepository(db, `${owner}/${repo}`);
  return task === "" ? name : taskName(name, task);
}

// Posts the lead's item for a task, or with `task` null for the repository, replacing the one open
// there, with its short title, or one from its text's first words. It must have at least two
// options, so you can always answer it by a pick. The task must show in the list, with a thread that isn't done, an open issue or a place
// in the backlog, so its item can be seen and answered. A task whose thread is done shows by its
// open issue, so the lead can ask whether to start it again. A note that the thread needs you,
// still waiting for the lead, goes, as the lead is asking you about it now.
// Every item passes through here, so each one queues a needs-you message to you here.
export function postItem(
  db: Database,
  repository: string,
  task: string | null,
  item: { title?: string | undefined; text: string; options: string[] },
): string {
  const { owner, repo } = findRepository(db, repository);
  const said = oneLine(item.text);
  if (said === "") throw new Error("say in plain words what the human must decide");
  const picks = item.options.map(oneLine);
  if (picks.length < 2)
    throw new Error(
      "give the human at least two options to pick from with --option, or ask a yes/no question with --yes-no",
    );
  if (picks.some((pick) => pick === "")) throw new Error("an --option can't be empty");
  if (picks.length > letters.length)
    throw new Error(`an item has at most ${letters.length} options`);
  const thread = task === null ? null : threadOn(db, repository, task);
  const waiting =
    task !== null &&
    (openTasks(db, owner, repo).some(
      (issue) => `#${issue.id}` === task || issue.id === thread?.issue,
    ) ||
      backlogOf(db, owner, repo).some((filed) => filed.task === task));
  const live = thread !== null && thread.status !== "done";
  if (task !== null && !live && !waiting)
    throw new Error(
      thread === null
        ? `there is no task ${aboutOf(db, owner, repo, task)}`
        : `${aboutOf(db, owner, repo, task)} is done already`,
    );
  db.run(
    "INSERT OR REPLACE INTO asks (owner, repo, task, title, text, options, posted) VALUES (?, ?, ?, ?, ?, ?, ?)",
    [owner, repo, task ?? "", oneLine(item.title ?? ""), said, JSON.stringify(picks), Date.now()],
  );
  if (thread !== null && live)
    record(db, thread.folder, { noting: null }, `the lead asked you: ${said}`);
  const about = aboutOf(db, owner, repo, task ?? "");
  noticeItem(db, about, said, live ? thread : null);
  return about;
}

// Your answer to an item: one of its options by letter, or words of your own.
export type Answer = { pick: (typeof letters)[number] } | { reply: string };

// Answers the item open for a task, or with `task` null for the repository, and tells the lead.
// `seen` is the item's title, text and options as you saw them, as the lead may have replaced the
// item since, even with the same text and other options, or another title.
// The item's text and your answer, and nothing else, go in a file of their own in the lead's
// folder, which the lead gives as --asked-file for what it runs on it, so a pick lets it do only
// what you picked. Each answer keeps its own file, so a later one never changes what an earlier
// note points to.
// Returns what the footer says.
export function answerItem(
  db: Database,
  sessions: string,
  repository: string,
  task: string | null,
  seen: { title: string; text: string; options: string[] },
  answer: Answer,
): string {
  const { owner, repo } = findRepository(db, repository);
  const item = itemOf(db, owner, repo, task ?? "");
  const about = aboutOf(db, owner, repo, task ?? "");
  if (item === null) throw new Error(`nothing asks you about ${about} any more`);
  if (
    item.title !== seen.title ||
    item.text !== seen.text ||
    !Bun.deepEquals(item.options, seen.options)
  )
    throw new Error(`the lead changed its item on ${about} as you answered, so read it again`);
  let words: string;
  if ("pick" in answer) {
    const option = item.options[letters.indexOf(answer.pick)];
    if (option === undefined) throw new Error(`${about}'s item has no option ${answer.pick}`);
    words = `You picked ${answer.pick} (${option}) on ${about}: ${item.text}`;
  } else {
    const reply = answer.reply.trim();
    if (reply === "") throw new Error("type a reply first");
    words = `You replied on ${about}: ${reply}\n\nThe item was: ${item.text}`;
  }
  const folder = join(leadOf(db, owner, repo).folder, "answers");
  mkdirSync(folder, { recursive: true });
  const file = join(folder, `${about.toLowerCase()}-${Date.now()}-${crypto.randomUUID()}.txt`);
  writeFileSync(file, `${words}\n`);
  const note = `${words}\n\nThese words are the human's: give --asked-file ${file} to what you run on this answer.`;
  // The item goes only with its note saved, so an answer that fails on the way keeps the item to
  // answer again.
  db.transaction(() => {
    noteForLead(db, sessions, { owner, repo }, note, null, true);
    db.run("DELETE FROM asks WHERE owner = ? AND repo = ? AND task = ?", [owner, repo, item.task]);
  })();
  typeLeadNotes(db, sessions);
  const thread = task === null ? null : threadOn(db, repository, task);
  if (thread !== null) {
    log(db, thread, words.split("\n")[0]);
    reportStatus(db, readThread(db, thread.folder));
  }
  return `Told the lead your answer on ${about}.`;
}

const deciding: Act[] = ["go on", "skip review", "stop", "merge"];

export async function pickOwnItem(
  db: Database,
  sessions: string,
  repository: string,
  task: string,
  seen: { title: string; text: string },
  pick: (typeof letters)[number],
  run: (act: Act, thread: Thread) => Promise<string>,
): Promise<string> {
  const thread = findThread(db, repository, task);
  const name = threadName(db, thread);
  const item = ownItem(thread, itemOpen(db, thread));
  if (item === null) throw new Error(`nothing asks you about ${name} any more`);
  if (item.title !== seen.title || item.text !== seen.text)
    throw new Error(`what ${name} needs you for changed as you answered, so read it again`);
  const option = item.options[letters.indexOf(pick)];
  if (option === undefined) throw new Error(`${name}'s item has no option ${pick}`);
  const handing = option.act === "lead";
  const words = `You picked ${pick} (${option.label}) on ${name}: ${item.title}`;
  const told = `${words}\n\n${item.text}`;
  const decides = deciding.includes(option.act);
  const decision = {
    by: "human" as const,
    at: Date.now(),
    text: `${option.label}, as the human picked on "${item.title}"`,
    words: told,
  };
  const recorded = decides
    ? "\n\nSkelcrew recorded this pick as the human's decision on the task."
    : "";
  const picking = pickingWords[option.act] ?? null;
  db.transaction(() => {
    noteForLead(db, sessions, thread, `${told}${recorded}`, null, true);
    const change = {
      picking,
      pick_failed: null,
      ...(handing ? { handed: handedKey(item) } : {}),
      ...(decides ? { decisions: [...thread.decisions, decision] } : {}),
    };
    record(db, thread.folder, change, words);
  })();
  let said: string;
  try {
    said = handing ? `Handed ${name} to the lead.` : await run(option.act, thread);
  } catch (error) {
    const why = error instanceof Error ? error.message : String(error);
    db.transaction(() => {
      noteForLead(
        db,
        sessions,
        thread,
        `The human's pick on ${name} didn't run: ${why}`,
        null,
        true,
      );
      const { decisions } = readThread(db, thread.folder);
      const kept = decisions.filter(({ at, words }) => at !== decision.at || words !== told);
      const change = { picking: null, pick_failed: why, ...(decides ? { decisions: kept } : {}) };
      record(db, thread.folder, change, `the pick didn't run: ${words}`);
    })();
    typeLeadNotes(db, sessions);
    throw error;
  }
  if (picking !== null) record(db, thread.folder, { picking: null });
  typeLeadNotes(db, sessions);
  return said;
}

// Takes the lead's item for a task, or with `task` null for the repository, off the inbox, such as
// once you answered it in the lead's chat. Returns what it was about.
export function clearItem(db: Database, repository: string, task: string | null): string {
  const { owner, repo } = findRepository(db, repository);
  const about = aboutOf(db, owner, repo, task ?? "");
  if (itemOf(db, owner, repo, task ?? "") === null) throw new Error(`no item asks about ${about}`);
  db.run("DELETE FROM asks WHERE owner = ? AND repo = ? AND task = ?", [owner, repo, task ?? ""]);
  const thread = task === null ? null : threadOn(db, repository, task);
  if (thread !== null) {
    log(db, thread, "the lead took its item off");
    reportStatus(db, readThread(db, thread.folder));
  }
  return about;
}

// Drops the item of a thread that ended, as nothing is left to decide on it.
export const dropItem = (db: Database, thread: Thread) =>
  db.run("DELETE FROM asks WHERE owner = ? AND repo = ? AND task = ?", [
    thread.owner,
    thread.repo,
    thread.task,
  ]);
