// The right pane while you are on one of the sidebar's entries: the entry's list, and the pages
// of the issues and PRs opened from it. It is a process of its own, in the screen's right pane,
// so it ends with the screen and agents' sessions never see it.
import { screenSocket, tmux } from "../agents/tmux.ts";
import { startOrMerge } from "../client.ts";
import { openDb } from "../db.ts";
import { type Page, readPage } from "../flow/page.ts";
import { errorText } from "../say.ts";
import { listFooter, tellFooter } from "./footer.ts";
import { type Action, type Entry, type Group, listGroups } from "./lists.ts";
import { fitted, grey, pad, paint, removeControlCodes, shaded, tinted, white } from "./look.ts";
import { drawPage } from "./page.ts";

// What a list with nothing in it says.
const nothing: Record<Entry, string> = {
  issues: "No open issues",
  prs: "No open PRs",
  threads: "No threads",
};

// Returns an entry's list as lines for a pane `width` columns wide, with the row each line opens,
// if any. `here` is the row you are on, counted through every group. The keys come first, dim,
// then each group under its dim heading. A row is its mark, its name, its whole title and its
// ends, which line up in columns at the right, so the title is cut with … only on a pane too
// narrow for it. An issue's or PR's row is a terminal link, as Skelcrew may run on another machine
// than your browser. A stopped thread is dim. It reads nothing, so what you see can be tested
// without a terminal.
export function drawList(
  groups: Group[],
  entry: Entry,
  here: number,
  width: number,
): { text: string; row: number | null }[] {
  if (groups.length === 0)
    return [
      { text: "", row: null },
      { text: `${pad}${nothing[entry]}`, row: null },
    ];
  // Every row's name takes as many columns as the longest, and each column of the ends as many as
  // its longest. A column empty on every row takes none. Text from outside is made safe first.
  const rows = groups.flatMap((group) => group.rows);
  const ends = rows.map((row) =>
    row.ends.map(([text, code]): [string, string] => [removeControlCodes(text), code]),
  );
  const nameWidth = Math.max(...rows.map((row) => Bun.stringWidth(row.name)));
  const columns = Array.from({ length: Math.max(...ends.map((end) => end.length)) }, (_, i) =>
    Math.max(...ends.map((end) => Bun.stringWidth(end[i]?.[0] ?? ""))),
  );
  const endsWidth = columns.reduce((sum, wide) => sum + (wide > 0 ? wide + 2 : 0), 0);
  // The title has what is left between the name and the ends, past the padding on each side.
  const room = Math.max(width - pad.length - 2 - nameWidth - 2 - endsWidth - pad.length, 0);
  // Returns one row as a line: shaded when you are on it, and dim when it can't be opened.
  const rowLine = (index: number): string => {
    const row = rows[index];
    if (!row) return "";
    const on = index === here;
    // Returns text in a colour, dim on a row that can't be opened. A mark keeps its colour on the
    // grey, so it looks the same whether or not you are on its row, while dim text turns light
    // grey there. Plain text is white on the grey, as a theme's own text can be dark there.
    const colour = (code: string | null, text: string) => {
      if (row.dim) return tinted(on, grey, text);
      if (code !== null) return tinted(on, code, text);
      return on ? paint(white, text) : text;
    };
    const title = fitted(removeControlCodes(row.title), room);
    const gap = " ".repeat(Math.max(room - Bun.stringWidth(title), 0));
    const start = `${colour(row.mark[1], row.mark[0])} ${colour(null, row.name.padEnd(nameWidth))}  ${colour(null, title)}`;
    const linked = row.link ? `\x1b]8;;${row.link}\x1b\\${start}\x1b]8;;\x1b\\` : start;
    // Each end is padded to its column, and the columns left empty on every row are left out.
    const tail = columns
      .map((wide, i) => {
        const [text, code] = ends[index]?.[i] ?? ["", grey];
        return wide > 0 ? `  ${colour(code, text.padEnd(wide))}` : "";
      })
      .join("");
    const line = `${pad}${linked}${gap}${tail}`;
    return on ? shaded(line, width) : line;
  };
  // The keys, then each group under its heading, with a blank line before each.
  const lines: { text: string; row: number | null }[] = [
    { text: paint(grey, `${pad}↑↓ move  ⏎ open`), row: null },
  ];
  let index = 0;
  for (const group of groups) {
    lines.push({ text: "", row: null }, { text: paint(grey, `${pad}${group.heading}`), row: null });
    for (let i = 0; i < group.rows.length; i++, index++)
      lines.push({ text: rowLine(index), row: index });
  }
  return lines;
}

// What the pane reads: a mouse report, with its button, column and row counted from 1 and
// whether it is a press, an arrow key, Enter, ?, and s or m. Esc is left out: in an agent it
// stops its turn, so here it does nothing, or your hand would learn to reach for it to leave an
// agent.
const esc = "\x1b";
const input = new RegExp(
  `${esc}\\[<(\\d+);(\\d+);(\\d+)([Mm])|${esc}[[O]([ABCD])|(\\r)|(\\?)|([sm])`,
  "g",
);
// How many lines a notch of the wheel moves, as an agent's history does.
const linesPerNotch = 5;
// The command that opens a link in your browser.
const openCommand = process.platform === "darwin" ? "open" : "xdg-open";

// Shows an entry's list of the repository named by its owner/name, and the pages opened from it,
// until the pane goes. `agents` names the agents' tmux server and `session` the screen's session,
// whose sidebar this tells which page is open, for the strip, and which thread to show. `where`
// names the remote Skelcrew runs on, and is empty on the machine you sit at. `start` is the
// session of the thread whose row the list starts on, for Ctrl-6 back from its agent, or empty to
// start on the first row.
// Up and Down move a list, and Enter, Right or a click opens a row: an issue's or PR's page here,
// or a thread's agent, which the sidebar puts in place of this pane. Right opens as Left goes
// back, so the arrows alone take you in and out. On a page, Up, Down and the
// wheel scroll, and Left goes back to the list, on the row you opened. ? shows or hides the
// list of keys on either. s on an issue starts a thread on it and m on a PR merges it, on its
// list or its page, after asking in the footer. All else you type goes nowhere. It tells the
// footer what to say, with s or m only while the row you are on can be started or merged. It
// reads the list again each second, and writes only when what shows changed, so a list left
// open lets a Sprite sleep. A page is read once.
export async function runPane(
  agents: string,
  session: string,
  entry: Entry,
  where: string,
  repository: string,
  start: string,
): Promise<void> {
  const db = openDb();
  const [owner = "", repo = ""] = repository.split("/");
  const open = { owner, repo, lead: "" };
  // What the pane keeps between frames: the list and the row you are on, by its place and its
  // name, so a row that moves as the list changes keeps you on it. `top` is the first line
  // shown, as far as the list or page scrolled.
  let groups = listGroups(db, open, entry, Date.now());
  let here = Math.max(
    groups.flatMap((group) => group.rows).findIndex((row) => start && row.session === start),
    0,
  );
  let top = 0;
  let page: { read: Page; url: string; top: number } | null = null;
  let lastFrame = "";
  // What the footer says in place of its keys: the question s or m asks while it waits for y,
  // whether the daemon is starting or merging, and whether it says something, such as why a row
  // can't be started or merged, until the next key. `said` is what the footer was last told.
  let asking: Extract<Action, { ask: string }> | null = null;
  let working = false;
  let saying = false;
  let said = "";
  const rows = () => groups.flatMap((group) => group.rows);
  const width = () => process.stdout.columns || 80;
  const height = () => process.stdout.rows || 24;
  // Tells the sidebar something, as text typed into its pane, which it reads as it reads a
  // click on a tab.
  const tell = (what: "page" | "thread", value: string) =>
    tmux(screenSocket(agents), [
      "send-keys",
      "-t",
      `=${session}:.0`,
      "-l",
      `\x1b]skel-${what};${value}\x07`,
    ]);
  // Your terminal opens a link only with Shift added, as the screen takes the mouse for the
  // sidebar. So a plain click on a page's link opens it here, on the machine you sit at. A Linux
  // machine with no display, such as a server you ssh to, has no browser to open, so the click
  // copies the link to your terminal's clipboard instead.
  const canOpen =
    where === "" &&
    (process.platform === "darwin" || !!process.env.DISPLAY || !!process.env.WAYLAND_DISPLAY) &&
    Bun.which(openCommand) !== null;
  let hint = canOpen ? "click to open" : "click to copy";
  // Returns the page's lines for the pane's width: the key back to the list, then the page.
  const pageLines = (shown: { read: Page; url: string }) => [
    paint(grey, `${pad}← back`),
    ...drawPage(shown.read, shown.url, width(), hint),
  ];
  // Returns the list's lines, scrolled so the row you are on shows when `follow` says so.
  const listLines = (follow: boolean) => {
    const lines = drawList(groups, entry, here, width());
    const at = lines.findIndex((line) => line.row === here);
    if (follow && at >= 0) top = Math.min(Math.max(top, at - height() + 1), at);
    top = Math.min(Math.max(top, 0), Math.max(lines.length - height(), 0));
    return lines;
  };
  // Returns the row s and m act on, in a list of rows read from Skelcrew's copy. On a page it is
  // the issue or PR the page shows, found by its link, as the list behind a page reads the copy
  // again and another row can take its place when it closes. On a list it is the row you are on,
  // found by its name. Nothing when it is gone.
  const chosen = (list: Group["rows"]) => {
    const shown = page;
    if (shown) return list.find((row) => row.link === shown.url);
    const name = rows()[here]?.name;
    return list.find((row) => row.name === name);
  };
  // Returns the footer's keys for the row s and m act on: s or m only when it can be started or
  // merged.
  const footerKeys = () => {
    const action = chosen(rows())?.action;
    return listFooter(action && !("refused" in action) ? action.key : null);
  };
  // Says something in the footer in place of its keys, or with null puts its keys back.
  const say = (text: string | null) => {
    said = text ?? footerKeys();
    tellFooter(agents, session, "footer", said);
  };
  // Draws what shows, filling the pane, only when it changed. The footer's keys follow the row
  // you are on, unless the footer is saying something else.
  const draw = (follow = false) => {
    if (!asking && !working && !saying && footerKeys() !== said) say(null);
    let shown: string[];
    if (page) {
      const lines = pageLines(page);
      page.top = Math.min(Math.max(page.top, 0), Math.max(lines.length - height(), 0));
      shown = lines.slice(page.top, page.top + height());
    } else
      shown = listLines(follow)
        .slice(top, top + height())
        .map((line) => line.text);
    const frame = `${shown.map((line) => `${line}\x1b[K`).join("\r\n")}\x1b[J`;
    if (frame === lastFrame) return;
    lastFrame = frame;
    process.stdout.write(`\x1b[H${frame}`);
  };
  // Reads the list again, keeping you on the same row by its name, or at the same place when it
  // went. A row that moved, such as an issue that started and went under Started, is scrolled
  // back into view, so Enter never opens a row you can't see. A list whose row didn't move stays
  // where the wheel put it.
  const refresh = () => {
    const name = rows()[here]?.name;
    const line = () => drawList(groups, entry, here, width()).findIndex((l) => l.row === here);
    const before = line();
    groups = listGroups(db, open, entry, Date.now());
    const at = rows().findIndex((row) => row.name === name);
    here = at >= 0 ? at : Math.max(Math.min(here, rows().length - 1), 0);
    draw(line() !== before);
  };
  // Opens a row: an issue's or PR's page here, read from Skelcrew's copy, or a thread's agent,
  // which the sidebar shows in place of this pane. A page that can't be read shows why. A
  // stopped thread's agent isn't running, so opening it does nothing.
  const openRow = (index: number) => {
    const row = rows()[index];
    if (!row) return;
    here = index;
    if (row.link) {
      const url = row.link;
      let read: Page;
      try {
        read = readPage(db, url);
      } catch (error) {
        read = { title: "Couldn't show this", facts: [], body: errorText(error) };
      }
      page = { read, url, top: 0 };
      tell("page", url);
    } else if (row.session && !row.dim) tell("thread", row.session);
    draw(true);
  };
  // Acts on s or m: on an issue's or PR's row, asks first, or says why it can't. A key that
  // isn't this row's does nothing, such as m on an issue. The row is read again from Skelcrew's
  // copy, so a PR that just became ready, or an issue just started, counts as it is now. A page's
  // issue or PR that closed since says so, and nothing is done. Nothing is drawn again, so the
  // page stays as it is. Once asked, y acts on the issue or PR the question named, however the
  // list moves meanwhile.
  const act = (key: string) => {
    if (working) return;
    const now = listGroups(db, open, entry, Date.now()).flatMap((group) => group.rows);
    const row = chosen(now);
    const own = entry === "prs" ? "m" : entry === "issues" ? "s" : "";
    if (!row && key === own) {
      saying = true;
      say(`This ${key === "m" ? "PR" : "issue"} is no longer open`);
      return;
    }
    const action = row?.action;
    if (action?.key !== key) return;
    if ("refused" in action) {
      saying = true;
      say(action.refused);
      return;
    }
    asking = action;
    say(action.ask);
  };
  // Has the daemon start or merge once you said y, saying so meanwhile. The footer comes back
  // once it is done, and the list shows the row move as Skelcrew's copy changes. When the daemon
  // or the forge refuses, the line says why until the next key.
  const goAhead = async (action: Extract<Action, { ask: string }>) => {
    working = true;
    say(action.working);
    try {
      await startOrMerge(action.request);
      say(null);
    } catch (error) {
      saying = true;
      say(errorText(error));
    }
    working = false;
  };
  // Goes back from a page to its list, on the row you opened.
  const back = () => {
    page = null;
    tell("page", "");
    refresh();
    draw(true);
  };
  // Opens the page's link in your browser, or copies it to your terminal's clipboard with OSC
  // 52, which reaches you over ssh and sprite too, and says so in the hint. The browser is
  // detached, so it outlives the page.
  const openLink = async (url: string) => {
    if (canOpen) {
      const opening = Bun.spawn([openCommand, url], {
        stdio: ["ignore", "ignore", "ignore"],
        detached: true,
      });
      if ((await opening.exited) === 0) return;
    }
    process.stdout.write(`\x1b]52;c;${btoa(url)}\x07`);
    hint = "copied";
    draw();
  };
  // Returns whether a press at a column and row of the pane is on the page's link or its hint.
  const onLink = (shown: { read: Page; url: string; top: number }, column: number, y: number) => {
    const line = pageLines(shown)[shown.top + y - 1] ?? "";
    const at = line.indexOf(`\x1b]8;;${shown.url}\x1b\\`);
    return (
      at >= 0 && column > Bun.stringWidth(line.slice(0, at)) && column <= Bun.stringWidth(line)
    );
  };
  process.stdin.setRawMode(true);
  // Without the cursor hidden it would blink in the pane. 1000 and 1006 ask for the wheel and
  // clicks, so tmux hands them here. ?7l cuts a line at the edge: a pane too narrow for a line
  // would otherwise wrap it, and rows the pane doesn't count would throw its scrolling off.
  process.stdout.write("\x1b[?25l\x1b[?1000h\x1b[?1006h\x1b[?7l");
  // Acts on each key, click and notch of the wheel that came together.
  process.stdin.on("data", (bytes) => {
    // A question waits for y. Any other key leaves it be, and does nothing else.
    if (asking) {
      const action = asking;
      asking = null;
      if (bytes.toString() === "y") void goAhead(action);
      else say(null);
      return;
    }
    // A line that says why goes at the next key, which then does what it does.
    if (saying) {
      saying = false;
      if (!working) say(null);
    }
    for (const [, button, column, y, press, arrow, enter, question, key] of bytes
      .toString()
      .matchAll(input)) {
      const notch = button === "64" ? -linesPerNotch : button === "65" ? linesPerNotch : 0;
      // ? shows or hides the list of keys, on a list as on a page.
      if (question) tellFooter(agents, session, "keys", "toggle");
      else if (key) act(key);
      else if (page) {
        // A page scrolls, goes back, or follows its link.
        if (arrow === "A" || arrow === "B") page.top += arrow === "A" ? -1 : 1;
        else if (notch) page.top += notch;
        else if (arrow === "D") back();
        else if (button === "0" && press === "M" && onLink(page, Number(column), Number(y)))
          void openLink(page.url);
        if (page) draw();
      } else if (arrow === "A" || arrow === "B") {
        // A list moves a row, and keeps it in view.
        here = Math.min(Math.max(here + (arrow === "A" ? -1 : 1), 0), rows().length - 1);
        draw(true);
      } else if (enter || arrow === "C") openRow(here);
      else if (notch) {
        top += notch;
        draw();
      } else if (button === "0" && press === "M") {
        // A click opens the row on its line, in the list as drawn now.
        const line = listLines(false)[top + Number(y) - 1];
        if (line?.row !== null && line?.row !== undefined) openRow(line.row);
      }
    }
  });
  // Draws now, on each resize and, with the list read again, each second, until the pane goes
  // and its input closes. A page is read once, so a page left open writes nothing. Its row is
  // read again with the list, so the footer offers m once a PR became ready while its page was
  // open.
  process.on("SIGWINCH", () => draw(true));
  draw(true);
  setInterval(refresh, 1000);
  await new Promise((gone) => process.stdin.on("close", gone));
  process.exit(0);
}
