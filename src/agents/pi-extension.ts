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

// The words a usage limit's message starts with, which Skelcrew reads.
export const limitWords = "rate limited";

// The status a Pi error starts with, and the body after it. Pi gives no status of its own, only
// text, and each of its provider APIs puts the status in one place: first, as in "429: ..." or
// Anthropic's "429 {...}", or after the provider's name, as in "openrouter API error (429): ...".
const statusFirst = /^(?:(\d{3})(?:: | (?=\{))|[\w.-]+ API error \((\d{3})\): )/;

// Returns the HTTP status a Pi error names, or null when it names none. Google's body comes
// alone, with its code in it, as in {"error":{"code":429,...}}.
function httpStatus(error: string): number | null {
  const first = statusFirst.exec(error.trim());
  if (first) return Number(first[1] ?? first[2]);
  const code = field(field(bodyOf(error), "error"), "code");
  return typeof code === "number" ? code : null;
}

// Returns the provider's answer a Pi error holds, read as JSON, or undefined when it holds none.
function bodyOf(error: string): unknown {
  try {
    return JSON.parse(error.trim().replace(statusFirst, ""));
  } catch {
    return undefined;
  }
}

// Reports whether a 429 is OpenAI's insufficient_quota, which says your credit ran out: it lasts
// until you pay, so it is no usage limit to wait out. OpenAI names it in the answer's code.
function outOfCredit(error: string): boolean {
  const body = bodyOf(error);
  return [body, field(body, "error")].some(
    (answer) =>
      field(answer, "code") === "insufficient_quota" ||
      field(answer, "type") === "insufficient_quota",
  );
}

// A clock right after "resets at" or "try again at", such as "3:15 PM", "14:00" or "Dec 31st,
// 2099 11:59 PM", made only of a month's name, digits and am or pm.
const months = "jan|feb|mar|apr|may|jun|jul|aug|sep|oct|nov|dec";
const day = `(?:(?:${months})[a-z]{0,6}\\.? \\d{1,2}(?:st|nd|rd|th)?,? (?:\\d{4},? )?)?`;
const resetClock = new RegExp(
  `(?:resets at|try again at) (${day}(?:\\d{1,2}(?::\\d{2})? ?[ap]\\.?m\\b|\\d{1,2}:\\d{2}(?!\\d)))`,
  "i",
);

// Pi's own words for a ChatGPT sign-in's usage limit, which comes with no status, and the
// minutes until it resets, as in "You have hit your ChatGPT usage limit (plus plan). Try again
// in ~42 min."
const chatGptLimit = /^You have hit your ChatGPT usage limit\b/;
const chatGptReset = /Try again in ~(\d+) min\.$/;

// Returns what Skelcrew keeps of an error Pi stopped on: its kind, which turn-failed's hook names,
// and a message of Skelcrew's own, with the HTTP status when Pi names one. Never the error's own
// words, as a provider can echo a key in them, and nothing can tell every key apart. A usage
// limit's message keeps only when it resets.
export function failureOf(error: string): { kind: string; message: string } {
  const said = error.trim();
  if (chatGptLimit.test(said)) {
    const minutes = chatGptReset.exec(said)?.[1];
    const limit = `${limitWords} by ChatGPT's usage limit`;
    return { kind: "rate_limit", message: minutes ? `${limit}, resets in ~${minutes} min` : limit };
  }
  if (said.startsWith("OAuth refresh failed for "))
    return {
      kind: "auth",
      message: "the sign-in expired: Skelcrew renews it as the session starts again",
    };
  const status = httpStatus(said);
  if (status === 429 && outOfCredit(said))
    return {
      kind: "billing",
      message: "out of credit (429): check the provider's plan and billing",
    };
  if (status === 429) {
    const at = resetClock.exec(said)?.[1];
    const limit = `${limitWords} (429)`;
    return { kind: "rate_limit", message: at ? `${limit}, resets at ${at}` : limit };
  }
  if (status === 401 || status === 403)
    return { kind: "auth", message: `auth failed (${status}): check Pi's login or key` };
  if (status !== null) return { kind: "provider", message: `the provider failed (${status})` };
  return { kind: "network", message: "the request failed with no HTTP status, such as offline" };
}

// What Pi gives a handler besides its event, as far as this extension uses it.
type Context = {
  hasUI: boolean;
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
    // Once Pi is at work its commands can print anything, which a line with the mark tells
    // Skelcrew. Before it, whatever Pi printed is its own.
    let atWork = false;
    pi.on("agent_start", () => {
      if (!atWork) process.stderr.write(`\nskelcrew: Pi at work ${mark}\n`);
      atWork = true;
    });
    // Pi's error goes on a line of its own, with the mark.
    pi.on("agent_settled", (event) => {
      if (field(event, "aborted") === true || !failed()) return;
      const { message } = failureOf(text(last, "errorMessage"));
      process.stderr.write(`\nskelcrew: Pi failed ${mark}: ${message}\n`);
    });
    return;
  }
  pi.on("input", async (event) => {
    if (field(event, "source") !== "extension")
      await hook("prompt", { prompt: text(event, "text") });
  });
  pi.on("agent_settled", async (event) => {
    if (field(event, "aborted") === true) return hook("turn-interrupted");
    if (failed()) {
      const { kind, message } = failureOf(text(last, "errorMessage"));
      return hook("turn-failed", { error: kind, error_details: message });
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
