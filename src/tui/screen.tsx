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
import { type Line, ListLine, listLines, widthsOf } from "./list";
import { counts, groupsOf } from "./rows";
import { firstShown } from "./scroll";

export type Loaded = { ok: true; tasks: TaskView[] } | { ok: false; message: string };

type Props = {
  repo: string;
  quit: () => void;
  load: () => Promise<Loaded>;
  // Runs a `skelcrew` command, as the CLI would, and returns what it says.
  send: (args: string[]) => Promise<Outcome>;
  refreshMs?: number;
  // The terminal's height in lines. With it, the screen fills the terminal:
  // the keys sit on the last line, and the list scrolls. Without it, the
  // screen is as tall as what it shows.
  height?: number;
};

// The list, a y/n question, or a line being typed.
type Mode =
  | { kind: "list" }
  | { kind: "confirm"; question: string; run: Run }
  | { kind: "type"; prompt: string; run: (text: string) => Run; text: string };

// A longer answer, such as a failed merge's check output, is cut to this.
const MAX_SAID = 4;

export function Screen({ repo, quit, load, send, refreshMs = 1000, height }: Props) {
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
  // The first line of the list shown, when it is taller than the screen.
  const scrolled = useRef(0);
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

  const widths = widthsOf(
    groups.flatMap((group) => group.rows),
    stdout.columns ?? 80,
  );
  const list = listLines(tasks, groups);

  // What sits under the list, each part after a blank line, keys last.
  const problemLines = problem === null ? [] : problem.split("\n");
  const saidLines = [...(running === null ? [] : [running.doing]), ...said];
  const below =
    (problemLines.length > 0 ? 1 + problemLines.length : 0) +
    (saidLines.length > 0 ? 1 + saidLines.length : 0) +
    (mode.kind === "list" ? 0 : 2) +
    2;

  // A list taller than its room scrolls. Its first and last lines then say
  // how many tasks are hidden above and below, such as "↓ 25 more".
  const listRoom = height === undefined ? list.length : height - 1 - below;
  let shown = list;
  let above: string | null = null;
  let under: string | null = null;
  if (list.length > listRoom) {
    const fits = Math.max(1, listRoom - 2);
    const cursorLine = Math.max(
      0,
      list.findIndex((line) => line.kind === "row" && line.row.task.task === selected),
    );
    // A group's first task shows with the blank line and heading above it.
    const top = list[cursorLine - 1]?.kind === "heading" ? cursorLine - 2 : cursorLine;
    const first = firstShown(scrolled.current, top, cursorLine, fits, list.length);
    scrolled.current = first;
    shown = list.slice(first, first + fits);
    const rows = (lines: Line[]) => lines.filter((line) => line.kind === "row").length;
    const hiddenAbove = rows(list.slice(0, first));
    const hiddenBelow = rows(list.slice(first + fits));
    above = hiddenAbove > 0 ? `↑ ${hiddenAbove} more` : "";
    under = hiddenBelow > 0 ? `↓ ${hiddenBelow} more` : "";
  }

  return (
    <Box flexDirection="column" {...(height === undefined ? {} : { height })}>
      {/* A long path is cut from the left, so its last folders show. */}
      <Box flexShrink={0}>
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
      {above !== null && <Text dimColor>{above || " "}</Text>}
      {shown.map((line, index) => (
        // biome-ignore lint/suspicious/noArrayIndexKey: a line is drawn where it is; it holds no state.
        <ListLine key={index} line={line} widths={widths} selected={selected} />
      ))}
      {under !== null && <Text dimColor>{under || " "}</Text>}
      {/* Takes the room left, so what follows sits at the bottom. */}
      <Box flexGrow={1} />
      {problemLines.length > 0 && (
        <Box marginTop={1} flexDirection="column" flexShrink={0}>
          {problemLines.map((line, index) => (
            // biome-ignore lint/suspicious/noArrayIndexKey: the lines never move.
            <Text key={index} wrap="truncate-end">
              {line}
            </Text>
          ))}
        </Box>
      )}
      {saidLines.length > 0 && (
        <Box marginTop={1} flexDirection="column" flexShrink={0}>
          {saidLines.map((line, index) => (
            // biome-ignore lint/suspicious/noArrayIndexKey: the lines never move.
            <Text key={index} wrap="truncate-end">
              {line}
            </Text>
          ))}
        </Box>
      )}
      {mode.kind === "confirm" && (
        <Box marginTop={1} flexShrink={0}>
          <Text wrap="truncate-end">{mode.question}</Text>
        </Box>
      )}
      {mode.kind === "type" && (
        <Box marginTop={1} flexShrink={0}>
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
      <Box marginTop={1} flexShrink={0}>
        <Text dimColor wrap="truncate-end">{`j k move · ${actionHints} · q quit`}</Text>
      </Box>
    </Box>
  );
}

// The CLI's lines, cut to MAX_SAID, with where to read the rest.
function shorten(lines: string[], run: Run): string[] {
  if (lines.length <= MAX_SAID) return lines;
  const rest = run.task === null ? "…" : `See the rest with: skelcrew log ${run.task}`;
  return [...lines.slice(0, MAX_SAID), rest];
}
