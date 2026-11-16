// What a page says: the issue or PR behind a row of the list of issues or PRs, read from
// Skelcrew's copy, so it opens at once and asks the tracker nothing.
import type { Database } from "bun:sqlite";
import { z } from "zod";
import { type Item, itemAt } from "./copy.ts";
import { reviewCheck } from "./decide.ts";

// The colour a fact takes, as the marks have them: green for good, yellow for wanting you, red for
// wrong, and dim while nothing is known yet.
const Colour = z.enum(["green", "yellow", "red", "dim"]);
type Colour = z.infer<typeof Colour>;

// What the page draws. Each fact is a short label, what it says, and the colour it takes, if
// any. All of it comes from the tracker or forge, so none of it is safe to show yet.
export const Page = z.object({
  title: z.string(),
  facts: z.array(z.tuple([z.string(), z.string(), Colour.optional()])),
  body: z.string(),
});
export type Page = z.infer<typeof Page>;

// Returns the page of the issue or PR at a list row's link. Throws when Skelcrew's copy has
// nothing there, such as once it closed.
export function readPage(db: Database, link: string): Page {
  const item = itemAt(db, link);
  if (!item) throw new Error("Skelcrew has no open issue or PR at this link now.");
  return pageOf(item);
}

// Returns what an issue's or PR's page says: an issue's state, author and labels, or a PR's
// state, branch, checks and latest review, then its description. Checks and review take the
// marks' colours, so a red failure or a green approval reads at a glance.
export function pageOf(item: Item): Page {
  const author = item.author?.login ?? "unknown";
  // An issue says who wrote it and how it is labeled, since a label such as skelcrew is what
  // starts a thread.
  if (item.kind === "task") {
    const labels = item.labels.join(", ") || "none";
    const facts: Page["facts"] = [
      ["State", item.state],
      ["Author", author],
      ["Labels", labels],
    ];
    return { title: item.title, facts, body: item.body };
  }
  // A PR says where its branch merges and how close it is to merging: its CI and only its
  // latest review, as that is the one that says where the PR stands now.
  const latest = item.reviews.at(-1);
  const facts: Page["facts"] = [
    ["State", item.state],
    ["Branch", `${item.branch} → ${item.base}`],
    ["Checks", ...ciSummary(item)],
    latest ? ["Review", ...reviewSummary(latest)] : ["Review", "none", "dim"],
  ];
  return { title: item.title, facts, body: item.body };
}

// Returns what a PR's CI says, and its colour, for its page and sc pr show. Skelcrew's own check
// isn't CI, and one failure is enough to say so while the rest still run. A repository with no CI
// says none, dim.
export function ciSummary(
  pr: Extract<Item, { kind: "pr" }>,
): ["none" | "passed" | "failed" | "running", Colour] {
  const ci = pr.checks.filter((check) => check.name !== reviewCheck);
  if (ci.length === 0) return ["none", "dim"];
  if (ci.every((check) => check.state === "passed")) return ["passed", "green"];
  // Anything neither passed nor running, such as failed or cancelled, counts as failed.
  const failed = ci.some((check) => !["passed", "running"].includes(check.state));
  return failed ? ["failed", "red"] : ["running", "dim"];
}

// A review on a PR, as the forge gave it.
type Review = Extract<Item, { kind: "pr" }>["reviews"][number];

// Returns what a review's verdict is in words, for its page and sc pr show. A forge such as
// GitHub won't let Skelcrew approve its own PR, so Skelcrew's verdict is a comment whose first
// line says it, such as "**Approved**". For those, that line is the verdict.
export function reviewVerdict(review: Review): string {
  const [first = ""] = review.text.split("\n");
  const said = review.verdict === "commented" ? first.replaceAll("*", "").trim() : "";
  return said || review.verdict;
}

// Returns what a review said and who said it, with green for an approval and yellow for changes
// asked for. Skelcrew's own verdict, posted as a comment, takes its colour from its first line.
// Any other comment has no colour.
function reviewSummary(review: Review): [string, Colour?] {
  const said = reviewVerdict(review);
  const verdict = said.toLowerCase();
  const text = `${said} · ${review.author?.login ?? "unknown"}`;
  if (verdict.startsWith("approved")) return [text, "green"];
  if (verdict.startsWith("changes")) return [text, "yellow"];
  return [text];
}
