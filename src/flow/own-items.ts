// Skelcrew's own items: what it marks itself on a thread, shown in Needs you as an item with
// options that act directly, until the lead posts an item of its own for the thread.
import { removeControlCodes } from "../screen/look.ts";
import { limitOf, roundOf } from "./ledger.ts";
import type { DaemonRequest } from "./requests.ts";
import { needsYou, threadWord } from "./status.ts";
import type { Thread } from "./thread.ts";

// What an option of Skelcrew's own item does: go on past the round limit, as sc start, merge
// without approval, as sc merge --skip-review, stop the builder, as sc stop, merge the approved
// PR, open the builder's session, start the builder again, or hand the item to the lead.
export type Act = "go on" | "skip review" | "stop" | "merge" | "open" | "restart" | "lead";

// Skelcrew's own item: its short title, what happened in plain words, and its options, each with
// what it does. Its text keeps its lines, with every other control code removed, as it can hold
// the builder's own words.
export type OwnItem = { title: string; text: string; options: { label: string; act: Act }[] };

const toBuilder = [
  { label: "Open the builder", act: "open" },
  { label: "Let the lead handle it", act: "lead" },
] as const;

// What a task says while a pick on its item runs, by what the pick does. Opening the builder and
// handing the item to the lead are done at once, so they have none.
export const pickingWords: Partial<Record<Act, string>> = {
  "go on": "going on…",
  "skip review": "merging…",
  stop: "stopping…",
  merge: "merging…",
  restart: "starting…",
};

// Returns the item for what Skelcrew sees the thread needs you for, or null when it needs you for
// nothing, its item went to the lead, the lead posted its own, which `asked` says, or a pick on it
// runs.
export function ownItem(thread: Thread, asked: boolean): OwnItem | null {
  if (asked || thread.status === "done" || thread.picking !== null || !needsYou(thread))
    return null;
  const item = itemFor(thread);
  return thread.handed === handedKey(item) ? null : item;
}

// What a pick carries besides its letter: the task, and for a merge what you saw of the PR.
export type Picking = {
  repo: string;
  task: string;
  commit?: string | undefined;
  merging?: { pr: number; started: number | null; head: string } | undefined;
};

// Returns the requests a pick makes of the daemon, in order, exactly as their commands make them,
// so a pick does what the command does: sc start to go on, sc stop, sc merge --skip-review with
// the PR you saw, the merge m makes with the commit you saw approved, and the screen's restart.
// A builder that isn't running, as its session ended or its host is gone, has nothing to restart,
// so it is stopped and started again, which resumes it on the current host, or only started when
// it is stopped already, such as after a start that failed. Opening the builder
// and handing the item to the lead make none.
export function pickRequests(
  act: Act,
  thread: Thread,
  picking: Picking,
  runs: boolean,
): DaemonRequest[] {
  const { repo, task, commit, merging } = picking;
  const start: DaemonRequest = { command: "start", repo, task };
  const stop: DaemonRequest = { command: "stop", repo, task };
  switch (act) {
    case "go on":
      return [start];
    case "stop":
      return [stop];
    case "skip review":
      return merging === undefined
        ? []
        : [{ command: "merge skip review", repo, task, seen: merging }];
    case "merge":
      return thread.pr === null || commit === undefined
        ? []
        : [{ command: "merge", repo, pr: thread.pr, commit }];
    case "restart":
      if (thread.status === "stopped") return [start];
      return runs && thread.needs_you_for === null
        ? [{ command: "restart", repo, task }]
        : [stop, start];
    default:
      return [];
  }
}

// Returns what an item you handed to the lead is kept as, so the same item stays gone and a new
// one, such as another question, shows.
export const handedKey = (item: OwnItem) => `${item.title}\n${item.text}`;

// A stopped thread's word says only that it stopped, so its item is told by what it would say at
// work, such as an error it stopped on.
function itemFor(thread: Thread): OwnItem {
  const asLive = thread.status === "stopped" ? { ...thread, status: "working" as const } : thread;
  const word = threadWord(asLive, limitOf(asLive));
  const said = thread.said?.split("\n").map(removeControlCodes).join("\n").trim() || null;
  const round = roundOf(thread);
  const pr = thread.pr === null ? "Its branch" : `#${thread.pr}`;
  if (thread.needs_you_for?.startsWith("run sc: sign in to "))
    return {
      title: "An agent needs a login",
      text: `An agent cannot start without its login. In your terminal, ${thread.needs_you_for}. Skelcrew will try again after you sign in.`,
      options: [{ label: "Let the lead handle it", act: "lead" }],
    };
  if (thread.needs_you_for !== null && word === thread.needs_you_for)
    return {
      title: "Its session host is missing",
      text: `Its builder's session host plugin is missing, so Skelcrew can't reach the builder. To bring it back, ${thread.needs_you_for}. Starting it again moves it to your current session host.`,
      options: [
        { label: "Start it again", act: "restart" },
        { label: "Open the builder", act: "open" },
      ],
    };
  if (word === "question")
    return {
      title: "Its builder asked a question",
      text: said ?? "Its builder asked a question in its session.",
      options: [...toBuilder],
    };
  if (word === "error")
    return {
      title: "Its harness stopped on an error",
      text: said ?? "Its builder's harness stopped on an error.",
      options: [
        { label: "Start it again", act: "restart" },
        { label: "Open the builder", act: "open" },
      ],
    };
  if (word === "round limit") {
    const findings = (round.review_findings ?? []).map(
      (finding, at) => `${at + 1}. ${removeControlCodes(finding)}`,
    );
    return {
      title: `Review still wants changes after ${round.review_round ?? round.rounds} rounds`,
      text: ["The latest review asks:", ...findings].join("\n"),
      options: [
        { label: "Go on: fix the findings", act: "go on" },
        { label: "Merge without approval", act: "skip review" },
        { label: "Stop the builder", act: "stop" },
      ],
    };
  }
  if (word === "approved" || word === "not reviewed") {
    const commit = round.reviewed_commit === null ? "" : ` at ${round.reviewed_commit.slice(0, 7)}`;
    const checks = thread.pr === null ? "" : " and its checks passed";
    const unreviewed = word === "approved" ? "" : " Its flow has no review, so nobody reviewed it.";
    return {
      title: "Ready to merge",
      text: `${pr} is ready${commit}${checks}.${unreviewed}`,
      options: [
        { label: "Merge it", act: "merge" },
        { label: "Not yet", act: "lead" },
      ],
    };
  }
  if (word === "turn ended")
    return {
      title: "Its builder stopped without submitting",
      text: said ?? "Its builder ended its turn without a submit, and said nothing.",
      options: [...toBuilder],
    };
  return {
    title: "Its builder needs you",
    text: "Skelcrew couldn't go on with this thread without you.",
    options: [...toBuilder],
  };
}
