// The `skelcrew` command line. `run` takes the arguments and returns what to
// print and the exit code, so tests can call it as a function.
//
// Every argument is checked here before it reaches the daemon. Every
// answer from the daemon is checked against the shape this command expects.

import { existsSync, readFileSync, statSync } from "node:fs";
import { dirname, join, resolve } from "node:path";
import { parseArgs } from "node:util";
import * as z from "zod";
import { SessionId, TaskId } from "../core/ids";
import { phaseNames, type WaitingOn } from "../core/task";
import type { Phase } from "../core/types";
import { request, type Started } from "../daemon/client";
import { serveUntilSignalled } from "../daemon/server";
import type { Command } from "../protocol/protocol";
import { commandHelp, mainHelp } from "./help";

export type Context = {
  cwd: string;
  // SKELCREW_SESSION, which agents' reports carry.
  session: string | undefined;
  readStdin: () => Promise<string>;
  // Starts the repository's daemon in the background.
  start: (repo: string) => Started;
  startTimeoutMs?: number;
  // Prints a line at once, for `serve`, which runs until it is stopped.
  announce?: (line: string) => void;
};

export type Outcome = { code: number; out: string[]; err: string[] };

const said = (...out: string[]): Outcome => ({ code: 0, out, err: [] });
const refused = (...err: string[]): Outcome => ({ code: 1, out: [], err });

type Handler = (args: string[], context: Context) => Promise<Outcome>;

export async function run(args: string[], context: Context): Promise<Outcome> {
  const [name, ...rest] = args;
  if (name === undefined) {
    return { code: 1, out: mainHelp, err: ["The TUI isn't built yet. Use the commands above."] };
  }
  if (name === "--help" || name === "-h" || name === "help") return said(...mainHelp);
  if (name === "init") {
    return refused("`skelcrew init` isn't built yet. It comes with pull request #34.");
  }
  const handler = handlers[name];
  if (handler === undefined) {
    return refused(`There is no command ${name}. Run \`skelcrew --help\` to see them all.`);
  }
  if (rest.includes("--help") || rest.includes("-h")) return said(...(commandHelp[name] ?? []));
  return handler(rest, context);
}

const handlers: Record<string, Handler> = {
  add: async (args, context) => {
    const parsed = parse("add", () =>
      parseArgs({
        args,
        allowPositionals: true,
        options: { spec: { type: "boolean" }, project: { type: "string" } },
      }),
    );
    if (!parsed.ok) return parsed.outcome;
    const [title, ...extra] = parsed.value.positionals;
    if (title === undefined || title.trim() === "") {
      return refused('Say what the task is, like this: skelcrew add "CSV export"');
    }
    if (extra.length > 0) {
      return refused('Put the task in quotes, like this: skelcrew add "CSV export"');
    }
    const withSpec = parsed.value.values.spec ?? false;
    const project = parsed.value.values.project ?? null;
    const command: Command = { type: "add", title, spec: withSpec, project };
    return ask(context, command, z.object({ task: TaskId }), ({ task }) =>
      said(`Added #${task}: ${title}.`, ...(withSpec ? ["It waits for a spec."] : [])),
    );
  },

  spec: async (args, context) =>
    withTask("spec", args, {}, (task) =>
      ask(context, { type: "spec", task }, anything, () => said(`Asked for a spec for #${task}.`)),
    ),

  approve: async (args, context) =>
    withTask("approve", args, { "send-back": { type: "string" } }, (task, values) => {
      const note = values["send-back"];
      if (note !== undefined && typeof note !== "string") return usage("approve");
      if (note !== undefined && note.trim() === "") {
        return refused('Say what to change, like this: --send-back "Add totals."');
      }
      return ask(context, { type: "approve", task, sendBack: note ?? null }, anything, () =>
        said(note === undefined ? `Approved #${task}.` : `Sent #${task} back with your note.`),
      );
    }),

  drop: async (args, context) =>
    withTask("drop", args, {}, (task) =>
      ask(context, { type: "drop", task }, anything, () => said(`Dropped #${task}.`)),
    ),

  status: async (args, context) => {
    const parsed = parse("status", () => parseArgs({ args, options: {} }));
    if (!parsed.ok) return parsed.outcome;
    return ask(context, { type: "status" }, statusResult, ({ tasks }) => said(...status(tasks)));
  },

  log: async (args, context) =>
    withTask("log", args, {}, (task) =>
      ask(context, { type: "log", task }, anything, (result) =>
        said(...JSON.stringify(result, null, 2).split("\n")),
      ),
    ),

  claim: async (args, context) =>
    withTask("claim", args, {}, (task) =>
      ask(context, { type: "claim", task }, claimResult, (claim) => said(...claimed(task, claim))),
    ),

  submit: async (args, context) =>
    withTask("submit", args, { file: { type: "string" } }, async (task, values) => {
      const session = sessionOf(context, `submit ${task}`);
      if (!session.ok) return session.outcome;
      const file = values.file;
      if (file !== undefined && typeof file !== "string") return usage("submit");
      const spec = await readSpec(file, context);
      if (!spec.ok) return spec.outcome;
      const command: Command = { type: "submit", task, session: session.value, spec: spec.value };
      return ask(context, command, anything, () => said(`Submitted the spec for #${task}.`));
    }),

  done: async (args, context) =>
    withTask("done", args, {}, (task) => {
      const session = sessionOf(context, `done ${task}`);
      if (!session.ok) return session.outcome;
      return ask(context, { type: "done", task, session: session.value }, doneResult, (result) =>
        result.passed
          ? said(`The checks passed for #${task}.`)
          : {
              code: 1,
              out: [`The checks failed for #${task}.`, ...result.summary.split("\n")],
              err: [],
            },
      );
    }),

  "give-up": async (args, context) => {
    const parsed = parse("give-up", () => parseArgs({ args, allowPositionals: true, options: {} }));
    if (!parsed.ok) return parsed.outcome;
    const [written, message, ...extra] = parsed.value.positionals;
    const task = taskNumber("give-up", written);
    if (!task.ok) return task.outcome;
    if (message === undefined || message.trim() === "") {
      return refused(
        `Say why, like this: skelcrew give-up ${task.value} "The API it needs doesn't exist."`,
      );
    }
    if (extra.length > 0) {
      return refused(`Put the reason in quotes, like this: skelcrew give-up ${task.value} "…"`);
    }
    const session = sessionOf(context, `give-up ${task.value}`);
    if (!session.ok) return session.outcome;
    const command: Command = {
      type: "give_up",
      task: task.value,
      session: session.value,
      message,
    };
    return ask(context, command, anything, () => said(`Gave up on #${task.value}.`));
  },

  serve: async (args, context) => {
    const parsed = parse("serve", () => parseArgs({ args, options: {} }));
    if (!parsed.ok) return parsed.outcome;
    const repo = findRepo(context.cwd);
    if (repo === null) return noRepo();
    const running = await serveUntilSignalled(repo);
    if (!running.ok) return refused(...running.message.split("\n"));
    context.announce?.(`The daemon for ${repo} is running. Stop it with Ctrl-C.`);
    await running.stopped;
    return said("The daemon stopped.");
  },
};

// ---------------------------------------------------------------------------
// Arguments
// ---------------------------------------------------------------------------

type Values = Record<string, string | boolean | (string | boolean)[] | undefined>;
type Options = Record<string, { type: "string" | "boolean" }>;

type Checked<T> = { ok: true; value: T } | { ok: false; outcome: Outcome };

// parseArgs throws on an option it doesn't know. That becomes a refusal.
function parse<T>(name: string, parseThem: () => T): Checked<T> {
  try {
    return { ok: true, value: parseThem() };
  } catch (error) {
    const message = error instanceof Error ? error.message.replace(/\.$/, "") : String(error);
    return {
      ok: false,
      outcome: refused(`${message}. Run \`skelcrew ${name} --help\` to see how to use it.`),
    };
  }
}

// A command that takes one task number, and the options given.
async function withTask(
  name: string,
  args: string[],
  options: Options,
  then: (task: TaskId, values: Values) => Outcome | Promise<Outcome>,
): Promise<Outcome> {
  const parsed = parse(name, () => parseArgs({ args, allowPositionals: true, options }));
  if (!parsed.ok) return parsed.outcome;
  const [written, ...extra] = parsed.value.positionals;
  const task = taskNumber(name, written);
  if (!task.ok) return task.outcome;
  if (extra.length > 0) return refused(`skelcrew ${name} takes one task number.`);
  return then(task.value, parsed.value.values);
}

const taskArg = z
  .string()
  .regex(/^#?[1-9]\d*$/)
  .transform((text) => Number(text.replace("#", "")))
  .pipe(TaskId);

function taskNumber(name: string, written: string | undefined): Checked<TaskId> {
  if (written === undefined) {
    return { ok: false, outcome: refused(`Say which task, like this: skelcrew ${name} 12`) };
  }
  const parsed = taskArg.safeParse(written);
  if (!parsed.success) {
    return {
      ok: false,
      outcome: refused(`"${written}" isn't a task number. Write it as 12 or #12.`),
    };
  }
  return { ok: true, value: parsed.data };
}

function usage(name: string): Outcome {
  return refused(`Run \`skelcrew ${name} --help\` to see how to use it.`);
}

function sessionOf(context: Context, example: string): Checked<SessionId> {
  const parsed = SessionId.safeParse(context.session);
  if (parsed.success) return { ok: true, value: parsed.data };
  return {
    ok: false,
    outcome: refused(
      "SKELCREW_SESSION isn't set. Set it to the session `skelcrew claim` printed, like this:",
      `SKELCREW_SESSION=<session> skelcrew ${example}`,
    ),
  };
}

// ---------------------------------------------------------------------------
// The spec an agent submits
// ---------------------------------------------------------------------------

const scope = "say what the task changes.";
const acceptance = "must be a list of criteria, each one text.";
const questions = "must be a list of questions. Leave it empty, [], when none are left.";

const specFile = z.strictObject({
  scope: z.string({ error: scope }).refine((text) => text.trim() !== "", { error: scope }),
  acceptance: z.array(z.string({ error: "must be text." }), { error: acceptance }),
  openQuestions: z.array(z.string({ error: "must be text." }), { error: questions }),
});

async function readSpec(
  file: string | undefined,
  context: Context,
): Promise<Checked<z.infer<typeof specFile>>> {
  let text: string;
  if (file === undefined) {
    text = await context.readStdin();
  } else {
    try {
      text = readFileSync(resolve(context.cwd, file), "utf8");
    } catch (error) {
      const message = error instanceof Error ? error.message : String(error);
      return { ok: false, outcome: refused(`The file ${file} couldn't be read: ${message}`) };
    }
  }
  if (text.trim() === "") {
    return {
      ok: false,
      outcome: refused(
        "No spec was given. Name its file with --file <path>, or send it on standard input.",
        "Run `skelcrew submit --help` to see the form.",
      ),
    };
  }
  let data: unknown;
  try {
    data = JSON.parse(text);
  } catch (error) {
    const message = error instanceof Error ? error.message : String(error);
    return { ok: false, outcome: refused(`The spec isn't valid JSON: ${message}`) };
  }
  const parsed = specFile.safeParse(data);
  if (parsed.success) return { ok: true, value: parsed.data };
  const unknown = parsed.error.issues.flatMap((issue) =>
    issue.code === "unrecognized_keys"
      ? issue.keys.map((key) => `- ${key} isn't part of a spec.`)
      : [],
  );
  const wrong = parsed.error.issues.flatMap((issue) =>
    issue.code === "unrecognized_keys"
      ? []
      : [`- ${issue.path.join(".") || "spec"}: ${issue.message}`],
  );
  return {
    ok: false,
    outcome: refused(
      "The spec doesn't fit:",
      ...unknown,
      ...wrong,
      "Run `skelcrew submit --help` to see the form.",
    ),
  };
}

// ---------------------------------------------------------------------------
// Talking to the daemon
// ---------------------------------------------------------------------------

const anything = z.unknown();

async function ask<T>(
  context: Context,
  command: Command,
  expected: z.ZodType<T>,
  show: (result: T) => Outcome,
): Promise<Outcome> {
  const repo = findRepo(context.cwd);
  if (repo === null) return noRepo();
  const options: Parameters<typeof request>[2] = { start: () => context.start(repo) };
  if (context.startTimeoutMs !== undefined) options.startTimeoutMs = context.startTimeoutMs;
  const answer = await request(repo, command, options);
  if (!answer.ok) return refused(...answer.message.split("\n"));
  const result = expected.safeParse(answer.result);
  if (!result.success) {
    return refused(`The daemon's answer to ${command.type} doesn't fit: ${result.error.message}`);
  }
  return show(result.data);
}

// The nearest folder, from here upwards, that has a .skelcrew/ folder.
function findRepo(from: string): string | null {
  let dir = resolve(from);
  for (;;) {
    const folder = join(dir, ".skelcrew");
    if (existsSync(folder) && statSync(folder).isDirectory()) return dir;
    const parent = dirname(dir);
    if (parent === dir) return null;
    dir = parent;
  }
}

function noRepo(): Outcome {
  return refused("No Skelcrew repository here. Run `skelcrew init` in your repository first.");
}

// ---------------------------------------------------------------------------
// What the daemon answers, and how it is shown
// ---------------------------------------------------------------------------

const phases: [Phase, ...Phase[]] = [
  "idea",
  "spec",
  "ready",
  "in_progress",
  "checks",
  "done",
  "dropped",
];

const waitingOn: [WaitingOn, ...WaitingOn[]] = [
  "retry",
  "answer",
  "spec_approval",
  "merge_approval",
  "revert_failed",
];

const statusResult = z.object({
  tasks: z.array(
    z.object({
      task: TaskId,
      title: z.string(),
      phase: z.enum(phases),
      blocked: z.string().nullable(),
      question: z.string().nullable(),
      waitingOnYou: z.enum(waitingOn).nullable(),
    }),
  ),
});

type TaskView = z.infer<typeof statusResult>["tasks"][number];

function status(tasks: TaskView[]): string[] {
  if (tasks.length === 0) return ['No tasks yet. Add one with: skelcrew add "<task>"'];
  const lines: string[] = [];
  const waiting = tasks.filter((task) => task.waitingOnYou !== null);
  if (waiting.length > 0) {
    lines.push("Waiting on you:");
    for (const task of waiting) lines.push(`- #${task.task} ${task.title}: ${needs(task)}`);
    lines.push("");
  }
  for (const phase of phases) {
    const inPhase = tasks.filter((task) => task.phase === phase);
    if (inPhase.length === 0) continue;
    lines.push(`${phaseNames[phase]}:`);
    for (const task of inPhase) {
      const blocked = task.blocked === null ? "" : ` (blocked: ${task.blocked})`;
      lines.push(`- #${task.task} ${task.title}${blocked}`);
    }
  }
  return lines;
}

function needs(task: TaskView): string {
  switch (task.waitingOnYou) {
    case "retry":
      return "blocked, so retry or drop it.";
    case "answer":
      return `answer its question: ${task.question ?? ""}`;
    case "spec_approval":
      return "approve its spec.";
    case "merge_approval":
      return "approve its merge.";
    case "revert_failed":
      return "its revert failed. Revert it by hand, or try again.";
    case null:
      return "";
  }
}

const claimResult = z.object({
  session: SessionId,
  phase: z.enum(phases),
  spec: z
    .object({
      scope: z.string(),
      acceptance: z.array(z.string()),
      openQuestions: z.array(z.string()),
    })
    .nullable()
    .optional(),
  note: z.string().nullable().optional(),
});

function claimed(task: TaskId, claim: z.infer<typeof claimResult>): string[] {
  const report = claim.phase === "spec" ? "submit" : "done";
  const lines = [
    `Claimed #${task}. It is in ${phaseNames[claim.phase]}.`,
    `Your session is ${claim.session}.`,
    "Set SKELCREW_SESSION to it for each report, like this:",
    `SKELCREW_SESSION=${claim.session} skelcrew ${report} ${task}`,
  ];
  if (claim.note !== null && claim.note !== undefined) {
    lines.push(`The developer's note: ${claim.note}`);
  }
  if (claim.spec !== null && claim.spec !== undefined) {
    lines.push("Its spec so far:", `Scope: ${claim.spec.scope}`);
    lines.push("Acceptance:", ...claim.spec.acceptance.map((line) => `- ${line}`));
    if (claim.spec.openQuestions.length > 0) {
      lines.push("Open questions:", ...claim.spec.openQuestions.map((line) => `- ${line}`));
    }
  }
  return lines;
}

// What `done` answers once the checks have run. The daemon doesn't build
// `done` yet, so this is the shape the CLI asks of it.
const doneResult = z.discriminatedUnion("passed", [
  z.object({ passed: z.literal(true) }),
  z.object({ passed: z.literal(false), summary: z.string() }),
]);
