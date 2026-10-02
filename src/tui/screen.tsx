// The TUI: one row per task, grouped by what you need to do. It asks the
// daemon for the status every second, so the list stays current. Enter
// opens a task's own screen. The keys in actions.ts act on the task under
// the cursor, or on the task that is open.

import { Box, Text, useInput, useStdout } from "ink";
import { useEffect, useRef, useState } from "react";
import type { Outcome } from "../cli/cli";
import type { ProjectView, TaskView } from "../cli/status";
import type { TaskId } from "../core/ids";
import { actions, hints, type Run, type Step, type Where } from "./actions";
import {
  Bottom,
  bottomHeight,
  ListHeader,
  LOGO,
  LOGO_MIN_HEIGHT,
  Logo,
  type Mode,
  TitleHeader,
} from "./frame";
import { keyLines } from "./keys";
import { type Line, ListLine, listLines, widthsOf } from "./list";
import {
  projectCounts,
  projectKeys,
  projectLines,
  projectRows,
  projectStep,
} from "./projects-screen";
import { counts, groupsOf } from "./rows";
import { type Scrolling, scrollWindow } from "./scroll";
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
  // Whether P has opened the projects screen, and the row its cursor is on.
  const [showProjects, setShowProjects] = useState(false);
  const [projectAt, setProjectAt] = useState(0);
  // The project whose tasks the list shows, or null for every task. An
  // id of null shows the tasks in no project.
  const [only, setOnly] = useState<{ id: string | null; name: string } | null>(null);
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
  const projectsScrolled = useRef(0);
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

  // The tasks the list shows: all, or one project's. A task whose project
  // the status leaves out counts as in no project, as on the projects screen.
  const known = new Set(projects.map((project) => project.id));
  const inView = (task: TaskView) =>
    only === null ||
    (only.id === null
      ? task.project === null || !known.has(task.project)
      : task.project === only.id);
  const shownTasks = tasks === null ? null : tasks.filter(inView);
  const groups = groupsOf(shownTasks ?? [], projects);
  const where: Where = {
    project: only === null || only.id === null ? null : { id: only.id, name: only.name },
  };
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

  // Runs a command, or asks its question, or opens its text box.
  const begin = (step: Step) => {
    if (step.kind === "run") {
      setMode({ kind: "list" });
      void execute(step.run);
    } else if (step.kind === "confirm") setMode(step);
    else setMode({ ...step, text: "" });
  };

  // An action's key, on the task it is about.
  const act = (input: string, task: TaskView | undefined, onTaskScreen: boolean) => {
    const action = actions.find((one) => one.key === input);
    if (action === undefined || (onTaskScreen && !action.onTask)) return;
    const step = action.step(task, where);
    if (step !== null) begin(step);
  };

  const rows = projectRows(projects, tasks ?? []);
  const projectRow = rows[Math.min(projectAt, rows.length - 1)];

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

    if (showProjects) {
      const move = (to: (index: number) => number) =>
        setProjectAt((at) =>
          Math.min(Math.max(to(Math.min(at, rows.length - 1)), 0), rows.length - 1),
        );
      if (key.escape || input === "h") setShowProjects(false);
      else if (input === "j" || key.downArrow) move((index) => index + 1);
      else if (input === "k" || key.upArrow) move((index) => index - 1);
      else if (input === "g") move(() => 0);
      else if (input === "G") move(() => rows.length - 1);
      else if ((key.return || input === "l") && projectRow !== undefined) {
        setOnly({ id: projectRow.id, name: projectRow.name });
        setShowProjects(false);
      } else {
        const step = projectStep(input, projectRow);
        if (step !== null) begin(step);
      }
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
    } else if (input === "P") {
      setShowProjects(true);
    } else if ((key.escape || input === "h") && only !== null) {
      setOnly(null);
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
    : showProjects
      ? projectLines(rows, Math.min(projectAt, rows.length - 1), projects.length === 0)
      : opened === undefined
        ? listLines(shownTasks, groups, only?.name)
        : taskLines(
            opened,
            log,
            columns,
            projects.find((project) => project.id === opened.project),
          );

  const problemLines = problem === null ? [] : problem.split("\n");
  const saidLines = [...(running === null ? [] : [running.doing]), ...said];
  // The logo tops the list in a window with room for it.
  const logo =
    height !== undefined &&
    height >= LOGO_MIN_HEIGHT &&
    !showKeys &&
    !showProjects &&
    opened === undefined;
  const headerHeight = logo ? LOGO.length + 1 : 1;
  const room =
    height === undefined
      ? body.length
      : height - headerHeight - bottomHeight(problemLines, saidLines, mode);
  // The list and the projects screen each remember where they scrolled to.
  const memory = showProjects ? projectsScrolled : scrolled;
  const scrolling: Scrolling = showKeys
    ? { kind: "top" }
    : showProjects
      ? {
          kind: "cursor",
          isCursor: (line) => line.kind === "project" && line.selected,
          previous: memory.current,
        }
      : opened === undefined
        ? {
            kind: "cursor",
            isCursor: (line) => line.kind === "row" && line.row.task.task === selected,
            previous: memory.current,
          }
        : { kind: "lines", top: taskTop };
  const { shown, above, under, first, lastTop: last } = scrollWindow(body, room, scrolling);
  if (scrolling.kind === "cursor" && body.length > room) memory.current = first;
  lastTop.current = last;

  // The keys used most. ? shows the rest.
  const pullRequest = typeof opened?.pullRequest === "string" ? " · o open PR" : "";
  const keys = showKeys
    ? "esc close · q quit"
    : showProjects
      ? projectKeys(projectRow)
      : opened === undefined
        ? `j k move · enter open · ${hints("list")}${only === null ? "" : " · esc all"} · ? keys · q quit`
        : `j k scroll · ${hints("task")}${pullRequest} · esc back · ? keys · q quit`;

  // What enter does in the text box: run the command, or ask the next
  // line, such as a project's goal after its name.
  const submit = (text: string) => {
    if (mode.kind !== "type" || text.trim() === "") return;
    const next = mode.run(text);
    if ("kind" in next) begin(next);
    else {
      setMode({ kind: "list" });
      void execute(next);
    }
  };

  return (
    <Box flexDirection="column" {...(height === undefined ? {} : { height })}>
      {showKeys ? (
        <TitleHeader title="Keys" />
      ) : showProjects ? (
        <TitleHeader title="Projects" right={projectCounts(projects)} />
      ) : opened === undefined ? (
        <>
          {logo && <Logo />}
          <ListHeader
            repo={repo}
            project={only?.name ?? null}
            counts={counts(groups)}
            named={!logo}
          />
        </>
      ) : (
        <TitleHeader
          title={`#${opened.task} ${opened.title}`}
          right={taskState(
            opened,
            groups.flatMap((group) => group.rows).find((row) => row.task.task === open),
          )}
        />
      )}
      {above !== null && <Text dimColor>{above || " "}</Text>}
      {shown.map((line, index) => (
        // biome-ignore lint/suspicious/noArrayIndexKey: a line is drawn where it is; it holds no state.
        <ListLine key={index} line={line} widths={widths} selected={selected} />
      ))}
      {under !== null && <Text dimColor>{under || " "}</Text>}
      {/* Takes the room left, so the bottom sits on the last lines. */}
      <Box flexGrow={1} />
      <Bottom
        problem={problemLines}
        said={saidLines}
        mode={mode}
        type={(text) => {
          if (mode.kind === "type") setMode({ ...mode, text });
        }}
        submit={submit}
        keys={keys}
      />
    </Box>
  );
}

// The CLI's lines, cut to MAX_SAID, with where to read the rest.
function shorten(lines: string[], run: Run): string[] {
  if (lines.length <= MAX_SAID) return lines;
  const rest = run.task === null ? "…" : `See the rest with: skelcrew log ${run.task}`;
  return [...lines.slice(0, MAX_SAID), rest];
}
