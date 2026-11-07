// The page: what the right side shows while you are on a row of ISSUES or PRS. Read-only: you
// scroll it with the wheel, and typing goes nowhere. It is a process of its own, in the
// screen's right pane, so it ends with the screen and agents' sessions never see it.
import { z } from "zod";
import { ciChecks } from "../flow/decide.ts";
import { Name, readIssueDetails, readPullDetails } from "../github.ts";
import { errorText } from "../say.ts";
import { clean, fitted, grey, pad, paint, white } from "./look.ts";

// What the daemon hands the page, checked on both sides of its socket. Each fact is a short
// label and what it says. All of it comes from GitHub, so none of it is safe to show yet.
export const Page = z.object({
  title: z.string(),
  facts: z.array(z.tuple([z.string(), z.string()])),
  body: z.string(),
});
export type Page = z.infer<typeof Page>;

// A page's address on GitHub, which is also the link of its row in the sidebar.
const address = /^https:\/\/github\.com\/([^/]+)\/([^/]+)\/(issues|pull)\/(\d+)$/;
export const PageUrl = z.string().regex(address);

// Returns the page of the issue or PR at a link, as GitHub has it now. Only the daemon runs
// this, as only it may call GitHub.
export async function readPage(url: string): Promise<Page> {
  const [, owner, repo, kind, number] = url.match(address) ?? [];
  const fullName = `${Name.parse(owner)}/${Name.parse(repo)}`;
  return kind === "pull" ? pullPage(fullName, Number(number)) : issuePage(fullName, Number(number));
}

// Returns an issue's page.
async function issuePage(fullName: string, number: number): Promise<Page> {
  const { title, body, state, user, labels } = await readIssueDetails(fullName, number);
  const names = labels.map((label) => label.name).join(", ");
  const facts: Page["facts"] = [
    ["State", state],
    ["Author", user?.login ?? "unknown"],
    ["Labels", names || "none"],
  ];
  return { title, facts, body: body ?? "" };
}

// Returns a PR's page. Its checks read as they do in the strip, and a review still being
// written isn't one yet.
async function pullPage(fullName: string, number: number): Promise<Page> {
  const pull = await readPullDetails(fullName, number);
  const checks = ciChecks(pull);
  const latest = pull.reviews.filter((review) => review.state !== "PENDING").at(-1);
  const facts: Page["facts"] = [
    ["State", pull.state.toLowerCase()],
    ["Branch", `${pull.headRefName} → ${pull.base}`],
    ["Checks", checks === "pending" ? "running" : (checks ?? "none")],
    ["Review", latest ? aboutReview(latest) : "none"],
  ];
  return { title: pull.title, facts, body: pull.body };
}

// Returns what a review said and who said it. GitHub won't let skel approve its own PR, so skel's
// verdict is a comment whose first line says it: for those, that line is what you want to read.
function aboutReview(review: { state: string; body: string; author: { login: string } | null }) {
  const [first = ""] = review.body.split("\n");
  const said = review.state === "COMMENTED" ? first.replaceAll("*", "").trim() : "";
  const verdict = said || review.state.toLowerCase().replaceAll("_", " ");
  return `${verdict} · ${review.author?.login ?? "unknown"}`;
}

// Returns text from outside, safe to show, on as many lines as it takes to fit a number of
// columns. Words that are too long are broken, so a line never wraps by itself.
const wrapped = (text: string, columns: number) =>
  Bun.wrapAnsi(clean(text), Math.max(columns, 1), { hard: true }).split("\n");

// Returns a page as lines for a pane of a given width, from the top: the title, then the facts
// with the link to GitHub, whose text is the only part of a line that is a terminal link, then
// the description, as plain text. It reads nothing, so what you see can be tested without a
// terminal. The link is skel's own, from the sidebar, so it is never text from GitHub. It sits
// with the facts, not under a description that could push it far out of view.
export function drawPage(page: Page, url: string, width: number): string[] {
  const room = width - 2 * pad.length;
  const labels = [...page.facts.map(([label]) => label), "GitHub"];
  const gap = Math.max(...labels.map((label) => label.length)) + 2;
  // Returns a label and what it says, with any more lines lined up under the first.
  const fact = (label: string, lines: string[]) =>
    lines.map((line, i) => `${pad}${paint(grey, (i === 0 ? label : "").padEnd(gap))}${line}`);
  const link = `\x1b]8;;${url}\x1b\\${fitted(url, room - gap)}\x1b]8;;\x1b\\`;
  const body = page.body.trim()
    ? page.body
        .trim()
        .split(/\r?\n/)
        .flatMap((line) => wrapped(line, room))
    : [paint(grey, "No description.")];
  return [
    "",
    ...wrapped(page.title, room).map((line) => `${pad}${paint(white, line)}`),
    "",
    ...page.facts.flatMap(([label, says]) => fact(label, wrapped(says, room - gap))),
    ...fact("GitHub", [link]),
    "",
    ...body.map((line) => `${pad}${line}`),
  ];
}

// What the page reads: the wheel, as a click's report with the wheel's button. All else you
// type goes nowhere.
const esc = "\x1b";
const wheel = new RegExp(`${esc}\\[<(64|65);\\d+;\\d+M`, "g");
// How many lines a notch of the wheel moves, as an agent's history does.
const notch = 5;

// Shows the page at a link until its pane goes, drawing what `reading` brings once it comes, or
// why it couldn't. It writes only when you scroll or resize: it never asks again and has no
// clock, as on a Sprite a terminal that stays quiet lets it sleep.
export async function runPage(url: string, reading: Promise<Page>): Promise<void> {
  // Returns what to show at a width, until the page has come.
  let lines = (_width: number) => ["", `${pad}${paint(grey, "Loading…")}`];
  let top = 0;
  const width = () => process.stdout.columns || 80;
  const height = () => process.stdout.rows || 24;
  // Returns the highest line the page can start at, so it never scrolls past its end.
  const lastTop = () => Math.max(lines(width()).length - height(), 0);
  // Draws what shows from the top line, filling the pane, so nothing of the last frame stays.
  const draw = () => {
    top = Math.min(top, lastTop());
    const shown = lines(width()).slice(top, top + height());
    process.stdout.write(`\x1b[H${shown.map((line) => `${line}\x1b[K`).join("\r\n")}\x1b[J`);
  };
  process.stdin.setRawMode(true);
  // Without the cursor hidden it would blink on the page. 1000 and 1006 ask for the wheel, so
  // tmux hands it here. ?7l cuts a line at the edge: a pane too narrow for a label would
  // otherwise wrap it, and rows the page doesn't count would throw its scrolling off.
  process.stdout.write("\x1b[?25l\x1b[?1000h\x1b[?1006h\x1b[?7l");
  process.stdin.on("data", (bytes) => {
    const before = top;
    for (const [, button] of bytes.toString().matchAll(wheel))
      top = Math.min(Math.max(top + (button === "64" ? -notch : notch), 0), lastTop());
    if (top !== before) draw();
  });
  process.on("SIGWINCH", draw);
  draw();
  reading.then(
    (page) => {
      lines = (columns) => drawPage(page, url, columns);
      draw();
    },
    (error) => {
      const why = errorText(error);
      const about = { title: "Couldn't read this from GitHub", facts: [], body: why };
      lines = (columns) => drawPage(about, url, columns);
      draw();
    },
  );
  await new Promise((gone) => process.stdin.on("close", gone));
  process.exit(0);
}
