// What sc ps prints of each thread: its columns, cut to fit 80 columns, and the same rows as
// JSON with --json.
import { expect, spyOn, test } from "bun:test";
import { printThreads, type ThreadRow } from "../src/flow/list.ts";

// A row of sc ps for a thread, with no PR or review unless given.
const psRow = (change: Partial<ThreadRow>): ThreadRow => ({
  thread: "app-9",
  short: null,
  title: "Ok",
  status: "working",
  needsYou: false,
  needsYouFor: null,
  queued: false,
  branch: "skelcrew/9",
  pr: null,
  prUrl: null,
  checks: null,
  review: null,
  waiting: 0,
  merge: null,
  ...change,
});

test("sc ps says how many messages wait for each builder, and --json counts them", () => {
  const said: string[] = [];
  const log = spyOn(console, "log").mockImplementation((line: string) => said.push(line));
  const rows = [
    psRow({ thread: "app-9", short: "Fix", waiting: 1 }),
    psRow({ thread: "app-8", short: "Ok", status: "waiting", needsYou: true }),
  ];
  try {
    printThreads(rows, false);
    printThreads(rows, true);
  } finally {
    log.mockRestore();
  }
  expect(said[0]).toEndWith("NEEDS YOU  WAITING");
  expect(said[1]).toEndWith("1");
  expect(said[2]).toEndWith("yes");
  expect(JSON.parse(said[3] ?? "")).toEqual(rows);
});

// The lead's mark says what you must do, which can be long, so sc ps cuts it to keep a row in 80
// columns, and --json gives it whole.
test("sc ps says what each thread needs you for, cut to fit", () => {
  const said: string[] = [];
  const log = spyOn(console, "log").mockImplementation((line: string) => said.push(line));
  const action = "apply the check.yml split in PR #463, then tell the lead";
  const rows = [
    psRow({ thread: "app-9", status: "waiting", needsYou: true, needsYouFor: action }),
    psRow({ thread: "app-8", status: "waiting", needsYou: true, needsYouFor: "round limit" }),
  ];
  try {
    printThreads(rows, false);
    printThreads(rows, true);
  } finally {
    log.mockRestore();
  }
  expect(said[1]).toEndWith("apply the check.yml…");
  expect(said[2]).toEndWith("round limit");
  for (const line of said.slice(0, 3)) expect(Bun.stringWidth(line)).toBeLessThanOrEqual(80);
  expect(JSON.parse(said[3] ?? "")[0].needsYouFor).toBe(action);
});

// MERGE shows only while a thread has an armed merge, as WAITING does for messages.
test("sc ps says which threads merge when ready or without approval, only while one does", () => {
  const said: string[] = [];
  const log = spyOn(console, "log").mockImplementation((line: string) => said.push(line));
  const rows = [
    psRow({ thread: "app-9", merge: { waits: "its checks", skipReview: false } }),
    psRow({ thread: "app-8", merge: { waits: null, skipReview: false } }),
    psRow({ thread: "app-7" }),
    psRow({
      thread: "app-6",
      merge: { waits: "its conflict with main to be fixed", skipReview: true },
    }),
  ];
  try {
    printThreads(rows, false);
    printThreads([psRow({ thread: "app-7" })], false);
  } finally {
    log.mockRestore();
  }
  expect(said[0]).toEndWith("NEEDS YOU  MERGE");
  expect(said[1]).toEndWith("merges when ready");
  expect(said[2]).toEndWith("merges when ready");
  expect(said[3]).toEndWith("working");
  expect(said[4]).toEndWith("merges without approval");
  // What each armed merge waits on goes under the table, as it can be long.
  expect(said.slice(5, 8)).toEqual([
    "",
    "app-9 merges when ready, waiting on its checks.",
    "app-6 merges without approval, waiting on its conflict with main to be fixed.",
  ]);
  expect(said[8]).toEndWith("NEEDS YOU");
  expect(said).toHaveLength(10);
});

// sc ps shows a thread with no short title by its title, cut so the whole row, with its PR, CI
// and review, fits a terminal 80 columns wide.
test("sc ps cuts a long title so each row fits 80 columns", () => {
  const title = "Send people back to the page they came from after signing in";
  const said: string[] = [];
  const log = spyOn(console, "log").mockImplementation((line: string) => said.push(line));
  try {
    printThreads(
      [
        psRow({
          thread: "dotfiles-t12",
          title,
          status: "waiting",
          needsYou: true,
          pr: 242,
          checks: "running",
          review: { state: "reviewing", round: 12, at: null },
        }),
      ],
      false,
    );
  } finally {
    log.mockRestore();
  }
  expect(said).toHaveLength(2);
  for (const line of said) expect(line.length).toBeLessThanOrEqual(80);
  expect(said[1]).toStartWith("dotfiles-t12  Send people");
  expect(said[1]).toContain("…  waiting  #242  running  reviewing r12  yes");
});

// A Japanese title takes two columns for each letter, so it is measured and padded by the
// columns it takes, not its letters, and the columns after it still line up.
test("sc ps lines up and fits rows whose titles mix wide and narrow letters", () => {
  const said: string[] = [];
  const log = spyOn(console, "log").mockImplementation((line: string) => said.push(line));
  try {
    printThreads(
      [
        psRow({ thread: "app-1", title: "ログインのリダイレクトを直して元のページに戻す", pr: 1 }),
        psRow({ thread: "app-2", title: "Send people back to the page they came from", pr: 2 }),
      ],
      false,
    );
  } finally {
    log.mockRestore();
  }
  for (const line of said) expect(Bun.stringWidth(line)).toBeLessThanOrEqual(80);
  // STATUS starts in the same column on every row.
  const at = (line: string) => Bun.stringWidth(line.slice(0, line.indexOf("working")));
  expect(at(said[1] ?? "")).toBe(at(said[2] ?? ""));
});

// A repository's name can be long, and so its threads' names. The name is cut in its middle, so
// its task, which tells threads apart, still shows, and the row still fits.
test("sc ps cuts a long thread name in its middle, keeping its task", () => {
  const said: string[] = [];
  const log = spyOn(console, "log").mockImplementation((line: string) => said.push(line));
  try {
    printThreads(
      [
        psRow({
          thread: "a-repository-with-a-perfectly-valid-long-name-t7",
          title: "Send people back to the page they came from",
          status: "waiting",
          needsYou: true,
          pr: 1234,
          checks: "running",
          review: { state: "reviewing", round: 12, at: null },
        }),
      ],
      false,
    );
  } finally {
    log.mockRestore();
  }
  for (const line of said) expect(Bun.stringWidth(line)).toBeLessThanOrEqual(80);
  expect(said[1]).toStartWith("a-repository-wit…-t7  ");
});

test("sc ps says a thread whose review waits for a place is queued for review", () => {
  const said: string[] = [];
  const log = spyOn(console, "log").mockImplementation((line: string) => said.push(line));
  try {
    const row = { short: "Export", title: null, status: "waiting" } as const;
    printThreads(
      [psRow({ ...row, thread: "app-9", queued: true }), psRow({ ...row, thread: "app-8" })],
      false,
    );
  } finally {
    log.mockRestore();
  }
  expect(said).toEqual([
    "THREAD  TITLE   STATUS             PR  CI  REVIEW  NEEDS YOU",
    "app-9   Export  queued for review",
    "app-8   Export  waiting",
  ]);
});

// With every other column at its widest, a thread queued for review next to one in its twelfth
// round, a long thread name is cut further, to what the row has left, and its task still shows.
test("sc ps fits 80 columns with a long name, a queued review and a late round", () => {
  const said: string[] = [];
  const log = spyOn(console, "log").mockImplementation((line: string) => said.push(line));
  try {
    const row = {
      title: "Send people back to the page they came from",
      status: "waiting",
      needsYou: true,
      pr: 1234,
      checks: "running",
    } as const;
    printThreads(
      [
        psRow({ ...row, thread: "a-repository-with-a-perfectly-valid-long-name-t7", queued: true }),
        psRow({ ...row, thread: "app-8", review: { state: "reviewing", round: 12, at: null } }),
      ],
      false,
    );
  } finally {
    log.mockRestore();
  }
  for (const line of said) expect(Bun.stringWidth(line)).toBeLessThanOrEqual(80);
  expect(said[1]).toStartWith("a-reposi…-t7  Send…  queued for review  #1234  running");
  expect(said[2]).toContain("reviewing r12  yes");
});

// A title comes from the tracker and a short title from the lead, so either could hold a line
// break or a code your terminal would act on.
test("sc ps prints a title or short title with control codes as one clean row", () => {
  const said: string[] = [];
  const log = spyOn(console, "log").mockImplementation((line: string) => said.push(line));
  try {
    printThreads(
      [
        psRow({ title: "Fix\nlogin\x1b[2J" }),
        psRow({ thread: "app-8", short: "Bad\x1b]8;;http://x\x07 one" }),
      ],
      false,
    );
  } finally {
    log.mockRestore();
  }
  expect(said).toHaveLength(3);
  for (const line of said) expect(line).not.toMatch(/\p{Cc}/u);
  expect(said[1]).toStartWith("app-9   Fix login [2J");
});
