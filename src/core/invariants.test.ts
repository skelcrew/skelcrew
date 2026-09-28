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
import type {
  Command,
  Config,
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
const sessions = ["s1", "s2", "s3"].map((s) => SessionId.parse(s));
const worktrees = ["/wt/a", "/wt/b"].map((path) => ({ path, branch: `task${path}` }));
const commit = CommitSha.parse("c".repeat(40));

// Every input a task can receive, with a few values each. `add` is sent
// first by the property itself.
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
  { by: "agent", type: "submit_spec", spec },
  { by: "agent", type: "submit_spec", spec: incomplete },
  { by: "agent", type: "ask", text: "Include deleted rows?", options: ["Yes", "No"] },
  { by: "agent", type: "report_done", branch: { commits: 2, changedFiles: ["src/export.ts"] } },
  { by: "agent", type: "report_done", branch: { commits: 1, changedFiles: ["src/auth/login.ts"] } },
  { by: "agent", type: "report_done", branch: { commits: 0, changedFiles: [] } },
  { by: "agent", type: "give_up", message: "Stuck." },
  { by: "plugin", type: "external_move", to: "Done" },
  ...worktrees.map((worktree): Input => ({ by: "plugin", type: "worktree_created", worktree })),
  { by: "plugin", type: "worktree_failed", message: "Disk full." },
  ...sessions.map((session): Input => ({ by: "plugin", type: "session_started", session })),
  { by: "plugin", type: "session_failed", message: "Crashed." },
  ...(["local", "review"] as const).flatMap((gate): Input[] => [
    { by: "plugin", type: "gate_result", gate, ok: true, summary: "Passed." },
    { by: "plugin", type: "gate_result", gate, ok: false, summary: "Failed." },
  ]),
  { by: "plugin", type: "merged", commit },
  { by: "plugin", type: "merge_failed", summary: "Conflicts." },
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
  "worktree_failed",
  "send_back_to_spec",
]);
const choice = fc.record({ guided: fc.integer({ min: 0, max: 9 }).map((x) => x < 8), n: fc.nat() });
const choices = fc.array(choice, { minLength: 1, maxLength: 300, size: "max" });

// ---------------------------------------------------------------------------
// Reading a task, the way the rules talk about it
// ---------------------------------------------------------------------------

// The agent the task has running, if any. In Checks the develop agent stays
// open, so it counts.
function runningSession(task: Task): Session | null {
  switch (task.phase) {
    case "spec":
    case "in_progress":
      return task.step.kind === "running" ? task.step.session : null;
    case "checks":
      return task.session;
    default:
      return null;
  }
}

function heldWorktree(task: Task): string | null {
  if (task.phase === "ready" && task.step.kind === "starting_session")
    return task.step.worktree.path;
  if (task.phase === "in_progress" || task.phase === "checks") return task.worktree.path;
  return null;
}

// What the slot limit counts: an agent running or starting, or a worktree
// being created for one. A task past its gates has no agent, so it doesn't.
function holdsSlot(task: Task): boolean {
  switch (task.phase) {
    case "spec":
    case "in_progress":
      return task.step.kind === "starting" || task.step.kind === "running";
    case "ready":
      return task.step.kind !== "queued";
    case "checks":
      return task.session !== null;
    default:
      return false;
  }
}

// ---------------------------------------------------------------------------
// The checker: follows one task and checks every rule after every step
// ---------------------------------------------------------------------------

class Checker {
  task: Task | null = null;
  log: TaskEvent[] = [];
  liveSessions = new Set<Session>();
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

  // Turns a random choice into an input, from the inputs `allowed` lets through.
  pick(choice: Choice, at: number, allowed: (input: Input) => boolean = () => true): Input {
    const pool = inputPool.filter(allowed);
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

    // 18. The same input always gives the same result.
    expect(decideTask(before, envelope, this.config, projects)).toEqual(decision);

    // 3. A move in another tool is never obeyed.
    if (input.type === "external_move") expect(decision.ok).toBe(false);

    if (!decision.ok) return;
    const { events, commands } = decision;

    for (const event of events) {
      // 20. Every event belongs to its task and its moment.
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
        expect(["task.reverted", "task.usage_recorded"]).toContain(event.type);
      }
    }

    this.track(input, events, commands, before);
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

      // 2. Only you retry, drop, revert or change a task's project.
      case "task.unblocked":
      case "task.dropped":
      case "task.reverted":
      case "task.project_changed":
        expect(input.by).toBe("human");
        break;

      case "task.done_reported":
        this.gatesPassed.clear();
        this.checksPassed = false;
        this.mergeStarted = false;
        break;

      case "task.gate_passed":
        this.gatesPassed.add(event.gate);
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

      case "task.merged":
        // 7. Every merge follows a started merge.
        expect(this.mergeStarted).toBe(true);
        break;
    }
  }

  // Follows which agents and worktrees exist outside the core.
  private track(input: Input, events: TaskEvent[], commands: Command[], before: Task | null): void {
    if (input.type === "session_started") this.liveSessions.add(input.session);
    if (input.type === "worktree_created") this.liveWorktrees.add(input.worktree.path);
    // A crashed agent is gone.
    if (input.type === "session_failed" && before !== null && events.length > 0) {
      const crashed = runningSession(before);
      if (crashed !== null) this.liveSessions.delete(crashed);
    }
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

    // 19. Replaying the log rebuilds the task exactly.
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
              const picks = schedule(tasks(), projects, config);
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
            expect(tasks().filter(holdsSlot).length).toBeLessThanOrEqual(config.maxRunning);
          });
        },
      ),
      { numRuns: 200 },
    );
  });
});
