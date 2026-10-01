// What ? shows: every key and what it does. The keys that act on tasks and
// projects come from their tables, so this list can't drift from what they
// do.

import { actions } from "./actions";
import type { Line } from "./list";
import { projectHelp } from "./projects-screen";

const KEY_WIDTH = 13;

export function keyLines(): Line[] {
  const key = (keys: string, does: string): Line => ({
    kind: "text",
    text: `  ${keys.padEnd(KEY_WIDTH)}${does}`,
    dim: false,
  });
  const onTask = actions.filter((action) => action.onTask).map((action) => action.key);
  return [
    { kind: "blank" },
    { kind: "heading", text: "On the list" },
    key("j k", "move down and up, or use the arrow keys"),
    key("g G", "go to the first or last task"),
    key("enter", "open the task, or press l"),
    ...actions.map((action) => key(action.key, action.help)),
    key("P", "open the projects screen"),
    { kind: "blank" },
    { kind: "heading", text: "On a task" },
    key("j k", "scroll down and up"),
    key("g G", "go to the top or the bottom"),
    key("o", "open its pull request in your browser"),
    key("esc", "go back to the list, or press h"),
    key(onTask.join(" "), "act on the task, as on the list"),
    { kind: "blank" },
    { kind: "heading", text: "On the projects screen" },
    key("j k", "move down and up"),
    ...projectHelp.map((one) => key(one.key, one.help)),
    key("esc", "go back to the list, or press h"),
    { kind: "blank" },
    { kind: "heading", text: "Anywhere" },
    key("?", "show or hide this list"),
    key("q", "quit"),
  ];
}
