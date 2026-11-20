// sc review, against a running daemon: the lead or a thread's own builder asks for its last
// submitted commit to be reviewed again.
import { Database } from "bun:sqlite";
import { afterEach, beforeEach, describe, expect, test } from "bun:test";
import { existsSync, mkdirSync, rmSync, writeFileSync } from "node:fs";
import { join } from "node:path";
import { git, insideSandbox, read } from "./harness.ts";
import {
  addApp,
  builder,
  builderSocket,
  clone,
  codexHome,
  data,
  fakeClaude,
  finished,
  home,
  plugin,
  pushed,
  reviews,
  setUp,
  skel,
  startApp12,
  statuses,
  tearDown,
  thread,
  until,
  verdict,
} from "./submit.ts";

beforeEach(setUp);
afterEach(tearDown);

// Lets a test change a thread as merging its PR would, without polling GitHub.
function setThread(change: string): void {
  const db = new Database(join(data(), "skelcrew.db"));
  db.run("PRAGMA busy_timeout = 5000");
  try {
    db.run(`UPDATE threads SET ${change}`);
  } finally {
    db.close();
  }
}

// app's lead's socket, named by a short hash of its GitHub name.
const leadSocketPath = () => {
  const short = new Bun.CryptoHasher("sha256").update("simon/app").digest("hex").slice(0, 16);
  return join(home, "run", "skelcrew", "leads", short, "skelcrew.sock");
};

describe.skipIf(insideSandbox)("sc review", () => {
  test("reviews a failed review's commit again: posts the verdict, sets the check, and types changes in as a round", async () => {
    addApp();
    verdict(2, "changes", "The export has no test.");
    verdict(3, "approve", "Ready to merge.");
    await startApp12();
    await until(() => thread().review_failed === 1, 30_000);
    const first = pushed();
    const again = await skel(["review", "app-12"]);
    expect(again.err).toBe("");
    expect(again.code).toBe(0);
    expect(again.out).toContain("APP-12");
    await until(() => finished("success").length === 1, 45_000);
    expect(
      statuses()
        .filter((s) => s.sha === first)
        .map((s) => [s.state, s.description]),
    ).toEqual([
      ["pending", "Skelcrew's reviewer is reviewing"],
      ["failure", "review failed"],
      ["pending", "Skelcrew's reviewer is reviewing"],
      ["failure", "Skelcrew's reviewer asked for changes"],
    ]);
    expect(reviews()[0]).toEqual({
      commit: first,
      verdict: "changes",
      body: "The export has no test.\n\n1. The export has no test.",
    });
    expect(read(join(builder(), "typed"))).toContain("The export has no test.");
    await until(() => read(join(data(), "threads", "app-12.log")).includes("waits on CI"));
    expect(thread()).toMatchObject({ status: "waiting", needs_you: 0, rounds: 1 });
  }, 90_000);

  // sc review, like sc submit, leaves the builder's turn waiting on a review, not on you.
  test("a builder that asks for another review and ends its turn doesn't need you", async () => {
    addApp();
    verdict(1, "approve", "Ready to merge.");
    verdict(2, "approve", "Still ready.");
    await startApp12();
    await until(() => read(join(data(), "threads", "app-12.log")).includes("waits on CI"), 30_000);
    // The first turn's own end must come before the turn the test plays, or it would end that.
    await until(() => read(join(builder(), "ended")).trim() === "1", 30_000);
    const asBuilder = { SKELCREW_SOCKET: builderSocket() };
    // You ask the builder for another review: a new turn, in which it runs sc review.
    expect((await skel(["question", "answered"], asBuilder)).code).toBe(0);
    expect((await skel(["review", "app-12"], asBuilder)).err).toBe("");
    expect((await skel(["turn", "ended"], asBuilder)).code).toBe(0);
    await until(() => finished("success").length === 2, 45_000);
    expect(thread().turn_ended).toBe(0);
    expect(read(join(data(), "threads", "app-12.log"))).not.toContain("without submitting");
  }, 90_000);

  // Only the builder's own sc review is a submit in its turn.
  test("a review the lead asks for doesn't hide a builder that then stops without submitting", async () => {
    addApp();
    verdict(1, "approve", "Ready to merge.");
    verdict(2, "approve", "Still ready.");
    await startApp12();
    await until(() => read(join(data(), "threads", "app-12.log")).includes("waits on CI"), 30_000);
    // The first turn's own end must come before the turn the test plays, or it would end that.
    await until(() => read(join(builder(), "ended")).trim() === "1", 30_000);
    const asBuilder = { SKELCREW_SOCKET: builderSocket() };
    // Something typed in starts the builder's turn, and meanwhile the lead asks for a review.
    expect((await skel(["question", "answered"], asBuilder)).code).toBe(0);
    expect((await skel(["review", "app-12"], { SKELCREW_SOCKET: leadSocketPath() })).err).toBe("");
    expect((await skel(["turn", "ended"], asBuilder)).code).toBe(0);
    await until(() => thread().turn_ended === 1);
    await until(() => finished("success").length === 2, 45_000);
  }, 90_000);

  // A review the lead or you ask for after the builder's turn ended answers that turn, so the
  // thread shows the review rather than turn ended.
  test("a review the lead asks for after a turn ended without a submit ends turn ended", async () => {
    addApp();
    verdict(1, "approve", "Ready to merge.");
    verdict(2, "approve", "Still ready.");
    await startApp12();
    await until(() => read(join(data(), "threads", "app-12.log")).includes("waits on CI"), 30_000);
    // The first turn's own end must come before the turn the test plays, or it would end that.
    await until(() => read(join(builder(), "ended")).trim() === "1", 30_000);
    const asBuilder = { SKELCREW_SOCKET: builderSocket() };
    expect((await skel(["question", "answered"], asBuilder)).code).toBe(0);
    expect((await skel(["turn", "ended"], asBuilder)).code).toBe(0);
    await until(() => thread().turn_ended === 1);
    expect((await skel(["review", "app-12"], { SKELCREW_SOCKET: leadSocketPath() })).err).toBe("");
    expect(thread()).toMatchObject({ turn_ended: 0, submitted: 0 });
    await until(() => finished("success").length === 2, 45_000);
  }, 90_000);

  test("refuses a thread with nothing submitted yet, and a thread that is done", async () => {
    addApp();
    fakeClaude(false);
    await startApp12();
    await until(() => read(join(builder(), "args")) !== "");
    const early = await skel(["review", "app-12"]);
    expect(early.code).not.toBe(0);
    expect(early.err).toContain("APP-12 has no submitted commit to review yet");
    setThread("status = 'done'");
    const done = await skel(["review", "app-12"]);
    expect(done.code).not.toBe(0);
    expect(done.err).toContain("APP-12 is done");
    expect(statuses()).toEqual([]);
  }, 60_000);

  test("the lead and the thread's own builder can ask, and a review already running is refused", async () => {
    addApp();
    mkdirSync(codexHome(), { recursive: true });
    writeFileSync(join(codexHome(), "slow-1"), "");
    await startApp12();
    await until(() => existsSync(join(codexHome(), "sessions", "prompt-1")), 30_000);
    const fromLead = await skel(["review", "app-12"], { SKELCREW_SOCKET: leadSocketPath() });
    expect(fromLead.code).not.toBe(0);
    expect(fromLead.err).toContain(
      "a review of APP-12's last commit is already waiting or running",
    );
    // Refused only as already running, so the builder may ask for its own thread.
    const fromBuilder = await skel(["review", "app-12"], { SKELCREW_SOCKET: builderSocket() });
    expect(fromBuilder.code).not.toBe(0);
    expect(fromBuilder.err).toContain(
      "a review of APP-12's last commit is already waiting or running",
    );
    const another = await skel(["review", "app-13"], { SKELCREW_SOCKET: builderSocket() });
    expect(another.code).not.toBe(0);
    expect(another.err).toContain("you may ask for a review of APP-12 only");
  }, 60_000);

  test("a newer sc submit cancels a review asked for again", async () => {
    addApp();
    mkdirSync(codexHome(), { recursive: true });
    writeFileSync(join(codexHome(), "slow-2"), "");
    verdict(2, "approve", "Stale.");
    verdict(3, "approve", "Fresh.");
    await startApp12();
    await until(() => thread().review_failed === 1, 30_000);
    const older = pushed();
    // Held so the second ask comes before the check is pending again.
    writeFileSync(join(plugin, "hold-status-pending"), "");
    expect((await skel(["review", "app-12"], { SKELCREW_SOCKET: leadSocketPath() })).err).toBe("");
    const twice = await skel(["review", "app-12"]);
    expect(twice.err).toContain("a review of APP-12's last commit is already waiting or running");
    rmSync(join(plugin, "hold-status-pending"));
    await until(() => existsSync(join(codexHome(), "sessions", "prompt-2")), 30_000);
    writeFileSync(join(clone(), "change"), "newer\n");
    git(clone(), "commit", "-qam", "newer");
    expect((await skel(["submit", "Newer"], { SKELCREW_SOCKET: builderSocket() })).err).toBe("");
    await until(() => finished("success").length === 1, 30_000);
    expect(finished("success")[0]?.sha).toBe(git(clone(), "rev-parse", "HEAD"));
    expect(
      statuses()
        .filter((s) => s.sha === older)
        .map((s) => s.state),
    ).toEqual(["pending", "failure", "pending"]);
    expect(reviews().map((r) => r.body)).toEqual(["Fresh."]);
  }, 60_000);
});
