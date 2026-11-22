// Needs you, against a running daemon: a builder's question, and an error or a usage limit that
// stops its harness. inbox.test.ts has the lead's items.
import { afterEach, beforeEach, describe, expect, test } from "bun:test";
import { rmSync, writeFileSync } from "node:fs";
import { join } from "node:path";
import { insideSandbox, read } from "./harness.ts";
import {
  addApp,
  asLead,
  builder,
  hook,
  lead,
  needsYou,
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
    expect(read(join(lead(), "typed"))).toContain("APP-12 needs you: its builder asked a question");

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
      "APP-12 needs you: its builder's harness stopped on an error",
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
});
