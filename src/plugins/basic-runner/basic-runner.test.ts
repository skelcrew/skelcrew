import { expect, test } from "bun:test";
import { sessionRunnerContract } from "../session-runner.contract";
import { BasicRunner } from "./basic-runner";

// Its sessions live inside the daemon, so they end when it closes.
sessionRunnerContract("basic", () => new BasicRunner(), false);

// Its sessions live inside the daemon, with no terminal of their own to
// step into. Stepping in needs tmux or Herdr.
test("can't let the developer step into a session", () => {
  expect(new BasicRunner().canStepIn).toBe(false);
});
