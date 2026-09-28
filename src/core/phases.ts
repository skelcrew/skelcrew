import type { Phase } from "./types";

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
