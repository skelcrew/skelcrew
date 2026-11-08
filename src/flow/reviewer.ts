// Runs a fresh adversarial reviewer in the sandbox for each thread's PR, on the harness your
// config names for reviews.
import { mkdtempSync, rmSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { z } from "zod";
import { type HarnessName, harnessNamed } from "../agents/harness.ts";
import { sandboxArgs, throwaway } from "../agents/sandbox.ts";
import { onSprite } from "../machine/sprite.ts";
import { errorText } from "../say.ts";

export type Review = { verdict: "approve" | "changes" | "failed"; body: string };

const Verdict = z.strictObject({ verdict: z.enum(["approve", "changes"]), body: z.string() });

// Every harness holds the model to this shape. OpenAI's strict mode asks for
// every property to be required and no others allowed.
const schema = JSON.stringify({
  type: "object",
  properties: {
    verdict: { type: "string", enum: ["approve", "changes"] },
    body: { type: "string" },
  },
  required: ["verdict", "body"],
  additionalProperties: false,
});

// Only what a shell and the tests need gets in, with the harness's own keys added.
const allowedEnv = ["PATH", "HOME", "USER", "LOGNAME", "SHELL", "TERM", "LANG", "TZ"];

// Builds the reviewer's instructions from the issue and base branch, asking for actionable
// findings.
function prompt(issue: { title: string; body: string }, base: string): string {
  return `Review this pull request as an adversarial reviewer. Another agent wrote it. Assume it is wrong until you have checked it yourself.

It should resolve this issue:

# ${issue.title}

${issue.body}

The change is everything on HEAD since ${base}. Read the whole diff with \`git diff ${base}...HEAD\`, and the code around it. Run the tests, using the commands under test: in the repository's skel.yaml if there is one. Anything you change here is thrown away after the review, so run what you need, but don't fix the code.

Check that it does what the issue asks and nothing else, and look for bugs, edge cases it misses, missing tests and failing ones.

Answer "approve" only if it is ready to merge. Otherwise answer "changes", and in the body name each problem, where it is and why it matters, so the builder can fix it.`;
}

// Starts the reviewer, waits for it to end, and returns what it printed and its exit code.
// Ending bwrap ends everything inside: the reviewer runs as the first process of a process
// list of its own, which the kernel empties when that process dies. On a Sprite, unshare
// comes first and ignores SIGTERM, so the review is ended with SIGKILL. A Mac has no process
// lists of their own, so the reviewer leads a group, which is ended when it ends. A process
// left in it would also hold its output open, and the review would wait forever.
async function spawnReviewer(given: {
  argv: string[];
  env: Record<string, string>;
  input: string;
  signal: AbortSignal;
}): Promise<{ out: string; err: string; code: number }> {
  const { argv, env, input, signal } = given;
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

// Returns the verdict of a reviewer that has ended, or a failed one saying why there is none:
// it exited with an error, or answered outside the shape.
function readVerdict(
  name: HarnessName,
  folder: string,
  finished: { out: string; err: string; code: number },
): Review {
  const { out, err, code } = finished;
  if (code !== 0)
    return {
      verdict: "failed",
      body: `${name} exited with ${code}: ${err.trim().slice(-2000)}`,
    };
  let said: unknown;
  try {
    said = harnessNamed(name).answer(folder, out);
  } catch (error) {
    const why = errorText(error);
    return { verdict: "failed", body: `the reviewer answered outside the shape: ${why}` };
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
}): Promise<Review> {
  const { clone, issue, base, model, harness, limit = 30 * 60_000, env = process.env } = given;
  if (given.signal?.aborted) return { verdict: "failed", body: "the review was cancelled" };
  const home = env.HOME;
  if (!home)
    return { verdict: "failed", body: "HOME isn't set, so skel can't find its own folders" };
  const path = env.PATH ?? "";
  if (!Bun.which(harness, { PATH: path }))
    return {
      verdict: "failed",
      body: `${harness} isn't installed, and your config picks it for reviews`,
    };
  const folder = mkdtempSync(join(tmpdir(), "skel-review-"));
  const timeout = AbortSignal.timeout(limit);
  // Never the timeout itself, even alone: Bun cancels a timeout's timer when a process given
  // it ends, so the copying before the review would leave the review with no limit.
  const signal = AbortSignal.any(given.signal ? [given.signal, timeout] : [timeout]);
  const sprite = onSprite(path);
  // A review can be cancelled or run out of time while its folders are copied, as well as
  // while the reviewer runs.
  const stopped = (): Review | null => {
    if (given.signal?.aborted) return { verdict: "failed", body: "the review was cancelled" };
    if (timeout.aborted)
      return { verdict: "failed", body: `the reviewer ran past ${limit / 60_000} minutes` };
    return null;
  };
  try {
    await Bun.write(join(folder, "schema.json"), schema);
    const { keys } = harnessNamed(harness);
    const launch = await harnessNamed(harness).review({
      home,
      folder,
      model,
      schema,
      sprite,
      signal,
    });
    const kept: Record<string, string> = { ...launch.env };
    const allowed: string[] = [...allowedEnv, ...keys];
    for (const [key, value] of Object.entries(env))
      if (value !== undefined && (allowed.includes(key) || key.startsWith("LC_")))
        kept[key] = value;
    // Tests and builds write in the clone, so it is seen as a throwaway folder too.
    const copy = join(folder, "clone");
    const { mounts, at } = await throwaway({ source: clone, copy, sprite, signal });
    mounts.push("--bind", folder, folder);
    // The builder can go on changing its clone after it submits, so the reviewer sees the
    // submitted commit, with what the builder changed since put aside. Ignored files, such
    // as installed packages, stay for the tests. git runs in the sandbox, as the clone's
    // .git is the builder's to plant settings in.
    const checkout = 'git checkout -q -f --detach "$0" && git clean -q -fd && exec "$@"';
    const argv = sandboxArgs({
      home,
      path,
      mounts: [...mounts, ...launch.mounts],
      cwd: at,
      command: ["sh", "-c", checkout, given.commit, ...launch.command],
      programs: launch.command.slice(0, 1),
    });
    const before = stopped();
    if (before) return before;
    const finished = await spawnReviewer({ argv, env: kept, input: prompt(issue, base), signal });
    const after = stopped();
    if (after) return after;
    return readVerdict(harness, folder, finished);
  } finally {
    rmSync(folder, { recursive: true, force: true });
  }
}

let queue: Promise<unknown> = Promise.resolve();

// Queues a review and returns its verdict, turning errors into failed verdicts for the
// caller. One review at a time across the daemon: reviews share skel's Codex login, and a
// renewal by one could leave the others with a token that no longer works. A review never
// rejects, so one that throws can't stop the reviews queued after it.
export function review(given: Parameters<typeof reviewNow>[0]): Promise<Review> {
  const turn = queue
    .then(() => reviewNow(given))
    .catch((error): Review => {
      return { verdict: "failed", body: errorText(error) };
    });
  queue = turn;
  return turn;
}
