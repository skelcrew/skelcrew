# #1 Init adds only the check script when it already runs the tests

The spec task #1 was built from.

## Scope

**Goal**

When a repository's check script already runs its test script, `skelcrew init` should choose only the check script. Today it chooses both, so the tests run twice at every done and every merge. This happened on Skelcrew's own repository, and the extra line had to be removed by hand (commit e585e37).

**Today**

- In a package.json with a check script, init keeps the test script as well: `src/init/detect.ts:148-150`. The one exception is a test script that is empty, does nothing, or is exactly the `npm init` placeholder. Init never chooses one of those (`src/init/detect.ts:139-140`). The comment at `src/init/detect.ts:142-147` says why. A check script often runs no tests, such as SvelteKit's `svelte-check`.
- On this repository, `detectChecks(".")` gives `["bun run test", "bun run check"]`. The check script is `bun run lint && bun run typecheck && bun run test`.
- A warning is given when the test script runs no test runner init knows. It is given only when the test script is among the chosen checks: `src/init/detect.ts:154`.
- The test "runs the test script as well as a check script" (`src/init/detect.test.ts:139`) covers the SvelteKit case.

**Change**

When the check script runs the test script by name, init chooses only the check script. For example, `"check": "bun run lint && bun run test"` gives `bun run check` alone.

These count as running the test script, in any piece of the check script split at `;`, `&&` or `||`:
- `npm run test`, `pnpm run test`, `yarn run test`, `bun run test`
- `npm test`, `pnpm test`, `yarn test`

Extra words after `test` still count, such as `npm test -- --coverage`. Any package manager counts, whichever one the project uses.

These do not count, and both scripts stay as today:
- a different script, such as `npm run test:unit` or `bun run tests`
- a test runner run directly, such as `vitest run` or `tsc && vitest run`
- `bun test`, which is Bun's own test runner, not the test script
- a check script that runs no tests, such as `svelte-check`

When the test script is dropped this way, the warning about a test script that runs no known test runner is still given. The tests still run, through the check script.

**Approach**

- `src/init/detect.ts`: in `packageChecks`, leave out "test" when the check script runs it by name. Split the check script the way `doesNothing` splits a test script. The builder chooses the pattern.
- The warning condition at `src/init/detect.ts:154` changes, so it also covers a test script run only through the check script. It still skips a test script init would never choose: empty, doing nothing, or the `npm init` placeholder. Otherwise `"test": "exit 0"` would give a wrong warning.
- Update the comments at `src/init/detect.ts:5-7` and `src/init/detect.ts:142-147` to the new rule.
- `docs/ARCHITECTURE.md:311` says the test script "runs even beside a check script". Update that sentence in the same change.
- Settled with the developer: only a run of the test script by name counts. A test runner in the check script does not. That runner may run only part of the tests, so dropping the test script could skip tests. Running tests twice is slow but safe.

**Tests**

In `src/init/detect.test.ts`:
- This repository's case: a check script of `bun run lint && bun run typecheck && bun run test` gives `bun run check` alone.
- Each counted form above, with each package manager, gives the check script alone.
- Extra words after `test` still count.
- `npm run test:unit`, `bun run tests`, `bun test` and `tsc && vitest run` keep both scripts.
- The existing SvelteKit test still passes unchanged.
- A check script that runs the test script, with a test script that runs no known runner, gives the check script alone and the warning.
- A check script that runs the test script, with a test script that does nothing, gives the check script alone and no warning. This already holds today, since a do-nothing test script is never chosen.

**Out of scope**

- Other ways to run a script, such as `npm t`, `npm run-script test`, `npm-run-all` or `run-s`.
- Following a check script into a shell script or makefile it calls.
- Changing the workflow.yml of a repository that init already set up.

## Acceptance criteria

- Running detectChecks on this repository gives ["bun run check"].
- A check script of `bun run lint && bun run test` gives only the check script.
- Each of `npm run test`, `pnpm run test`, `yarn run test`, `bun run test`, `npm test`, `pnpm test` and `yarn test` inside a check script gives only the check script.
- A check script of `svelte-check`, `npm run test:unit`, `bun test` or `tsc && vitest run`, next to a test script, still gives both.
- When the test script is dropped and runs no known test runner, the warning is still given.
- When the test script does nothing and the check script runs it, no warning is given.
- docs/ARCHITECTURE.md and the comments in src/init/detect.ts describe the new rule.
- bun run check passes.
