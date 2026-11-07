// Runs a fresh adversarial reviewer in the sandbox for each thread's PR. Uses the harness
// your config names, or else Codex when it is installed and Claude Code on the builder's
// model when it isn't.
import {
  existsSync,
  lstatSync,
  mkdirSync,
  mkdtempSync,
  readdirSync,
  readFileSync,
  rmSync,
  symlinkSync,
} from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { z } from "zod";
import { claudeToken, settings } from "./claude.ts";
import { dataDir } from "./paths.ts";
import { sandboxArgs } from "./sandbox.ts";
import { errorText } from "./say.ts";
import { onSprite } from "./sprite.ts";

export type Review = { verdict: "approve" | "changes" | "failed"; body: string };

const Verdict = z.strictObject({ verdict: z.enum(["approve", "changes"]), body: z.string() });

// Codex and Claude Code both hold the model to this shape. OpenAI's strict mode asks for
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

// Only what a shell, the tests and the harness need gets in. The keys are for those who use
// one rather than a login. codex exec reads CODEX_API_KEY: given only OPENAI_API_KEY, it
// sent no key at all.
const allowedEnv = [
  ...["PATH", "HOME", "USER", "LOGNAME", "SHELL", "TERM", "LANG", "TZ"],
  ...["OPENAI_API_KEY", "CODEX_API_KEY", "ANTHROPIC_API_KEY"],
];

// Returns the harness a review runs on: the one your config names, or else Codex when it is
// installed and Claude Code when it isn't. The thread saves it as the review starts, so you can
// see which agent has the thread while it waits and runs.
export const reviewerHarness = (configured: "codex" | "claude" | undefined, path: string) =>
  configured ?? (Bun.which("codex", { PATH: path }) ? "codex" : "claude");

// Builds the reviewer's instructions from the issue and base branch, asking for actionable
// findings.
function prompt(issue: { title: string; body: string }, base: string): string {
  return `Review this pull request as an adversarial reviewer. Another agent wrote it. Assume it is wrong until you have checked it yourself.

It should resolve this issue:

# ${issue.title}

${issue.body}

The change is everything on HEAD since ${base}. Read the whole diff with \`git diff ${base}...HEAD\`, and the code around it. Run the tests, using the commands under test: in skel.yaml if there is one. Anything you change here is thrown away after the review, so run what you need, but don't fix the code.

Check that it does what the issue asks and nothing else, and look for bugs, edge cases it misses, missing tests and failing ones.

Answer "approve" only if it is ready to merge. Otherwise answer "changes", and in the body name each problem, where it is and why it matters, so the builder can fix it.`;
}

// Returns the mounts that show the reviewer a folder whose changes are thrown away after the
// review, and where it sees that folder. A copy leaves out the entries named in `kept`, which
// the caller mounts writable over it, and bwrap makes their places in the copy.
// bwrap's throwaway overlay does it, but on a Sprite an overlay can't be made on the
// Sprite's own disk, which is an overlay already: bwrap fails with "Invalid argument". There
// the reviewer gets a copy instead, made in the review's own folder so it goes with it. A Mac
// has no overlay either, and can't show a folder at another path, so there the reviewer
// works in the copy where it lies, which the review's folder already opens to it.
async function throwaway(given: {
  source: string;
  copy: string;
  sprite: boolean;
  signal: AbortSignal;
  kept?: string[];
}): Promise<{ mounts: string[]; at: string }> {
  const { source, copy, sprite, signal, kept = [] } = given;
  const mac = process.platform === "darwin";
  if (!sprite && !mac)
    return { mounts: ["--overlay-src", source, "--tmp-overlay", source], at: source };
  mkdirSync(copy);
  const entries = readdirSync(source).filter((entry) => !kept.includes(entry));
  if (entries.length > 0) {
    let copied = false;
    let err = "";
    // A copy of a clone with its installed packages is large, and cp shares the blocks
    // where the disk allows it. A Mac's cp has its own word for that, and can fail on it
    // across two disks, so it goes on to a plain copy.
    const paths = entries.map((entry) => join(source, entry));
    for (const share of mac ? [["-c"], []] : [["--reflink=auto"]]) {
      const cp = ["cp", "-a", ...share, ...paths, copy];
      const copying = Bun.spawn(cp, { stdout: "ignore", stderr: "pipe", signal });
      const [said, code] = await Promise.all([new Response(copying.stderr).text(), copying.exited]);
      err = said;
      copied = code === 0;
      if (copied) break;
    }
    // A copy cut short by a cancel is reported as the cancel, after the copy is removed.
    if (!copied && !signal.aborted)
      throw new Error(`couldn't copy ${source} for the reviewer: ${err.trim()}`);
  }
  return mac ? { mounts: [], at: copy } : { mounts: ["--bind", copy, source], at: source };
}

// Returns Codex's review command, mounts and environment, protecting instructions shared by
// reviews. skel's Codex folder holds what Codex reads as instructions, and every review
// shares it. So the reviewer sees it as a throwaway folder, and only its login and sessions
// reach the real one. Codex saves its login by rewriting auth.json in place, not by renaming
// a new file over it, so the file itself can be mounted and a renewal still reaches skel's.
async function codexCommand(home: string, folder: string, sprite: boolean, signal: AbortSignal) {
  const codexHome = join(dataDir(home), "codex");
  const sessions = join(codexHome, "sessions");
  mkdirSync(sessions, { recursive: true, mode: 0o700 });
  const copy = join(folder, "codex");
  const { mounts, at } = await throwaway({
    source: codexHome,
    copy,
    sprite,
    signal,
    kept: ["sessions", "auth.json"],
  });
  mounts.push("--bind", sessions, sessions);
  const auth = join(codexHome, "auth.json");
  if (existsSync(auth)) mounts.push("--bind", auth, auth);
  // A copy at another path can't have the real ones mounted into it, so it links to them.
  if (at !== codexHome) {
    symlinkSync(sessions, join(at, "sessions"));
    if (existsSync(auth)) symlinkSync(auth, join(at, "auth.json"));
  }
  // --no-daemon belongs to codex itself, not to exec: without it Codex may start a
  // background server that outlives the review.
  const command = ["codex", "--no-daemon", "exec", "--dangerously-bypass-approvals-and-sandbox"];
  command.push("--output-schema", join(folder, "schema.json"), "-o", join(folder, "answer.json"));
  command.push("-");
  return { command, mounts, env: { CODEX_HOME: at } };
}

// Returns Claude Code's review command and isolated login settings when Codex is
// unavailable.
function claudeCommand(home: string, folder: string, model: string) {
  const token = claudeToken(home);
  const command = ["claude", "-p", "--model", model, "--output-format", "json"];
  command.push("--json-schema", schema, "--no-session-persistence");
  command.push("--permission-mode", "bypassPermissions", "--settings", settings);
  const env = { CLAUDE_CONFIG_DIR: join(folder, "claude"), CLAUDE_CODE_OAUTH_TOKEN: token };
  return { command, mounts: [], env };
}

// Returns the reviewer's JSON answer for validation, from Claude Code output or Codex's
// answer file. Read only after the reviewer ends, so it cannot change the file meanwhile.
function answer(harness: "codex" | "claude", folder: string, out: string): unknown {
  if (harness === "claude")
    return z.looseObject({ structured_output: z.unknown() }).parse(JSON.parse(out))
      .structured_output;
  const file = join(folder, "answer.json");
  if (!lstatSync(file, { throwIfNoEntry: false })?.isFile()) throw new Error("it gave no answer");
  return JSON.parse(readFileSync(file, "utf8"));
}

// Runs a fresh reviewer against a throwaway view of the clone and returns its verdict or failure
// reason. Enforces cancellation and a time limit, then removes the review's temporary
// files.
async function reviewNow(given: {
  clone: string;
  issue: { title: string; body: string };
  base: string;
  commit: string;
  model: string;
  harness?: "codex" | "claude" | undefined;
  signal?: AbortSignal;
  limit?: number;
  env?: Record<string, string | undefined>;
}): Promise<Review> {
  const { clone, issue, base, model, limit = 30 * 60_000, env = process.env } = given;
  if (given.signal?.aborted) return { verdict: "failed", body: "the review was cancelled" };
  const home = env.HOME;
  if (!home)
    return { verdict: "failed", body: "HOME isn't set, so skel can't find its own folders" };
  const path = env.PATH ?? "";
  const harness = reviewerHarness(given.harness, path);
  if (given.harness && !Bun.which(harness, { PATH: path }))
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
    const run =
      harness === "codex"
        ? await codexCommand(home, folder, sprite, signal)
        : claudeCommand(home, folder, model);
    const kept: Record<string, string> = { ...run.env };
    for (const [key, value] of Object.entries(env))
      if (value !== undefined && (allowedEnv.includes(key) || key.startsWith("LC_")))
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
      mounts: [...mounts, ...run.mounts],
      cwd: at,
      command: ["sh", "-c", checkout, given.commit, ...run.command],
      programs: run.command.slice(0, 1),
    });
    const before = stopped();
    if (before) return before;
    // Ending bwrap ends everything inside: the reviewer runs as the first process of a
    // process list of its own, which the kernel empties when that process dies. On a
    // Sprite, unshare comes first and ignores SIGTERM, so the review is ended with SIGKILL.
    // A Mac has no process lists of their own, so the reviewer leads a group, which is ended
    // when it ends. A process left in it would also hold its output open, and the review
    // would wait forever.
    const mac = process.platform === "darwin";
    const proc = Bun.spawn(argv, {
      env: kept,
      stdin: new Blob([prompt(issue, base)]),
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
    const after = stopped();
    if (after) return after;
    if (code !== 0)
      return {
        verdict: "failed",
        body: `${harness} exited with ${code}: ${err.trim().slice(-2000)}`,
      };
    let said: unknown;
    try {
      said = answer(harness, folder, out);
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
