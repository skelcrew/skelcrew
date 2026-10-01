// The TUI: one row per task, grouped by what you need to do. It asks the
// daemon for the status every second, so the list stays current. The keys
// in actions.ts act on the task under the cursor.

import { Box, Text, useInput, useStdout } from "ink";
import TextInput from "ink-text-input";
import { useEffect, useRef, useState } from "react";
import type { Outcome } from "../cli/cli";
import type { TaskView } from "../cli/status";
import type { TaskId } from "../core/ids";
import { actionHints, actions, type Run } from "./actions";
import { counts, finished, groupsOf, type Row } from "./rows";

export type Loaded = { ok: true; tasks: TaskView[] } | { ok: false; message: string };

type Props = {
  repo: string;
  quit: () => void;
  load: () => Promise<Loaded>;
  // Runs a `skelcrew` command, as the CLI would, and returns what it says.
  send: (args: string[]) => Promise<Outcome>;
  refreshMs?: number;
};

// The list, a y/n question, or a line being typed.
type Mode =
  | { kind: "list" }
  | { kind: "confirm"; question: string; run: Run }
  | { kind: "type"; prompt: string; run: (text: string) => Run; text: string };

const MIN_TITLE = 20;

// A longer answer, such as a failed merge's check output, is cut to this.
const MAX_SAID = 4;

export function Screen({ repo, quit, load, send, refreshMs = 1000 }: Props) {
  // null until the first answer.
  const [tasks, setTasks] = useState<TaskView[] | null>(null);
  // Why the last refresh failed. The last list stays on screen.
  const [problem, setProblem] = useState<string | null>(null);
  // The task the cursor is on, so it stays there when tasks move.
  const [cursor, setCursor] = useState<TaskId | null>(null);
  const [mode, setMode] = useState<Mode>({ kind: "list" });
  // The command running now, and what the last one said.
  const [running, setRunning] = useState<Run | null>(null);
  const [said, setSaid] = useState<string[]>([]);
  // Loads the list now, rather than at the next second.
  const refreshNow = useRef(() => {});
  const { stdout } = useStdout();

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
    refreshNow.current = () => void refresh();
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

  const execute = async (run: Run) => {
    if (running !== null) {
      setSaid([
        `Wait for ${running.task === null ? "the last command" : `#${running.task}`} first.`,
      ]);
      return;
    }
    setRunning(run);
    setSaid([]);
    const outcome = await send(run.args);
    setRunning(null);
    setSaid(shorten([...outcome.out, ...outcome.err], run));
    refreshNow.current();
  };

  useInput((input, key) => {
    if (mode.kind === "type") {
      // The text box takes every other key.
      if (key.escape) setMode({ kind: "list" });
      return;
    }
    if (mode.kind === "confirm") {
      if (input === "y") {
        setMode({ kind: "list" });
        void execute(mode.run);
      } else if (input === "n" || key.escape) {
        setMode({ kind: "list" });
      }
      return;
    }
    setSaid([]);
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
    else {
      const action = actions.find((one) => one.key === input);
      const step = action?.step(tasks?.find((task) => task.task === selected));
      if (step === undefined || step === null) return;
      if (step.kind === "run") void execute(step.run);
      else if (step.kind === "confirm") setMode(step);
      else setMode({ ...step, text: "" });
    }
  });

  const all = groups.flatMap((group) => group.rows);
  const number = Math.max(0, ...all.map((row) => `#${row.task.task}`.length));
  const project = Math.max(0, ...all.map((row) => (row.task.project ?? "").length));
  const says = Math.max(0, ...all.map((row) => row.says.length));
  // Titles get the room the other columns leave, with two spaces between
  // columns, but never less than MIN_TITLE.
  const others = 1 + 2 + number + 2 + (project > 0 ? project + 2 : 0) + 2 + says;
  const room = Math.max(MIN_TITLE, (stdout.columns ?? 80) - others);
  const widths = {
    number,
    title: Math.min(room, Math.max(0, ...all.map((row) => row.task.title.length))),
    project,
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
          <Text>No tasks yet. Press a to add one.</Text>
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
      {(running !== null || said.length > 0) && (
        <Box marginTop={1} flexDirection="column">
          {running !== null && <Text>{running.doing}</Text>}
          {said.map((line, index) => (
            // biome-ignore lint/suspicious/noArrayIndexKey: the lines never move.
            <Text key={index}>{line}</Text>
          ))}
        </Box>
      )}
      {mode.kind === "confirm" && (
        <Box marginTop={1}>
          <Text>{mode.question}</Text>
        </Box>
      )}
      {mode.kind === "type" && (
        <Box marginTop={1}>
          <Text>{`${mode.prompt} `}</Text>
          <TextInput
            value={mode.text}
            onChange={(text) => setMode({ ...mode, text })}
            onSubmit={(text) => {
              if (text.trim() === "") return;
              setMode({ kind: "list" });
              void execute(mode.run(text));
            }}
          />
        </Box>
      )}
      <Box marginTop={1}>
        <Text dimColor>{`j k move · ${actionHints} · q quit`}</Text>
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

// The CLI's lines, cut to MAX_SAID, with where to read the rest.
function shorten(lines: string[], run: Run): string[] {
  if (lines.length <= MAX_SAID) return lines;
  const rest = run.task === null ? "…" : `See the rest with: skelcrew log ${run.task}`;
  return [...lines.slice(0, MAX_SAID), rest];
}
