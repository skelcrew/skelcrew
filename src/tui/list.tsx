// How the task list is drawn: its lines, one row per task, and the width
// of each column.

import { Text } from "ink";
import type { TaskView } from "../cli/status";
import type { TaskId } from "../core/ids";
import { finished, type Group, type Row } from "./rows";

// One line of the list.
export type Line =
  | { kind: "blank" }
  | { kind: "heading"; text: string }
  | { kind: "row"; row: Row }
  | { kind: "text"; text: string; dim: boolean };

// The list's lines: each group after a blank line, then the count of done
// and dropped tasks. tasks is null until the first answer.
export function listLines(tasks: TaskView[] | null, groups: Group[]): Line[] {
  const lines: Line[] = [];
  if (tasks !== null && tasks.length === 0) {
    lines.push(
      { kind: "blank" },
      { kind: "text", text: "No tasks yet. Press a to add one.", dim: false },
    );
  }
  for (const group of groups) {
    lines.push({ kind: "blank" }, { kind: "heading", text: group.heading });
    for (const row of group.rows) lines.push({ kind: "row", row });
  }
  const done = finished(tasks ?? []);
  if (done !== "") lines.push({ kind: "blank" }, { kind: "text", text: done, dim: true });
  return lines;
}

export type Widths = { number: number; title: number; project: number };

const MIN_TITLE = 20;

// Titles get the room the other columns leave on a screen `columns` wide,
// with two spaces between columns, but never less than MIN_TITLE.
export function widthsOf(rows: Row[], columns: number): Widths {
  const number = Math.max(0, ...rows.map((row) => `#${row.task.task}`.length));
  const project = Math.max(0, ...rows.map((row) => (row.project ?? "").length));
  const says = Math.max(0, ...rows.map((row) => row.says.length));
  const others = 1 + 2 + number + 2 + (project > 0 ? project + 2 : 0) + 2 + says;
  const room = Math.max(MIN_TITLE, columns - others);
  return {
    number,
    title: Math.min(room, Math.max(0, ...rows.map((row) => row.task.title.length))),
    project,
  };
}

export function ListLine({
  line,
  widths,
  selected,
}: {
  line: Line;
  widths: Widths;
  selected: TaskId | undefined;
}) {
  switch (line.kind) {
    case "blank":
      return <Text> </Text>;
    case "heading":
      return <Text bold>{line.text}</Text>;
    case "row":
      return <TaskRow row={line.row} widths={widths} selected={line.row.task.task === selected} />;
    case "text":
      return (
        <Text dimColor={line.dim} wrap="truncate-end">
          {line.text}
        </Text>
      );
  }
}

// "› #14  CSV export   reports  approve its spec", cut to the screen's width.
function TaskRow({ row, widths, selected }: { row: Row; widths: Widths; selected: boolean }) {
  const { task } = row;
  const title =
    task.title.length > widths.title ? `${task.title.slice(0, widths.title - 1)}…` : task.title;
  const columns = [
    selected ? "›" : " ",
    `#${task.task}`.padEnd(widths.number),
    title.padEnd(widths.title),
    ...(widths.project > 0 ? [(row.project ?? "").padEnd(widths.project)] : []),
  ];
  const colour = row.mark === "question" ? "yellow" : row.mark === "blocked" ? "red" : undefined;
  return (
    <Text wrap="truncate-end" bold={selected}>
      {`${columns.join("  ")}  `}
      <Text {...(colour === undefined ? {} : { color: colour })}>{row.says}</Text>
    </Text>
  );
}
