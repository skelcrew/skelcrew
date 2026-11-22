// Skelcrew's extension for Pi, which every Pi lead, builder and reviewer loads: it tells Skelcrew
// what the agent is doing, draws the line Skelcrew reads its screen by, and takes a review's answer.
import { spawn } from "node:child_process";
import { readFileSync, writeFileSync } from "node:fs";
import { join } from "node:path";

export const readyLine = "Skelcrew: ready";
export const draftLine = "Skelcrew: typed";
export const busyMark = "Skelcrew: working";
export const startedWord = "started";

type Message = { role?: string; content?: unknown; stopReason?: string; errorMessage?: string };
type Event = { text?: string; message?: Message; aborted?: boolean };
type Component = { render: (width: number) => string[]; invalidate: () => void };
type Context = {
  hasUI: boolean;
  ui: {
    setWidget: (
      key: string,
      widget: ((tui: { requestRender: () => void }) => Component) | undefined,
    ) => void;
    getEditorText: () => string;
  };
};
type Tool = {
  name: string;
  label: string;
  description: string;
  promptGuidelines: string[];
  parameters: unknown;
  execute: (
    id: string,
    params: unknown,
  ) => Promise<{
    content: { type: "text"; text: string }[];
    details: undefined;
    terminate: boolean;
  }>;
};
export type Pi = {
  on: (event: string, handler: (event: Event, ctx: Context) => unknown) => void;
  registerTool: (tool: Tool) => void;
};

// What went wrong, as a kind Skelcrew acts on and words of Skelcrew's own. A provider's error
// text can echo a key, so none of it is kept: only its HTTP status, and the time a limit resets.
export function failureOf(error: string, now: number): { kind: string; words: string } {
  const status = statusOf(error);
  const resets = resetOf(error, now);
  const reset = resets === null ? "" : `, resets at ${resets}`;
  if (/^You have hit your ChatGPT usage limit/.test(error))
    return { kind: "rate_limit", words: `usage limit reached (ChatGPT)${reset}` };
  if (status === 429 && error.includes("insufficient_quota"))
    return {
      kind: "billing_error",
      words: "out of credit (429): the provider's account needs paying",
    };
  if (status === 429) return { kind: "rate_limit", words: `usage limit reached (429)${reset}` };
  if (/^OAuth refresh failed/.test(error))
    return {
      kind: "authentication_failed",
      words: "Pi's sign-in expired, and Pi couldn't renew it",
    };
  if (status === 401 || status === 403)
    return { kind: "authentication_failed", words: `the provider refused Pi's login (${status})` };
  if (status !== null)
    return { kind: "server_error", words: `the provider failed the request (${status})` };
  return { kind: "unknown", words: "Pi's request failed" };
}

// Returns the HTTP status Pi put in its error, where each provider's API puts it: first on
// OpenAI's completions and Anthropic's, in brackets on OpenAI's responses API, and as the code in
// Google's body.
function statusOf(error: string): number | null {
  const found = /^(\d{3})[: ]/.exec(error) ?? /API error \((\d{3})\)/.exec(error);
  if (found) return Number(found[1]);
  let body: unknown;
  try {
    body = JSON.parse(error);
  } catch {
    return null;
  }
  const inner = typeof body === "object" && body !== null && "error" in body ? body.error : null;
  const code = typeof inner === "object" && inner !== null && "code" in inner ? inner.code : null;
  return typeof code === "number" ? code : null;
}

// Returns the clock a limit resets at, such as "3:15 PM", or "Nov 23, 3:15 PM" past a day, from
// the wait the error names, such as "Try again in ~42 min.", or null when it names none.
function resetOf(error: string, now: number): string | null {
  const wait =
    /try again in ~?(\d+(?:\.\d+)?) ?(ms|s|sec|seconds?|m|min|minutes?|h|hours?)\b/i.exec(error);
  if (!wait) return null;
  const unit = (wait[2] ?? "").toLowerCase();
  const scale =
    unit === "ms" ? 1 : unit.startsWith("s") ? 1000 : unit.startsWith("m") ? 60_000 : 3_600_000;
  const at = new Date(now + Number(wait[1]) * scale);
  const hours = at.getHours() % 12 || 12;
  const clock = `${hours}:${String(at.getMinutes()).padStart(2, "0")} ${at.getHours() < 12 ? "AM" : "PM"}`;
  if (at.getTime() - now < 20 * 3_600_000) return clock;
  return `${at.toLocaleString("en-US", { month: "short" })} ${at.getDate()}, ${clock}`;
}

// Returns the text of an assistant message.
function textOf(message: Message | null): string {
  if (!Array.isArray(message?.content)) return "";
  const parts: unknown[] = message.content;
  return parts
    .map((part) =>
      typeof part === "object" && part !== null && "text" in part && typeof part.text === "string"
        ? part.text
        : "",
    )
    .join("");
}

// Runs one of sc's hooks with `input` on its stdin, and waits for it, but never past ten seconds.
function hook(name: string, input: object): Promise<void> {
  return new Promise((resolve) => {
    const sc = spawn("sc", ["hook", name], { stdio: ["pipe", "ignore", "ignore"] });
    const timer = setTimeout(() => sc.kill(), 10_000);
    sc.on("error", () => {});
    sc.on("close", () => {
      clearTimeout(timer);
      resolve();
    });
    sc.stdin.on("error", () => {});
    sc.stdin.end(JSON.stringify(input));
  });
}

// A lead or builder tells Skelcrew of each message, each turn's end and each error through sc's
// hooks. A review instead prints its start and its error after `mark`, which Skelcrew makes for
// each review and takes out of the environment here, so no command the reviewer runs sees it.
export default function skelcrew(pi: Pi): void {
  const mark = process.env.SKELCREW_PI_MARK;
  const review = process.env.SKELCREW_PI_REVIEW;
  delete process.env.SKELCREW_PI_MARK;
  delete process.env.SKELCREW_PI_REVIEW;
  let last: Message | null = null;
  let since: number | null = null;
  let tick: ReturnType<typeof setInterval> | undefined;
  let render = () => {};

  pi.on("session_start", (_event, ctx) => {
    if (!ctx.hasUI || mark) return;
    ctx.ui.setWidget("skelcrew", (tui) => {
      render = () => tui.requestRender();
      return {
        render: () => {
          if (since !== null) return [`${busyMark} ${Math.floor((Date.now() - since) / 1000)}s`];
          return [ctx.ui.getEditorText() === "" ? readyLine : draftLine];
        },
        invalidate: () => {},
      };
    });
  });
  pi.on("input", async (event) => {
    if (!mark) await hook("prompt", { prompt: event.text ?? "" });
  });
  pi.on("agent_start", () => {
    if (mark) return void console.error(`${mark} ${startedWord}`);
    if (since !== null) return;
    since = Date.now();
    tick = setInterval(() => render(), 1000);
    render();
  });
  pi.on("message_end", (event) => {
    if (event.message?.role === "assistant") last = event.message;
  });
  pi.on("agent_settled", async (event) => {
    since = null;
    clearInterval(tick);
    render();
    const failed =
      last?.stopReason === "error" ? failureOf(last.errorMessage ?? "", Date.now()) : null;
    const said = textOf(last);
    last = null;
    if (mark) return void (failed && !event.aborted && console.error(`${mark} ${failed.words}`));
    if (event.aborted) return hook("turn-interrupted", {});
    if (failed) return hook("turn-failed", { error: failed.kind, error_details: failed.words });
    return hook("turn-ended", { last_assistant_message: said });
  });
  pi.on("session_shutdown", () => clearInterval(tick));

  if (!review) return;
  pi.registerTool({
    name: "skelcrew_answer",
    label: "Answer",
    description: "Give Skelcrew your review's answer, in the shape it asks for.",
    promptGuidelines: ["Call skelcrew_answer once, as your last step, with your whole answer."],
    parameters: JSON.parse(readFileSync(join(review, "schema.json"), "utf8")),
    execute: async (_id, params) => {
      writeFileSync(join(review, "answer.json"), JSON.stringify(params));
      return {
        content: [{ type: "text", text: "Skelcrew has your answer." }],
        details: undefined,
        terminate: true,
      };
    },
  });
}
