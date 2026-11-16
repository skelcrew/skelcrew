// Runs a fresh adversarial reviewer in the sandbox for each thread's PR, on the harness your
// config names for reviews.
import { mkdtempSync, rmSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { z } from "zod";
import { type HarnessName, harnessNamed } from "../agents/harness.ts";
import { filterEnv, sandboxArgs, throwawayMounts } from "../agents/sandbox.ts";
import { sandboxFolders } from "../agents/seatbelt.ts";
import { errorText } from "../say.ts";
import { limitOn } from "./limits.ts";

// What a review round ends with: the reviewer's verdict and what it said, a failed review and
// why, or a review that ran past its time limit and was ended.
export type Review = { verdict: "approve" | "changes" | "failed" | "timed out"; body: string };
// A review its harness's usage limit stopped, with the harness's error and when the limit
// resets, or null when the harness didn't say. The round holds it and tries again.
export type Limited = { verdict: "limited"; body: string; reset: number | null };

// The answer a reviewer must give, checked as any outside input is. A failed verdict is never
// the reviewer's to give: only Skelcrew says a review failed.
const Verdict = z.strictObject({ verdict: z.enum(["approve", "changes"]), body: z.string() });

// The JSON schema of the reviewer's answer, which every harness holds the model to. OpenAI's
// strict mode needs every property required and no others allowed.
const schema = JSON.stringify({
  type: "object",
  properties: {
    verdict: { type: "string", enum: ["approve", "changes"] },
    body: { type: "string" },
  },
  required: ["verdict", "body"],
  additionalProperties: false,
});

// Returns what the reviewer is told: the task it checks the PR against, where the change
// starts, and to answer with problems the builder can act on. It tells the reviewer to assume
// the change is wrong, since a reviewer that trusts the builder misses what the builder missed.
function reviewerPrompt(issue: { title: string; body: string }, base: string): string {
  return `Review this pull request as an adversarial reviewer. Another agent wrote it. Assume it is wrong until you have checked it yourself.

It should do this:

# ${issue.title}

${issue.body}

The change is everything on HEAD since ${base}. Read the whole diff with \`git diff ${base}...HEAD\`, and the code around it. Run the tests, using the commands under test: in the repository's skelcrew.yaml if there is one. Anything you change here is thrown away after the review, so run what you need, but don't fix the code.

Check that it does what this asks and nothing else, and look for bugs, edge cases it misses, missing tests and failing ones.

Answer "approve" only if it is ready to merge. Otherwise answer "changes", and in the body name each problem, where it is and why it matters, so the builder can fix it.`;
}

// Starts the reviewer, waits for it to end, and returns what it printed and its exit code.
// Ending bwrap ends everything inside: the reviewer runs as the first process of a process
// list of its own, which the kernel empties when that process dies. A Mac has no process
// lists of their own, so the reviewer leads a group, which is ended when it ends. A process
// left in it would also hold its output open, and the review would wait forever. A review is
// ended with SIGKILL, as the shell around a Mac sandbox ignores SIGTERM to clean up after it.
async function spawnReviewer(given: {
  argv: string[];
  env: Record<string, string>;
  input: string;
  signal: AbortSignal;
}): Promise<{ out: string; err: string; code: number }> {
  const { argv, env, input, signal } = given;
  // On a Mac the reviewer starts a group of its own, and when it ends, whatever it left in that
  // group is ended too. Elsewhere bwrap's own process list does that.
  const mac = process.platform === "darwin";
  const proc = Bun.spawn(argv, {
    env,
    stdin: new Blob([input]),
    stdout: "pipe",
    stderr: "pipe",
    signal,
    killSignal: "SIGKILL",
    detached: mac,
  });
  if (mac)
    proc.exited.then(() => {
      try {
        process.kill(-proc.pid, "SIGKILL");
      } catch {}
    });
  // A process that left the group can still hold the output open, and a Mac can't find it
  // once its parent is gone. So there the output gets a moment after the reviewer ends, or
  // the review, and every review queued after it, would wait forever.
  const read = (output: ReadableStream<Uint8Array>) => {
    const text = new Response(output).text();
    if (!mac) return text;
    return Promise.race([text, proc.exited.then(() => Bun.sleep(1000)).then(() => "")]);
  };
  const [out, err, code] = await Promise.all([read(proc.stdout), read(proc.stderr), proc.exited]);
  return { out, err, code };
}

// Returns the error a reviewer that failed ended on, never a line of the prompt it was given:
// the error its harness reports, else, when `guess`, the last line it printed on stderr, or
// else stdout. A harness can echo the prompt as it starts, so the end of what it printed can be
// the task's text rather than what went wrong. A task can hold a line that looks like the
// harness's own error, such as "ERROR: connection refused" in a bug report, so the prompt's
// lines are taken out before anything is read.
function failureOf(
  name: HarnessName,
  finished: { out: string; err: string },
  prompt: string,
  guess: boolean,
): string | null {
  const echoed = new Set(prompt.split("\n").map((line) => line.trim()));
  const own = (printed: string) =>
    printed
      .split("\n")
      .filter((line) => line.trim() === "" || !echoed.has(line.trim()))
      .join("\n");
  const [out, err] = [own(finished.out), own(finished.err)];
  const reported = harnessNamed(name).failure(out, err);
  if (reported !== null) return reported.slice(0, 2000);
  if (!guess) return null;
  for (const printed of [err, out]) {
    const last = printed.split("\n").findLast((line) => line.trim() !== "");
    if (last !== undefined) return last.trim().slice(0, 2000);
  }
  return null;
}

// Returns the verdict of a reviewer that has ended, or a failed one saying why there is none:
// it exited with an error, or answered outside the shape. An error that says the harness's
// usage limit is reached gives a limited review instead, with when the limit resets.
function readVerdict(
  name: HarnessName,
  folder: string,
  finished: { out: string; err: string; code: number },
  prompt: string,
): Review | Limited {
  // A reviewer that exited with an error, or gave no answer, is asked what went wrong. One that
  // exited cleanly has only the error its harness reports, as any other line is its work.
  const { out, code } = finished;
  const failed = (otherwise: string): Review | Limited => {
    // Only the error the harness itself reports can be a usage limit. A line guessed at could
    // be a test's output, and would hold every review on the harness for nothing.
    const reported = failureOf(name, finished, prompt, false);
    const error = reported ?? (code === 0 ? null : failureOf(name, finished, prompt, true));
    const limit = reported === null ? null : harnessNamed(name).usageLimit(reported, Date.now());
    if (error !== null && limit !== null) return { verdict: "limited", body: error, ...limit };
    if (code === 0)
      return {
        verdict: "failed",
        body: error === null ? otherwise : `the reviewer answered outside the shape: ${error}`,
      };
    const why = error === null ? "" : `: ${error}`;
    return { verdict: "failed", body: `${name} exited with ${code}${why}` };
  };
  if (code !== 0) return failed("");
  // Each harness gives its answer in its own way, so the harness reads it, and the answer is
  // then checked against the shape the reviewer was asked for.
  let said: unknown;
  try {
    said = harnessNamed(name).answer(folder, out);
  } catch (error) {
    const why = errorText(error);
    return failed(`the reviewer answered outside the shape: ${why}`);
  }
  const verdict = Verdict.safeParse(said);
  if (!verdict.success)
    return {
      verdict: "failed",
      body: `the reviewer answered outside the shape: ${z.prettifyError(verdict.error)}`,
    };
  return verdict.data;
}

// Runs a fresh reviewer against a throwaway view of the clone and returns its verdict or failure
// reason. Enforces cancellation and a time limit, then removes the review's temporary
// files.
async function reviewNow(given: {
  clone: string;
  issue: { title: string; body: string };
  base: string;
  commit: string;
  model?: string | undefined;
  harness: HarnessName;
  signal?: AbortSignal;
  limit?: number;
  env?: Record<string, string | undefined>;
}): Promise<Review | Limited> {
  const { clone, issue, base, model, harness, limit = 30 * 60_000, env = process.env } = given;
  // Fail at once, with a reason you can act on, when the review was cancelled before its turn
  // or can't run on this machine.
  if (given.signal?.aborted) return { verdict: "failed", body: "the review was cancelled" };
  const home = env.HOME;
  if (!home)
    return { verdict: "failed", body: "HOME isn't set, so Skelcrew can't find its own folders" };
  const path = env.PATH ?? "";
  if (!Bun.which(harness, { PATH: path }))
    return {
      verdict: "failed",
      body: `${harness} isn't installed, and your config picks it for reviews`,
    };
  const folder = mkdtempSync(join(tmpdir(), "skelcrew-review-"));
  const timeout = AbortSignal.timeout(limit);
  // Never the timeout itself, even alone: Bun cancels a timeout's timer when a process given
  // it ends, so the copying before the review would leave the review with no limit.
  const signal = AbortSignal.any(given.signal ? [given.signal, timeout] : [timeout]);
  // A review can be cancelled or run out of time while its folders are copied, as well as
  // while the reviewer runs.
  const whyStopped = (): Review | null => {
    if (given.signal?.aborted) return { verdict: "failed", body: "the review was cancelled" };
    if (timeout.aborted)
      return { verdict: "timed out", body: `the reviewer ran past ${limit / 60_000} minutes` };
    return null;
  };
  let argv: string[] = [];
  try {
    // The harness gets the answer's shape from a file, and says how to start the reviewer
    // and what it needs from outside the sandbox.
    await Bun.write(join(folder, "schema.json"), schema);
    const { keys } = harnessNamed(harness);
    const launch = await harnessNamed(harness).review({
      home,
      folder,
      model,
      schema,
      signal,
    });
    // Only what a shell and the tests need gets in, with the harness's own keys added.
    const sandboxEnv = { ...launch.env, ...filterEnv(env, keys) };
    // Tests and builds write in the clone, so it is seen as a throwaway folder too.
    const copy = join(folder, "clone");
    const { mounts, at } = await throwawayMounts({ source: clone, copy, signal });
    mounts.push("--bind", folder, folder);
    // The builder can go on changing its clone after it submits, so the reviewer sees the
    // submitted commit, with what the builder changed since put aside. Ignored files, such
    // as installed packages, stay for the tests. git runs in the sandbox, as the clone's
    // .git is the builder's to plant settings in.
    const checkout = 'git checkout -q -f --detach "$0" && git clean -q -fd && exec "$@"';
    argv = sandboxArgs({
      home,
      path,
      mounts: [...mounts, ...launch.mounts],
      cwd: at,
      command: ["sh", "-c", checkout, given.commit, ...launch.command],
      programs: launch.command.slice(0, 1),
    });
    // Check for cancellation and the time limit on both sides of the run, so a review that was
    // stopped says so rather than reading half an answer.
    const before = whyStopped();
    if (before) return before;
    const input = reviewerPrompt(issue, base);
    const finished = await spawnReviewer({ argv, env: sandboxEnv, input, signal });
    const after = whyStopped();
    if (after) return after;
    return readVerdict(harness, folder, finished, input);
  } finally {
    // On a Mac the review may have been ended with SIGKILL, before the sandbox could remove
    // its own folders, one of them in /tmp.
    for (const own of [folder, ...sandboxFolders(argv)])
      rmSync(own, { recursive: true, force: true });
  }
}

let queue: Promise<unknown> = Promise.resolve();

// Queues a review and returns its verdict, turning errors into failed verdicts for the
// caller. One review at a time across the daemon: reviews share Skelcrew's Codex login, and a
// renewal by one could leave the others with a token that no longer works. A review never
// rejects, so one that throws can't stop the reviews queued after it. A review whose turn
// comes while its harness waits out a usage limit doesn't start, and is limited at once, as a
// review ahead of it in the queue may have just hit that limit.
export function review(given: Parameters<typeof reviewNow>[0]): Promise<Review | Limited> {
  const turn = queue
    .then((): Review | Limited | Promise<Review | Limited> => {
      const limit = limitOn(given.harness, Date.now());
      if (limit === null) return reviewNow(given);
      return { verdict: "limited", body: "its usage limit is reached", reset: limit.reset };
    })
    .catch((error): Review => {
      return { verdict: "failed", body: errorText(error) };
    });
  queue = turn;
  return turn;
}
