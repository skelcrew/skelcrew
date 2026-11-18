// The rows of the list: what `sc` shows of one repository, read from Skelcrew's database and its
// copy of the tracker, never the tracker itself, as the list reads them again each second. Its
// lead, then its tasks by stage: Issues, Working and Ready for review. Also a tab for each
// repository, with how many of its threads need you.
import type { Database } from "bun:sqlite";
import { z } from "zod";
import { threadConfig } from "../config.ts";
import { openTasks, prOf, type Task } from "../flow/copy.ts";
import { reviewCheck } from "../flow/decide.ts";
import { leadOf } from "../flow/lead.ts";
import { type Badge, badgeOf, type Colour, needsDecision, shownOf } from "../flow/marks.ts";
import { findRepository } from "../flow/repo.ts";
import type { DaemonRequest } from "../flow/requests.ts";
import { lastApproved } from "../flow/round.ts";
import { taskStage } from "../flow/stage.ts";
import { Thread } from "../flow/thread.ts";
import { forgeOf } from "../plugins/ask.ts";
import { removeControlCodes } from "../screen/look.ts";

// What y does on a row once its question is answered: the question the bottom line asks, what it
// says while the daemon works, and the request the daemon gets.
export type Question = { ask: string; working: string; request: DaemonRequest };
// What m does on a task ready for review: asks, or says why it can't, such as for a PR whose
// forge plugin is too old to merge.
type Action = Question | { refused: string };

// One row of the list. `part` is where it is: the lead, or the stage of its task. Its mark is a
// sign and the colour that says what kind of state it is in, and `says` is the end of the row, in
// `colour`. `session` is the agent's session, which Enter attaches to, and `running` whether
// its agent runs. `start` is what Enter does on an issue, and `merge` what m does on a task
// ready for review. `link` is its PR's, which Enter opens, and `branch` the branch a task that is
// ready without a forge waits on. Each is null where it doesn't apply.
export type Row = {
  part: "lead" | "issue" | "working" | "ready";
  name: string;
  title: string;
  mark: { sign: string; colour: Colour };
  says: string;
  colour: Colour;
  session: string | null;
  running: boolean;
  start: Question | null;
  merge: Action | null;
  link: string | null;
  branch: string | null;
};

// The repository the list shows, by its owner/name.
export type Open = { owner: string; repo: string };

// A repository's tab: its name in Skelcrew, its owner/name, and its badge.
export type Tab = Badge & { name: string; fullName: string };

// Returns a thread's round limit, from its repository's skelcrew.yaml or your config. Settings
// that aren't valid already stop rounds, with the reason, and mustn't also take the list away.
// Such a thread then reads as never past the limit.
function roundLimit(thread: Thread): number {
  try {
    return threadConfig(thread).maxRounds;
  } catch {
    return Number.POSITIVE_INFINITY;
  }
}

// Returns how long ago a moment was, in the fewest letters: <1m, then 5m, 2h, 3d. Rounded down,
// so the text changes at most once a minute, and the list writes nothing in between.
function threadAge(started: number, now: number): string {
  const minutes = Math.floor((now - started) / 60_000);
  if (minutes < 1) return "<1m";
  if (minutes < 60) return `${minutes}m`;
  return minutes < 24 * 60 ? `${Math.floor(minutes / 60)}h` : `${Math.floor(minutes / 1440)}d`;
}

// What the list reads of a thread beyond what its log keeps: when its builder's current stretch
// of work began. Null before the builder first started.
const Working = z.object({ working_since: z.number().nullable() });

// What the list reads of a lead beyond leadOf: what its hooks last said it does.
const LeadState = z.object({ lead_state: z.string().nullable() });

// Returns the lead's row. It says whether the lead runs, and when it does, what its hooks last
// said it is doing, with its harness.
function leadRow(db: Database, open: Open, running: string[]): Row {
  const lead = leadOf(db, open.owner, open.repo);
  const runs = running.includes(lead.name);
  const state = LeadState.parse(
    db
      .query("SELECT lead_state FROM repositories WHERE owner = ? AND repo = ?")
      .get(open.owner, open.repo),
  ).lead_state;
  // The hooks say asking while a question waits on you, and nothing before the first one ran.
  const word = !runs ? "stopped" : state === "asking" ? "asks you" : (state ?? "running");
  return {
    part: "lead",
    name: "lead",
    title: "",
    mark: { sign: "◆", colour: "bright" },
    says: [word, lead.harness ?? ""].filter(Boolean).join(" · "),
    colour: state === "asking" ? "yellow" : "dim",
    session: lead.name,
    running: runs,
    start: null,
    merge: null,
    link: null,
    branch: null,
  };
}

// What a PR's CI says at the end of a row, from the word Skelcrew saved as it last polled it.
const ciWords = { passing: "CI passed", failing: "CI failed", pending: "CI running" } as const;

// Returns the row of a task with a thread, from the thread's saved row, given the repository's
// open issues, which say whether its issue is open. The end of the row says what is happening:
// when a thread needs you, why, in its mark's colour. Otherwise its word, harness, round once it
// has had a review, how long its builder has worked while it works, and its PR. A task ready for
// review shows its PR, the review's verdict and CI instead, and offers m when it has a PR to
// merge.
function taskRow(
  db: Database,
  open: Open,
  repoName: string,
  saved: unknown,
  issues: Task[],
  running: string[],
  now: number,
): Row {
  const thread = Thread.parse(saved);
  const name = `${repoName}-${thread.task}`;
  const issueOpen = issues.some((issue) => issue.id === thread.task);
  const ready = taskStage(thread, issueOpen) === "ready for review";
  const { word, mark } = shownOf(thread, roundLimit(thread), now);
  // A thread with no harness saved started before Skelcrew saved it, when builders ran only on
  // Claude Code.
  const harness = thread.harness ?? "claude";
  const round = thread.review_round === null ? "" : `round ${thread.review_round}`;
  const since = Working.parse(saved).working_since ?? thread.started;
  const age = word === "working" && since !== null ? threadAge(since, now) : "";
  const pr = thread.pr === null ? "" : `#${thread.pr}`;
  const copy = thread.pr === null ? null : prOf(db, open.owner, open.repo, thread.pr);
  const ci = thread.checks === null ? "" : ciWords[thread.checks];
  const says = ready
    ? [pr, "approved", ci].filter(Boolean)
    : needsDecision(mark)
      ? [`needs you: ${word}`, harness]
      : [word, harness, round, age, pr].filter(Boolean);
  // m merges the PR only at the commit Skelcrew's reviewer approved, and only while it is the
  // head the forge last sent and CI passed there, as the forge's copy of the PR shows. The thread's own verdict and checks can lag
  // behind a push, so they never stand for a newer head. A forge too old to send the head
  // commit can't merge either, as it lacks the call too.
  let merge: Action | null = null;
  if (ready && thread.pr !== null && copy !== null) {
    const named = `${repoName}#${thread.pr}`;
    const approved = lastApproved(thread);
    const ci = copy.checks.filter((check) => check.name !== reviewCheck);
    if (copy.head === null)
      merge = {
        refused: `${named} needs a newer forge plugin to merge here: run sc plugin update`,
      };
    else if (approved !== copy.head)
      merge = { refused: `${named} has a newer commit than the one approved: wait for its review` };
    // No checks in the copy is a pass only for a repository with no CI, which its polls saved
    // as none. Otherwise CI may not have started on the approved commit yet.
    else if (
      (ci.length === 0 && thread.checks !== null) ||
      !ci.every((check) => check.state === "passed")
    )
      merge = { refused: `${named}'s checks haven't passed on the approved commit yet` };
    else
      merge = {
        ask: `Merge ${named} into ${removeControlCodes(copy.base)}? y/n`,
        working: `Merging ${named}…`,
        request: {
          command: "merge",
          repo: `${open.owner}/${open.repo}`,
          pr: thread.pr,
          commit: approved,
        },
      };
  }
  const runs = running.includes(thread.folder);
  return {
    part: ready ? "ready" : "working",
    name,
    title: removeControlCodes(thread.short ?? thread.title ?? ""),
    mark,
    says: says.join(" · "),
    colour: mark.colour,
    session: thread.folder,
    running: runs,
    start: null,
    merge,
    link: copy?.link ?? null,
    branch: thread.branch,
  };
}

// Returns the repository's rows as the database and tmux have them now, at a moment in
// milliseconds: its lead, then its open issues no thread works on, newest first, then its tasks
// with agents on them, those that need you first and then newest first, so the list reaches them
// fastest, then those ready for review. `running` names the sessions whose agents run.
export function listRows(db: Database, open: Open, running: string[], now: number): Row[] {
  const repository = findRepository(db, `${open.owner}/${open.repo}`);
  const issues = openTasks(db, open.owner, open.repo);
  const saved = db
    .query(`SELECT * FROM task_threads WHERE status != 'done' AND owner = ? AND repo = ?
      ORDER BY rowid DESC`)
    .all(open.owner, open.repo);
  const tasks = saved.map((row) => taskRow(db, open, repository.name, row, issues, running, now));
  // An issue whose work ended, such as by sc rm, is back in stage issue, to start again, as its
  // thread is done.
  const waiting = issues
    .map((issue) => ({ issue, name: `${repository.name}-${issue.id}` }))
    .filter(({ name }) => !tasks.some((row) => row.name === name))
    .map(({ issue, name }): Row => {
      return {
        part: "issue",
        name,
        title: removeControlCodes(issue.title),
        mark: { sign: "○", colour: "dim" },
        says: "",
        colour: "dim",
        session: null,
        running: false,
        start: {
          ask: `Start ${name}? y/n`,
          working: `Starting ${name}…`,
          request: { command: "start", repo: `${open.owner}/${open.repo}`, task: issue.id },
        },
        merge: null,
        link: null,
        branch: null,
      };
    });
  const working = tasks.filter((row) => row.part === "working");
  const needing = working.filter((row) => row.mark.sign === "●");
  return [
    leadRow(db, open, running),
    ...waiting,
    ...needing,
    ...working.filter((row) => row.mark.sign !== "●"),
    ...tasks.filter((row) => row.part === "ready"),
  ];
}

// Returns whether a repository has a forge, which merging and PRs need.
export function hasForge(db: Database, open: Open): boolean {
  return forgeOf(db, findRepository(db, `${open.owner}/${open.repo}`)) !== null;
}

// What a tab's row holds as the database gives it, checked, since it is read from disk.
const TabRow = z.object({ name: z.string(), owner: z.string(), repo: z.string() });

// Returns a tab for each repository, in name order, with its badge: how many of its threads
// need you, and how many are ready to merge. The badges are how you hear of other repositories,
// as one repository's lead never mentions another's threads. A repository whose lead you exited
// has no tab until you open it again, except the open one, so the list never loses what it shows.
export function repositoryTabs(db: Database, open: Open): Tab[] {
  const repositories = db
    .query(`SELECT name, owner, repo FROM repositories
      WHERE tab_closed = 0 OR (owner = ? AND repo = ?) ORDER BY name`)
    .all(open.owner, open.repo)
    .map((row) => TabRow.parse(row));
  // Each thread that isn't done gets the mark its row would have.
  const marked = db
    .query("SELECT * FROM task_threads WHERE status != 'done'")
    .all()
    .map((row) => {
      const thread = Thread.parse(row);
      return { thread, mark: shownOf(thread, roundLimit(thread)).mark };
    });
  return repositories.map(({ name, owner, repo }) => {
    const ours = marked.filter((m) => m.thread.owner === owner && m.thread.repo === repo);
    return { name, fullName: `${owner}/${repo}`, ...badgeOf(ours.map((m) => m.mark)) };
  });
}
