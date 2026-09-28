import type { Phase, Task } from "./types";

// A task in one phase, for example TaskIn<"checks">.
export type TaskIn<P extends Phase> = Extract<Task, { phase: P }>;

// Phase names as the developer sees them, for rejection and inbox text.
export const phaseNames: Record<Phase, string> = {
  idea: "Idea",
  spec: "Spec",
  ready: "Ready",
  in_progress: "In progress",
  checks: "Checks",
  done: "Done",
  dropped: "Dropped",
};
