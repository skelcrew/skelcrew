// Runs a fresh adversarial reviewer in the sandbox for each thread's PR. Uses the harness
// your config names, or else Codex when it is installed and Claude Code on the builder's
// model when it isn't.
import { existsSync, lstatSync, mkdirSync, mkdtempSync, readFileSync, rmSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { z } from "zod";
import { sandboxArgs, settings } from "./sandbox.ts";

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
const passed = [
  ...["PATH", "HOME", "USER", "LOGNAME", "SHELL", "TERM", "LANG", "TZ"],
  ...["OPENAI_API_KEY", "CODEX_API_KEY", "ANTHROPIC_API_KEY"],
];

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

// Returns Codex's review command, mounts and environment, protecting instructions shared by
// reviews. skel's Codex folder holds what Codex reads as instructions, and every review
// shares it. So the reviewer sees it through a throwaway layer, and only its login and
// sessions reach the real folder. Codex saves its login by rewriting auth.json in place,
// not by renaming a new file over it, so the file itself can be mounted and a renewal still
// reaches skel's.
function codexCommand(home: string, folder: string) {
  const codexHome = join(home, ".local", "share", "skel", "codex");
  mkdirSync(join(codexHome, "sessions"), { recursive: true, mode: 0o700 });
  const mounts = ["--overlay-src", codexHome, "--tmp-overlay", codexHome];
  mounts.push("--bind", join(codexHome, "sessions"), join(codexHome, "sessions"));
  const auth = join(codexHome, "auth.json");
  if (existsSync(auth)) mounts.push("--bind", auth, auth);
  // --no-daemon belongs to codex itself, not to exec: without it Codex may start a
  // background server that outlives the review.
  const command = ["codex", "--no-daemon", "exec", "--dangerously-bypass-approvals-and-sandbox"];
  command.push("--output-schema", join(folder, "schema.json"), "-o", join(folder, "answer.json"));
  command.push("-");
  return { command, mounts, env: { CODEX_HOME: codexHome } };
}

// Returns Claude Code's review command and isolated login settings when Codex is
// unavailable.
function claudeCommand(home: string, folder: string, model: string) {
  const tokenFile = join(home, ".config", "skel", "claude-token");
  if (!existsSync(tokenFile))
    throw new Error("Claude Code's login token for agents isn't saved yet: run skel to set it up");
  const token = z.string().trim().min(1).parse(readFileSync(tokenFile, "utf8"));
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

// Runs a fresh reviewer against a throwaway clone layer and returns its verdict or failure
// reason. Enforces cancellation and a time limit, then removes the review's temporary
// files.
async function reviewNow(given: {
  clone: string;
  issue: { title: string; body: string };
  base: string;
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
  const harness = given.harness ?? (Bun.which("codex", { PATH: path }) ? "codex" : "claude");
  if (given.harness && !Bun.which(harness, { PATH: path }))
    return {
      verdict: "failed",
      body: `${harness} isn't installed, and your config picks it for reviews`,
    };
  const folder = mkdtempSync(join(tmpdir(), "skel-review-"));
  try {
    await Bun.write(join(folder, "schema.json"), schema);
    const run =
      harness === "codex" ? codexCommand(home, folder) : claudeCommand(home, folder, model);
    const kept: Record<string, string> = { ...run.env };
    for (const [key, value] of Object.entries(env))
      if (value !== undefined && (passed.includes(key) || key.startsWith("LC_"))) kept[key] = value;
    // Tests and builds write in the clone, so it is seen through a throwaway layer too.
    const mounts = ["--overlay-src", clone, "--tmp-overlay", clone, "--bind", folder, folder];
    const argv = sandboxArgs({
      home,
      path,
      mounts: [...mounts, ...run.mounts],
      cwd: clone,
      command: run.command,
    });
    const timeout = AbortSignal.timeout(limit);
    const signal = given.signal ? AbortSignal.any([given.signal, timeout]) : timeout;
    // Ending bwrap ends everything inside: the reviewer runs as the first process of a
    // process list of its own, which the kernel empties when that process dies.
    const proc = Bun.spawn(argv, {
      env: kept,
      stdin: new Blob([prompt(issue, base)]),
      stdout: "pipe",
      stderr: "pipe",
      signal,
    });
    const [out, err, code] = await Promise.all([
      new Response(proc.stdout).text(),
      new Response(proc.stderr).text(),
      proc.exited,
    ]);
    if (given.signal?.aborted) return { verdict: "failed", body: "the review was cancelled" };
    if (timeout.aborted)
      return { verdict: "failed", body: `the reviewer ran past ${limit / 60_000} minutes` };
    if (code !== 0)
      return {
        verdict: "failed",
        body: `${harness} exited with ${code}: ${err.trim().slice(-2000)}`,
      };
    let said: unknown;
    try {
      said = answer(harness, folder, out);
    } catch (error) {
      const why = error instanceof Error ? error.message : String(error);
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
      return { verdict: "failed", body: error instanceof Error ? error.message : String(error) };
    });
  queue = turn;
  return turn;
}
