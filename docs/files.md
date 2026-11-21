# Files and settings

Every setting a repository's files and your own `~/.config/skelcrew/` hold, what each does, and its default.

It describes how Skelcrew works today, in more detail than [the spec](spec.md). Builders keep it true to the code, changing it in the same pull request as the code. Where it and [docs/spec.md](spec.md) differ, the spec wins, and the code should follow the spec.

## Files

A repository describes how its agents work in files. Skelcrew ships the same files inside itself as its defaults, so a repository with none of them works exactly as one with the defaults written out.

```
skelcrew.yaml            the repository's setup
skelcrew.lock            exact plugin versions, written by Skelcrew
.agents/
  roles/
    lead.md
    builder.md
    reviewer.md
  flows/
    default.yaml
  skills/
    <name>/SKILL.md
```

`AGENTS.md` stays where it is. Every harness reads it from the clone on its own, and Skelcrew doesn't touch it. Skelcrew reads every file here from its own clone of the default branch, so a change counts once it is pushed there.

### `skelcrew.yaml`

The repository's setup, shared with everyone who works on it. It never holds a secret.

```yaml
# Shared with everyone who works on this repository. Never put a secret here.
tracker: github            # or linear, or none. Without a line, the forge's tracker
setup: [bun install]
test: [bun run check]
plugins: [skelcrew/skelcrew-github]   # the plugins this repository needs, pinned in skelcrew.lock
limits: { threads: 4 }     # at most this many builders at once in this repository
```

**Setup and test.** `setup` runs once in each builder's fresh clone. `test` is the whole test suite, which `sc check` runs. An empty list, such as `setup: []`, says on purpose that the repository needs none, so nobody asks for it. Skelcrew never guesses them from the repository's files: a guess is often wrong, and builders and reviewers would use it without anyone seeing it was a guess. They are settled once, with you. A line that is only a comment, as `sc init` writes them, sets nothing. While either of setup and test is missing, set nowhere, a repository's standard setup isn't finished, and the lead's first proposal, before anything else, is a task that finishes it. The lead reads the repository, its CI workflow and package files above all, proposes the missing commands to you in plain words, and on a yes starts that task. It fills in only the missing ones in `skelcrew.yaml` itself, as real lines, leaving a command that is set as it is, from what the repository's CI and package files really run, and anything else `sc init` left as a comment that the repository clearly needs. For a repository you only drop into, with no `skelcrew.yaml` to commit, the lead offers to put them under `repos:` in your `config.yaml` instead. The lead and builders are told them as they start, as neither can read your `config.yaml` from its sandbox. A builder is told each command or that it isn't configured. One that needs a command that isn't configured never makes one up: it asks the lead with `sc tell lead`, and waits.

**The tracker.** A repository's forge is found on its own: the plugin that claims its remote, if one does. Its tracker is its forge, when the forge can be one, as GitHub can, unless `tracker:` names another, such as `linear`. `tracker: none` makes the repository work from git alone, with tasks named like `APP-T100`. It is a word, since a bare `tracker:` reads in YAML as no line at all. Which team or project holds the repository's issues stays in the tracker plugin's own settings. When `tracker:` names a plugin that isn't installed, the repository has no tracker, and `sc repo ls` says which plugin to install. It doesn't fall back to its forge, since its issues are planned elsewhere. A task keeps the issue it started on when the repository's tracker changes.

**`limits.threads`** is the most builder threads running at once in this repository, since that depends on the repository: each builder runs its tests, uses CI minutes and opens a PR its reviewers must read. A start over the limit, from `sc start`, the lead or the `skelcrew` label, isn't refused: its task waits in a queue, first come first served unless you reorder it in the list, in stage `working`, shown as `queued`. The queue survives a restart of the engine. `sc rm` takes a task out of the queue. A labelled issue is claimed as it joins the queue, so another machine doesn't start it meanwhile. Without the line there is no limit.

### `.agents/roles/`

One Markdown file per role, named after it. Its frontmatter holds only `harness` and `model`, both optional, and the rest is its instructions. Nothing else goes in a role file until a need shows up.

```markdown
---
harness: codex
model: gpt-6.1-sol
---
You are the reviewer of a Skelcrew task. Read the diff against the base branch
adversarially …
```

`lead`, `builder` and `reviewer` always exist, from the built-in defaults when the repository has no file for them. A flow names the roles it uses, so a repository that adds a flow can add a role file for it. A role with no `harness` or `model` gets yours, as **Which wins** says.

A model name belongs to its harness, so your top-level `model` applies only to a role on your top-level harness. A role on another harness with no `model` gets that harness's default: `opus` for Claude Code, and Codex's own pick for Codex. Skelcrew passes a model to the harness as written and keeps no list of names. Before it starts a Codex session, it checks the model against `codex debug models`.

### `.agents/flows/`

A flow is the stages a task goes through and their settings. Skelcrew ships one flow, `default`: build, review, CI and ready, in that order.

```yaml
# .agents/flows/default.yaml. Build, review, CI, ready.
build:
  role: builder
review:
  role: reviewer
  rounds: 3              # after this many rounds of changes, the task needs you
```

CI and ready have no settings: ready waits for green checks when the repository has a forge.

**A flow without a review.** A flow file with no `review:` goes build, CI and ready, with no reviewer, for changes too small to need one, such as docs, wording or a one-line fix. Skelcrew ships no such flow: a repository that wants one adds it, under the name it chooses. A file that says `review:` with nothing under it still has the stage, with its defaults.

- **Submit.** `sc submit` pushes and opens the PR as in any flow, and queues no reviewer. The submit waits for CI's first check as a review would, a change to docs alone included, as nobody else will look at it, then Skelcrew's check goes green with "not reviewed: this flow has no review stage", so branch protection that requires it lets the PR through.
- **State.** The task is never shown as approved, nor as reviewing. From its submit on, while it is pushed and waits for CI's first check, and then on CI, it shows `checks`, and once CI is green it is ready with the word `not reviewed` in place of `approved`, in `sc ps`, `sc ls` and `sc show`. The list, its details pane and the sidebar say `ready to merge, not reviewed`, as it waits on you to merge it, and `not reviewed` once a merge is armed, as [The list](screen.md#the-list) says. It counts no rounds, so it never reaches the round limit. A submit that fails says what failed, never `review failed`: `submit failed` when its push or opening its PR failed, with the forge's error in the note to the lead, or `check failed` when Skelcrew couldn't set its check once it was pushed. Like a failed review it doesn't need you, as the lead can run it again with `sc review`, and `sc ps`, `sc ls` and `sc show` still give its review as `not reviewed`, with no round. An armed merge then waits on its submit or Skelcrew's check, which failed, and the lead hears it. Without a forge it is ready at once, as an approved branch is.
- **Merge when ready.** `sc merge --when-ready` asks `Merge #7 (APP-12 Fix typo) when its checks pass?` and says it merges "as soon as its checks pass", as does the lead's note. It waits only for CI, at the commit last submitted, by the same rules as an approval: the wait for checks, every check passed and no conflict. A newer submit takes the place of the last, as a new approval does, and a push Skelcrew didn't make is never merged. `m` in the list merges it only at that commit too. In a repository with no forge, `sc ps` still shows it as `not reviewed`. A needs-you mark for ready to merge shows as for an approved task. When an armed merge is stuck, such as on a conflict or a refusal, the lead hears it once per submit, as it would once per review round. It posts no record of who asked on the PR, as the forge would show that record as an approval nobody gave: the task's log keeps who asked. A merge skipping the review has nothing to skip, so `sc merge --skip-review` refuses and says to merge it as usual, even while the submit waits for CI's first check.
- **On the PR.** Skelcrew posts no review and no note. Its check says the PR wasn't reviewed, and the PR stays quiet: a forge's review carries a verdict, such as GitHub's "Approved.", which would contradict it.

**Picking a flow.** Every task gets `default`, unless the repository has other flow files. Then the lead triages: it picks the flow when it starts or proposes a task, with `sc start --flow <name>`, and whenever it picks anything but `default`, it tells you which and why. A task started from the `skelcrew` label gets `default`. The lead can switch a task's flow only until its builder first runs `sc submit`, with `sc start <task> --flow <name>` on the task already working, and it tells you which and why. The builder keeps working, and the first round follows the new flow. After the first submit the flow is fixed, and `sc start --flow` on the task refuses and says so, since rounds already ran under the old one. It picks a flow with no review only for a change too small to need one, such as docs, wording or a trivial config change, and always tells you, as nobody will review it. The built-in lead's instructions say this, so it holds in every repository.

Your own confirmations are never flow settings: you always merge, you always add repositories, and you always say yes before a lead starts work or briefs another lead. No flow can drop them.

### `.agents/skills/`

A skill is a folder with a `SKILL.md`, in the format Claude Code reads: a name and a description in the frontmatter, the instructions below, and any files they use beside it. A skill written for Claude Code works unchanged.

Skills come from Skelcrew's clone of the repository, at the `.agents/` you approved, and are copied in as a session starts. They go only into a folder that belongs to one session, never one that sessions share, so an agent that edits its copy changes only its own session.

- **Claude Code.** Into the `skills/` folder of the session's own config folder, in `~/.local/share/skelcrew/claude/`. Every Claude Code session has one, reviews included.
- **Codex.** A Codex lead or builder has a `CODEX_HOME` of its own, and its skills go into `skills/` there. Reviews share Skelcrew's `CODEX_HOME`, whose `skills/` stays read-only and empty, since anything there would steer every later review in every repository. So a Codex review gets them the third way: they are copied into the review's own folder, and its instructions list those paths. Never the clone's `.agents/skills/`, which is the builder's branch, as a builder must not steer its own reviewer.
- **Any other harness**, or one with no folder of one session's own: Skelcrew adds one line per skill to the role's instructions, with its name, description and the path of its `SKILL.md`, so the agent reads it when it needs it.

Skills a repository keeps in `.claude/skills/` already reach Claude Code from the clone, and Skelcrew leaves them alone.

### `skelcrew.lock`

The exact version and commit of every plugin `skelcrew.yaml` names. `sc add` and `sc update` write it, you commit it, and `sc install` installs exactly what it says on every machine, as `package-lock.json` does.

```yaml
# Written by sc add and sc update. Commit it.
skelcrew/skelcrew-github:
  name: github
  version: 0.3.1
  commit: 4f9c2e1a7b…
```

### Yours, never in a repository

What belongs to you or your machine stays in `~/.config/skelcrew/`:

- every login and token, and each plugin's settings and sign-ins;
- the session host: `session: tmux`, or a runtime plugin, such as `session: herdr`;
- your limits: `limits.reviews` and `limits.checks`;
- your default harness and model, for every role and for each;
- your default round limit, `rounds`;
- the reviewer's `fallback`, and a review's time limit;
- per-repository overrides, under `repos:`;
- what you declined, such as `github_declined`;
- whether the lead may arm a merge when ready, or skipping Skelcrew's review, when you ask it to, `lead: { can_merge: true }`, on by default, and turned off with `lead: { can_merge: false }`;
- your personal plugins, which no repository names, such as every runtime plugin, pinned in `~/.config/skelcrew/skelcrew.lock`.

```yaml
# ~/.config/skelcrew/config.yaml
harness: claude
model: opus
session: tmux
rounds: 3
limits: { reviews: 2, checks: 2 }
review: { timeout_minutes: 30 }
needs_you: { grace_minutes: 5 }
plugins: [skelcrew/skelcrew-herdr]   # named afterwards by its short name, as in session: herdr
roles:
  builder:  { harness: codex, model: gpt-6.1-sol }
  reviewer: { harness: codex, fallback: claude }
repos:
  simon/site:
    setup: [npm ci]
    roles:
      builder: { model: sonnet }
```

`limits.reviews` is how many reviews run at once, by default a quarter of the machine's cores, at least 1. `limits.checks` is how many whole test suites run at once through `sc check`, by default half the machine's cores divided by four, at least 1, as a test suite usually runs about four processes of its own. Both fit your machine, so only you set them.

The reviewer's `fallback` names the harness reviews run on while the reviewer's own waits out its usage limit, on that harness's default model. It is yours alone, as a usage limit belongs to your account. A review's time limit, `review: { timeout_minutes: 30 }`, is 30 minutes by default.

`needs_you: { grace_minutes: 5 }` is how long a builder that stopped without submitting may wait for someone to act before it needs you, as [Needs you](flow.md#needs-you) says. It is yours, as it is about how soon you want to hear, and 5 minutes by default.

### Built-in defaults

Skelcrew ships its defaults as the same files, inside Skelcrew: a `skelcrew.yaml` with no setup or test, the three roles with their instructions, and the `default` flow with three rounds. The defaults are read the same way a repository's files are, and nothing about them is special in the code.

### Which wins

Each setting comes from the first of these that sets it:

1. **Your per-repository overrides**, under `repos:` in your `config.yaml`. They are you, saying what you want for this repository on your machine. They apply to that repository only.
2. **The repository's files**, from Skelcrew's clone of its default branch.
3. **Your general settings** in `config.yaml`.
4. **The built-in defaults.**

So the repository decides how its agents work, your general settings fill in what it leaves out, and an override is how you differ from your team on purpose. Settings merge key by key. A role's instructions are one value: a repository's `builder.md` replaces the built-in instructions whole.

Some settings exist only in your files: logins, tokens, the session host, `limits.reviews`, `limits.checks`, the reviewer's fallback, the review time limit, whether the lead may merge, and personal plugins. A repository's files can't set them. Whether the lead may merge is in your general settings only: not under `repos:`, and never from a repository's `skelcrew.yaml` or `.agents/`, so no repository can turn it on.

Settings in their old shape are still read: `lead:`, `builder:` and `reviewer:` at the top level as the roles' harness and model, and `max_rounds` as `rounds`. Where both shapes say something, the new one wins. `sc` says once which old key it read and what replaces it, and changes no file itself.
