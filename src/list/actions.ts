// What the list's keys do on a row that isn't an agent's, for sc --list and the screen's sidebar
// alike: opening a task's PR, and going ahead with a start or a merge you said yes to.
import type { Database } from "bun:sqlite";
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

// A question open on the bottom line: what it asks, the row it is about by name, and whether it
// is a merge or a start.
export type Asking = { question: Question; row: string; merge: boolean };

// Returns the start or merge to go ahead with once you said yes, given the rows read again just
// now, or what the bottom line says instead. The task can change while the question is open: CI
// can fail, the approval can go, or the issue can start elsewhere. So it goes ahead only while
// the row still offers the very same request.
export function stillOffered(asking: Asking, rows: Row[]): Question | string {
  const row = rows.find((candidate) => candidate.name === asking.row);
  const offer = asking.merge ? row?.merge : row?.start;
  if (offer && "ask" in offer && Bun.deepEquals(offer.request, asking.question.request))
    return offer;
  return offer && "refused" in offer
    ? offer.refused
    : `${asking.row} changed while you were asked, so nothing was done`;
}

// Returns your answer to the lead's request on a row, for y or n there, as what the daemon gets,
// with what the bottom line says while it works. A yes to a start starts it, so the daemon's
// reply then says what happened, such as that the task waits in the queue.
export function answerOf(open: Open, row: Row, yes: boolean): Question | null {
  if (row.request === null) return null;
  return {
    ask: "",
    working: yes ? "Saying yes…" : "Saying no…",
    request: { command: "answer", repo: `${open.owner}/${open.repo}`, id: row.request, yes },
    queues: false,
  };
}
