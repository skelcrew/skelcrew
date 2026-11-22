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

// Reports whether a Pi error says a usage limit was reached: an HTTP 429, or a message that a
// quota was exceeded. An error that only mentions a quota, such as Google's "quota project not
// set", is no limit: waiting never fixes it.
export function isUsageLimit(error: string): boolean {
  return /(^|\D)429(\D|$)/.test(error) || /exceeded[^.]*quota/i.test(error);
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
    // Pi's error goes on a line of its own, so Skelcrew never takes a line a command printed
    // for it.
    pi.on("agent_settled", (event) => {
      if (field(event, "aborted") === true || !failed()) return;
      const said = text(last, "errorMessage").replace(/\s+/g, " ").trim();
      process.stderr.write(`\nskelcrew: Pi failed: ${said || "an unknown error"}\n`);
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
      const said = text(last, "errorMessage");
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
