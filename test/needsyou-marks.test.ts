// Needs you, against a running daemon: a builder's question, an error or a usage limit that stops
// its harness, the marks the lead and you set, and the safety net for a builder nobody acted on.
import { afterEach, beforeEach, describe, expect, test } from "bun:test";
import { rmSync, writeFileSync } from "node:fs";
import { join } from "node:path";
import { insideSandbox, read } from "./harness.ts";
import {
  addApp,
  asLead,
  builder,
  builderSocket,
  data,
  graceMinutes,
  hook,
  lead,
  needsYou,
  needsYouFor,
  notes,
  setUp,
  skel,
  startApp12,
  tearDown,
  thread,
  until,
  untilNeedsYou,
} from "./needsyou.ts";

beforeEach(setUp);
afterEach(tearDown);

// bubblewrap can't start inside Skelcrew's own sandbox, so only there builders can't start.
describe.skipIf(insideSandbox)("needs you", () => {
  test("a builder's question marks the thread needs you, tells the lead once, and clears when answered", async () => {
    addApp();
    await startApp12();
    expect(await needsYou()).toBe(false);

    await hook("ask");
    expect(read(join(builder(), "hooks"))).toBe("");
    await untilNeedsYou(true);
    await until(() => notes() === 1);
    expect(read(join(lead(), "typed"))).toContain("app-12 needs you: its builder asked a question");

    // A second question while the first still waits is no news.
    await hook("ask");
    await hook("answer");
    expect(read(join(builder(), "hooks"))).toBe("");
    await untilNeedsYou(false);
    await Bun.sleep(1500);
    expect(notes()).toBe(1);

    // A question you set aside, then talked past, is over too.
    await hook("ask");
    await untilNeedsYou(true);
    await until(() => notes() === 2);
    await hook("talk");
    await untilNeedsYou(false);
  }, 60_000);

  test("a builder whose harness stops on an error needs you, tells the lead, and clears when you type to it", async () => {
    addApp();
    await startApp12();
    await hook("fail");
    expect(read(join(builder(), "hooks"))).toBe("");
    await untilNeedsYou(true);
    await until(() => notes() === 1);
    expect(read(join(lead(), "typed"))).toContain(
      "app-12 needs you: its builder's harness stopped on an error",
    );
    // You fix it, such as with /login, and type to the builder.
    await hook("talk");
    await untilNeedsYou(false);
  }, 60_000);

  test("a builder stopped by its usage limit waits for the reset without needing you, then is told to continue", async () => {
    addApp();
    await startApp12();
    // Claude Code's StopFailure hook is given the kind of error and what it showed.
    // Far enough off to see the thread wait before the reset comes.
    const reset = Math.ceil(Date.now() / 1000) + 8;
    const said = `Claude AI usage limit reached|${reset}`;
    await hook("limit", JSON.stringify({ error: "rate_limit", last_assistant_message: said }));
    expect(read(join(builder(), "hooks"))).toBe("");
    await until(() => thread().limited === 1);
    expect(thread()).toMatchObject({ erred: 1, limit_reset: reset * 1000 });
    expect(await needsYou()).toBe(false);
    // At the reset, Skelcrew types continue into the builder, and nobody hears of it.
    await until(() => read(join(builder(), "typed")).includes("continue"), 30_000);
    expect(thread()).toMatchObject({ erred: 0, limited: 0, limit_reset: null });
    expect(notes()).toBe(0);
  }, 60_000);

  // The builder's own last words can mention rate limits, such as the code it was writing.
  test("a login error is no usage limit, whatever the builder last said, and needs you", async () => {
    addApp();
    await startApp12();
    const said =
      "I added rate limit handling to the API client.\nOAuth token has expired. Please run /login";
    await hook(
      "limit",
      JSON.stringify({ error: "authentication_failed", last_assistant_message: said }),
    );
    await untilNeedsYou(true);
    expect(thread()).toMatchObject({ erred: 1, limited: 0 });
  }, 60_000);

  // The wake waits for the builder to be idle, so it can still be waiting when the error ends.
  for (const [ends, step] of [
    ["you type to it", "talk"],
    ["it meets another error", "fail"],
  ] as const)
    test(`a wake planned for a usage limit never types once ${ends}`, async () => {
      addApp();
      await startApp12();
      const said = `Claude AI usage limit reached|${Math.ceil(Date.now() / 1000) + 2}`;
      await hook("limit", JSON.stringify({ error: "rate_limit", last_assistant_message: said }));
      await until(() => thread().limited === 1);
      // Busy past the reset, so the wake waits to type, and the error ends meanwhile. The wake
      // clears the limit as it starts to type.
      writeFileSync(join(builder(), "busy"), "");
      await until(() => thread().limited === 0);
      await hook(step);
      rmSync(join(builder(), "busy"));
      // One message at a time goes into a builder, so the lead's, typed once the turn you
      // started has ended, goes in only after the wake's typing is over. A "continue" would
      // have gone in before it.
      if (step === "talk") await hook("stop");
      await asLead(["tell", "app-12", "Carry on with the export."]);
      await until(() => read(join(builder(), "typed")).includes("Carry on with the export."));
      expect(read(join(builder(), "typed"))).not.toContain("continue");
    }, 60_000);

  test("stopping a builder that waits out a usage limit forgets the limit", async () => {
    addApp();
    await startApp12();
    const said = `Claude AI usage limit reached|${Math.ceil(Date.now() / 1000) + 3600}`;
    await hook("limit", JSON.stringify({ error: "rate_limit", last_assistant_message: said }));
    await until(() => thread().limited === 1);
    expect((await skel(["stop", "app-12"])).err).toBe("");
    expect(thread()).toMatchObject({ status: "stopped", erred: 0, limited: 0, limit_reset: null });
  }, 60_000);

  // The builder may have written a question as plain text, or only replied. The lead reads its
  // words and brings a real question to you.
  // Only the human can unblock it, so the lead marks it, saying what to do. It said so itself,
  // so it gets no note of it.
  test("the lead marks a thread with what you must do, which sc ps and sc show say, and clears it", async () => {
    addApp();
    await startApp12();
    const action = "apply the check.yml split in PR #463";
    const marked = await asLead(["needs-you", "app-12", action]);
    expect(marked.err).toBe("");
    expect(marked.out).toContain(`app-12 needs you: ${action}`);
    await untilNeedsYou(true);
    expect(await needsYouFor()).toBe(action);
    expect((await skel(["show", "app-12"])).out).toContain(`needs you: ${action}`);
    await until(() => read(join(data(), "threads", "app-12.log")).includes("the lead marked it"));
    await Bun.sleep(1500);
    expect(notes()).toBe(0);

    const cleared = await asLead(["needs-you", "--clear", "app-12"]);
    expect(cleared.err).toBe("");
    expect(cleared.out).toContain("app-12 no longer needs you.");
    await untilNeedsYou(false);
    expect(read(join(data(), "threads", "app-12.log"))).toContain(
      `the lead cleared its needs you: ${action}`,
    );
  }, 60_000);

  test("you can mark a thread too, and the lead hears of it, but a builder can't", async () => {
    addApp();
    await startApp12();
    const builder = { SKELCREW_SANDBOX: "1", SKELCREW_SOCKET: builderSocket() };
    const refused = await skel(["needs-you", "app-12", "answer me"], builder);
    expect(refused.code).not.toBe(0);
    expect(await needsYou()).toBe(false);

    expect((await skel(["needs-you", "app-12", "check the new design"])).err).toBe("");
    await untilNeedsYou(true);
    await until(() => notes() === 1);
    expect(read(join(lead(), "typed"))).toContain(
      "app-12 needs you: you marked it: check the new design",
    );
  }, 60_000);

  // The lead's message goes in as Skelcrew types it, so only text Skelcrew didn't type is yours.
  test("a mark clears when you type to the builder, but not when the lead's message goes in", async () => {
    addApp();
    await startApp12();
    await asLead(["needs-you", "app-12", "say which export format you want"]);
    await untilNeedsYou(true);
    const before = read(join(builder(), "ran")).split("\n").length;
    expect((await asLead(["tell", "app-12", "Hold on, the human decides."])).err).toBe("");
    await until(() => read(join(builder(), "ran")).split("\n").length > before);
    expect(read(join(builder(), "typed"))).toContain("Hold on, the human decides.");
    await Bun.sleep(1000);
    expect(await needsYou()).toBe(true);

    await hook("talk", JSON.stringify({ prompt: "JSON, please." }));
    await untilNeedsYou(false);
    expect(read(join(data(), "threads", "app-12.log"))).toContain("you typed to its builder");
  }, 60_000);

  // Stopping isn't the thing a mark is about, so what you must do stays shown.
  test("stopping a thread keeps its mark", async () => {
    addApp();
    await startApp12();
    await asLead(["needs-you", "app-12", "apply the check.yml split in PR #463"]);
    await untilNeedsYou(true);
    expect((await skel(["stop", "app-12"])).err).toBe("");
    await until(() => thread().status === "stopped");
    expect(thread().needs_you_for).toBe("apply the check.yml split in PR #463");
    expect(await needsYouFor()).toBe("apply the check.yml split in PR #463");
  }, 60_000);

  test("removing a thread ends its mark", async () => {
    addApp();
    await startApp12();
    await asLead(["needs-you", "app-12", "say which export format you want"]);
    await untilNeedsYou(true);
    expect((await skel(["rm", "app-12"])).err).toBe("");
    await until(() => thread().status === "done");
    expect(thread().needs_you_for).toBe(null);
  }, 60_000);

  // The lead hears of a builder that stopped, but may be busy or miss it, so nothing waits unseen.
  test("a stopped builder nobody acts on needs you after the grace, with its last message", async () => {
    graceMinutes(0.02);
    addApp();
    await startApp12();
    const said = "Should I delete the old exports?";
    await hook("stop", JSON.stringify({ hook_event_name: "Stop", last_assistant_message: said }));
    await untilNeedsYou(true);
    expect(await needsYouFor()).toBe(said);
    await until(() =>
      read(join(lead(), "typed")).includes(
        `app-12 needs you: nobody acted on its stopped builder for 0.02 minutes: ${said}`,
      ),
    );
    // The lead clears it, and the safety net doesn't mark it again.
    expect((await asLead(["needs-you", "--clear", "app-12"])).err).toBe("");
    await untilNeedsYou(false);
    await Bun.sleep(3000);
    expect(await needsYou()).toBe(false);
  }, 60_000);

  // The lead acted as it told the builder, though the message waits until the builder can take it.
  test("the lead's reply stops the safety net while it still waits to be typed in", async () => {
    graceMinutes(0.05);
    addApp();
    await startApp12();
    await hook("stop", JSON.stringify({ last_assistant_message: "Delete the old exports?" }));
    await until(() => thread().turn_ended === 1);
    // The builder looks busy, so the reply waits.
    writeFileSync(join(builder(), "busy"), "");
    const told = await asLead(["tell", "app-12", "Yes, delete them."]);
    expect(told.out).toContain("can't take it yet");
    expect(thread().ended_at).toBe(null);
    await Bun.sleep(4000);
    expect(await needsYou()).toBe(false);
    expect(read(join(builder(), "typed"))).not.toContain("Yes, delete them.");
  }, 60_000);

  test("telling or clearing a stopped builder in time keeps the safety net from marking it", async () => {
    graceMinutes(0.05);
    addApp();
    await startApp12();
    await hook("stop", JSON.stringify({ last_assistant_message: "Delete the old exports?" }));
    await until(() => thread().turn_ended === 1);
    expect((await asLead(["tell", "app-12", "Yes, delete them."])).err).toBe("");
    await until(() => thread().turn_ended === 0);
    await Bun.sleep(4000);
    expect(await needsYou()).toBe(false);

    await hook("stop", JSON.stringify({ last_assistant_message: "Done. Anything else?" }));
    await until(() => thread().turn_ended === 1);
    expect((await asLead(["needs-you", "--clear", "app-12"])).err).toBe("");
    await Bun.sleep(4000);
    expect(await needsYou()).toBe(false);
    expect(thread().turn_ended).toBe(1);
  }, 60_000);
});
