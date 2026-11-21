// The tabs, one for each repository: switching between them, a tab closing, a lead that
// stopped being brought back, and a repository removed while the screen shows it.
import { afterEach, beforeEach, expect, test } from "bun:test";
import { existsSync, mkdirSync, writeFileSync } from "node:fs";
import { join } from "node:path";
import { startSession } from "../src/agents/sessions.ts";
import { leadPlaces } from "../src/paths.ts";
import { source, threadSql } from "./harness.ts";
import {
  agent,
  agents,
  asked,
  click,
  daemon,
  endTest,
  env,
  home,
  labels,
  onDetails,
  onLead,
  open,
  pathNow,
  press,
  read,
  ready,
  right,
  screenSessions,
  seen,
  selected,
  sql,
  startTest,
  tabRow,
  terminal,
  tmux,
  type,
  until,
} from "./screen.ts";

beforeEach(startTest);
afterEach(endTest);

// site, a second repository, whose thread needs you, and whose lead runs.
const siteLead = leadPlaces("simon", "site").name;
function addSite(): void {
  sql(`INSERT INTO repositories (name, owner, repo) VALUES ('site', 'simon', 'site');
${threadSql({ repo: "site", task: "8", status: "waiting", needs_you: 1 })}`);
  agent(siteLead);
}

test("a tab for each repository runs across the top, with a badge for what needs you", async () => {
  addSite();
  open("lead");
  await ready("lead");
  await until(() => /^ {4}Skelcrew .* {2}app {4}site •1$/.test(tabRow()), "the tabs");
  const colours = tmux(terminal, "capture-pane", "-p", "-e", "-t", "=one:").out.split("\n")[0];
  // The open one is on its dark grey, the others on a lighter one.
  expect(colours).toContain("48;5;234");
  expect(colours).toContain("48;5;237");
  // The sidebar shows only app's threads.
  expect(seen()).not.toMatch(/[○●] 8\b/);
});

test("Alt-Shift-Right and Alt-Shift-Left switch both sides to the repository beside, wrapping round, and open it", async () => {
  addSite();
  daemon();
  open("lead");
  await ready("lead");
  press("M-S-Right");
  await until(() => seen().includes(`I am ${siteLead}`), "site's lead");
  await until(() => /[○●] 8\b/.test(seen()) && !/[○●] 12\b/.test(seen()), "site's threads");
  expect(onLead()).toBe(true);
  await until(() => asked.includes("open simon/site from a tab"), "the daemon to open site");
  type("hello\r");
  await until(() => existsSync(join(home, `${siteLead}.typed`)), "the typing");
  // After the last tab comes the first, and before the first the last.
  press("M-S-Right");
  await until(() => seen().includes("I am lead") && /[○●] 12\b/.test(seen()), "app again");
  press("M-S-Left");
  await until(() => seen().includes(`I am ${siteLead}`), "site's lead again");
});

test("a lead on a plugin's host shows through that host from its tab, and comes back once it ends", async () => {
  daemon();
  sql(`INSERT INTO repositories (name, owner, repo) VALUES ('site', 'simon', 'site')`);
  // The host lists site's lead as running while its file running says true.
  const plugin = join(home, "plugin-fake");
  mkdirSync(plugin, { recursive: true });
  writeFileSync(join(plugin, "running"), "true");
  writeFileSync(
    join(plugin, "session.sh"),
    `read -r question; echo >> listed; echo "{\\"sessions\\":[{\\"id\\":\\"fake-site-lead\\",\\"running\\":$(cat running),\\"labels\\":null}]}"\n`,
  );
  writeFileSync(join(plugin, "attach.sh"), 'echo "I am $1 on fake"; exec sleep 300\n');
  writeFileSync(
    join(plugin, "skelcrew-plugin.yaml"),
    "name: fake\nversion: 0.1.0\nskelcrew: 0.1.0\nabout: A host\nkind: runtime\nprovides: [sessions]\nsession: [sh, session.sh]\nattach: [sh, attach.sh]\n",
  );
  sql(`INSERT INTO plugins (name, folder) VALUES ('fake', '${plugin}');
UPDATE repositories SET lead_host = 'fake', lead_host_id = 'fake-site-lead' WHERE repo = 'site'`);
  open("lead");
  await ready("lead");
  press("M-S-Right");
  await until(() => seen().includes("I am fake-site-lead on fake"), "site's lead on its host");
  await until(() => onLead(), "the sidebar on site's lead");
  const opened = () => asked.filter((one) => one === "open simon/site from a tab").length;
  await until(() => opened() === 1, "the daemon to open site");
  // Once the sidebar has seen the lead run on its host, a lead that ends there is brought back.
  const looks = () => read(join("plugin-fake", "listed")).split("\n").length;
  await until(() => looks() > 2, "the sidebar to ask the host");
  writeFileSync(join(plugin, "running"), "false");
  await until(() => opened() === 2, "the daemon to bring site's lead back");
  press("M-S-Left");
  await until(() => seen().includes("I am lead") && /[○●] 12\b/.test(seen()), "app again");
});

test("a click on a tab switches to its repository", async () => {
  addSite();
  daemon();
  open("lead");
  await ready("lead");
  await until(() => tabRow().includes("site"), "the tabs");
  click(tabRow().indexOf("site") + 2, 1);
  await until(() => seen().includes(`I am ${siteLead}`), "site's lead");
  await until(() => /[○●] 8\b/.test(seen()), "site's threads");
  // A click on the row under the tabs, the top of the boxes, switches nothing.
  click(tabRow().indexOf("app") + 2, 2);
  await Bun.sleep(300);
  expect(seen()).toMatch(/[○●] 8\b/);
  click(tabRow().indexOf("app") + 2, 1);
  await until(() => seen().includes("I am lead") && /[○●] 12\b/.test(seen()), "app again");
});

// A terminal can hand both keys over at once, and the second must move in the new repository.
test("several Alt keys typed together all move, and none is typed into the agent", async () => {
  open("lead");
  await ready("lead");
  // The second task is five rows down, past the headings of the task queue, Backlog and
  // Building. Nothing needs you, so Needs you has no heading.
  type("\x1b[1;3B".repeat(5));
  await until(() => / 7\b/.test(selected()), "the second task");
  await until(onDetails, "app-7's details");
  await Bun.sleep(300);
  expect(read("lead.typed")).toBe("");
});

test("Alt-Shift-Right then Alt-Shift-Down, typed together, lands on the new repository's task", async () => {
  addSite();
  agent("site-8");
  daemon();
  open("lead");
  await ready("lead");
  type("\x1b[1;4C\x1b[1;4B");
  await until(() => / 8\b/.test(selected()), "the sidebar on SITE-8");
  await until(onDetails, "site-8's details");
  expect(seen()).not.toMatch(/[○●] 12\b/);
});

// The daemon closes a repository's tab when you exit its lead, by marking it in the database.
const closeTab = (repo: string) =>
  sql(`UPDATE repositories SET tab_closed = 1 WHERE repo = '${repo}'`);

test("a tab that closes moves the screen to the tab after it, and leaves the threads alone", async () => {
  addSite();
  daemon();
  open("lead");
  await ready("lead");
  await until(() => tabRow().includes("site"), "the tabs");
  closeTab("app");
  await until(() => seen().includes(`I am ${siteLead}`), "site's lead");
  await until(() => /[○●] 8\b/.test(seen()) && !/\bapp\b/.test(tabRow()), "app's tab to go");
  // The sidebar asks the daemon without waiting, and its request goes out only after it has
  // shown site, so site can show before the request lands.
  await until(() => asked.includes("open simon/site from a tab"), "the daemon to open site");
  // Nothing of app's ended: its builders still run.
  expect(tmux(agents, "has-session", "-t", "=app-7").ok).toBe(true);
});

test("the last tab closing moves the screen to the tab before it", async () => {
  addSite();
  daemon();
  open("lead");
  await ready("lead");
  press("M-S-Right");
  await until(() => seen().includes(`I am ${siteLead}`), "site's lead");
  closeTab("site");
  await until(() => seen().includes("I am lead") && /[○●] 12\b/.test(seen()), "app again");
  expect(tabRow()).not.toContain("site");
});

test("with no tab left, the screen stays, saying how to open a repository", async () => {
  open("lead");
  await ready("lead");
  closeTab("app");
  await until(() => right().includes("No repository is open."), "the empty screen");
  expect(read("left-one")).toBe("");
  expect(screenSessions()).toHaveLength(1);
  expect(tmux(agents, "has-session", "-t", "=lead").ok).toBe(true);
});

test("a lead that stops while you look at it is brought back, once", async () => {
  daemon();
  open("lead");
  await ready("lead");
  tmux(agents, "kill-session", "-t", "=lead");
  await until(
    () => asked.includes("open simon/app from a tab"),
    "the daemon to bring the lead back",
  );
  // The stand-in brings nothing back, and the sidebar doesn't ask again each second. The right
  // side says once that it waits, never tmux's error each second. Two seconds see the sidebar
  // look twice.
  await Bun.sleep(2000);
  expect(asked.filter((open) => open === "open simon/app from a tab")).toHaveLength(1);
  expect(right().split("Waiting for the lead to start.")).toHaveLength(2);
  expect(seen()).not.toContain("can't find session");
});

// The right side falls back to the lead when the builder you look at ends. A lead that went
// while you looked at the builder must be asked back then, or the right side waits forever.
test("a lead that stopped while you look at a builder is brought back once the builder ends", async () => {
  daemon();
  open("app-7");
  await ready("app-7");
  tmux(agents, "kill-session", "-t", "=lead");
  await Bun.sleep(1500);
  expect(asked).toEqual([]);
  tmux(agents, "kill-session", "-t", "=app-7");
  await until(
    () => asked.includes("open simon/app from a tab"),
    "the daemon to bring the lead back",
  );
  await until(() => right().includes("Waiting for the lead to start."), "the waiting line");
});

test("a lead you exited isn't brought back, as its tab closes", async () => {
  daemon();
  open("lead");
  await ready("lead");
  tmux(agents, "set", "-w", "-t", "=lead:", "remain-on-exit", "on");
  tmux(agents, "respawn-pane", "-k", "-t", "=lead:", "sh", "-c", "exit 0");
  await until(
    () => tmux(agents, "display-message", "-p", "-t", "=lead:", "#{pane_dead}").out.trim() === "1",
    "the lead to exit",
  );
  await Bun.sleep(2000);
  expect(asked).toEqual([]);
});

test("a repository removed while the screen shows it loses its tab, and the screen moves on", async () => {
  addSite();
  daemon();
  open("lead");
  await ready("lead");
  sql("DELETE FROM repositories WHERE repo = 'app'");
  tmux(agents, "kill-session", "-t", "=lead");
  await until(() => seen().includes(`I am ${siteLead}`), "site's lead");
  await until(() => !/\bapp\b/.test(tabRow()), "app's tab to go");
  expect(seen()).not.toContain("can't find session");
});

// sc repo rm ends the lead and waits for it before it removes the repository. A screen that
// finds the lead gone meanwhile must not take it for a crash and ask the daemon to bring back
// the lead of a repository on its way out.
test("sc repo rm while the screen shows the repository moves the screen on, and never asks for its lead", async () => {
  addSite();
  daemon();
  sql("UPDATE threads SET status = 'stopped' WHERE repo = 'app'");
  // A lead that takes a few seconds to end, as a real one can.
  tmux(agents, "kill-session", "-t", "=lead");
  startSession(agents, "lead", {
    folder: home,
    command: ["sh", "-c", "trap 'sleep 3; exit' HUP; echo I am lead; while :; do sleep 0.2; done"],
    env: { PATH: pathNow },
    labels,
  });
  open("lead");
  await ready("lead");
  const script = `import { removeRepo } from ${JSON.stringify(source("flow/repo.ts"))};
await removeRepo("app", ${JSON.stringify(agents)});`;
  const removed = Bun.spawn([process.execPath, "-e", script], { env: env(), stderr: "pipe" });
  expect(await removed.exited).toBe(0);
  await until(() => seen().includes(`I am ${siteLead}`), "site's lead");
  await until(() => !/\bapp\b/.test(tabRow()), "app's tab to go");
  expect(asked.filter((open) => open.includes("simon/app"))).toEqual([]);
  expect(seen()).not.toContain("can't find session");
});
