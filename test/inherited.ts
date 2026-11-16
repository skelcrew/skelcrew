// Loaded before every test file: stops a run that inherited Skelcrew's sandbox, as a builder's
// plain `bun test` does, and says how to run the tests there instead.

// Inside the sandbox every sc, daemon and tmux server a test starts would take the agent's
// paths: refusing the sidebar, or calling the real daemon. Tests fail one by one after long
// waits, and a run looks hung. Bun hands children the environment the run started with, so
// it can't be cleared from here. scripts/test.ts starts the run without it.
if (process.env.SKELCREW_SANDBOX === "1") {
  console.error(
    "Inside Skelcrew's sandbox, run the tests with `bun run test`, followed by the test files if you want only some.",
  );
  process.exit(1);
}
