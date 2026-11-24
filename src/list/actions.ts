// Actions shared by sc --list and the sidebar: answering items, opening PRs, starting and merging tasks.
import type { Database } from "bun:sqlite";
import { mergingWord } from "../flow/marks.ts";
import { pickingWord } from "../flow/own-items.ts";
import { type Letter, letters } from "../flow/requests.ts";
import { typedTask } from "../flow/thread.ts";
import { enterAttaches, type Pick, type Target } from "./layout.ts";
import { hasForge, type Open, type Question, type Row } from "./rows.ts";

// The command that opens a link in your browser.
const openCommand = process.platform === "darwin" ? "open" : "xdg-open";

// Returns whether a link can open in your browser here. Your browser opens a PR only on the
// machine you sit at, so never on a remote, given as `where`. A Linux machine with no display,
// such as a server you ssh to, has none either, so Enter copies the link to your clipboard instead.
export function canOpenLinks(where: string): boolean {
  return (
    where === "" &&
    (process.platform === "darwin" || !!process.env.DISPLAY || !!process.env.WAYLAND_DISPLAY) &&
    Bun.which(openCommand) !== null
  );
}

// Opens a task's PR, as Enter does on a ready or ended task, and returns what the bottom line
// says of it. With `canOpen` the PR opens in your browser. Otherwise its link goes to your
// terminal's clipboard as OSC 52, written with `write`, which reaches your laptop over ssh too.
// A task with no PR says why: one without a forge names the branch that waits for you, and one
// that ended before Skelcrew saved PR links names its PR, as there is no link left to open.
export function openPr(
  db: Database,
  open: Open,
  row: Row,
  canOpen: boolean,
  write: (text: string) => void,
): string {
  if (row.link === null && row.part === "done")
    return row.pr
      ? `${row.name}'s PR ${row.pr} has no link saved, as it ended before Skelcrew kept them: open it on the forge`
      : `${row.name} has no PR to open`;
  if (row.link === null) {
    const branch = row.branch ? ` on branch ${row.branch}` : "";
    return hasForge(db, open)
      ? `${row.name} has no PR yet`
      : `${row.name} is ready${branch}: open a PR or merge it yourself`;
  }
  if (canOpen) {
    Bun.spawn([openCommand, row.link], { stdout: "ignore", stderr: "ignore" });
    return `Opened ${row.link}`;
  }
  write(`\x1b]52;c;${Buffer.from(row.link).toString("base64")}\x07`);
  return `Copied ${row.link}`;
}

// A question open on the bottom line: what it asks, the row it is about by name, and which of
// the row's offers it is: a start, a start now over limits.threads, a merge, or a pick on
// Skelcrew's own item.
export type Asking = {
  question: Question;
  row: string;
  offer: "start" | "startNow" | "merge" | "pick";
};

// Returns the rows with the y/n question a pick asks in its item's box too, while it waits on
// your answer, so you read it where you picked.
export const askingInBox = (rows: Row[], asking: Asking | null): Row[] =>
  rows.map((row) =>
    asking?.offer === "pick" && row.name === asking.row && row.ask
      ? { ...row, ask: { ...row.ask, confirm: asking.question.ask } }
      : row,
  );

// A pick on the item of a row, by its name, on its way to the daemon.
export type Sent = { row: string; pick: Letter };

// Returns the rows with a pick on its way to the daemon shown as the daemon shows it once it has
// it, so your answer shows at once: a merge takes the task out of Needs you, and another pick
// says what it does in the item's box.
export const pickSent = (rows: Row[], sent: Sent | null): Row[] =>
  rows.map((row) => {
    const act = sent?.row === row.name ? row.ask?.acts?.[letters.indexOf(sent.pick)] : undefined;
    const doing = act === undefined ? null : pickingWord(act);
    if (doing === null || !row.ask) return row;
    if (doing !== mergingWord) return { ...row, ask: { ...row.ask, doing } };
    const { part } = row;
    if (part === "lead" || part === "heading" || part === "ask") return row;
    return { ...row, section: part, says: mergingWord, ask: null };
  });

// Returns the start or merge to go ahead with once you said yes, given the rows read again just
// now, or what the bottom line says instead. The task can change while the question is open: CI
// can fail, the approval can go, or the issue can start elsewhere. So it goes ahead only while
// the row still offers the very same request, and a pick only while it asks the very same
// question, as a retargeted PR can change what it says of .agents/.
export function stillOffered(asking: Asking, rows: Row[]): Question | string {
  const row = rows.find((candidate) => candidate.name === asking.row);
  const changed = `${asking.row} changed while you were asked, so nothing was done`;
  if (asking.offer === "pick") {
    const { request } = asking.question;
    const again = row && request.command === "pick" && ownPick(row, request.pick, request.repo);
    const same = again && again.ask === asking.question.ask;
    return same && Bun.deepEquals(again.request, request) ? again : changed;
  }
  const offer = row?.[asking.offer];
  if (offer && "ask" in offer && Bun.deepEquals(offer.request, asking.question.request))
    return offer;
  return offer && "refused" in offer ? offer.refused : changed;
}

// What a pick on a row's item does: answers the lead's item, starts a reply, or does what an
// option of Skelcrew's own item does. Every option of Skelcrew's own goes to the daemon, so the
// lead hears each pick. Opening the builder then attaches to it, and a merge asks y/n first, as
// every merge does, or says why it can't.
export type Picked =
  | { answer: Letter }
  | "reply"
  | { open: Question }
  | { confirm: Question }
  | { run: Question }
  | { refused: string };

// Returns what a pick on the item of `row`, in the repository `repo` names, does, or null when the
// row has no such option.
export function picked(row: Row, pick: Pick, repo: string): Picked | null {
  if (pick === "reply") return row.ask?.acts === null ? "reply" : null;
  if (!row.ask) return null;
  if (row.ask.acts === null) return { answer: pick };
  const act = row.ask.acts[letters.indexOf(pick)];
  if (act === "merge" && row.merge && "refused" in row.merge) return row.merge;
  if (act === "merge" && !row.merge) return { refused: `${row.name} has no PR to merge here` };
  const question = ownPick(row, pick, repo);
  if (question === null) return null;
  if (act === "open") return { open: question };
  return question.ask ? { confirm: question } : { run: question };
}

// Returns what a pick on Skelcrew's own item on `row` asks the daemon, with what the bottom line
// asks first, for a merge, and says meanwhile, or null with no such option. Merging the approved
// PR carries the commit you saw approved, as m does, and merging without approval the PR you saw,
// its number, when its thread started and its head, as sc merge --skip-review does.
function ownPick(row: Row, pick: Letter, repo: string): Question | null {
  if (!row.ask || row.ask.acts === null || row.task === null) return null;
  const at = letters.indexOf(pick);
  const label = row.ask.options[at];
  const act = row.ask.acts[at];
  if (label === undefined || act === undefined) return null;
  const merge = act === "merge" && row.merge && "ask" in row.merge ? row.merge : null;
  if (act === "merge" && merge === null) return null;
  const commit = merge?.request.command === "merge" ? { commit: merge.request.commit } : {};
  const merging = act === "skip review" && row.ask.merging ? { merging: row.ask.merging } : {};
  return {
    ask:
      act === "skip review"
        ? (row.ask.skipping ??
          `Merge ${row.pr || row.name} (${row.name}) without Skelcrew's approval? CI must still pass. y/n`)
        : (merge?.ask ?? ""),
    working: `${label}…`,
    request: {
      command: "pick",
      repo,
      task: typedTask(row.task),
      seen: { title: row.ask.title, text: row.ask.text },
      pick,
      ...commit,
      ...merging,
    },
    queues: false,
  };
}

// Returns what a key does on the row at `here`, when it has the lead's item: a letter picks that
// option, and r starts a reply in your own words. Only a line drawn on screen answers, by the
// targets of the last draw, so a key never picks an option you can't see. Any other key, or a
// row with no item, does nothing here.
export function itemKey(
  row: Row | undefined,
  here: number,
  targets: Target[],
  key: string,
  visible: string[] = [],
): Pick | null {
  if (!row?.ask) return null;
  const pick = key === "r" ? "reply" : letters.find((letter) => letter === key);
  const shown =
    visible.some((line) => Bun.stripANSI(line).trimStart().startsWith(`│ ${key}) `)) ||
    targets.some(
      (target) => target !== null && "row" in target && target.row === here && target.pick === pick,
    );
  return pick !== undefined && shown ? pick : null;
}

// Returns the keys that answer a row's item, for the bottom line, such as `a/b answer  r reply`.
// Skelcrew's own item takes no reply, as its options act.
export function itemKeys(row: Row): string {
  if (!row.ask) return "";
  const picks = `${letters.slice(0, row.ask.options.length).join("/")} answer`;
  return row.ask.acts === null ? `${picks}  r reply` : picks;
}

// Returns what the bottom line says while the lead's item on `row` is open full-size, or null on
// a row with no item.
export const itemFooter = (row: Row | undefined) =>
  row?.ask
    ? `${itemKeys(row)}  ↑↓ scroll  ⏎ ${enterAttaches(row) ? "attach" : "open"}  esc back`
    : null;

// A reply you are typing to an item, with the row it answers.
export type Reply = { row: Row; text: string };

// Returns what a key does to a reply you are typing: Enter sends it, Esc drops it, Backspace takes
// its last character off, and any other single character is typed. Other keys do nothing.
export function typeReply(reply: Reply, key: string): "send" | "drop" | Reply {
  if (key === "enter") return "send";
  if (key === "esc" || key === "escape") return "drop";
  if (key === "\x7f" || key === "\b")
    return { ...reply, text: [...reply.text].slice(0, -1).join("") };
  if ([...key].length === 1 && !/\p{Cc}/u.test(key)) return { ...reply, text: reply.text + key };
  return reply;
}

// Returns what the bottom line says while you type a reply: the reply so far, its end if it is
// long, and the keys.
export const replyLine = (reply: Reply) =>
  `Reply on ${reply.row.label}: ${[...reply.text].slice(-60).join("")}▏  ⏎ send  esc drop`;
