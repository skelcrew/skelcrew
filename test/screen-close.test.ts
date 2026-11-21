// Closing or removing a repository from the screen, by w in the sidebar or Alt-W from anywhere:
// the question and its confirms, the refusal, and where the screen goes next.

import { Database } from "bun:sqlite";
import { afterEach, beforeEach, expect, test } from "bun:test";
import { existsSync } from "node:fs";
import { join } from "node:path";
import { z } from "zod";
import { leadPlaces } from "../src/paths.ts";
import { threadSql } from "./harness.ts";
import {
  agent,
  agents,
  asked,
  daemon,
  endTest,
  footer,
  home,
  onLead,
  open,
  press,
  read,
  ready,
  right,
  screen,
  screenSessions,
  seen,
  sidebar,
  sql,
  startTest,
  tabRow,
  tmux,
  type,
  typingToSidebar,
  until,
} from "./screen.ts";

beforeEach(startTest);
afterEach(endTest);

// site, a second repository, whose lead runs.
const siteLead = leadPlaces("simon", "site").name;
function addSite(): void {
  sql(`INSERT INTO repositories (name, owner, repo) VALUES ('site', 'simon', 'site');
${threadSql({ repo: "site", task: "8", status: "waiting" })}`);
  agent(siteLead);
}

// What the database says of app now: whether it is there, and whether its tab is closed.
function appRow(): { tab_closed: number } | null {
  const db = new Database(join(home, ".local", "share", "skelcrew", "skelcrew.db"));
  try {
    const row = db.query("SELECT tab_closed FROM repositories WHERE repo = 'app'").get();
    return row === null ? null : z.object({ tab_closed: z.number() }).parse(row);
  } finally {
    db.close();
  }
}

const leadRuns = () => tmux(agents, "has-session", "-t", "=lead").ok;
const zoomed = () =>
  tmux(
    screen,
    "display",
    "-p",
    "-t",
    `=${screenSessions()[0]}:`,
    "#{window_zoomed_flag}",
  ).out.trim() === "1";
// The sidebar's text as one line, its own lines joined, without its border or the right side.
const flat = () =>
  seen()
    .split("\n")
    .map((line) =>
      line
        .slice(0, sidebar)
        .replace(/[│─┬┴┌┐└┘├┤]/g, "")
        .trim(),
    )
    .filter(Boolean)
    .join(" ");
const question =
  "c  close the tab: its lead stops, its tasks keep running, and it comes back when you open the repository again";

test("w in the sidebar asks, c then y closes app's tab, ending only its lead, and the screen moves to the next tab", async () => {
  addSite();
  daemon();
  open("lead");
  await ready("lead");
  // Ctrl-\ gives the sidebar your typing, and the footer offers w there.
  press("C-\\");
  await until(() => typingToSidebar() && footer().includes("w close"), "the sidebar's keys");
  type("w");
  await until(() => seen().includes("Close app?"), "the question");
  expect(flat()).toContain(question);
  expect(footer()).toBe("  c close  r remove  esc cancel");
  type("c");
  await until(() => seen().includes("Close app's tab? y/n"), "the confirm");
  type("y");
  await until(() => seen().includes(`I am ${siteLead}`), "site's lead");
  await until(() => !/\bapp\b/.test(tabRow()), "app's tab to go");
  expect(appRow()).toEqual({ tab_closed: 1 });
  // The tab closes first, so the screen moves on before the lead has ended.
  await until(() => !leadRuns(), "app's lead to end");
  // Its builders still run, and nothing asked for its lead back.
  expect(tmux(agents, "has-session", "-t", "=app-7").ok).toBe(true);
  expect(asked.filter((one) => one.includes("simon/app"))).toEqual([]);
});

test("Alt-W from a lead in full screen asks in the sidebar, and Esc gives the lead back full screen", async () => {
  open("lead");
  await ready("lead");
  press("C-\\");
  await until(typingToSidebar, "the sidebar's typing");
  type("a");
  await until(zoomed, "the lead full screen");
  press("M-w");
  await until(() => seen().includes("Close app?") && !zoomed(), "the question beside the lead");
  press("Escape");
  await until(zoomed, "the lead full screen again");
  await until(() => !seen().includes("Close app?"), "the question to go");
  type("hello\r");
  await until(() => read("lead.typed").includes("hello"), "the typing to reach the lead");
  // Alt-W never reached the lead, and nothing closed.
  expect(read("lead.typed")).toBe("hello\n");
  expect(appRow()).toEqual({ tab_closed: 0 });
  expect(leadRuns()).toBe(true);
});

test("n at the confirm closes nothing and gives the lead its typing back", async () => {
  open("lead");
  await ready("lead");
  press("M-w");
  await until(() => seen().includes("Close app?"), "the question");
  type("c");
  await until(() => seen().includes("Close app's tab? y/n"), "the confirm");
  type("n");
  await until(() => !seen().includes("Close app's tab?"), "the confirm to go");
  type("hello\r");
  await until(() => read("lead.typed").includes("hello"), "the typing to reach the lead");
  expect(appRow()).toEqual({ tab_closed: 0 });
});

test("r is refused while app has live threads, naming them, then removes it once they stop", async () => {
  addSite();
  daemon();
  open("lead");
  await ready("lead");
  press("M-w");
  await until(() => seen().includes("Close app?"), "the question");
  type("r");
  await until(
    () =>
      flat().includes(
        "Remove app from Skelcrew? Its clone is deleted; GitHub and your checkouts are untouched. y/n",
      ),
    "the confirm",
  );
  type("y");
  const refusal = "app has live threads: APP-7, APP-12. Stop them first.";
  await until(() => flat().includes(refusal), "the refusal");
  expect(appRow()).toEqual({ tab_closed: 0 });
  expect(leadRuns()).toBe(true);
  // Any key goes back from the refusal.
  type("x");
  await until(() => !flat().includes(refusal) && onLead(), "the list again");
  // With its threads stopped, it goes, clone and all.
  sql("UPDATE threads SET status = 'stopped' WHERE repo = 'app'");
  press("M-w");
  await until(() => seen().includes("Close app?"), "the question again");
  type("r");
  await until(() => seen().includes("Remove app from Skelcrew?"), "the confirm again");
  type("y");
  await until(() => seen().includes(`I am ${siteLead}`), "site's lead");
  await until(() => !/\bapp\b/.test(tabRow()), "app's tab to go");
  await until(() => appRow() === null, "app to be removed");
  expect(existsSync(join(home, ".local", "share", "skelcrew", "repos", "simon", "app"))).toBe(
    false,
  );
  await until(() => !leadRuns(), "app's lead to end");
});

test("closing the last tab leaves the screen on how to open a repository, until a tab comes back", async () => {
  daemon();
  open("lead");
  await ready("lead");
  press("M-w");
  await until(() => seen().includes("Close app?"), "the question");
  type("c");
  await until(() => seen().includes("Close app's tab? y/n"), "the confirm");
  type("y");
  await until(
    () => right().includes("No repository is open. Run sc in a checkout of one to open it."),
    "the empty screen",
  );
  expect(footer()).toBe("  ⌥Q quit");
  expect(screenSessions()).toHaveLength(1);
  expect(seen()).not.toContain("APP-12");
  // Opening app again, such as with sc in another terminal, brings its tab back here.
  sql("UPDATE repositories SET tab_closed = 0 WHERE repo = 'app'");
  agent("lead");
  await until(() => seen().includes("I am lead") && seen().includes("APP-12"), "app again");
});

// Adding or removing a repository can rename others while the question is open, and a name
// can pass to another repository. The question acts on the one it asked about.
test("a repository renamed while the question is open is the one closed, and the one now named app is left alone", async () => {
  addSite();
  daemon();
  open("lead");
  await ready("lead");
  press("M-w");
  await until(() => seen().includes("Close app?"), "the question");
  type("c");
  await until(() => seen().includes("Close app's tab? y/n"), "the confirm");
  sql(`UPDATE repositories SET name = 'simon-app' WHERE repo = 'app';
UPDATE repositories SET name = 'app' WHERE repo = 'site'`);
  type("y");
  await until(() => appRow()?.tab_closed === 1, "simon/app's tab to close");
  await until(() => !leadRuns(), "simon/app's lead to end");
  expect(tmux(agents, "has-session", "-t", `=${siteLead}`).ok).toBe(true);
});
