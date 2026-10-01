// The `skelcrew` command line. `run` takes the arguments and returns what to
// print and the exit code, so tests can call it as a function.
//
// Every argument is checked here before it reaches the daemon. Every
// answer from the daemon is checked against the shape this command expects.

import { existsSync, readFileSync, statSync } from "node:fs";
import { join, resolve } from "node:path";
import { parseArgs } from "node:util";
import * as z from "zod";
import { SessionId, TaskId } from "../core/ids";
import { phaseNames } from "../core/task";
import type { TaskEvent } from "../core/types";
import { request, type Started } from "../daemon/client";
import { serveUntilSignalled } from "../daemon/server";
import { mainRepository } from "../plugins/git/top";
import type { Command } from "../protocol/protocol";
import { taskEvent } from "../store/schema";
import { commandHelp, mainHelp } from "./help";
import { init } from "./init";
import { leftOutLine, logLines } from "./log";
import { type ProjectView, phases, statusLines, statusResult, type TaskView } from "./status";

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
  // In a terminal, main.ts opens the TUI instead. Without one, such as when
  // an agent runs bare `skelcrew`, it gets the status.
  if (name === undefined) return run(["status"], context);
  if (name === "--help" || name === "-h" || name === "help") return said(...mainHelp);
  const handler = handlers[name];
  if (handler === undefined) {
    return refused(`There is no command ${name}. Run \`skelcrew --help\` to see them all.`);
  }
  // Help only when it's the command's only argument: `-h` could also be a
  // reason, a note or a title.
  if (rest.length === 1 && (rest[0] === "--help" || rest[0] === "-h")) {
    return said(...(commandHelp[name] ?? []));
  }
  return handler(rest, context);
}

const handlers: Record<string, Handler> = {
  init: async (args, context) => init(args, context.cwd),

  add: async (args, context) => {
    const parsed = parse(
      "add",
      () =>
        parseArgs({
          args,
          allowPositionals: true,
          options: { spec: { type: "boolean" }, project: { type: "string" } },
        }),
      args,
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
    withTask("approve", args, {}, (task) =>
      ask(context, { type: "approve", task }, approveResult, (result) => {
        if (!("merged" in result)) return said(`Approved #${task}.`);
        if (result.merged) {
          return said(`Approved #${task}. It merged into main as ${result.commit.slice(0, 7)}.`);
        }
        // Nothing starts an agent in step 2, so the task waits for a claim.
        const next = result.outOfAttempts
          ? `Approved #${task}, but the merge failed, and #${task} is out of attempts. Retry it with skelcrew retry ${task}, or drop it.`
          : `Approved #${task}, but the merge failed. #${task} is back in In progress. Claim it to fix it: skelcrew claim ${task}`;
        return { code: 1, out: [next, "Why:", ...result.summary.split("\n")], err: [] };
      }),
    ),

  reject: async (args, context) => {
    const parsed = parse(
      "reject",
      () => parseArgs({ args, allowPositionals: true, options: {} }),
      args,
    );
    if (!parsed.ok) return parsed.outcome;
    const [written, note, ...extra] = parsed.value.positionals;
    const task = taskNumber("reject", written);
    if (!task.ok) return task.outcome;
    const example = `skelcrew reject ${task.value} "Add totals."`;
    if (note === undefined || note.trim() === "") {
      return refused(`Say what to change, like this: ${example}`);
    }
    if (extra.length > 0) return refused(`Put the note in quotes, like this: ${example}`);
    return ask(context, { type: "reject", task: task.value, note }, rejectResult, ({ phase }) =>
      said(`Sent #${task.value} back to ${phaseNames[phase]} with your note.`),
    );
  },

  drop: async (args, context) =>
    withTask("drop", args, {}, (task) =>
      ask(context, { type: "drop", task }, anything, () => said(`Dropped #${task}.`)),
    ),

  // The daemon doesn't start agents yet, so a retried task waits in its
  // phase until it is claimed again.
  retry: async (args, context) =>
    withTask("retry", args, {}, (task) =>
      ask(context, { type: "retry", task }, anything, () =>
        said(
          `Retried #${task}.`,
          `Skelcrew doesn't start agents itself yet, so claim it again: skelcrew claim ${task}`,
        ),
      ),
    ),

  status: async (args, context) => {
    const parsed = parse("status", () => parseArgs({ args, options: {} }));
    if (!parsed.ok) return parsed.outcome;
    return ask(context, { type: "status" }, statusResult, ({ tasks, projects }) =>
      said(...statusLines(tasks, projects)),
    );
  },

  project: async (args, context) => project(args, context),

  log: async (args, context) =>
    withTask("log", args, {}, (task) =>
      ask(context, { type: "log", task }, logResult, ({ events, leftOut }) =>
        said(...leftOutLine(leftOut), ...logLines(events)),
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
    const parsed = parse(
      "give-up",
      () => parseArgs({ args, allowPositionals: true, options: {} }),
      args,
    );
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
// Projects
// ---------------------------------------------------------------------------

// A project as the daemon names it in an answer.
const namedProject = z.object({ id: z.string(), name: z.string() });

// `skelcrew project new|add|remove|archive|unarchive`. A project is named by
// its name or its ID. A name of several words needs no quotes, except in
// `new`, where the goal follows it.
async function project(args: string[], context: Context): Promise<Outcome> {
  const [command, ...rest] = args;
  if (command === undefined) return said(...(commandHelp.project ?? []));
  const name = `project ${command}`;
  const parsed = parse(name, () => parseArgs({ args: rest, allowPositionals: true }), rest);
  if (!parsed.ok) return parsed.outcome;
  const words = parsed.value.positionals;

  switch (command) {
    case "new": {
      const [title, goal, ...extra] = words;
      if (
        title === undefined ||
        goal === undefined ||
        title.trim() === "" ||
        goal.trim() === "" ||
        extra.length > 0
      ) {
        return refused(
          'Give a name and a goal, like this: skelcrew project new "Reports page" "Export what the reports page shows."',
        );
      }
      const made = z.object({ project: namedProject });
      return ask(context, { type: "project_new", name: title, goal }, made, ({ project }) =>
        said(
          `Added project ${project.name}.`,
          `Add tasks to it with: skelcrew add "<task>" --project ${project.id}`,
        ),
      );
    }

    case "add": {
      const [written, ...named] = words;
      if (written === undefined || named.length === 0) {
        return refused(
          "Say which task and which project, like this: skelcrew project add 12 reports-page",
        );
      }
      const task = taskNumber(name, written);
      if (!task.ok) return task.outcome;
      const moved = z.object({ from: namedProject.nullable(), to: namedProject });
      const command: Command = { type: "project_add", task: task.value, project: named.join(" ") };
      return ask(context, command, moved, ({ from, to }) => {
        if (from === null) return said(`Added #${task.value} to ${to.name}.`);
        if (from.id === to.id) return said(`#${task.value} is already in ${to.name}.`);
        return said(`Moved #${task.value} from ${from.name} to ${to.name}.`);
      });
    }

    case "remove": {
      const [written, ...extra] = words;
      if (written === undefined) {
        return refused("Say which task, like this: skelcrew project remove 12");
      }
      if (extra.length > 0) return refused("skelcrew project remove takes one task number.");
      const task = taskNumber(name, written);
      if (!task.ok) return task.outcome;
      const left = z.object({ from: namedProject });
      return ask(context, { type: "project_remove", task: task.value }, left, ({ from }) =>
        said(`Took #${task.value} out of ${from.name}.`),
      );
    }

    case "archive":
    case "unarchive": {
      if (words.length === 0) {
        return refused(`Say which project, like this: skelcrew project ${command} reports-page`);
      }
      const type = command === "archive" ? "project_archive" : "project_unarchive";
      const changed = z.object({ project: namedProject });
      return ask(context, { type, project: words.join(" ") }, changed, ({ project }) =>
        command === "archive"
          ? said(
              `Archived ${project.name}. No new agents start in it.`,
              "Work already running carries on.",
            )
          : said(`Unarchived ${project.name}. Agents can start in it again.`),
      );
    }

    default:
      return refused(
        `There is no \`skelcrew project ${command}\`. Run \`skelcrew project --help\` to see them.`,
      );
  }
}

// ---------------------------------------------------------------------------
// Arguments
// ---------------------------------------------------------------------------

type Values = Record<string, string | boolean | (string | boolean)[] | undefined>;
type Options = Record<string, { type: "string" | "boolean" }>;

type Checked<T> = { ok: true; value: T } | { ok: false; outcome: Outcome };

// parseArgs throws on an option it doesn't know. That becomes a refusal.
// Often it is a title, note or reason that starts with a dash, so the
// refusal shows how to pass one: after `--`.
function parse<T>(name: string, parseThem: () => T, args: string[] = []): Checked<T> {
  try {
    return { ok: true, value: parseThem() };
  } catch (error) {
    const message = error instanceof Error ? error.message : String(error);
    // Node names the option with or without its dashes, so the argument is
    // found by what follows them.
    const option = /Unknown option '-*([^']+)'/.exec(message)?.[1];
    const at =
      option === undefined
        ? -1
        : args.findIndex((arg) => arg.startsWith("-") && arg.replace(/^-+/, "").startsWith(option));
    const value = args[at];
    if (value !== undefined) {
      const example = [
        "skelcrew",
        name,
        ...args.slice(0, at).map(shellWord),
        "--",
        shellWord(value),
      ];
      return {
        ok: false,
        outcome: refused(
          `${value.split(/[\s=]/)[0]} isn't an option of \`skelcrew ${name}\`. Run \`skelcrew ${name} --help\` to see its options.`,
          `If it's part of a title, note or reason, put -- before it: ${example.join(" ")}`,
        ),
      };
    }
    return {
      ok: false,
      outcome: refused(
        `${message.replace(/\.$/, "")}. Run \`skelcrew ${name} --help\` to see how to use it.`,
      ),
    };
  }
}

// An argument as it would be typed: quoted if it holds anything but plain
// letters, digits and a few safe marks.
function shellWord(arg: string): string {
  return /^[\w#./:@-]+$/.test(arg) ? arg : JSON.stringify(arg);
}

// A command that takes one task number, and the options given.
async function withTask(
  name: string,
  args: string[],
  options: Options,
  then: (task: TaskId, values: Values) => Outcome | Promise<Outcome>,
): Promise<Outcome> {
  const parsed = parse(name, () => parseArgs({ args, allowPositionals: true, options }), args);
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
  // Standard input is read only when asked for, with `--file -`. Waiting on
  // it otherwise could hang for ever on an input nobody writes to.
  if (file === undefined) {
    return {
      ok: false,
      outcome: refused(
        "No spec was given. Name its file with --file <path>, or use --file - to read it from standard input.",
        "Run `skelcrew submit --help` to see the form.",
      ),
    };
  }
  let text: string;
  if (file === "-") {
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

type Answered<T> = { ok: true; value: T } | { ok: false; message: string };

// The tasks as `skelcrew status` sees them, as data, for the TUI.
export async function readStatus(
  context: Context,
): Promise<
  { ok: true; tasks: TaskView[]; projects: ProjectView[] } | { ok: false; message: string }
> {
  const answer = await answered(context, { type: "status" }, statusResult);
  if (!answer.ok) return answer;
  return { ok: true, tasks: answer.value.tasks, projects: answer.value.projects ?? [] };
}

// A task's events as `skelcrew log` reads them, as data, for the TUI.
export async function readLog(
  context: Context,
  task: TaskId,
): Promise<{ ok: true; events: TaskEvent[]; leftOut: number } | { ok: false; message: string }> {
  const answer = await answered(context, { type: "log", task }, logResult);
  return answer.ok ? { ok: true, ...answer.value } : answer;
}

async function ask<T>(
  context: Context,
  command: Command,
  expected: z.ZodType<T>,
  show: (result: T) => Outcome,
): Promise<Outcome> {
  const answer = await answered(context, command, expected);
  return answer.ok ? show(answer.value) : refused(...answer.message.split("\n"));
}

// Sends the command to the repository's daemon, and checks its answer.
async function answered<T>(
  context: Context,
  command: Command,
  expected: z.ZodType<T>,
): Promise<Answered<T>> {
  const repo = findRepo(context.cwd);
  if (repo === null) return { ok: false, message: noRepoMessage };
  const options: Parameters<typeof request>[2] = { start: () => context.start(repo) };
  if (context.startTimeoutMs !== undefined) options.startTimeoutMs = context.startTimeoutMs;
  const answer = await request(repo, command, options);
  if (!answer.ok) return answer;
  const result = expected.safeParse(answer.result);
  if (!result.success) {
    return {
      ok: false,
      message: `The daemon's answer to ${command.type} doesn't fit: ${result.error.message}`,
    };
  }
  return { ok: true, value: result.data };
}

// The repository's main folder, if Skelcrew is set up there. It comes
// from git, so from inside a task's worktree, which holds its own copy of
// .skelcrew/, it is still the main folder, and its daemon.
export function findRepo(from: string): string | null {
  const main = mainRepository(resolve(from));
  if (!main.ok) return null;
  const folder = join(main.top, ".skelcrew");
  return existsSync(folder) && statSync(folder).isDirectory() ? main.top : null;
}

const noRepoMessage = "No Skelcrew repository here. Run `skelcrew init` in your repository first.";

function noRepo(): Outcome {
  return refused(noRepoMessage);
}

// ---------------------------------------------------------------------------
// What the daemon answers, and how it is shown
// ---------------------------------------------------------------------------

// What `log` answers: the task's newest events as saved, checked against
// the store's own schema, and how many older ones didn't fit in the reply.
const logResult = z.object({ events: z.array(taskEvent), leftOut: z.number().int().min(0) });

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
  // A build's worktree has a branch. A spec's copy of main has none.
  worktree: z
    .union([z.object({ path: z.string(), branch: z.string() }), z.object({ path: z.string() })])
    .optional(),
  failure: z.string().optional(),
});

function claimed(task: TaskId, claim: z.infer<typeof claimResult>): string[] {
  const report = claim.phase === "spec" ? "submit" : "done";
  const { worktree } = claim;
  const lines = [
    `Claimed #${task}. It is in ${phaseNames[claim.phase]}.`,
    ...(worktree === undefined
      ? []
      : "branch" in worktree
        ? [`Work in ${worktree.path}, on the branch ${worktree.branch}.`]
        : [`Work in ${worktree.path}, a fresh copy of main.`]),
    `Your session is ${claim.session}.`,
    "Set SKELCREW_SESSION to it for each report, like this:",
    `SKELCREW_SESSION=${claim.session} skelcrew ${report} ${task}`,
  ];
  if (claim.note !== null && claim.note !== undefined) {
    lines.push(`The developer's note: ${claim.note}`);
  }
  if (claim.failure !== undefined) {
    lines.push("Why it's back:", ...claim.failure.split("\n"));
  }
  if (claim.spec !== null && claim.spec !== undefined) {
    const heading = claim.phase === "spec" ? "Its spec so far:" : "The spec to build:";
    lines.push(heading, ...`Scope: ${claim.spec.scope}`.split("\n"));
    lines.push("Acceptance:", ...claim.spec.acceptance.map((line) => `- ${line}`));
    if (claim.spec.openQuestions.length > 0) {
      lines.push("Open questions:", ...claim.spec.openQuestions.map((line) => `- ${line}`));
    }
  }
  return lines;
}

// A spec's approval answers nothing more. A merge's says whether it landed.
// Strict, so a broken merge answer can't pass as a spec's approval.
const approveResult = z.union([
  z.object({ merged: z.literal(true), commit: z.string() }),
  z.object({ merged: z.literal(false), outOfAttempts: z.boolean(), summary: z.string() }),
  z.strictObject({}),
]);

// Where a rejected spec or merge went: Spec or In progress.
const rejectResult = z.object({ phase: z.enum(phases) });

// What `done` answers once the checks have run.

const doneResult = z.discriminatedUnion("passed", [
  z.object({ passed: z.literal(true) }),
  z.object({ passed: z.literal(false), summary: z.string() }),
]);
