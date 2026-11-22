// Skelcrew's extension for Pi, which every Pi agent and review loads: it runs sc's hooks as a turn
// starts and ends, draws the marks Skelcrew reads on the screen, and gives a reviewer its verdict tool.
// Pi loads it from a file of its own, so it imports nothing but Node's own modules.
import { spawn } from "node:child_process";
import { readFileSync, writeFileSync } from "node:fs";
import { join } from "node:path";

// The line Pi's screen shows while it waits for a message with nothing typed, and the start of
// the line that shows while it works, which counts the seconds so it redraws while a turn runs.
// Pi's own input has no prompt mark, and its busy line reads differently while it retries or
// compacts.
export const readyMark = "◇ Pi is ready for a message";
export const busyMark = "◆ Pi is at work";

// The tool a reviewer gives its verdict with, as Pi has no setting that holds an answer to a shape.
export const verdictTool = "skelcrew_verdict";

// Returns the HTTP status a Pi error names, or null when it names none. Pi gives no status of its
// own, only text, and each of its provider APIs puts the status in one place: first, as in
// "429: ..." or Anthropic's "429 {...}", after the provider's name, as in "openrouter API error (429): ...",
// or in Google's body, which comes alone, as in {"error":{"code":429,...}}.
function httpStatus(error: string): number | null {
  const said = error.trim();
  const first = /^(\d{3})(?:: | \{)/.exec(said) ?? /^[\w.-]+ API error \((\d{3})\): /.exec(said);
  if (first) return Number(first[1]);
  try {
    const code = field(field(JSON.parse(said), "error"), "code");
    return typeof code === "number" ? code : null;
  } catch {
    return null;
  }
}

// Reports whether a Pi error says a usage limit was reached: the provider answered 429, as it does
// for a rate limit and for a quota used up. Its words never decide, so an error that only mentions
// a quota, or a 429 elsewhere, such as in a request ID, is no limit.
export const isUsageLimit = (error: string): boolean => httpStatus(error) === 429;

// Returns the credentials Pi may send: the key and headers it resolved for the model it runs, from
// its login, a key it ran a command for or the environment, and every key or token in the
// environment. Whatever can't be read is left out.
async function credentials(ctx: Context): Promise<string[]> {
  const found = Object.entries(process.env).flatMap(([name, value]) =>
    value && /KEY|TOKEN|SECRET/.test(name) ? [value] : [],
  );
  try {
    const auth = await ctx.modelRegistry.getApiKeyAndHeaders(ctx.model);
    found.push(text(auth, "apiKey"));
    for (const part of ["headers", "env"]) {
      const values = field(auth, part);
      if (typeof values !== "object" || values === null) continue;
      for (const value of Object.values(values))
        if (typeof value === "string") found.push(value, value.split(" ").at(-1) ?? "");
    }
  } catch {}
  return found.filter((value) => value.trim() !== "");
}

// Returns Pi's error with every key taken out, as Skelcrew keeps it in the task's log: each of
// the credentials Pi may send, wherever it stands, even inside a longer word, and anything shaped
// like a key, such as sk-... or a Google key, which a provider can echo back. Only one of three
// characters or fewer, which can be no real key, such as a local model's "x", is taken out just
// where it stands as a word of its own, so it never cuts into every other word.
async function withoutKeys(error: string, ctx: Context): Promise<string> {
  let said = error;
  const longest = (await credentials(ctx)).sort((a, b) => b.length - a.length);
  for (const value of longest) {
    const escaped = value.replace(/[.*+?^${}()|[\]\\]/g, "\\$&");
    const word = value.length < 4 ? `(?<![\\w-])${escaped}(?![\\w-])` : escaped;
    said = said.replace(new RegExp(word, "g"), "[key]");
  }
  return said
    .replace(/\b(sk|rk|pk)-[\w-]{8,}/g, "[key]")
    .replace(/\bAIza[\w-]{20,}/g, "[key]")
    .replace(/\b(Bearer|Basic) [\w.~+/=-]{8,}/gi, "$1 [key]");
}

// What Pi gives a handler besides its event, as far as this extension uses it.
type Context = {
  hasUI: boolean;
  model: unknown;
  modelRegistry: { getApiKeyAndHeaders: (model: unknown) => Promise<unknown> };
  isIdle: () => boolean;
  ui: {
    setWidget: (key: string, lines: string[] | undefined) => void;
    getEditorText: () => string;
  };
};
// What Pi offers an extension, as far as this one uses it. Its events are read as outside input.
type Pi = {
  on: (event: string, handler: (event: unknown, ctx: Context) => unknown) => void;
  registerTool: (tool: {
    name: string;
    label: string;
    description: string;
    parameters: unknown;
    execute: (id: string, given: unknown) => Promise<unknown>;
  }) => void;
};

// Returns a field of an event or a message, or undefined when it has none.
const field = (value: unknown, key: string): unknown =>
  typeof value === "object" && value !== null ? Reflect.get(value, key) : undefined;
// Returns a field that should hold text, or empty text when it doesn't.
const text = (value: unknown, key: string): string => {
  const found = field(value, key);
  return typeof found === "string" ? found : "";
};

// Runs `sc hook <name>` with `input` on stdin, as Claude Code and Codex run their hooks, and waits
// for it, at most ten seconds. It prints nothing, as Pi's screen is the agent's. A missing sc, or
// one that fails, leaves Pi as it is.
function hook(name: string, input: unknown = {}): Promise<void> {
  return new Promise((resolve) => {
    const child = spawn("sc", ["hook", name], {
      env: process.env,
      stdio: ["pipe", "ignore", "ignore"],
      timeout: 10_000,
    });
    child.on("error", () => resolve());
    child.on("close", () => resolve());
    child.stdin.on("error", () => {});
    child.stdin.end(JSON.stringify(input));
  });
}

// Returns the text of an assistant message, its parts joined.
function textOf(message: unknown): string {
  const parts = field(message, "content");
  if (!Array.isArray(parts)) return "";
  return parts.map((part) => (field(part, "type") === "text" ? text(part, "text") : "")).join("");
}

// A review's folder holds the answer's shape, and gets the verdict. Without one, Pi runs as the
// lead or a builder, and its hooks tell Skelcrew what it does.
export default function skelcrew(pi: Pi): void {
  const review = process.env.SKELCREW_PI_REVIEW;
  // The mark Skelcrew knows its error line by. It leaves the environment at once, so no command
  // the reviewer runs can print a line Skelcrew would take for Pi's.
  const mark = process.env.SKELCREW_PI_ERROR_MARK ?? "";
  delete process.env.SKELCREW_PI_ERROR_MARK;
  // The last answer of the run that ended, kept for the moment Pi settles: a run Pi retries ends
  // once for each try.
  let last: unknown = {};
  pi.on("agent_end", (event) => {
    const messages = field(event, "messages");
    const answers = Array.isArray(messages) ? messages : [];
    last = answers.findLast((message) => field(message, "role") === "assistant") ?? {};
  });
  const failed = () => field(last, "stopReason") === "error";
  if (review) {
    pi.registerTool({
      name: verdictTool,
      label: "Verdict",
      description:
        "Give your review's verdict, its body and its findings. Call it once, at the end.",
      parameters: JSON.parse(readFileSync(join(review, "schema.json"), "utf8")),
      execute: async (_id, given) => {
        writeFileSync(join(review, "answer.json"), JSON.stringify(given));
        return { content: [{ type: "text", text: "Skelcrew has your verdict." }], details: {} };
      },
    });
    // Pi's error goes on a line of its own, with the mark.
    pi.on("agent_settled", async (event, ctx) => {
      if (field(event, "aborted") === true || !failed()) return;
      const said = (await withoutKeys(text(last, "errorMessage"), ctx)).replace(/\s+/g, " ").trim();
      process.stderr.write(`\nskelcrew: Pi failed ${mark}: ${said || "an unknown error"}\n`);
    });
    return;
  }
  pi.on("input", async (event) => {
    if (field(event, "source") !== "extension")
      await hook("prompt", { prompt: text(event, "text") });
  });
  pi.on("agent_settled", async (event, ctx) => {
    if (field(event, "aborted") === true) return hook("turn-interrupted");
    if (failed()) {
      const said = await withoutKeys(text(last, "errorMessage"), ctx);
      const error = isUsageLimit(said) ? "rate_limit" : "error";
      return hook("turn-failed", { error, error_details: said });
    }
    return hook("turn-ended", { last_assistant_message: textOf(last) });
  });
  // The marks Skelcrew reads, above Pi's input, looked at four times a second.
  let timer: ReturnType<typeof setInterval> | undefined;
  pi.on("session_start", (_event, ctx) => {
    if (!ctx.hasUI) return;
    let shown = "";
    let since = 0;
    const draw = () => {
      if (ctx.isIdle()) since = 0;
      else if (since === 0) since = Date.now();
      const seconds = Math.floor((Date.now() - since) / 1000);
      let line = since === 0 ? readyMark : `${busyMark} ${seconds}s`;
      if (since === 0 && ctx.ui.getEditorText() !== "") line = "";
      if (line === shown) return;
      shown = line;
      ctx.ui.setWidget("skelcrew", line === "" ? undefined : [line]);
    };
    clearInterval(timer);
    timer = setInterval(draw, 250);
    draw();
  });
  pi.on("session_shutdown", () => clearInterval(timer));
}
