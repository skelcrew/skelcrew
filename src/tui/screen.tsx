// The TUI: one row per task, grouped by what you need to do. It asks the
// daemon for the status every second, so the list stays current. Enter
// opens a task's own screen. The keys in actions.ts act on the task under
// the cursor, or on the task that is open.

import { Box, Text, useInput, useStdout } from "ink";
import TextInput from "ink-text-input";
import { useEffect, useRef, useState } from "react";
import type { Outcome } from "../cli/cli";
import type { ProjectView, TaskView } from "../cli/status";
import type { TaskId } from "../core/ids";
import { actions, hints, type Run } from "./actions";
import { keyLines } from "./keys";
import { type Line, ListLine, listLines, widthsOf } from "./list";
import { counts, groupsOf } from "./rows";
import { firstShown } from "./scroll";
import { type LoadedLog, taskLines, taskState } from "./task-screen";

// The status: tasks, and every project. A daemon from before projects
// leaves them out.
export type Loaded =
  | { ok: true; tasks: TaskView[]; projects?: ProjectView[] }
  | { ok: false; message: string };

type Props = {
  repo: string;
  quit: () => void;
  load: () => Promise<Loaded>;
  // Runs a `skelcrew` command, as the CLI would, and returns what it says.
  send: (args: string[]) => Promise<Outcome>;
  // Reads a task's history, as `skelcrew log` does.
  loadLog: (task: TaskId) => Promise<LoadedLog>;
  // Opens a link in the browser.
  browse: (url: string) => void;
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

export function Screen(props: Props) {
  const { repo, quit, load, send, loadLog, browse, refreshMs = 1000, height } = props;
  // null until the first answer.
  const [tasks, setTasks] = useState<TaskView[] | null>(null);
  const [projects, setProjects] = useState<ProjectView[]>([]);
  // Why the last refresh failed. The last list stays on screen.
  const [problem, setProblem] = useState<string | null>(null);
  // The task the cursor is on, so it stays there when tasks move.
  const [cursor, setCursor] = useState<TaskId | null>(null);
  // The task whose own screen is open, its history, and how far down its
  // screen is scrolled.
  const [open, setOpen] = useState<TaskId | null>(null);
  const [log, setLog] = useState<LoadedLog | null>(null);
  const [taskTop, setTaskTop] = useState(0);
  // Whether ? has opened the list of keys, over the list or a task.
  const [showKeys, setShowKeys] = useState(false);
  const [mode, setMode] = useState<Mode>({ kind: "list" });
  // The command running now, and what the last one said.
  const [running, setRunning] = useState<Run | null>(null);
  const [said, setSaid] = useState<string[]>([]);
  // Loads the list, and the open task's history, now rather than at the
  // next second.
  const refreshNow = useRef(() => {});
  const openNow = useRef<TaskId | null>(null);
  openNow.current = open;
  // The first line of the list shown, when it is taller than the screen,
  // and how far a task's screen can scroll.
  const scrolled = useRef(0);
  const lastTop = useRef(0);
  const { stdout } = useStdout();

  useEffect(() => {
    let busy = false;
    let closed = false;
    const refresh = async () => {
      if (busy) return;
      busy = true;
      const loaded = await load();
      const showing = openNow.current;
      const read = showing === null ? null : await loadLog(showing);
      busy = false;
      if (closed) return;
      if (loaded.ok) {
        setTasks(loaded.tasks);
        setProjects(loaded.projects ?? []);
        setProblem(null);
      } else {
        setProblem(loaded.message);
      }
      if (read !== null && openNow.current === showing) setLog(read);
    };
    refreshNow.current = () => void refresh();
    void refresh();
    const timer = setInterval(refresh, refreshMs);
    return () => {
      closed = true;
      clearInterval(timer);
    };
  }, [load, loadLog, refreshMs]);

  const groups = groupsOf(tasks ?? [], projects);
  const order = groups.flatMap((group) => group.rows.map((row) => row.task.task));
  // A task that is gone, or none yet, puts the cursor on the first task.
  const at = (task: TaskId | null) => (task !== null && order.includes(task) ? task : order[0]);
  const selected = at(cursor);
  const opened = open === null ? undefined : tasks?.find((task) => task.task === open);

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

  const openTask = (task: TaskId) => {
    setOpen(task);
    openNow.current = task;
    setLog(null);
    setTaskTop(0);
    void loadLog(task).then((read) => {
      if (openNow.current === task) setLog(read);
    });
  };

  // An action's key, on the task it is about.
  const act = (input: string, task: TaskView | undefined, onTaskScreen: boolean) => {
    const action = actions.find((one) => one.key === input);
    if (action === undefined || (onTaskScreen && !action.onTask)) return;
    const step = action.step(task);
    if (step === null) return;
    if (step.kind === "run") void execute(step.run);
    else if (step.kind === "confirm") setMode(step);
    else setMode({ ...step, text: "" });
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
    if (input === "q") {
      quit();
      return;
    }
    if (showKeys) {
      if (key.escape || input === "?") setShowKeys(false);
      return;
    }
    if (input === "?") {
      setShowKeys(true);
      return;
    }

    if (opened !== undefined) {
      const scroll = (to: (top: number) => number) =>
        setTaskTop((top) => Math.min(Math.max(to(top), 0), lastTop.current));
      if (key.escape || input === "h") setOpen(null);
      else if (input === "j" || key.downArrow) scroll((top) => top + 1);
      else if (input === "k" || key.upArrow) scroll((top) => top - 1);
      else if (input === "g") scroll(() => 0);
      else if (input === "G") scroll(() => lastTop.current);
      else if (input === "o" && typeof opened.pullRequest === "string") browse(opened.pullRequest);
      else act(input, opened, true);
      return;
    }

    const move = (to: (index: number) => number) =>
      setCursor((previous) => {
        const current = at(previous);
        const from = current === undefined ? 0 : order.indexOf(current);
        const index = Math.min(Math.max(to(from), 0), order.length - 1);
        return order[index] ?? null;
      });
    if (input === "j" || key.downArrow) move((index) => index + 1);
    else if (input === "k" || key.upArrow) move((index) => index - 1);
    else if (input === "g") move(() => 0);
    else if (input === "G") move(() => order.length - 1);
    else if ((key.return || input === "l") && selected !== undefined) {
      setCursor(selected);
      openTask(selected);
    } else
      act(
        input,
        tasks?.find((task) => task.task === selected),
        false,
      );
  });

  const columns = stdout.columns ?? 80;
  const widths = widthsOf(
    groups.flatMap((group) => group.rows),
    columns,
  );
  const body: Line[] = showKeys
    ? keyLines()
    : opened === undefined
      ? listLines(tasks, groups)
      : taskLines(
          opened,
          log,
          columns,
          projects.find((project) => project.id === opened.project),
        );

  // What sits under the body, each part after a blank line, keys last.
  const problemLines = problem === null ? [] : problem.split("\n");
  const saidLines = [...(running === null ? [] : [running.doing]), ...said];
  const below =
    (problemLines.length > 0 ? 1 + problemLines.length : 0) +
    (saidLines.length > 0 ? 1 + saidLines.length : 0) +
    (mode.kind === "list" ? 0 : 2) +
    2;

  // A body taller than its room scrolls. Its first and last lines then say
  // what is hidden above and below: tasks on the list, such as "↓ 25 more",
  // and lines on a task's screen or the list of keys.
  const room = height === undefined ? body.length : height - 1 - below;
  let shown = body;
  let above: string | null = null;
  let under: string | null = null;
  lastTop.current = 0;
  if (body.length > room) {
    const fits = Math.max(1, room - 2);
    let first: number;
    let hiddenAbove: string;
    let hiddenBelow: string;
    if (showKeys) {
      first = 0;
      hiddenAbove = "";
      hiddenBelow = more(body.length - fits, "line");
    } else if (opened === undefined) {
      const cursorLine = Math.max(
        0,
        body.findIndex((line) => line.kind === "row" && line.row.task.task === selected),
      );
      // A group's first task shows with the blank line and heading above it.
      const top = body[cursorLine - 1]?.kind === "heading" ? cursorLine - 2 : cursorLine;
      first = firstShown(scrolled.current, top, cursorLine, fits, body.length);
      scrolled.current = first;
      const rows = (lines: Line[]) => lines.filter((line) => line.kind === "row").length;
      hiddenAbove = more(rows(body.slice(0, first)), "");
      hiddenBelow = more(rows(body.slice(first + fits)), "");
    } else {
      lastTop.current = body.length - fits;
      first = Math.min(taskTop, lastTop.current);
      hiddenAbove = more(first, "line");
      hiddenBelow = more(body.length - fits - first, "line");
    }
    shown = body.slice(first, first + fits);
    above = hiddenAbove === "" ? "" : `↑ ${hiddenAbove}`;
    under = hiddenBelow === "" ? "" : `↓ ${hiddenBelow}`;
  }

  // The keys used most. ? shows the rest.
  const pullRequest = typeof opened?.pullRequest === "string" ? " · o open PR" : "";
  const keys = showKeys
    ? "esc close · q quit"
    : opened === undefined
      ? `j k move · enter open · ${hints("list")} · ? keys · q quit`
      : `j k scroll · ${hints("task")}${pullRequest} · esc back · ? keys · q quit`;

  return (
    <Box flexDirection="column" {...(height === undefined ? {} : { height })}>
      {showKeys ? (
        <Text bold>Keys</Text>
      ) : opened === undefined ? (
        // A long path is cut from the left, so its last folders show.
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
      ) : (
        <Box flexShrink={0}>
          <Box flexGrow={1} flexShrink={1}>
            <Text bold wrap="truncate-end">{`#${opened.task} ${opened.title}`}</Text>
          </Box>
          <Box flexShrink={0} marginLeft={2}>
            <Text>
              {taskState(
                opened,
                groups.flatMap((group) => group.rows).find((row) => row.task.task === open),
              )}
            </Text>
          </Box>
        </Box>
      )}
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
        <Text dimColor wrap="truncate-end">
          {keys}
        </Text>
      </Box>
    </Box>
  );
}

// "25 more", or "3 more lines" when `unit` is "line". "" when none.
function more(count: number, unit: "" | "line"): string {
  if (count === 0) return "";
  if (unit === "") return `${count} more`;
  return `${count} more ${count === 1 ? "line" : "lines"}`;
}

// The CLI's lines, cut to MAX_SAID, with where to read the rest.
function shorten(lines: string[], run: Run): string[] {
  if (lines.length <= MAX_SAID) return lines;
  const rest = run.task === null ? "…" : `See the rest with: skelcrew log ${run.task}`;
  return [...lines.slice(0, MAX_SAID), rest];
}
