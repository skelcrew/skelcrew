# #7 Hide .skelcrew/checking/ from git like the other working folders, so git add -A can't pick up a running check's copy

The spec task #7 was built from.

## Scope

Goal: A running check's throwaway copy must never show up in git. Today it appears in `git status` while checks run, and `git add -A` picks it up as an embedded repository. That happened during dogfooding, and the commit had to be fixed.

Today:
- Skelcrew keeps its working folders under `.skelcrew/`: `worktrees`, `merging`, `reverting` and `checking` (`src/plugins/git/git.ts:36-42`).
- `ignoreWorktrees` hides folders by adding a line per folder to git's local ignore list, `.git/info/exclude` (`src/plugins/git/git.ts:469-483`).
- Its list has only `worktrees`, `merging` and `reverting` (`src/plugins/git/git.ts:473`). `checking` is missing.
- The check's copy is made in `.skelcrew/checking/<task>`, and making it already calls `ignoreWorktrees` (`src/plugins/git/git.ts:517-519`). So adding the folder to the list is enough.
- The shared plugin tests already check that making a worktree leaves `git status` clean (`src/plugins/version-control.contract.ts:129-133`). Nothing checks this for the check's copy.

Change: While a check runs, `git status` in the repository shows nothing from `.skelcrew/checking/`, and `git add -A` doesn't add it. The ignore list gains the line `/.skelcrew/checking/`, once, like the other three.

Approach:
- Add `checkingFolder` to the list in `ignoreWorktrees` (`src/plugins/git/git.ts:473`).
- It hides the folder the same way as the others, in `.git/info/exclude`, not `.gitignore`. So nothing new appears in the repository's committed files, and existing repositories pick it up on their next check.
- Nothing else changes. One small commit.

Tests:
- Add a shared plugin test in the `checkCommit` group of `src/plugins/version-control.contract.ts`: while the checks run, `git status --porcelain` in the repository is empty. Read it from inside the checks, since the copy is removed afterwards.
- Check the ignore list holds the line only once, after two checks.

Out of scope:
- Moving these lines into `.gitignore`, or changing how the other folders are hidden.

## Acceptance criteria

- While a check runs, `git status --porcelain` in the repository shows nothing under `.skelcrew/checking/`.
- While a check runs, `git add -A` in the repository stages nothing under `.skelcrew/checking/`.
- `.git/info/exclude` holds `/.skelcrew/checking/` exactly once, after two checks.
- `bun run check` passes.
