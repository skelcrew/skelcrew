// Projects in the TUI: rows name their project, a task waiting to start in
// an archived project says it won't start, and m moves a task.

import { expect, test } from "bun:test";
import type { Outcome } from "../cli/cli";
import type { ProjectView } from "../cli/status";
import type { Loaded } from "./screen";
import { lines, open, task, tick } from "./testing";

const ENTER = "\r";

const reports: ProjectView = {
  id: "reports-page",
  name: "Reports page",
  goal: "Export what the reports page shows.",
  status: "active",
};
const someday: ProjectView = {
  id: "someday",
  name: "Someday",
  goal: "Old ideas.",
  status: "archived",
};

const withProjects =
  (tasks: Parameters<typeof task>[], projects: ProjectView[]) => async (): Promise<Loaded> => ({
    ok: true,
    tasks: tasks.map((fields) => task(...fields)),
    projects,
  });

test("a row shows its project's name, not its ID", async () => {
  const load = withProjects(
    [[14, "CSV export", "spec", { project: "reports-page", waitingOnYou: "spec_approval" }]],
    [reports],
  );
  const { lastFrame } = open({ load });
  await tick();
  expect(lines(lastFrame())).toContain("› #14 CSV export Reports page approve its spec");
});

test("a task waiting to start in an archived project says it won't start", async () => {
  const load = withProjects(
    [
      [15, "Rate limit", "ready", { project: "someday", step: "queued" }],
      [17, "Spec me", "spec", { step: "queued" }],
    ],
    [someday],
  );
  const { lastFrame } = open({ load });
  await tick();
  const shown = lines(lastFrame());
  expect(shown).toContain("› #15 Rate limit Someday Ready · its project is archived");
  expect(shown).toContain("#17 Spec me Spec · start it with /spec 17");
});

test("a task's own screen names its project, and says when it is archived", async () => {
  const load = withProjects(
    [[15, "Rate limit", "ready", { project: "someday", step: "queued" }]],
    [someday],
  );
  const { lastFrame, stdin } = open({ load });
  await tick();
  stdin.write(ENTER);
  await tick();
  expect(lines(lastFrame())).toContain("Project: Someday (archived)");
});

function cli() {
  const sent: string[][] = [];
  return {
    sent,
    send: async (args: string[]): Promise<Outcome> => {
      sent.push(args);
      return { code: 0, out: ["Done."], err: [] };
    },
  };
}

test("m moves the task to the project typed, by its name", async () => {
  const { sent, send } = cli();
  const load = withProjects([[14, "CSV export", "idea", {}]], [reports]);
  const { lastFrame, stdin } = open({ load, send });
  await tick();
  stdin.write("m");
  await tick();
  expect(lines(lastFrame())).toContain("Move #14 to which project? Type none to take it out:");
  stdin.write("Reports page");
  await tick();
  stdin.write(ENTER);
  await tick();
  expect(sent).toEqual([["project", "add", "14", "--", "Reports page"]]);
});

test("m, then none, takes the task out of its project", async () => {
  const { sent, send } = cli();
  const load = withProjects([[14, "CSV export", "idea", { project: "reports-page" }]], [reports]);
  const { stdin } = open({ load, send });
  await tick();
  stdin.write("m");
  await tick();
  stdin.write("none");
  await tick();
  stdin.write(ENTER);
  await tick();
  expect(sent).toEqual([["project", "remove", "14"]]);
});

test("m works on a task's own screen too", async () => {
  const { sent, send } = cli();
  const load = withProjects([[14, "CSV export", "idea", {}]], [reports]);
  const { stdin } = open({ load, send });
  await tick();
  stdin.write(ENTER);
  await tick();
  stdin.write("m");
  await tick();
  stdin.write("reports-page");
  await tick();
  stdin.write(ENTER);
  await tick();
  expect(sent).toEqual([["project", "add", "14", "--", "reports-page"]]);
});
