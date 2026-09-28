// Property tests: random input sequences, with every invariant in
// docs/invariants.md checked after every step. The numbers in the comments
// match the rules there.
//
// The inputs come from a small fixed pool, so random sequences often hit
// the right input for the task's current step and reach every phase.

import { describe, expect, test } from "bun:test";
import * as fc from "fast-check";
import { criticalFiles } from "./contracts";
import { decideTask } from "./decide";
import { evolveTask } from "./evolve";
import { CommitSha, ProjectId, SessionId, TaskId } from "./ids";
import { schedule } from "./schedule";
import { awaitedRequest, heldWorktree, runningSession } from "./task";
import type {
  Command,
  Config,
  GateName,
  Input,
  Project,
  SessionId as Session,
  Spec,
  Task,
  TaskEvent,
} from "./types";

// ---------------------------------------------------------------------------
// The world the random inputs run in
// ---------------------------------------------------------------------------

const reports = ProjectId.parse("reports");
const archive = ProjectId.parse("archive");
const projects = new Map<ProjectId, Project>([
  [
    reports,
    { id: reports, name: "Reports", goal: "Better reports", status: "active", createdAt: 0 },
  ],
  [archive, { id: archive, name: "Archive", goal: "Old ideas", status: "parked", createdAt: 0 }],
]);

const base: Config = {
  gates: ["local", "review"],
  maxAttempts: 3,
  maxRunning: 2,
  specApproval: "always",
  criticalPaths: ["src/auth/**"],
  safetyCap: { tokens: 200_000, ms: 60 * 60_000 },
};
const configs = fc.constantFrom<Config>(
  base,
  { ...base, specApproval: "never" },
  { ...base, criticalPaths: [], maxAttempts: 1 },
  { ...base, gates: ["local"] },
);

const spec: Spec = { scope: "Export CSV.", acceptance: ["It downloads."], openQuestions: [] };
const incomplete: Spec = { ...spec, openQuestions: ["Include deleted rows?"] };
const commit = CommitSha.parse("c".repeat(40));

// Every input a task can receive from you and the scheduler, with a few
// values each. `add` is sent first by the property itself. Replies to
// requests and agents' reports aren't here: each checker builds them from
// the requests its task sent and the agents it started, old ones included
// (see replies()).
const inputPool: Input[] = [
  { by: "human", type: "request_spec" },
  { by: "human", type: "provide_spec", spec },
  { by: "human", type: "approve_spec" },
  { by: "human", type: "send_back_spec", note: "Add totals." },
  { by: "human", type: "answer", text: "No" },
  { by: "human", type: "approve_merge" },
  { by: "human", type: "send_back_merge", note: "Don't touch login." },
  { by: "human", type: "retry" },
  { by: "human", type: "send_back_to_spec", note: "Split it." },
  { by: "human", type: "drop" },
  { by: "human", type: "revert", reason: "Broke exports." },
  { by: "human", type: "change_project", project: reports },
  { by: "human", type: "change_project", project: archive },
  { by: "human", type: "change_project", project: null },
  { by: "plugin", type: "external_move", to: "Done" },
  { by: "system", type: "start" },
  ...[1_000, 150_000, 250_000].map(
    (tokens): Input => ({ by: "system", type: "usage", usage: { tokens, ms: 60_000 } }),
  ),
];

const addInputs = fc.constantFrom<Input>(
  ...[null, reports, archive].flatMap((project): Input[] => [
    { by: "human", type: "add", title: "CSV export", project, requestSpec: false },
    { by: "human", type: "add", title: "CSV export", project, requestSpec: true },
  ]),
);
// Each step is a choice, not an input. A guided choice picks one of the
// inputs the task accepts right now, so runs get through every phase. The
// rest pick any input, so rejections are tested too. Inputs that are
// accepted almost anywhere (usage, project changes) or that send a task
// backwards (drops, crashes, giving up) only come from unguided choices.
// Otherwise they crowd out the inputs that move a task on, and few runs
// would reach a merge.
type Choice = { guided: boolean; n: number };
const unguided = new Set<Input["type"]>([
  "drop",
  "usage",
  "change_project",
  "give_up",
  "session_failed",
  "session_crashed",
  "worktree_failed",
  "send_back_to_spec",
]);

// A request the task sent, as the daemon remembers it, so replies can be
// built for it: on time, repeated, or long after the task moved on.
type Sent =
  | { request: number; kind: "agent" | "worktree" | "merge" | "revert" }
  | { request: number; kind: "gate"; gate: GateName };
const choice = fc.record({ guided: fc.integer({ min: 0, max: 9 }).map((x) => x < 8), n: fc.nat() });
const choices = fc.array(choice, { minLength: 1, maxLength: 300, size: "max" });

// ---------------------------------------------------------------------------
// Reading a task, the way the rules talk about it
// ---------------------------------------------------------------------------

// The request the task's current step waits on, or null if none.
function awaited(task: Task | null): number | null {
  return task && awaitedRequest(task);
}

// The fields each phase carries, besides the ones every task has. A task
// must carry exactly these: a field left over from an earlier phase is a
// state its type says can't exist.
const everyTask = [
  "blocked",
  "builds",
  "createdAt",
  "id",
  "phase",
  "project",
  "question",
  "requests",
  "source",
  "title",
  "usage",
  "usageAtRetry",
];
const phaseFields: Record<Task["phase"], string[]> = {
  idea: [],
  spec: ["note", "spec", "step"],
  ready: ["spec", "step"],
  in_progress: ["attempts", "brief", "spec", "step", "worktree"],
  checks: ["attempts", "branch", "spec", "step", "worktree"],
  done: ["mergeCommit", "spec", "step"],
  dropped: [],
};

// ---------------------------------------------------------------------------
// The checker: follows one task and checks every rule after every step
// ---------------------------------------------------------------------------

class Checker {
  task: Task | null = null;
  log: TaskEvent[] = [];
  liveSessions = new Set<Session>();
  // Every request sent, and every agent ever started, for building replies.
  sent: Sent[] = [];
  started: Session[] = [];
  // Starts sent out and not yet answered, the way the daemon counts them:
  // by request number, since each reply names the request it answers.
  startsPending = new Set<number>();
  lastUsage = { tokens: 0, ms: 0 };

  get startsInFlight(): number {
    return this.startsPending.size;
  }
  liveWorktrees = new Set<string>();
  lastBuild = 0;
  // Since the last report of done: which gates passed, and whether the
  // checks passed and the merge started.
  gatesPassed = new Set<string>();
  checksPassed = false;
  mergeStarted = false;

  constructor(
    readonly id: TaskId,
    readonly config: Config,
  ) {}

  // Replies for every request the task sent, and crash reports and reports
  // from every agent it ever started. Most answer requests long since dealt
  // with, or come from agents it has replaced, so late and repeated messages
  // come up all the time.
  replies(): Input[] {
    const id = this.id;
    const out: Input[] = this.started.flatMap((session): Input[] => [
      { by: "agent", type: "submit_spec", session, spec },
      { by: "agent", type: "submit_spec", session, spec: incomplete },
      { by: "agent", type: "ask", session, text: "Include deleted rows?", options: ["Yes", "No"] },
      {
        by: "agent",
        type: "report_done",
        session,
        branch: { commits: 2, changedFiles: ["src/export.ts"] },
      },
      {
        by: "agent",
        type: "report_done",
        session,
        branch: { commits: 1, changedFiles: ["src/auth/login.ts"] },
      },
      { by: "agent", type: "report_done", session, branch: { commits: 0, changedFiles: [] } },
      { by: "agent", type: "give_up", session, message: "Stuck." },
    ]);
    for (const sent of this.sent) {
      const { request } = sent;
      switch (sent.kind) {
        case "agent": {
          // The agent a request starts is always named after it, so its
          // crash can be reported before, after or instead of its start.
          const session = SessionId.parse(`s${id}-${request}`);
          out.push(
            { by: "plugin", type: "session_started", request, session },
            { by: "plugin", type: "session_failed", request, message: "Didn't start." },
            { by: "plugin", type: "session_crashed", request, session, message: "Crashed." },
          );
          break;
        }
        case "worktree":
          out.push(
            {
              by: "plugin",
              type: "worktree_created",
              request,
              worktree: { path: `/wt/${id}-${request}`, branch: `task/${id}-${request}` },
            },
            { by: "plugin", type: "worktree_failed", request, message: "Disk full." },
          );
          break;
        case "gate":
          out.push(
            { by: "plugin", type: "gate_result", request, gate: sent.gate, ok: true, summary: "." },
            {
              by: "plugin",
              type: "gate_result",
              request,
              gate: sent.gate,
              ok: false,
              summary: ".",
            },
          );
          break;
        case "merge":
          out.push(
            { by: "plugin", type: "merged", request, commit },
            { by: "plugin", type: "merge_failed", request, summary: "Conflicts." },
          );
          break;
        case "revert":
          out.push(
            { by: "plugin", type: "reverted", request },
            { by: "plugin", type: "revert_failed", request, summary: "Conflicts." },
          );
          break;
      }
    }
    return out;
  }

  // Turns a random choice into an input, from the inputs `allowed` lets through.
  pick(choice: Choice, at: number, allowed: (input: Input) => boolean = () => true): Input {
    const pool = [...inputPool, ...this.replies()].filter(allowed);
    const fits = pool.filter(
      (input) =>
        !unguided.has(input.type) &&
        decideTask(this.task, { taskId: this.id, at, input }, this.config, projects).ok,
    );
    const from = choice.guided && fits.length > 0 ? fits : pool;
    const input = from[choice.n % from.length];
    if (input === undefined) throw new Error("the input pool is empty");
    return input;
  }

  send(input: Input, at: number): void {
    const before = this.task;
    const envelope = { taskId: this.id, at, input };
    const decision = decideTask(before, envelope, this.config, projects);

    // 19. The same input always gives the same result.
    expect(decideTask(before, envelope, this.config, projects)).toEqual(decision);

    // 3. A move in another tool is never obeyed.
    if (input.type === "external_move") expect(decision.ok).toBe(false);

    // The daemon's bookkeeping happens whatever the core decides: a reply
    // answers its start, and a crashed agent is gone.
    if (
      input.type === "session_started" ||
      input.type === "session_failed" ||
      input.type === "session_crashed" ||
      input.type === "worktree_created" ||
      input.type === "worktree_failed"
    ) {
      this.startsPending.delete(input.request);
    }
    if (input.type === "session_crashed") this.liveSessions.delete(input.session);

    if (!decision.ok) return;
    const { events, commands } = decision;

    // Only the task's current agent is heard: a report from an agent the
    // task has replaced never counts. (Proposed as a new invariant.)
    if (input.by === "agent") {
      expect<Session | null>(input.session).toBe(before === null ? null : runningSession(before));
    }

    for (const event of events) {
      // 21. Every event belongs to its task and its moment.
      expect(event.taskId).toBe(this.id);
      expect(event.at).toBe(at);
      this.checkEvent(event, input);
      const result = evolveTask(this.task, event);
      if (!result.ok) throw new Error(`evolveTask refused decide's event: ${result.reason}`);
      this.task = result.task;
      this.log.push(event);
    }

    // 17. Dropped is final. Done only takes a revert or a late usage report.
    if (before?.phase === "dropped") expect(events).toEqual([]);
    if (before?.phase === "done") {
      for (const event of events) {
        expect([
          "task.revert_started",
          "task.revert_failed",
          "task.reverted",
          "task.usage_recorded",
        ]).toContain(event.type);
      }
    }

    this.track(input, commands);
    this.checkTask();
  }

  // Rules about a single event, checked before it is applied.
  private checkEvent(event: TaskEvent, input: Input): void {
    const task = this.task;
    switch (event.type) {
      // 1, 2. Only you make a task Ready while approval is required.
      case "task.ready":
        if (this.config.specApproval === "always") expect(input.by).toBe("human");
        break;

      // 2. Only you retry, drop, revert or change a task's project. The
      // revert starts on your input; version control's answer finishes it.
      case "task.unblocked":
      case "task.dropped":
      case "task.revert_started":
      case "task.project_changed":
        expect(input.by).toBe("human");
        break;

      case "task.done_reported":
        this.gatesPassed.clear();
        this.checksPassed = false;
        this.mergeStarted = false;
        break;

      case "task.gate_passed":
        // 5. A pass only counts for the run of the gate it answers: a late
        // result checked code that has since changed.
        if (input.type === "gate_result") expect<number | null>(input.request).toBe(awaited(task));
        this.gatesPassed.add(event.gate);
        break;

      // 13, 14. An agent or worktree is only taken for the request that
      // asked for it, never a late one from an earlier request.
      case "task.worktree_created":
      case "task.spec_session_started":
      case "task.dispatched":
        if (input.type === "worktree_created" || input.type === "session_started") {
          expect<number | null>(input.request).toBe(awaited(task));
        }
        break;

      // A merge or revert only finishes on the reply to its own request.
      case "task.merged":
      case "task.merge_failed":
      case "task.reverted":
      case "task.revert_failed":
        if (
          input.type === "merged" ||
          input.type === "merge_failed" ||
          input.type === "reverted" ||
          input.type === "revert_failed"
        ) {
          expect<number | null>(input.request).toBe(awaited(task));
        }
        break;

      case "task.checks_passed":
        // 5. Every gate passed on this build.
        expect([...this.gatesPassed].sort()).toEqual([...this.config.gates].sort());
        this.checksPassed = true;
        break;

      case "task.merge_started":
        // 7. A merge only starts after the checks pass.
        expect(this.checksPassed).toBe(true);
        // 6. A critical merge only starts on your approval.
        if (task?.phase === "checks") {
          if (criticalFiles(task.branch, this.config.criticalPaths).length > 0) {
            expect(input.by === "human" && input.type === "approve_merge").toBe(true);
          }
        }
        this.mergeStarted = true;
        break;
    }
    // 7. Every merge follows a started merge.
    if (event.type === "task.merged") expect(this.mergeStarted).toBe(true);
  }

  // Follows which agents and worktrees exist outside the core.
  private track(input: Input, commands: Command[]): void {
    for (const command of commands) {
      switch (command.type) {
        case "start_spec_session":
        case "start_develop_session":
          this.sent.push({ request: command.request, kind: "agent" });
          this.startsPending.add(command.request);
          break;
        case "create_worktree":
          this.sent.push({ request: command.request, kind: "worktree" });
          this.startsPending.add(command.request);
          break;
        case "run_gate":
          this.sent.push({ request: command.request, kind: "gate", gate: command.gate });
          break;
        case "merge":
          this.sent.push({ request: command.request, kind: "merge" });
          break;
        case "revert":
          this.sent.push({ request: command.request, kind: "revert" });
          break;
        default:
          break;
      }
    }
    if (input.type === "session_started") {
      this.liveSessions.add(input.session);
      if (!this.started.includes(input.session)) this.started.push(input.session);
    }
    if (input.type === "worktree_created") this.liveWorktrees.add(input.worktree.path);
    for (const command of commands) {
      if (command.type === "stop_session") this.liveSessions.delete(command.session);
      if (command.type === "remove_worktree") this.liveWorktrees.delete(command.worktree.path);
      if (command.type === "create_worktree") {
        // 14. Each build gets a new number, so a new branch.
        expect(command.build).toBeGreaterThan(this.lastBuild);
        this.lastBuild = command.build;
      }
    }
  }

  // Rules about the task as it stands.
  private checkTask(): void {
    const task = this.task;
    if (task === null) return;
    const session = runningSession(task);

    // 13. Every agent and worktree is stopped or still stored on the task.
    for (const live of this.liveSessions) expect<Session | null>(live).toBe(session);
    for (const live of this.liveWorktrees) expect<string | null>(live).toBe(heldWorktree(task));
    // And the reverse: what the task stores is really still there. A repeated
    // reply must never stop the agent or remove the worktree the task uses.
    if (session !== null) expect(this.liveSessions.has(session)).toBe(true);
    const worktree = heldWorktree(task);
    if (worktree !== null) expect(this.liveWorktrees.has(worktree)).toBe(true);

    // 10. No more failed rounds than max_attempts without a block.
    if (task.phase === "in_progress" || task.phase === "checks") {
      if (task.attempts >= this.config.maxAttempts) expect(task.blocked).not.toBeNull();
    }

    // 11. A task running over its safety cap is blocked.
    if (session !== null) {
      const cap = this.config.safetyCap;
      const tokens = task.usage.tokens - task.usageAtRetry.tokens;
      const ms = task.usage.ms - task.usageAtRetry.ms;
      expect(tokens < cap.tokens && ms < cap.ms).toBe(true);
    }

    // 15. No leftover flags: a question only exists in its agent's phases.
    if (task.question?.from === "spec") expect(task.phase).toBe("spec");
    if (task.question?.from === "develop") expect(["in_progress", "checks"]).toContain(task.phase);

    // 16. A blocked task has no agent running.
    if (task.blocked !== null) expect(session).toBeNull();

    // Each phase carries exactly its own fields, and nothing left over.
    expect(Object.keys(task).sort()).toEqual([...everyTask, ...phaseFields[task.phase]].sort());

    // 18. Usage totals never go down: the record keeps the true cost, and
    // the safety cap counts from them.
    expect(task.usage.tokens).toBeGreaterThanOrEqual(this.lastUsage.tokens);
    expect(task.usage.ms).toBeGreaterThanOrEqual(this.lastUsage.ms);
    this.lastUsage = task.usage;

    // 20. Replaying the log rebuilds the task exactly.
    let replayed: Task | null = null;
    for (const event of this.log) {
      const result = evolveTask(replayed, event);
      if (!result.ok) throw new Error(result.reason);
      replayed = result.task;
    }
    expect(replayed).toEqual(task);
  }
}

// ---------------------------------------------------------------------------
// The properties
// ---------------------------------------------------------------------------

describe("the invariants", () => {
  test("hold for one task, after every step of any input sequence", () => {
    fc.assert(
      fc.property(configs, addInputs, choices, (config, add, sequence) => {
        const checker = new Checker(TaskId.parse(1), config);
        checker.send(add, 0);
        sequence.forEach((c, i) => {
          checker.send(checker.pick(c, i + 1), i + 1);
        });
      }),
      { numRuns: 300 },
    );
  });

  test("8, 9: max_running holds and parked or blocked tasks never start", () => {
    const steps = fc.array(
      fc.oneof(
        fc.record({ task: fc.integer({ min: 0, max: 3 }), choice }),
        fc.constant("schedule" as const),
      ),
      { minLength: 1, maxLength: 200, size: "max" },
    );

    fc.assert(
      fc.property(
        configs,
        fc.array(addInputs, { minLength: 4, maxLength: 4 }),
        steps,
        (config, adds, sequence) => {
          const checkers = adds.map((add, i) => {
            const checker = new Checker(TaskId.parse(i + 1), config);
            checker.send(add, 0);
            return checker;
          });
          const tasks = () => checkers.flatMap((c) => (c.task === null ? [] : [c.task]));

          sequence.forEach((step, i) => {
            if (step === "schedule") {
              const inFlight = checkers.reduce((sum, c) => sum + c.startsInFlight, 0);
              const picks = schedule(tasks(), projects, config, inFlight);
              for (const id of picks) {
                const task = tasks().find((t) => t.id === id);
                // 9. The scheduler never picks a blocked task or one in a parked project.
                expect(task?.blocked ?? null).toBeNull();
                const project = task?.project ?? null;
                expect(project === null ? "active" : projects.get(project)?.status).not.toBe(
                  "parked",
                );
                checkers.find((c) => c.id === id)?.send({ by: "system", type: "start" }, i + 1);
              }
            } else {
              // Only the scheduler starts tasks here.
              const checker = checkers[step.task];
              checker?.send(
                checker.pick(step.choice, i + 1, (input) => input.type !== "start"),
                i + 1,
              );
            }
            // 8. Never more than max_running agents at once.
            const inFlight = checkers.reduce((sum, c) => sum + c.startsInFlight, 0);
            expect(
              tasks().filter((t) => runningSession(t) !== null).length + inFlight,
            ).toBeLessThanOrEqual(config.maxRunning);
          });
        },
      ),
      { numRuns: 200 },
    );
  });
});
