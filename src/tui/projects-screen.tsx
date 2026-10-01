// The projects screen, which P opens from the list: every project, whether
// it is archived, how many open tasks it has, and its goal. n makes a
// project, and e archives or unarchives one.

import type { ProjectView, TaskView } from "../cli/status";
import type { Step } from "./actions";
import type { Line } from "./list";

// One row: a project, or the tasks in none, whose `id` is null.
export type ProjectRow = {
  id: string | null;
  name: string;
  status: ProjectView["status"] | null;
  open: number;
  goal: string;
};

const isOpen = (task: TaskView) => task.phase !== "done" && task.phase !== "dropped";

// The projects in the order the status gives them, by name. The tasks in
// no project come last, when there are any open.
export function projectRows(projects: ProjectView[], tasks: TaskView[]): ProjectRow[] {
  const known = new Set(projects.map((project) => project.id));
  const rows: ProjectRow[] = projects.map((project) => ({
    id: project.id,
    name: project.name,
    status: project.status,
    open: tasks.filter((task) => isOpen(task) && task.project === project.id).length,
    goal: project.goal,
  }));
  const loose = tasks.filter(
    (task) => isOpen(task) && (task.project === null || !known.has(task.project)),
  ).length;
  if (loose > 0) rows.push({ id: null, name: "No project", status: null, open: loose, goal: "" });
  return rows;
}

// The screen's lines under its header.
export function projectLines(rows: ProjectRow[], selected: number, empty: boolean): Line[] {
  const widths = {
    name: Math.max(0, ...rows.map((row) => row.name.length)),
    open: Math.max(0, ...rows.map((row) => `${row.open} open`.length)),
  };
  return [
    { kind: "blank" },
    ...(empty
      ? ([
          { kind: "text", text: "No projects yet. Press n to make one.", dim: false },
          { kind: "blank" },
        ] satisfies Line[])
      : []),
    ...rows.map(
      (row, index): Line => ({ kind: "project", row, selected: index === selected, widths }),
    ),
  ];
}

// The header's right side: "2 active · 1 archived".
export function projectCounts(projects: ProjectView[]): string {
  const active = projects.filter((project) => project.status === "active").length;
  const archived = projects.length - active;
  const parts: string[] = [];
  if (active > 0) parts.push(`${active} active`);
  if (archived > 0) parts.push(`${archived} archived`);
  return parts.join(" · ");
}

// The keys line. e says what it would do to the project under the cursor,
// and isn't there for the tasks in no project.
export function projectKeys(row: ProjectRow | undefined): string {
  const archive =
    row === undefined || row.id === null
      ? ""
      : row.status === "archived"
        ? " · e unarchive"
        : " · e archive";
  return `j k move · n new${archive} · esc back · ? keys · q quit`;
}

// What n and e do, for the list ? shows.
export const projectHelp = [
  { key: "n", help: "make a project, with its name and goal" },
  { key: "e", help: "archive the project, or unarchive it" },
];

// The step a key starts on the projects screen, or null for a key that
// does nothing here.
export function projectStep(input: string, row: ProjectRow | undefined): Step | null {
  if (input === "n") {
    return {
      kind: "type",
      prompt: "New project's name:",
      run: (typed) => {
        const name = typed.trim();
        return {
          kind: "type",
          prompt: `${name}'s goal, in one line:`,
          // After --, a name or goal that starts with a dash is still text.
          run: (goal) => ({
            args: ["project", "new", "--", name, goal.trim()],
            doing: `Making ${name}…`,
            task: null,
          }),
        };
      },
    };
  }
  if (input === "e" && row !== undefined && row.id !== null) {
    const verb = row.status === "archived" ? "unarchive" : "archive";
    const doing = row.status === "archived" ? "Unarchiving" : "Archiving";
    return {
      kind: "run",
      run: { args: ["project", verb, "--", row.id], doing: `${doing} ${row.name}…`, task: null },
    };
  }
  return null;
}
