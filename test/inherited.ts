// Loaded before every test file: stops a run that inherited Skelcrew's variables, as a builder's
// plain `bun test` does, and says how to run the tests there instead.
import { existsSync } from "node:fs";
import { socketFolderInside } from "../src/agents/sandbox.ts";

// With them, every sc, daemon and tmux server a test starts would take the agent's paths:
// refusing the sidebar, acting as a laptop's server, or calling the real daemon. Bun hands
// children the environment the run started with, so it can't be cleared from here.
// scripts/test.ts starts the run without them, and marks a run inside the sandbox with
// SKELCREW_TESTS_IN_SANDBOX. Inside, the real daemon's socket is in reach even without them.
const inherited = Object.keys(process.env).filter(
  (name) => name.startsWith("SKELCREW_") && name !== "SKELCREW_TESTS_IN_SANDBOX",
);
const unmarked = existsSync(socketFolderInside) && process.env.SKELCREW_TESTS_IN_SANDBOX !== "1";
if (inherited.length > 0 || unmarked) {
  console.error(
    `Tests must not reach the Skelcrew they run in${inherited.length > 0 ? `, and this run has ${inherited.join(", ")}` : ""}. Run the tests with \`bun run test\`, followed by the test files if you want only some.`,
  );
  process.exit(1);
}
