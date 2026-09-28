# skelcrew

Skelcrew moves coding tasks from idea to merged code. Agents do the work, and the developer
acts as team lead: setting direction, answering questions and approving what matters. The
design is in `docs/spec.md`. Read it before changing anything it covers.

## Hard constraints

These are correctness requirements, not preferences. A change that breaks one is wrong even
if a task asks for it. Stop and report the conflict instead.

- **The human merges.** Every change stops at a pull request. Auto-merge comes later, in
  step 5 of the spec's build plan.
- **Never force push. Never skip a check, and never use `--no-verify`.**
- **Never weaken a test, fixture or assertion to get green.** If a test cannot pass
  honestly, stop and say why.
- **The spec is never edited to match the code.** If the code and `docs/spec.md` disagree,
  stop and report it. The human decides which one changes.

## Critical code

The core decides what agents may do, so it gets the closest care. The critical paths are
the state machine, the gates, the merge policy and revert. They live in `src/core/`.

- The types, contracts and invariants come first, and the human approves them. The code is
  written against them.
- Tests come before code, and the human reads them closely. A wrong test here is more
  dangerous than wrong code.
- One transition or contract at a time. The human reads every diff before it lands.
- An agent working alone does not change `src/core/`. Work there happens in a live session
  with the human.

## Code rules

- **The core has no side effects.** Code in `src/core/` never reads the clock, files or the
  network, and never makes up IDs. Time and IDs arrive as inputs, and side effects leave as
  commands. The same inputs must always give the same result.
- **Strict TypeScript.** No `any`, no `!` to silence a possible null, no `as` casts. The
  tsconfig has `strict`, `noUncheckedIndexedAccess` and `exactOptionalPropertyTypes` on.
- **Check every outside input** with Zod: plugin input, CLI requests, config and replies
  from outside services.
- **Errors are values in the core.** Functions return a result that says what failed. They
  do not throw.

## Definition of done

```
bun run check
```

It runs the lint and format check, the typecheck, and `bun test`. It never changes files;
`bun run fix` does that. The scaffold adds both scripts. Until then, this is the target.

- **Red, then green.** Write the failing test first. Run it, and confirm it fails for the
  reason you meant: an import or fixture error is a broken test, not red. Then write the
  smallest code that passes, and tidy up while the test stays green. Never add a test after
  the code. A test written against existing code checks what the code does, not what it
  should do.
- **Tests check what a user of the code sees**, never private helpers. Tests never start a
  real agent or call an outside service; the simulator stands in for them.
- **Commit in small, self-contained slices.** Each commit passes `bun run check` on its own,
  and its message says what changed and why. A failing test and its fix land in the same
  commit. Two small diffs review better than one large one, so split before the first
  review.

## Writing for the human

Everything the human reads must make sense on the first read. That covers commit messages,
pull requests, review notes, spec changes and chat. A text that needs deciphering has
failed, however accurate it is.

- **The plain answer first.** One sentence that says what happened or what is needed. Then
  the detail, if any.
- **One idea per sentence**, about 20 words at most. No stacked clauses, no semicolons
  joining two ideas, no em-dashes.
- **The reader's words, not the code's.** Say what a person sees or does. Use a name from
  the code only when the reader needs it to find something, and explain it in the same
  sentence.
- **An example when the mechanism is hard to picture.** A small concrete case beats a
  description of how the parts connect.
- **Say the consequence.** "An agent could approve its own spec" beats a description of
  which check is missing.
- **No invented terms.** Define a new word in plain words the first time, or don't use it.

Before sending, read the text as someone who was not there. If a sentence needs a second
read, rewrite it.

## Evidence

- **Run it, don't remember it.** Before writing that something works, exists or is
  impossible, run the command or read the line.
- **A claimed limitation needs proof:** the exact error, or the command that showed it.
- **An honest partial result beats a made-up complete one.** If you skipped a step, say
  which. A clean report of work that did not happen is the worst thing you can produce.

## Layout

- `docs/spec.md`: the design. The source of truth for what Skelcrew does.
- `docs/invariants.md`: the rules the core must never break. Tests are written against it.
- `docs/ARCHITECTURE.md`: a map of the code for new developers: the parts, what each does,
  and how an input flows through them.
- `src/core/`: the core. Critical code, see above.
- `src/store/fixtures/v1-events.jsonl`: saved events that must always read back. Once
  Skelcrew keeps a real log, a change to the shape of an event needs a way to read the
  old shape. The fixture is never regenerated to make a change pass.
- `CLAUDE.md` links to this file, so every agent reads the same rules.

**Keep `docs/ARCHITECTURE.md` current.** A change that adds, removes, renames or moves a
part it describes updates it in the same pull request. A map that no longer matches the
code misleads every reader who trusts it.
