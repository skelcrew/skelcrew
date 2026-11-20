// A builder's turn ending, against a running daemon: turn ended and its last message go to the
// lead, not to you, and each of the harness's hooks puts the builder in its state.
import { afterEach, beforeEach, describe, expect, test } from "bun:test";
import { rmSync, writeFileSync } from "node:fs";
import { join } from "node:path";
import { z } from "zod";
import { git, insideSandbox, read } from "./harness.ts";
import {
  addApp,
  builder,
  builderSocket,
  builderState,
  data,
  hook,
  lead,
  leadSocket,
  leadState,
  needsYou,
  notes,
  setColumn,
  setUp,
  skel,
  startApp12,
  submittedAsReviewing,
  tearDown,
  thread,
  until,
} from "./needsyou.ts";

beforeEach(setUp);
afterEach(tearDown);

// bubblewrap can't start inside Skelcrew's own sandbox, so only there builders can't start.
describe.skipIf(insideSandbox)("needs you", () => {
  test("a builder that stops without submitting shows turn ended, and its last message goes to the lead", async () => {
    addApp();
    await startApp12();
    const said = "Which format should the export use?\n1. JSON\n2. CSV";
    await hook("stop", JSON.stringify({ hook_event_name: "Stop", last_assistant_message: said }));
    expect(read(join(builder(), "hooks"))).toBe("");
    await until(() => read(join(lead(), "typed")).includes("2. CSV"));
    const typed = read(join(lead(), "typed"));
    expect(typed).toContain('<skelcrew from="APP-12" reply="sc tell APP-12">');
    expect(typed).toContain(`My turn ended without a submit, saying:\n\n${said}`);
    expect(typed).not.toContain("needs you");
    expect(thread().turn_ended).toBe(1);
    expect(await needsYou()).toBe(false);
    // You answer it in the sidebar, which ends turn ended.
    await hook("talk");
    await until(() => thread().turn_ended === 0);
    // The turn your answer started ends without a submit too. A harness that gives no last
    // message still has the lead told.
    await hook("stop");
    await until(() => notes() === 2);
    expect(read(join(lead(), "typed"))).toContain("My turn ended without a submit.");
    expect(thread().turn_ended).toBe(1);
    expect(await needsYou()).toBe(false);
  }, 60_000);

  // Claude Code's Stop hook lists the background jobs still running. The builder goes on once
  // its job ends, so the lead hears nothing until a turn ends with nothing left running.
  test("a turn that ends with a background job running doesn't show turn ended", async () => {
    addApp();
    await startApp12();
    const running = [{ id: "b1", type: "shell", status: "running", description: "bun test" }];
    const said = "The tests are still running. I'll pick up when they finish.";
    await hook("stop", JSON.stringify({ last_assistant_message: said, background_tasks: running }));
    await Bun.sleep(1000);
    expect(thread().turn_ended).toBe(0);
    expect(notes()).toBe(0);
    await hook(
      "stop",
      JSON.stringify({ last_assistant_message: "Tests pass.", background_tasks: [] }),
    );
    await until(() => thread().turn_ended === 1);
    await until(() => read(join(lead(), "typed")).includes("Tests pass."));
  }, 60_000);

  test("a turn that ends right after sc submit waits on the review, not on you", async () => {
    addApp();
    await startApp12();
    setColumn("submitted");
    await hook("stop");
    await Bun.sleep(1000);
    expect(await needsYou()).toBe(false);
    expect(notes()).toBe(0);
  }, 60_000);

  // A builder that only answers a message, such as the lead's note about something it already
  // fixed, has nothing new to submit, and its last submit still waits on its review. Its words
  // go to the lead rather than bringing you in.
  test("a turn with no new work, while the last submit is reviewed, goes to the lead and doesn't need you", async () => {
    addApp();
    await startApp12();
    submittedAsReviewing();
    await hook("talk");
    const said = "The lead's note about the import order came in after I had already fixed it.";
    await hook("stop", JSON.stringify({ last_assistant_message: said }));
    await until(() => read(join(lead(), "typed")).includes("import order"));
    expect(read(join(lead(), "typed"))).toContain(
      '<skelcrew from="APP-12" reply="sc tell APP-12">',
    );
    expect(await needsYou()).toBe(false);
    expect(thread().turn_ended).toBe(0);
    expect(read(join(lead(), "typed"))).not.toContain("needs you");
  }, 60_000);

  // A long report is shortened for the lead, but a question at its end still reaches it, and
  // the lead reads that some of it was cut.
  test("a long last message keeps its end for the lead, and says it was cut", async () => {
    addApp();
    await startApp12();
    submittedAsReviewing();
    await hook("talk");
    const said = `I went through every file.\n\n${"Checked. ".repeat(500)}\n\nShould the export use JSON or YAML`;
    await hook("stop", JSON.stringify({ last_assistant_message: said }));
    await until(() => read(join(lead(), "typed")).includes("Should the export use JSON or YAML"));
    const typed = read(join(lead(), "typed"));
    expect(typed).toContain("I went through every file.");
    expect(typed).toContain(`[${said.length - 2000} characters cut]`);
  }, 60_000);

  // A note that a thread ended waits while the lead is busy. If the thread starts over first,
  // the lead would take that note for the new thread of the same name, and drop it.
  test("a thread that starts over while the lead is busy drops the note that its old self ended", async () => {
    addApp();
    await startApp12();
    writeFileSync(join(lead(), "busy"), "");
    expect((await skel(["rm", "app-12"])).err).toBe("");
    rmSync(join(builder(), "args"));
    expect((await skel(["start", "app-12"])).err).toBe("");
    await until(() => read(join(builder(), "args")) !== "", 30_000);
    // Notes reach the lead oldest first, so once the new builder's message is in, the old
    // thread's end note would be too.
    rmSync(join(lead(), "busy"));
    const asBuilder = { SKELCREW_SANDBOX: "1", SKELCREW_SOCKET: builderSocket() };
    expect((await skel(["tell", "lead", "Starting again."], asBuilder)).code).toBe(0);
    await until(() => read(join(lead(), "typed")).includes("Starting again."));
    expect(read(join(lead(), "typed"))).not.toContain("APP-12 ended");
  }, 60_000);

  test("a turn that leaves work it didn't submit shows turn ended, even while the last submit is reviewed", async () => {
    addApp();
    await startApp12();
    submittedAsReviewing();
    writeFileSync(join(data(), "threads", "app-12", "export.ts"), "export {};\n");
    await hook("stop", JSON.stringify({ last_assistant_message: "Started on the export." }));
    await until(() => thread().turn_ended === 1);
    await until(() => read(join(lead(), "typed")).includes("Started on the export."));
    expect(await needsYou()).toBe(false);
  }, 60_000);

  // The clone's own settings could hide a new file from git status, and with it the work.
  test("a new file a clone's settings hide from git status still shows turn ended", async () => {
    addApp();
    await startApp12();
    submittedAsReviewing();
    const clone = join(data(), "threads", "app-12");
    git(clone, "config", "status.showUntrackedFiles", "no");
    writeFileSync(join(clone, "export.ts"), "export {};\n");
    await hook("stop", JSON.stringify({ last_assistant_message: "Started on the export." }));
    await until(() => thread().turn_ended === 1);
  }, 60_000);

  test("a turn that ends on an error needs you for the error alone", async () => {
    addApp();
    await startApp12();
    await hook("fail");
    await until(() => notes() === 1);
    await Bun.sleep(1000);
    expect(notes()).toBe(1);
    expect(read(join(lead(), "typed"))).not.toContain("without a submit");
  }, 60_000);

  // Claude Code's hooks reference says Esc runs no Stop hook, and the fake runs none for it. What
  // Skelcrew controls is which hooks builders get: none of them may be one Claude Code runs on
  // Esc, so a new one must be checked against the reference before it joins this list.
  test("pressing Esc in a builder's turn doesn't mark it needing you", async () => {
    addApp();
    await startApp12();
    const given = read(join(builder(), "args")).split("\n");
    const Settings = z.object({ hooks: z.record(z.string(), z.unknown()) });
    const settings = Settings.parse(JSON.parse(given[given.indexOf("--settings") + 1] ?? "{}"));
    expect(Object.keys(settings.hooks).sort()).toEqual([
      "PostToolUse",
      "PreToolUse",
      "Stop",
      "StopFailure",
      "UserPromptSubmit",
    ]);
    await hook("interrupt");
    await Bun.sleep(1000);
    expect(await needsYou()).toBe(false);
  }, 60_000);

  test("each of Claude Code's hooks puts the builder in its state", async () => {
    addApp();
    await startApp12();
    // The builder shows its busy mark throughout, so its screen never says it idles.
    writeFileSync(join(builder(), "busy"), "");
    await hook("talk");
    expect(builderState()).toBe("working");
    await hook("ask");
    expect(builderState()).toBe("asking");
    await hook("answer");
    expect(builderState()).toBe("working");
    await hook("stop");
    expect(builderState()).toBe("idle");
    await hook("talk");
    expect(builderState()).toBe("working");
    await hook("fail");
    expect(builderState()).toBe("error");
    expect(read(join(builder(), "hooks"))).toBe("");
  }, 60_000);

  // Esc runs no hook on Claude Code, so only the screen can tell.
  test("a builder stopped with Esc shows idle once its busy mark is gone, and doesn't need you", async () => {
    addApp();
    await startApp12();
    writeFileSync(join(builder(), "busy"), "");
    await hook("talk");
    // While its busy mark shows, it works, however long the turn takes.
    await Bun.sleep(5000);
    expect(builderState()).toBe("working");
    rmSync(join(builder(), "busy"));
    await hook("interrupt");
    await until(() => builderState() === "idle");
    expect(await needsYou()).toBe(false);
  }, 60_000);

  test("the lead gets the builders' hooks, which change its state and flag nothing", async () => {
    addApp();
    await startApp12();
    // The same hooks as a builder's.
    await until(() => read(join(lead(), "args")) !== "");
    const given = read(join(lead(), "args")).split("\n");
    const Settings = z.object({ hooks: z.record(z.string(), z.unknown()) });
    const settings = Settings.parse(JSON.parse(given[given.indexOf("--settings") + 1] ?? "{}"));
    expect(Object.keys(settings.hooks).sort()).toEqual([
      "PostToolUse",
      "PreToolUse",
      "Stop",
      "StopFailure",
      "UserPromptSubmit",
    ]);
    // The lead shows its busy mark, so its screen never says it idles. Each hook's command runs
    // from the lead's socket, as the lead's Claude Code would run it.
    writeFileSync(join(lead(), "busy"), "");
    const asLead = (args: string[]) =>
      skel(args, { SKELCREW_SANDBOX: "1", SKELCREW_SOCKET: leadSocket() });
    for (const [args, state] of [
      [["question", "answered"], "working"],
      [["question", "asked"], "asking"],
      [["question", "closed"], "working"],
      [["turn", "ended"], "idle"],
      [["question", "answered"], "working"],
      [["turn", "failed"], "error"],
    ] as const) {
      const run = await asLead([...args]);
      expect(run.err).toBe("");
      expect(run.out).toBe("");
      expect(leadState()).toBe(state);
    }
    // Nothing the lead did touched the thread or brought a note.
    await Bun.sleep(1000);
    expect(await needsYou()).toBe(false);
    expect(builderState()).toBe(null);
    expect(notes()).toBe(0);
  }, 60_000);
});
