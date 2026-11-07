// What a page says: the issue or PR behind a row of ISSUES or PRS, read from GitHub. The daemon
// reads it and the screen draws it.
import { z } from "zod";
import { Name, readIssueDetails, readPullDetails } from "../github.ts";
import { ciChecks } from "./decide.ts";

// What the daemon hands the page, checked on both sides of its socket. Each fact is a short
// label and what it says. All of it comes from GitHub, so none of it is safe to show yet.
export const Page = z.object({
  title: z.string(),
  facts: z.array(z.tuple([z.string(), z.string()])),
  body: z.string(),
});
export type Page = z.infer<typeof Page>;

// A page's address on GitHub, which is also the link of its row in the sidebar.
const address = /^https:\/\/github\.com\/([^/]+)\/([^/]+)\/(issues|pull)\/(\d+)$/;
export const PageUrl = z.string().regex(address);

// Returns the page of the issue or PR at a link, as GitHub has it now. Only the daemon runs
// this, as only it may call GitHub.
export async function readPage(url: string): Promise<Page> {
  const [, owner, repo, kind, number] = url.match(address) ?? [];
  const fullName = `${Name.parse(owner)}/${Name.parse(repo)}`;
  return kind === "pull" ? pullPage(fullName, Number(number)) : issuePage(fullName, Number(number));
}

// Returns an issue's page.
async function issuePage(fullName: string, number: number): Promise<Page> {
  const { title, body, state, user, labels } = await readIssueDetails(fullName, number);
  const names = labels.map((label) => label.name).join(", ");
  const facts: Page["facts"] = [
    ["State", state],
    ["Author", user?.login ?? "unknown"],
    ["Labels", names || "none"],
  ];
  return { title, facts, body: body ?? "" };
}

// Returns a PR's page. Its checks read as they do in the strip, and a review still being
// written isn't one yet.
async function pullPage(fullName: string, number: number): Promise<Page> {
  const pull = await readPullDetails(fullName, number);
  const checks = ciChecks(pull);
  const latest = pull.reviews.filter((review) => review.state !== "PENDING").at(-1);
  const facts: Page["facts"] = [
    ["State", pull.state.toLowerCase()],
    ["Branch", `${pull.headRefName} → ${pull.base}`],
    ["Checks", checks === "pending" ? "running" : (checks ?? "none")],
    ["Review", latest ? aboutReview(latest) : "none"],
  ];
  return { title: pull.title, facts, body: pull.body };
}

// Returns what a review said and who said it. GitHub won't let skel approve its own PR, so skel's
// verdict is a comment whose first line says it: for those, that line is what you want to read.
function aboutReview(review: { state: string; body: string; author: { login: string } | null }) {
  const [first = ""] = review.body.split("\n");
  const said = review.state === "COMMENTED" ? first.replaceAll("*", "").trim() : "";
  const verdict = said || review.state.toLowerCase().replaceAll("_", " ");
  return `${verdict} · ${review.author?.login ?? "unknown"}`;
}
