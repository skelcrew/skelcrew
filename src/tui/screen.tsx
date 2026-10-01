// The TUI: one row per task, grouped by what you need to do. It asks the
// daemon for the status every second, so the list stays current.

import { Box, Text, useInput } from "ink";
import { useEffect, useState } from "react";
import type { TaskView } from "../cli/status";
import type { TaskId } from "../core/ids";
import { counts, finished, groupsOf, type Row } from "./rows";

export type Loaded = { ok: true; tasks: TaskView[] } | { ok: false; message: string };

type Props = {
  repo: string;
  quit: () => void;
  load: () => Promise<Loaded>;
  refreshMs?: number;
};

const TITLE_WIDTH = 32;

export function Screen({ repo, quit, load, refreshMs = 1000 }: Props) {
  // null until the first answer.
  const [tasks, setTasks] = useState<TaskView[] | null>(null);
  // Why the last refresh failed. The last list stays on screen.
  const [problem, setProblem] = useState<string | null>(null);
  // The task the cursor is on, so it stays there when tasks move.
  const [cursor, setCursor] = useState<TaskId | null>(null);

  useEffect(() => {
    let busy = false;
    let closed = false;
    const refresh = async () => {
      if (busy) return;
      busy = true;
      const loaded = await load();
      busy = false;
      if (closed) return;
      if (loaded.ok) {
        setTasks(loaded.tasks);
        setProblem(null);
      } else {
        setProblem(loaded.message);
      }
    };
    void refresh();
    const timer = setInterval(refresh, refreshMs);
    return () => {
      closed = true;
      clearInterval(timer);
    };
  }, [load, refreshMs]);

  const groups = groupsOf(tasks ?? []);
  const order = groups.flatMap((group) => group.rows.map((row) => row.task.task));
  // A task that is gone, or none yet, puts the cursor on the first task.
  const at = (task: TaskId | null) => (task !== null && order.includes(task) ? task : order[0]);
  const selected = at(cursor);

  useInput((input, key) => {
    const move = (to: (index: number) => number) =>
      setCursor((previous) => {
        const current = at(previous);
        const from = current === undefined ? 0 : order.indexOf(current);
        const index = Math.min(Math.max(to(from), 0), order.length - 1);
        return order[index] ?? null;
      });
    if (input === "q") quit();
    else if (input === "j" || key.downArrow) move((index) => index + 1);
    else if (input === "k" || key.upArrow) move((index) => index - 1);
    else if (input === "g") move(() => 0);
    else if (input === "G") move(() => order.length - 1);
  });

  const all = groups.flatMap((group) => group.rows);
  const widths = {
    number: Math.max(0, ...all.map((row) => `#${row.task.task}`.length)),
    title: Math.min(TITLE_WIDTH, Math.max(0, ...all.map((row) => row.task.title.length))),
    project: Math.max(0, ...all.map((row) => (row.task.project ?? "").length)),
  };
  const done = finished(tasks ?? []);

  return (
    <Box flexDirection="column">
      {/* A long path is cut from the left, so its last folders show. */}
      <Box>
        <Box flexShrink={0} marginRight={2}>
          <Text>skelcrew</Text>
        </Box>
        <Box flexGrow={1} flexShrink={1}>
          <Text wrap="truncate-start">{repo}</Text>
        </Box>
        <Box flexShrink={0} marginLeft={2}>
          <Text>{counts(groups)}</Text>
        </Box>
      </Box>
      {tasks !== null && tasks.length === 0 && (
        <Box marginTop={1}>
          <Text>No tasks yet. Add one with: skelcrew add "&lt;task&gt;"</Text>
        </Box>
      )}
      {groups.map((group) => (
        <Box key={group.heading} flexDirection="column" marginTop={1}>
          <Text bold>{group.heading}</Text>
          {group.rows.map((row) => (
            <TaskRow
              key={row.task.task}
              row={row}
              widths={widths}
              selected={row.task.task === selected}
            />
          ))}
        </Box>
      ))}
      {done !== "" && (
        <Box marginTop={1}>
          <Text dimColor>{done}</Text>
        </Box>
      )}
      {problem !== null && (
        <Box marginTop={1}>
          <Text>{problem}</Text>
        </Box>
      )}
      <Box marginTop={1}>
        <Text dimColor>j k move · q quit</Text>
      </Box>
    </Box>
  );
}

type Widths = { number: number; title: number; project: number };

// "› #14  CSV export   reports  approve its spec", cut to the screen's width.
function TaskRow({ row, widths, selected }: { row: Row; widths: Widths; selected: boolean }) {
  const { task } = row;
  const title =
    task.title.length > widths.title ? `${task.title.slice(0, widths.title - 1)}…` : task.title;
  const columns = [
    selected ? "›" : " ",
    `#${task.task}`.padEnd(widths.number),
    title.padEnd(widths.title),
    ...(widths.project > 0 ? [(task.project ?? "").padEnd(widths.project)] : []),
  ];
  const colour = row.mark === "question" ? "yellow" : row.mark === "blocked" ? "red" : undefined;
  return (
    <Text wrap="truncate-end" bold={selected}>
      {`${columns.join("  ")}  `}
      <Text {...(colour === undefined ? {} : { color: colour })}>{row.says}</Text>
    </Text>
  );
}
