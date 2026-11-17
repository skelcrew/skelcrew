// Runs a fresh adversarial reviewer in the sandbox for each thread's PR, on the harness your
// config names for reviews.
import { mkdtempSync, renameSync, rmSync, writeFileSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { z } from "zod";
import { type HarnessName, harnessNamed } from "../agents/harness.ts";
import { filterEnv, sandboxArgs, throwawayMounts } from "../agents/sandbox.ts";
import { sandboxFolders } from "../agents/seatbelt.ts";
import { builtInRole } from "../roles.ts";
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

// Who runs the tests on a review's commit: CI, whose result is in the file `ci`; the reviewer;
// or no one, on a change to docs and Markdown alone.
export type Tests = { ci: string } | "run" | "docs only";

// Returns what the reviewer does when it has to run the whole test suite: `run` it with the
// commands under test: in the repository's skelcrew.yaml or your config. With none named, or
// with test configured as none, it reviews without running tests and says why. Skelcrew never
// guesses a test command, as a wrong guess would pass for a real result.
function runSuite(run: string, test: string[] | undefined): string {
  if (test === undefined)
    return "no test command is configured, so don't run the tests. Review the code, and say in the body that you didn't run them, as none is configured.";
  if (test.length === 0)
    return "don't run the tests: the repository is configured with none. Review the code, and say in the body that you didn't run them, as it has none.";
  return `${run}, with \`${test.join(" && ")}\`.`;
}

// Returns what the reviewer is told about the tests. The whole test suite runs once per commit,
// and only when code changed, as several threads running it at once overload the machine. So
// with CI on the commit the reviewer reads CI's result from its file, without CI it runs the
// suite with `test`, and on a change to docs alone no one runs it.
function testsTold(tests: Tests, test: string[] | undefined): string {
  if (tests === "docs only")
    return "The change only touches docs and Markdown, so don't run the tests. Say in the body that you didn't run them, as no code changed.";
  if (tests === "run")
    return `No CI runs on this commit, so ${runSuite("run the repository's whole test suite", test)}`;
  return `The repository's CI runs the whole test suite on this commit, so don't run it yourself. Run a single test only to settle a doubt. CI's result for this commit is in ${tests.ci}: whether it passed, failed or is still running, and the end of each failed check's log. Skelcrew updates that file as CI goes on, so read it when you start and again just before you answer. When CI failed, name the failing tests as problems. When it lists checks and none of them runs the tests, such as only a deploy preview or a CLA check, ${runSuite("run the whole test suite yourself", test)} When CI hasn't reported yet, or is still running as you answer, review the code anyway, and say in the body that CI is still running.`;
}

// Returns what the reviewer is told: its built-in instructions, with the task it checks the
// PR against, where the change starts, and who runs the tests and with what filled into their
// blanks. All blanks are filled in one pass, so a task whose text holds a blank's mark, or a `$&`, reaches
// the reviewer as written. The file's last newline is dropped, as the reviewer has always been
// told without one.
export function reviewerPrompt(
  issue: { title: string; body: string },
  base: string,
  tests: Tests,
  test: string[] | undefined,
): string {
  const blanks: Record<string, string> = { ...issue, base, tests: testsTold(tests, test) };
  const instructions = builtInRole("reviewer").instructions.replace(/\n$/, "");
  return instructions.replace(
    /\{\{(title|body|base|tests)\}\}/g,
    (_, blank: string) => blanks[blank] ?? "",
  );
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
  // the review would wait forever, and keep its place among the reviews that run at once.
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
// harness's own error, such as "ERROR: connection refused" in a bug report, so the echoed
// prompt is taken out before anything is read.
function failureOf(
  name: HarnessName,
  finished: { out: string; err: string },
  prompt: string,
  guess: boolean,
): string | null {
  // The echoed prompt goes as one block, so an error printed after it stays, even one the
  // task quotes word for word. It ends with no newline, so what the harness prints next would
  // join its last line: a newline takes its place. Echoed some other way, only its lines can
  // be told apart, and each line of it goes.
  const block = prompt.trimEnd();
  const echoed = new Set(prompt.split("\n").map((line) => line.trim()));
  const own = (printed: string) => {
    const at = printed.indexOf(block);
    if (at >= 0) return `${printed.slice(0, at)}\n${printed.slice(at + block.length)}`;
    return printed
      .split("\n")
      .filter((line) => line.trim() === "" || !echoed.has(line.trim()))
      .join("\n");
  };
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
// files. `ci` says whether CI runs on the commit, asked as the review starts, since CI may have
// shown a check while it waited its turn, and what CI says about the commit. With CI, the reviewer
// reads CI's result rather than running the whole test suite. It is asked again every 15
// seconds while the review runs, as CI usually finishes during it. `docsOnly` says the change
// touches only docs and Markdown, so the reviewer runs no tests, and `ci` isn't asked. `test`
// is the repository's test command, for when the reviewer has to run the suite.
async function reviewNow(given: {
  clone: string;
  issue: { title: string; body: string };
  base: string;
  test: string[] | undefined;
  commit: string;
  model?: string | undefined;
  harness: HarnessName;
  signal?: AbortSignal;
  limit?: number;
  env?: Record<string, string | undefined>;
  ci?: { has: () => boolean; read: () => Promise<string> } | undefined;
  docsOnly?: boolean;
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
  // CI's result goes in the review's folder, which the reviewer sees. It is written whole and
  // then moved in, so the reviewer never reads half of it. The reviewer can write in that
  // folder too, so Skelcrew never writes to a file there it didn't just make: each result goes
  // to a new name, made only if nothing is there, which never follows a link, and the rename
  // replaces whatever is at ci.md rather than writing into it. A write that fails leaves the
  // result before in place. A failure to ask is written there
  // too, so the reviewer says it couldn't tell rather than taking an old result for current.
  // Asking the forge for a failed log can take a minute, longer than between two refreshes,
  // so a refresh is skipped while the one before still runs. Once the review ends, an answer
  // that comes late writes nothing, and the review never waits for it: the next review in the
  // queue would wait too.
  const ciFile = join(folder, "ci.md");
  let ended = false;
  let refreshing = false;
  const writeCi = async (read: () => Promise<string>) => {
    refreshing = true;
    try {
      const text = await read().catch((e) => `Skelcrew couldn't read CI: ${errorText(e)}\n`);
      // No await between this check and the write, so it never lands in a removed folder.
      if (ended) return;
      const aside = join(folder, `.ci-${crypto.randomUUID()}.md`);
      writeFileSync(aside, text, { flag: "wx" });
      renameSync(aside, ciFile);
    } catch {
      // Something the reviewer left in the way: it keeps reading the result before.
    } finally {
      refreshing = false;
    }
  };
  let refresh: ReturnType<typeof setInterval> | undefined;
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
    // Its git keeps an index of its own in the review's folder, as explained below.
    const index = join(folder, "index");
    const sandboxEnv = { ...launch.env, ...filterEnv(env, keys), GIT_INDEX_FILE: index };
    // Tests and builds write in the clone, so it is seen as a throwaway folder too.
    const copy = join(folder, "clone");
    const { mounts, at } = await throwawayMounts({ source: clone, copy, signal });
    mounts.push("--bind", folder, folder);
    // The builder can go on changing its clone after it submits, so the reviewer sees the
    // submitted commit, with what the builder changed since put aside. Ignored files, such
    // as installed packages, stay for the tests. git runs in the sandbox, as the clone's
    // .git is the builder's to plant settings in. The builder runs git whenever it likes, and
    // a command of its holds index.lock or HEAD.lock in its .git, which the view shows. A
    // checkout needs both, so the review never takes them: it reads the commit into an index
    // of its own, started from a copy of the builder's so unchanged files aren't rewritten,
    // and then points HEAD at the commit by writing it, which needs no lock. git replaces the
    // builder's index whole, so the copy is never half written. Without one to copy, git
    // starts from an empty index. Every other step must work, or the reviewer never starts.
    const checkout = [
      '{ cp "$(git rev-parse --git-dir)/index" "$GIT_INDEX_FILE" 2>/dev/null || true; }',
      'git read-tree --reset -u "$0"',
      "git clean -q -fd",
      'printf "%s\\n" "$0" > "$(git rev-parse --git-path HEAD)"',
      'exec "$@"',
    ].join(" && ");
    argv = sandboxArgs({
      home,
      path,
      mounts: [...mounts, ...launch.mounts],
      cwd: at,
      command: ["sh", "-c", checkout, given.commit, ...launch.command],
      programs: launch.command.slice(0, 1),
    });
    // CI's result is there before the reviewer starts, and kept current while it runs. The
    // first answer is waited for, but never past a cancellation or the time limit.
    const ci = !given.docsOnly && given.ci?.has() ? given.ci.read : undefined;
    if (ci && !signal.aborted) {
      const stopped = new Promise<void>((resolve) =>
        signal.addEventListener("abort", () => resolve(), { once: true }),
      );
      await Promise.race([writeCi(ci), stopped]);
      refresh = setInterval(() => {
        if (!refreshing) writeCi(ci).catch(() => {});
      }, 15_000);
    }
    // Check for cancellation and the time limit on both sides of the run, so a review that was
    // stopped says so rather than reading half an answer.
    const before = whyStopped();
    if (before) return before;
    const tests: Tests = given.docsOnly ? "docs only" : ci ? { ci: ciFile } : "run";
    const input = reviewerPrompt(issue, base, tests, given.test);
    const finished = await spawnReviewer({ argv, env: sandboxEnv, input, signal });
    const after = whyStopped();
    if (after) return after;
    return readVerdict(harness, folder, finished, input);
  } finally {
    // No write of CI's result may land after the folder is gone, or it would make it again.
    ended = true;
    clearInterval(refresh);
    // On a Mac the review may have been ended with SIGKILL, before the sandbox could remove
    // its own folders, one of them in /tmp.
    for (const own of [folder, ...sandboxFolders(argv)])
      rmSync(own, { recursive: true, force: true });
  }
}

// Runs a review and returns its verdict. An error becomes a failed verdict, so a review that
// throws ends its round as any failed review does. How many run at once is the round's to
// limit. A review whose turn comes while its harness waits out a usage limit doesn't start,
// and is limited at once, as a review that ran just before it may have hit that limit.
export function review(given: Parameters<typeof reviewNow>[0]): Promise<Review | Limited> {
  const limit = limitOn(given.harness, Date.now());
  if (limit !== null)
    return Promise.resolve({
      verdict: "limited",
      body: "its usage limit is reached",
      reset: limit.reset,
    });
  return reviewNow(given).catch((error): Review => ({ verdict: "failed", body: errorText(error) }));
}
