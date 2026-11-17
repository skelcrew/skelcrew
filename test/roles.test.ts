// The roles' built-in files: they give the lead, builders and reviewers exactly the
// instructions Skelcrew gave them before the instructions became files.
import { expect, test } from "bun:test";
import { reviewerPrompt } from "../src/flow/reviewer.ts";
import { builtInRole, readRole } from "../src/roles.ts";

const sha256 = (text: string) => new Bun.CryptoHasher("sha256").update(text).digest("hex");

// What the builder's file added after its instructions moved there: Skelcrew can't push a
// change to a workflow file.
const workflows =
  "\nYou can't change files under .github/workflows/: Skelcrew can't push them, and the push is refused. If the work needs a change there, leave it out, and say in your sc submit summary, which becomes the PR, what a person should change there instead.\n";

test("the lead and builder files hold the instructions the code gave, and the builder's adds only workflows", () => {
  // The digests of src/agents/prompts/lead.md and builder.md before they moved.
  expect(sha256(builtInRole("lead").instructions)).toBe(
    "4a964d29382eddbab5268fa24921ee599fa1bde9bd1eb51341f5bee1cb577837",
  );
  const builder = builtInRole("builder").instructions;
  expect(builder).toContain(workflows);
  expect(sha256(builder.replace(workflows, ""))).toBe(
    "556629d5f335c1d5e635a1996a021041ea3e9fb75deaa593399ef84d70ee4d00",
  );
});

test("the built-in roles name no harness or model, so yours count, as before", () => {
  for (const name of ["lead", "builder", "reviewer"] as const) {
    const role = builtInRole(name);
    expect(role.harness).toBeUndefined();
    expect(role.model).toBeUndefined();
  }
});

// What the reviewer was told when its instructions lived in its code.
function before(issue: { title: string; body: string }, base: string): string {
  return `Review this pull request as an adversarial reviewer. Another agent wrote it. Assume it is wrong until you have checked it yourself.

It should do this:

# ${issue.title}

${issue.body}

The change is everything on HEAD since ${base}. Read the whole diff with \`git diff ${base}...HEAD\`, and the code around it. Run the tests, using the commands under test: in the repository's skelcrew.yaml if there is one. Anything you change here is thrown away after the review, so run what you need, but don't fix the code.

Check that it does what this asks and nothing else, and look for bugs, edge cases it misses, missing tests and failing ones.

Answer "approve" only if it is ready to merge. Otherwise answer "changes", and in the body name each problem, where it is and why it matters, so the builder can fix it.`;
}

test("the reviewer is told exactly what its code told it", () => {
  const issue = { title: "Fix the flaky test", body: "It fails one run in ten." };
  expect(reviewerPrompt(issue, "origin/main")).toBe(before(issue, "origin/main"));
});

test("a task's own text reaches the reviewer as written, even when it looks like a blank", () => {
  // A title or body that holds the blanks' marks, or what a replacement treats as special,
  // must not be filled in again.
  const issue = { title: "Rename {{base}} to $& and $1", body: "Mention {{title}} and {{body}}." };
  expect(reviewerPrompt(issue, "origin/$&")).toBe(before(issue, "origin/$&"));
});

test("a role file's frontmatter gives its harness and model, and the rest is its instructions", () => {
  const role = readRole("---\nharness: codex\nmodel: gpt-6.1-sol\n---\nReview it.\n");
  expect(role).toEqual({ harness: "codex", model: "gpt-6.1-sol", instructions: "Review it.\n" });
  expect(readRole("Build it.\n")).toEqual({ instructions: "Build it.\n" });
});

test("a role file's frontmatter holds only harness and model", () => {
  expect(() => readRole("---\nharness: codex\nrounds: 5\n---\nReview it.\n")).toThrow("rounds");
  expect(() => readRole("---\nharness: emacs\n---\nReview it.\n")).toThrow("harness");
});
