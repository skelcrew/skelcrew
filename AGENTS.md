# skel

skel is Claude Code, but always on, in parallel, isolated, and seeing each task through
to the merge. The design is in `docs/spec.md`. Read it before changing anything it covers.
The traps earlier versions found are in `docs/learnings.md`. Read the part that covers
typing into a session, starting Claude Code or the sandbox before touching them.

We launch a beta on Monday 16 November 2026. The launch and its milestones are in the
spec. Until then, work that doesn't serve the launch waits.

## The goal: simple and clear

The last version grew too big to hold in your head. Every change is judged first by
whether it keeps the code small and easy to read.

- **Build only what the spec asks for.** No features, options or extension points for
  later. If something seems missing, ask instead of adding it.
- **Plain functions and data.** A class only when something really holds state over time,
  such as a live session. No interfaces with a single implementation, no factories, no
  dependency injection.
- **One file, one job.** A reader should guess what a file does from its name. Prefer a few
  clear files over many tiny ones.
- **Name things with the spec's words**: lead, repository, task, thread, builder,
  reviewer, event, round, needs you.
- **No abstraction before the second use.** Duplicating three lines beats a helper nobody
  can find.
- **Delete before you add.** If a change can remove code, do that first.
- **Copy from v4 only when a step needs it**, and trim the file to what the spec uses. v4
  is in `~/skel-v4`, for reference only. Never change it.

## Hard rules

These are correctness requirements. If a task asks you to break one, stop and say why.

- **Every change lands through a pull request.** Never push to `main`, never force push.
- **The human decides what merges.** Never merge unless asked for that pull request.
- **Never skip or weaken a check, test or assertion** to get green. One exception, decided
  by Simon: tests that start real sandboxes skip when they run inside skel's own sandbox,
  where bubblewrap can't nest. Anywhere else they must run.
- **The spec is never edited to match the code.** If they disagree, stop and report it.
- **Ask before adding a dependency.** The expected ones are `yaml` and `zod`. State uses
  `bun:sqlite`.
- **Agents never see a GitHub token.** Only the daemon, outside the sandbox, pushes or calls
  GitHub.

## Code rules

- **TypeScript on Bun, strict.** No `any`, no `!`, no `as` casts.
- **Deciding what an event means is pure.** Given a thread and what GitHub returned, it
  returns what to do. It never reads the clock, files or the network, so it can be tested
  without them.
- **Check every outside input with Zod**: `skel.yaml`, requests over the socket, what `gh`
  returns, and anything read back from disk.

## Test first

- Write the failing test, run it, and check it fails for the reason you meant. Then write
  the smallest code that passes.
- Tests check what a user of the code sees, never private helpers.
- **Tests never call a real model, a real harness or real GitHub.** A short shell script
  stands in for the harness and runs `skel submit` like an agent would. A fake `gh` stands
  in for GitHub.
- **Tests clean up what they start.** Every session, daemon and temporary folder a test
  creates ends with the test. Tests run tmux on a socket of their own, never skel's
  (`tmux -L skel`). Never kill processes by name: Simon runs real threads on this machine.

## Definition of done

```
bun run check
```

It runs the format and lint check, the typecheck and the tests, and never changes files.
Commit in small slices. Each commit passes `bun run check` on its own, and its message says
what changed and why.

## Writing for the human

Commit messages, pull requests and chat must make sense on the first read.

- The plain answer first. Then the detail, if any.
- One idea per sentence, about 20 words at most. No em dashes.
- The reader's words, not the code's.
- Say the consequence: "a review could reach the builder after it already moved on" beats
  naming the missing check.

## Evidence

Run it, don't remember it. Before writing that something works or is impossible, run the
command or read the line. An honest partial result beats a made-up complete one.

## Comments

Comments are for a human reading the code for the first time.

**Every function gets a comment** saying what it does and what it is for, in plain words.
A reader should understand the function from its comment without reading its body. Say what
it gives back or changes, and why skel needs it. Add the reason behind anything surprising:
a trap, a harness quirk, a limit someone hit before. One to four lines is usually enough.

Inside a function, comment only what the code can't say: why it is this way, when it looks
wrong or roundabout but is right, or when a reader might "simplify" it and break something.

Each file starts with one or two lines saying what the file is for, in the spec's words.

Never write:
- the name again as a sentence ("parseConfig parses the config")
- each line again in words, inside a function ("loop over the threads")
- history or chat ("fixed after review", "now handles X", "as discussed")
- references to tasks, steps, spec sections or numbers

Examples:

```
Bad:  // Brings in from.
Good: // Brings in the repository you ran skel from, so the lead can work on it. A
      // repository skel already has costs no call to GitHub, since skel must start fast
      // and the daemon keeps its clone current. A folder that isn't on GitHub, such as
      // your dotfiles, is skipped without a complaint.

Bad:  // Wait 2 seconds before typing
Good: // Text typed while Claude Code is still starting can be lost, so wait until its
      // pane has been quiet.
```

When you change code, update or delete any comment it makes wrong. A wrong comment is worse
than none.
