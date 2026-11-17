// The roles' built-in files: they give the lead, builders and reviewers exactly the
// instructions Skelcrew gave them before the instructions became files.
import { expect, test } from "bun:test";
import { reviewerPrompt } from "../src/flow/reviewer.ts";
import { builtInRole, readRole } from "../src/roles.ts";

const sha256 = (text: string) => new Bun.CryptoHasher("sha256").update(text).digest("hex");

// What the builder's file added after its instructions moved there: Skelcrew can't push a
// change to a workflow file.
const workflows =
  "\nNever change files under .github/: Skelcrew can't push a change to its workflows, and the push is refused. If the work needs a change there, leave it out, and say in your sc submit summary, which becomes the PR, what a person should change there instead.\n";

// What the lead's file added after its instructions moved there: why a message to a builder
// waits, and what to do when it waits long.
const waiting =
  " When the builder can't take it yet, sc tell says why, and sc ps counts the messages still waiting. If one still waits after 10 minutes, Skelcrew tells you why. When the builder is mid-turn, you may ask the human to press Esc in that thread if it shouldn't finish its turn first.";

// What the lead was told about issues, threads and PRs before sc ls and sc show, each with what
// it is told now.
const leadTasks = [
  [
    "- sc issue ls lists open issues, and sc ps lists threads, with their status, whether they need the human, and each one's PR, CI and review, such as #242, failed and changes r3.",
    "- sc ls lists tasks: open issues, and the work on each. Each row says what is happening, such as waiting · #242 · CI failed · changes r3, and whether it needs the human. sc ls --all adds tasks whose work ended. sc ps lists threads, with the same columns.",
  ],
  [
    "- sc pr show app-13, or a PR's number such as sc pr show 242, shows a PR: its state, branch, thread, checks, latest review and description, with the log of each failed check. Use it to see why CI failed or what a review asked for.",
    "- sc show app-13 shows a task: its issue, threads, PR with its checks and review, and its description as its reviewer gets it, then the PR's latest review and description, with the log of each failed check. Use it to see why CI failed or what a review asked for. sc pr show 242 shows the task of PR 242 the same way.",
  ],
  [
    "Skelcrew keeps its own copy: sc issue ls and sc issue show app-13 show issues, with the title and body a builder sees, and sc ps and sc pr show show PRs.",
    "Skelcrew keeps its own copy: sc ls and sc show app-13 show issues, tasks and their PRs, with the title and description a builder sees.",
  ],
  [
    '- sc tell app-13 "<text>" types a message into that thread\'s builder once it is idle,',
    '- sc tell app-13 "<text>", or sc tell app-13/builder "<text>", types a message into that task\'s builder once it is idle,',
  ],
];

// What the builder was told about the tests before the whole suite ran once per commit, in CI
// or the reviewer, and what it is told now.
const builderTestsBefore =
  "While you work, run only the tests near your change. Other agents share this machine, and whole test suites running at once slow everyone down. Run the repository's whole test command, under test: in its skelcrew.yaml if there is one, once before each sc submit.";
const builderTests =
  "Never run the repository's whole test suite: CI or the reviewer runs it once for each commit, and other agents share this machine, so whole suites running at once slow everyone down. While you work, run only the tests near your change. Before each sc submit, run the tests related to your change: the test files you touched and the tests of the code you changed. Run the repository's lint and typecheck too, if it has them.";

// What the builder's file added later: it tells the lead only what the lead needs, as Skelcrew
// already shows its progress.
const tellingTheLead =
  " Tell it only when you are blocked or need a decision. Never tell it just to report progress, such as that you submitted, resubmitted or merged main: Skelcrew already shows that.";

test("the lead and builder files hold the instructions the code gave, but waiting messages, tasks and the builder's workflows, tests and telling the lead", () => {
  // The digests of src/agents/prompts/lead.md and builder.md before they moved.
  let lead = builtInRole("lead").instructions;
  expect(lead).toContain(waiting);
  for (const [before = "", now = ""] of leadTasks) {
    expect(lead).toContain(now);
    lead = lead.replace(now, before);
  }
  expect(sha256(lead.replace(waiting, ""))).toBe(
    "4a964d29382eddbab5268fa24921ee599fa1bde9bd1eb51341f5bee1cb577837",
  );
  const builder = builtInRole("builder").instructions;
  expect(builder).toContain(workflows);
  expect(builder).toContain(builderTests);
  expect(builder).toContain(tellingTheLead);
  const before = builder
    .replace(workflows, "")
    .replace(builderTests, builderTestsBefore)
    .replace(tellingTheLead, "");
  expect(sha256(before)).toBe("556629d5f335c1d5e635a1996a021041ea3e9fb75deaa593399ef84d70ee4d00");
});

test("the built-in roles name no harness or model, so yours count, as before", () => {
  for (const name of ["lead", "builder", "reviewer"] as const) {
    const role = builtInRole(name);
    expect(role.harness).toBeUndefined();
    expect(role.model).toBeUndefined();
  }
});

// What the reviewer was told when its instructions lived in its code, but for the tests, which
// `tests` says.
function before(issue: { title: string; body: string }, base: string, tests: string): string {
  return `Review this pull request as an adversarial reviewer. Another agent wrote it. Assume it is wrong until you have checked it yourself.

It should do this:

# ${issue.title}

${issue.body}

The change is everything on HEAD since ${base}. Read the whole diff with \`git diff ${base}...HEAD\`, and the code around it. Anything you change here is thrown away after the review, so run what you need, but don't fix the code.

${tests}

Check that it does what this asks and nothing else, and look for bugs, edge cases it misses, missing tests and failing ones.

Answer "approve" only if it is ready to merge. Otherwise answer "changes", and in the body name each problem, where it is and why it matters, so the builder can fix it.`;
}

// Without CI on the commit, the reviewer runs the tests, as it always did.
const runs =
  "No CI runs on this commit, so run the repository's whole test suite, with `bun test`.";
const testedBy = { commands: ["bun test"], detected: false };

test("the reviewer is told exactly what its code told it, and who runs the tests", () => {
  const issue = { title: "Fix the flaky test", body: "It fails one run in ten." };
  expect(reviewerPrompt(issue, "origin/main", "run", testedBy)).toBe(
    before(issue, "origin/main", runs),
  );
});

test("a task's own text reaches the reviewer as written, even when it looks like a blank", () => {
  // A title or body that holds the blanks' marks, or what a replacement treats as special,
  // must not be filled in again.
  const issue = { title: "Rename {{base}} to $& and $1", body: "Mention {{title}} and {{body}}." };
  expect(reviewerPrompt(issue, "origin/$&", "run", testedBy)).toBe(
    before(issue, "origin/$&", runs),
  );
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
