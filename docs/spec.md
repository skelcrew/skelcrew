# Skelcrew spec

Nov 18, 2026 · @Simon · the design of Skelcrew v6. `docs/v6.md` is the plan that builds it, phase by phase.

## Goal

Skelcrew is a crew of coding agents, always on, in parallel and isolated, from issue to merged PR. Bring your own harness and model.

You run `sc` in a checkout and talk to that repository's lead: a Claude Code or Codex session that knows the repository. The lead proposes tasks and starts them once you say yes. Each task has a builder, an agent in its own branch, clone and sandbox. It opens a PR. A fresh reviewer, on another model if you choose one, reviews it adversarially, and they go back and forth until it is ready. CI failures and your PR comments wake the builder again. You merge.

Skelcrew is the engine. The repository describes how its agents work, in files, as a `Dockerfile` or `package.json` does, and Skelcrew runs what the files say. Flows are fixed stages with settings, not a language: Skelcrew trusts capable agents and adds an adversarial review, rather than scripting them. Agents run in a session host, tmux by default, and a runtime plugin can bring another, such as herdr. The command line works like npm's.

The code is small, plain and tested. `AGENTS.md` says how to write it, and `docs/learnings.md` holds the traps to avoid.

## Qualities

| Quality | What it means |
| --- | --- |
| Always on | Skelcrew runs on a machine that stays on. Start work from your laptop, close the lid, and it carries on. |
| Unattended, where it makes sense | Agents stay alive, wake on events, and only ask you when they need you. You approve and you merge. |
| Parallel | Many tasks at once, across repositories, without juggling chat windows. |
| Isolated | Each builder gets a branch, clone and sandbox. Your own checkouts are never touched. No tokens inside. |
| Connected | Issues come from GitHub and PRs go back to it, through the GitHub plugin. Any other tool is a plugin too. Without any, Skelcrew works from git alone. |
| Build ⇄ review | A builder and a fresh adversarial reviewer loop until the change is ready. Put the reviewer on another model: a model reviewing its own work shares its blind spots. |
| Combinable | You stay in Claude Code or Codex. Skelcrew's own screen is a simple list, and a session host such as herdr can show the same agents in its own apps. |

## Words

| Word | Meaning |
| --- | --- |
| Lead | Your agent session for one repository, on your harness. One per repository: it starts the first time you open that repository, and from then on is always running. It acts only in its own repository, and reads every other repository Skelcrew has. You talk to it. It proposes tasks and starts them only once you say yes, files an issue only when you ask for one, and never acts on brainstorming alone. |
| Repository | A git repository Skelcrew works on, from a clone of its own, with a lead of its own. It is named by its name on its forge, such as GitHub's `app`, or without a forge by its remote's path, with the owner added (`simon/app`) only when two share a name, in any case, such as `App` and `app`. |
| Task | What you want done, kept by Skelcrew: its title, description, flow, stage, the lead's updates, and links to the issue it came from and the PR it produced. One task makes at most one PR. |
| Issue | An item in a tracker, such as a GitHub issue or a Linear ticket. An issue can become a task. A task needs no issue. |
| Stage | Where a task is: `issue`, `working`, `ready for review`, `merged` or `closed`. |
| Flow | The stages a task goes through and their settings, such as the round limit and the reviewer's role. A file in `.agents/flows/`. |
| Role | What an agent does on a task: its instructions, harness and model. `lead`, `builder` and `reviewer` come built in. A flow can name others. A file in `.agents/roles/`. |
| Thread | One agent working on a task, in one role, on one harness, in one session. A task usually has one thread, its builder. |
| Harness | The coding agent an agent runs on: Claude Code or Codex. |
| Engine | Skelcrew's daemon, one per machine, which runs the flow, polls trackers and forges, and talks to plugins. |
| Builder | The role that writes the change. Its thread lives from the task's start until its PR merges or closes. |
| Reviewer | The role that reviews each round, fresh each time. It runs once per round, with no session and no thread, and never inherits the builder's context. |
| Round | One submit and the review of it. |
| Event | Something that happened to a task: a review, a PR comment, a failed check, a merge. |
| Needs you | A flag on a thread, shown on its task: you must act to unblock it, and its word says what to do. The lead sets it when only you can unblock the thread, and Skelcrew sets it for what it sees itself, such as a question asked in the builder's session, a harness error or the round limit. A task in `ready for review` waits on you too, by its stage. |
| Skill | Knowledge an agent loads when it needs it, as a folder with a `SKILL.md`. A folder in `.agents/skills/`. |
| Session host | What runs agents' sessions and lets you attach to them: tmux, or a runtime plugin that provides sessions, such as herdr. |
| Base module | One of the five parts that run agents: sessions, transport, messages, sandbox and status. Each has a built-in default, and a runtime plugin can provide some. |
| Plugin | A program in a repository of its own, of one of two kinds. An I/O plugin brings work in and sends results out, such as GitHub. A runtime plugin provides some of where and how agents run, such as herdr. |
| Lock file | `skelcrew.lock`: the exact version and commit of every plugin a repository uses. |

Tracker items are called issues everywhere: in commands, in the list and in the lead's words. The word task means Skelcrew's own object only.

## Tasks and threads

### Tasks

A task is Skelcrew's own record of a piece of work, from the first words to the merge. It has:

- a **name**, such as `app-12` or `app-t103`;
- a **title** and a **description**, which the builder gets as its first message, and a **short title** of two or three words, such as `Login redirect`, which the lead gives it for the list;
- a **flow**, named when it starts, `default` unless said otherwise;
- a **stage**;
- the **lead's updates**: every message the lead typed into one of its threads after it started, in order, with who sent it and when;
- a link to the **issue** it came from, if it came from one, and whether Skelcrew assigned you that issue;
- a link to the **PR** it produced, once there is one, with its CI state and Skelcrew's review state: the round, the reviewer, the verdict.

| Stage | When |
| --- | --- |
| `issue` | Not started: an open issue with no work running on it, never started or started and then removed with `sc rm`, or a task in the backlog. A task started with no issue, by `sc start <repo>`, never has this stage: it starts in `working`. |
| `working` | Agents are on it: the builder works, a review runs, CI runs, or a thread needs you. A task whose thread stopped or failed stays here too, so it doesn't vanish. A task waiting in the queue of `limits.threads` is here, shown as `queued`. |
| `ready for review` | Skelcrew's reviewer approved the latest round and CI is green: the wait for CI's first check on the approved commit has ended and every check on it passed, as **The wait for checks** says. It waits for you to review and merge. Without a forge, the branch is approved and waits for you. |
| `merged` | The PR merged, or without a forge, the branch's changes reached the default branch. |
| `closed` | The work ended without a merge, by `sc rm` or a PR closed without merging, and there is no open issue behind it. Or its issue closed while it was still in stage `issue`. |

`merged` is the end. `closed` is the end unless you start the task again with `sc start`, which moves it back to `working`. The list shows the latest of both under Done, and `sc ls --all` shows them all.

When the work on a task ends without a merge and its issue is still open, the task goes back to stage `issue`, not to `closed`. After `sc rm app-12`, issue #12 shows as not started again. It is the same task, with the same name. Its threads, its closed PR and the lead's updates stay in its log, and `sc show app-12` lists them as an earlier attempt. `sc start app-12` starts it again from the issue's title and body as they are then, in a fresh clone on a fresh branch, with no updates carried over. A task with no issue, such as `app-t103`, goes to `closed`, and `sc start app-t103` starts it again from its own title and description.

Needs you is a flag on a thread, never a stage. A task in `working` can need you, and the list shows why in its row.

### The backlog

Work you want done later, but not as an issue in the tracker, is filed in Skelcrew's backlog with `sc task add app "<title>" "<description>"`. It makes a task with no issue and no thread, named as any task with no issue is, such as `app-t104`, in stage `issue`. The lead parks work there, and creates an issue only when you explicitly ask for one. You can file one too.

The backlog is shared between machines through the repository's git remote, never through the tracker. Each task is a commit under a hidden ref, `refs/skelcrew/tasks/t104`, holding its title, description, when it was filed and by whom, such as `simon` or `simon via the lead`. It is never a branch or a file in the tree. The same push that claims the task's name files it, so a name is never claimed without its task, nor a task filed without its name. The claim of the name is a commit of its own, which holds none of the task's words, so once the task's ref goes, no ref holds them. Every machine's engine fetches these refs each time it refreshes its clone of the repository, so the list, `sc ls` and `sc show` on any machine show the same backlog within a poll.

`sc start app-t104`, or `s` or Enter on its row in the list, starts it like an issue, from its title and description. Starting it first claims the start on the remote: one push moves the task from its ref to `refs/skelcrew/started/t104`, a commit that keeps its words, with a lease on the commit Skelcrew read. So two machines never both start it: the second is refused before it records anything. The engine notes the claim in its database before the push, and keeps the note when the push fails without saying how, such as a connection lost on the way back: it asks the remote whose claim is there, and goes on when it is its own. Within one engine, a refresh, a start and a removal of the backlog run one at a time, so none writes back what another just changed. Then it records the thread, which holds the task's words from then on, and deletes the claim. An engine that stops in between finds its claim at its next refresh: it deletes it once the thread is there, and otherwise puts the task back in the backlog, so a task is never lost. A claim the engine didn't note is another machine's start, and that machine finishes it. From then on its thread keeps its words, and once its work ends without a merge it goes to `closed`, as any task with no issue does. `sc rm app-t104` deletes a task that never started, on the remote too. Its name stays claimed, so it never names other work.

### Names

A task has one name, used everywhere. It is the issue's ID with the repository's short name in front when the ID doesn't name a repository: GitHub issue #12 in app is `app-12`, since its number is only unique within app, and Linear's `JOTT-12` stays `JOTT-12`. A task with no issue gets a `t` and a number of Skelcrew's, such as `app-t103`, so it never clashes with an issue's name. The number is the next one after every `t` number claimed on the repository's remote or held by a task on this machine, starting at `t100`. Names from before Skelcrew claimed them, such as `app-t25`, live only on the machine that started them, and are all lower, so a new name never equals an old one. Skelcrew claims it on the remote before using it, in one push that also moves the remote's last claim, which must still be the one Skelcrew read. So two machines on one repository never take the same name, and a name is never below one claimed before it. A name is typed in any case: `sc show APP-T103` and `sc show app-t103` show the same task. So an issue whose ID has the shape of Skelcrew's own in any case, such as `T103`, is left out of Skelcrew's copy of the tracker, as it would share a name. A name never changes, so you can always tell which issue a task is. A dash, because no shell reads a dash as anything special.

A thread is addressed as its task and its role: `app-12/builder`. Wherever a command takes a thread, the task's name alone means its active thread: the one that needs you, or else its builder. The slash never needs quoting in a shell.

### Threads

A thread is one agent on a task. It has:

- its **role**, such as `builder`, or one a flow defines;
- its **harness** and **model**, from the role, kept for the thread's life, since a conversation can't move between harnesses;
- its **session**: the session host it runs on and the session's ID there;
- its **state**: `working`, `idle`, `asking` or `error`, as **Status** says;
- its **status**: `working`, `waiting` (on review, CI or you), `failed`, `stopped` or `done`;
- its **needs you** reasons;
- for a builder, the task's **branch and clone**, which the builder owns.

A task makes at most one PR, from its builder's branch. Work that needs two PRs is two tasks, and the lead says which comes first with `sc tell`.

Reviewers are one-off runs: a fresh agent for each round, with no session and no thread. A review is recorded on the task, as part of its review state.

### The tracker is a source and a mirror

You plan where you already do. An issue on GitHub shows up in Skelcrew with nothing to write, and the `skelcrew` label starts it. But tasks are Skelcrew's own, so a task can exist with no tracker at all, and Skelcrew's stages stay the same whichever tracker a repository uses.

As a **source**, the tracker gives Skelcrew issues. Every open issue in Skelcrew's copy of the tracker shows as a task in stage `issue`. Skelcrew stores a task of its own once one starts, from the issue's title and body at that moment. Later edits to the issue don't reach a started task: the lead passes on what matters as an update.

As a **mirror**, Skelcrew shows the task's progress in the tracker through the tracker's own signals, never comments. It claims the issue with 👀, assigns it to you, and puts the line that closes it in the PR. A merged PR closes the issue. Closing an issue by hand ends nothing: a task already working carries on until its PR merges or closes, or you remove it, since an issue closed as a duplicate or by mistake must not kill a builder mid-work. A task still in stage `issue` whose issue closes leaves the list. A task with no issue mirrors nothing.

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

**The tracker.** A repository's forge is found on its own: the plugin that claims its remote, if one does. Its tracker is its forge, when the forge can be one, as GitHub can, unless `tracker:` names another, such as `linear`. `tracker: none` makes the repository work from git alone, with tasks named like `app-t100`. It is a word, since a bare `tracker:` reads in YAML as no line at all. Which team or project holds the repository's issues stays in the tracker plugin's own settings. When `tracker:` names a plugin that isn't installed, the repository has no tracker, and `sc repo ls` says which plugin to install. It doesn't fall back to its forge, since its issues are planned elsewhere. A task keeps the issue it started on when the repository's tracker changes.

**`limits.threads`** is the most builder threads running at once in this repository, since that depends on the repository: each builder runs its tests, uses CI minutes and opens a PR its reviewers must read. A start over the limit, from `sc start`, the lead or the `skelcrew` label, isn't refused: its task waits in a queue, first come first served, in stage `working`, shown as `queued`. The queue survives a restart of the engine. `sc rm` takes a task out of the queue. A labelled issue is claimed as it joins the queue, so another machine doesn't start it meanwhile. Without the line there is no limit.

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

**Picking a flow.** Every task gets `default`, unless the repository has other flow files. Then the lead triages: it picks the flow when it starts or proposes a task, with `sc start --flow <name>`, and whenever it picks anything but `default`, it tells you which and why. A task started from the `skelcrew` label gets `default`. The lead can switch a task's flow only until its builder first runs `sc submit`, with `sc start <task> --flow <name>` on the task already working, and it tells you which and why. The builder keeps working, and the first round follows the new flow. After the first submit the flow is fixed, and `sc start --flow` on the task refuses and says so, since rounds already ran under the old one. The built-in lead's instructions say this, so it holds in every repository.

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
- whether the lead may arm a merge when ready, or skipping Skelcrew's review, when you ask it to, `lead: { may_arm_merges: true }`, off by default;
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

`needs_you: { grace_minutes: 5 }` is how long a builder that stopped without submitting may wait for someone to act before it needs you, as **Needs you** says. It is yours, as it is about how soon you want to hear, and 5 minutes by default.

### Built-in defaults

Skelcrew ships its defaults as the same files, inside Skelcrew: a `skelcrew.yaml` with no setup or test, the three roles with their instructions, and the `default` flow with three rounds. The defaults are read the same way a repository's files are, and nothing about them is special in the code.

`sc init`, run in a checkout, writes them out there and adds the repository. Every repository gets the same standard setup: `skelcrew.yaml`, `skelcrew.lock` and `.agents/`, with setup and test filled in.

- **setup and test** as commented examples, which the lead fills in with you, as **Setup and test** says;
- **the forge** from the checkout's remote: its plugin goes in `plugins:`, such as `skelcrew/skelcrew-github` for a remote on github.com, and `skelcrew.lock` pins it, as `sc add` does. A plugin already installed here from the same source, such as one of yours, is pinned at its installed version, asking nothing. One not installed yet is installed after asking. A remote on a host with no plugin gets none. A plugin that can't be added, or that you say no to, is only reported, with the `sc add` command that adds it later;
- **a commented `limits: { threads: 4 }`**, to show how to limit the builders at once;
- **your harness and model** for each role, as real lines, so the repository works the same for a teammate;
- no tracker line, so a repository on GitHub keeps its issues, with a commented `# tracker: none` to show how to work from git alone.

It leaves any file that already exists as it is, with one exception: a `skelcrew.yaml` whose `plugins:` names none still gains the forge's plugin, and `sc init` says so. A `skelcrew.lock` that is there gains the plugin's pin beside its others, or keeps the pin it has for it. Then the plugin is installed at that pin, as `sc install` does. Every other line of either file stays as it was. A file written as one map, such as `{setup: [make]}`, is left as it is, and `sc init` says which line to add to it by hand. In a checkout that already has an `.agents/`, it writes nothing into it, then shows what is in it and asks you to approve it, as **Trust** says. It ends by naming the files it wrote or changed, which count once you commit and push them to the default branch. For each of setup and test that neither the checkout's `skelcrew.yaml` nor anything else the lead is told sets, it says the lead will propose it before anything else. It stops outside a git repository, and when the repository has no remote. Only you can run it.

### Which wins

Each setting comes from the first of these that sets it:

1. **Your per-repository overrides**, under `repos:` in your `config.yaml`. They are you, saying what you want for this repository on your machine. They apply to that repository only.
2. **The repository's files**, from Skelcrew's clone of its default branch.
3. **Your general settings** in `config.yaml`.
4. **The built-in defaults.**

So the repository decides how its agents work, your general settings fill in what it leaves out, and an override is how you differ from your team on purpose. Settings merge key by key. A role's instructions are one value: a repository's `builder.md` replaces the built-in instructions whole.

Some settings exist only in your files: logins, tokens, the session host, `limits.reviews`, `limits.checks`, the reviewer's fallback, the review time limit, letting the lead arm merges, and personal plugins. A repository's files can't set them. Letting the lead arm merges is in your general settings only: not under `repos:`, and never from a repository's `skelcrew.yaml` or `.agents/`, so no repository can grant it.

Settings in their old shape are still read: `lead:`, `builder:` and `reviewer:` at the top level as the roles' harness and model, and `max_rounds` as `rounds`. Where both shapes say something, the new one wins. `sc` says once which old key it read and what replaces it, and changes no file itself.

## Trust

Two kinds of thing could reach your machine through the files: plugins, which run as you, and a repository's own files, which steer agents. Each has its rule.

**Plugins run as you, outside the sandbox**, with no sandbox of their own. A plugin can read what you can, your git login and other plugins' tokens included. So `sc install`, `sc add` and `sc update` never install a plugin silently, unlike npm. For a plugin that is new to this machine, or whose version or commit changed, they show its name, source, version, the commands its manifest runs, its kind and what it provides, and ask. A plugin already installed at its locked version asks nothing, as you approved that exact version before. Without a terminal, such as for the engine, nothing is installed: the repository needs you, and its row says to run `sc install`. So a repository's files can make Skelcrew ask you, never make it install. Agents can't run any of these commands.

**A repository's files steer agents, but can't grant anything.** `skelcrew.yaml` and `.agents/` say how agents work. They can't:

- **widen the sandbox.** No file mounts a folder, passes an environment variable, or reaches a socket. The harness module draws the boundary;
- **skip your confirmations.** You merge. You add repositories, in your own terminal. You say yes before a lead starts work or files a public issue;
- **install anything without asking**;
- **set what is yours**, such as logins, the session host and your limits.

**A repository's `.agents/` needs your OK, the first time and after each change.** Role instructions and flows decide what agents are told and how far they go, so a change to them is a change to what runs on your machine. Skelcrew remembers the `.agents/` you approved for each repository in your `~/.config/skelcrew/`, never in the repository.

The first time comes when a repository comes in. Adding a repository whose default branch already has an `.agents/` shows what is in it and asks, even when Skelcrew would trust the repository because you can push to it. Being able to push is not the same as having read what a teammate wrote there. A yes approves it. A no still adds the repository, and its tasks run on the built-in roles and flows until `sc repo trust <repo>` approves its own. `sc init` in a checkout that already has an `.agents/` leaves it as it is and asks the same way. Files `sc init` writes itself are the built-in defaults, so they are approved as it writes them. A repository already in Skelcrew when it first reads `.agents/` asks the same way, at the first `sc` there.

After that, when the default branch brings an `.agents/` different from the one you approved, new tasks keep starting on the version you approved, and the repository needs you. `sc repo trust <repo>` shows what changed and asks, and a yes makes the new version count. A task that already started keeps the version it started with. Merging a PR that changes `.agents/` approves nothing, since an agent wrote it and the merge confirm doesn't show the change. The confirm says the PR changes `.agents/`, and after the merge `sc repo trust` shows the change and asks.

**Plugins aren't agents.** Agents never see a plugin's folders or tokens, which live in your home folder, which the sandbox hides. What a plugin brings in is outside text: its control codes are removed, and typed into the lead, it steers the lead. So each plugin decides who may reach the lead through it.

## Repositories

Skelcrew keeps its own clone of every repository it works on, in `~/.local/share/skelcrew/repos/<owner>/<repo>/`, at the latest default branch. A repository comes in only when you add it, in your own terminal: with `sc` in a checkout of it, `sc init`, or `sc repo add`, which takes a checkout's path, its full name on its forge, such as `simon/site`, or nothing for the checkout you are in. After that its short name works everywhere. The lead can't bring one in: it asks you to add it and open it. `sc repo ls` lists them and `sc repo rm <name>` removes Skelcrew's clone.

**Opening a repository.** The repository is the context, as the folder is for `claude` in a terminal. `sc` in a checkout opens that repository, matched by its remote: its split screen, or its list with `sc --list`, as **The list** says. A repository Skelcrew doesn't have yet is added first, so the first `sc` in any clone goes straight to work. A remote that still uses a repository's old name, such as from before a rename, is matched by asking its forge once. Skelcrew remembers the answer and prints the `git remote set-url` that updates the remote. Outside any repository, `sc` opens the repository you opened last. With no repositories yet, it says `Skelcrew has no repositories yet. Run sc in a checkout of one.` In a repository with no remote, `sc` opens nothing, as opening another repository there would look as if Skelcrew had ignored where you are. It says, with each command on a line of its own and a blank line at the end:

```
This git repository has no remote. To add a remote and push it:

  git remote add origin <url>
  git push -u origin HEAD

Then run sc again.
```

The folder only names the repository: agents never work in your checkout, and Skelcrew never sees changes you haven't pushed. The only files Skelcrew writes there are those of `sc init`, `sc add` and `sc update`, commands you run yourself.

**The GitHub plugin.** `sc` in a checkout whose origin is on github.com, in a repository whose files name no forge plugin, offers the GitHub plugin, until it is installed or you say no for that repository. Skelcrew only reads the checkout's remote for this, with no call to GitHub. Yes adds `skelcrew/skelcrew-github` as yours, as `sc add -g` does, and that yes is enough: it says which version it installs, and asks nothing more. Its setup then runs, as **GitHub** says. GitHub becomes the repository's tracker and forge, so its open issues show as tasks, and nothing has to be written into the repository. No is saved under `github_declined` in `config.yaml`, as the repository's full name, such as `simon/app`, so every checkout of it stays quiet and deleting the line undoes it.

**Trusting a repository.** Before cloning, Skelcrew decides whether to trust the repository: agents will run its setup and test commands, and read its `AGENTS.md` and settings as instructions. It trusts it on its own when its forge says your login can push to it, unless it is a fork. For any other repository, one with no forge included, Skelcrew asks you as you add it, and `sc repo trust <name>` trusts one without the question. Only you can do either, in your own terminal, since a yes passed on by the lead could come from an injected instruction. The answer is remembered in `~/.config/skelcrew/`, never in the repository.

**A repository with no forge** must take Skelcrew's pushes on your own git login, so Skelcrew checks that as it comes in. The engine runs `git push --dry-run` of a new branch from Skelcrew's clone, outside your terminal and without your SSH agent. If git refuses, Skelcrew shows what git said and what to fix, such as a key the engine can use or a credential helper, and doesn't add the repository.

**Each lead, its own repository.** A repository's lead works only in that repository: its clone, read-only, its tasks, and its issues and PRs. Its commands work only there, as the engine knows which lead is calling from its socket. It can also read every other repository Skelcrew has, through their clones, read-only, to understand them and review their leads' work. It starts the first time you open its repository, and from then on runs. Asked about work in another repository, it says so. When work it found belongs in another repository, it briefs that repository's lead with `sc tell lead <repo>`, as **Messages** says, rather than you copying the brief across. Leads message each other this way by default, with no confirmation from you. That lead starts work on a brief only when the brief carries your own words, as **Messages** says. Otherwise it reports the brief to you and asks.

**Issues in public repositories.** Before the lead files an issue in a public repository's tracker, it asks you, such as "I'll file this as an issue on simon/app, which is public. OK?" A lead that can't tell whether the repository is public asks. For a task that fixes a security hole, it asks each time whether to file it as a plain issue or keep it out of GitHub. Its title and body say only what to change, such as "Sanitise HTML in posts", never what an attacker could do. The lead gives the builder the details with `sc tell`. The builder's PR description and commit messages likewise say what changed, never how the hole could be used.

## Commands

The command line follows npm: files describe what a repository needs, `sc install` makes the machine match, and `sc add`, `sc remove` and `sc update` change the files and the machine together.

Every command that lists or shows something takes `--json`, for tools. Commands that do something print one line or fail with a clear message and a non-zero exit, with or without `--json`.

### Setting up

| Command | What it does |
| --- | --- |
| `sc [--from <owner/repo>]` | Opens the split screen on the lead of the repository you are in, as **The list** says. Runs `sc install` first on a machine that isn't set up, and starts the engine in the background first if it isn't running. |
| `sc --list [--from <owner/repo>]` | Shows the list of the repository you are in, and otherwise does what plain `sc` does. |
| `sc init` | Writes the standard setup: `skelcrew.yaml`, `skelcrew.lock` with the forge's plugin pinned, and `.agents/` from the built-in defaults. Then adds the repository. The lead fills in setup and test. |
| `sc install` | Makes the machine match the files, as **Installing** says. Safe to run again: with nothing to do, it says so. In a checkout, it covers that repository and your personal files. Outside one, every repository Skelcrew has. |
| `sc add <plugin>` | Adds a plugin to the repository: `plugins:` in `skelcrew.yaml` and its exact version in `skelcrew.lock`. Then installs it, after asking. A plugin installed here already from the same source, such as one of yours, is pinned at the installed version, asking nothing. Another plugin of the same name is refused, as is one of yours from a folder, which has no version to pin. |
| `sc add -g <plugin>` | Adds a personal plugin: your `config.yaml` and your own lock file. Then installs it, after asking. |
| `sc remove [-g] <plugin>` | Takes a plugin out of the files, and removes it from the machine with its settings and tokens once nothing else uses it. Refuses for the tracker or forge of a repository Skelcrew has. |
| `sc update [-g] [<plugin>]` | Moves a plugin, or all of them, to its newest tag, rewrites the lock, and installs it after asking. |
| `sc setup <plugin>` | Runs an installed plugin's setup again, such as to sign in when its sign-in lapsed, without fetching or building it again. |
| `sc plugins` | Lists the plugins the files ask for and the machine has, with their versions, their kind and what each provides, and any that `sc install` would change. |
| `sc up` | Runs the engine in the foreground, with a readable log, until Ctrl-C. |
| `sc up --bg` | Runs the engine as the background service, under systemd or launchd, and returns. |
| `sc restart` | Restarts the engine's service, under systemd or launchd, and prints one line once the new engine answers, such as `Restarted the engine on simon@workbox. Agents kept running.` Agents keep running. An engine run in a terminal with `sc up` isn't restarted: `sc restart` asks you to stop it, and starts no service beside it. |
| `sc --remote <host> install` | Sends your personal files to the server and runs `sc install` there. On a server with no Skelcrew, asks, then puts Skelcrew there first. |
| `sc --remote <host> up --bg` | Runs the engine on the server as its background service. |
| `sc --remote <host> restart` | Restarts the server's engine, with no `ssh` by hand. |
| `sc --remote <host> [command]` | Runs any command on the server, over `ssh -t`. With no command, opens the server's split screen, and with `--list` its list. |
| `sc repo add [<path> \| <owner/repo>]` | Adds a repository: the checkout at the path, the one named, or the checkout you are in. Asks whether you trust it when it needs to. |
| `sc repo ls` | Lists the repositories, with their short names, trackers and forges, and a tracker `skelcrew.yaml` names that isn't installed. |
| `sc repo rm <name>` | Removes Skelcrew's clone of a repository. Refuses while the repository has live threads, and names them. The lead never needs it, and asks you instead. |
| `sc repo trust <name>` | Trusts a repository your login can't push to, and approves a changed `.agents/` after showing what changed. |

Only you can run these, never an agent.

### Tasks and threads

For you, and for the lead within its own repository:

| Command | What it does |
| --- | --- |
| `sc ls [<repo>] [--all]` | The tasks, grouped by stage, each with its name, its short title or title, and its PR, CI and review, such as `#31 · CI failed · changes r3`. `--all` adds merged and closed ones. `--json` gives each task's `stage`, `issue`, its threads' `status`, `needsYou` and `queued`, and its `pr`, `checks` and `review`. |
| `sc show <task>` | One task: its title, stage, issue with its link, threads with their status, PR with its state and branch, CI and each check, Skelcrew's review, its armed merge with what it waits on, such as `merges without approval · waiting on its checks`, and the PR's link. Then its description and updates as its reviewer gets them, the PR's latest review with its text, the PR's description, and the end of each failed check's log, labelled as from the forge. Earlier attempts are listed after. Text from the tracker or forge has its control characters removed. The lead reads issues and PRs here, never through the tracker's or forge's API, which it has no login for. |
| `sc ps [<repo>] [--all]` | The threads, one row each, named `app-12/builder`, newest first: status and what it needs you for, such as `round limit` or the lead's mark, cut to fit, short title, PR, CI (`passed`, `failed`, `running` or `none`), review (`approved`, `changes`, `reviewing`, `failed` or `none`, with its round, such as `changes r3`), `queued for review` while a review waits for a place, a WAITING count while messages wait for an agent, and a MERGE column while any task has an armed merge, `merges when ready` or `merges without approval`. A row fits in 80 columns. Under the table, one line per armed merge says what it waits on, such as `app-12 merges without approval, waiting on its checks.`, as that can be long. Done threads only with `--all`. `--json` adds each thread's `branch`, `prUrl`, `needsYouFor` whole, the review's `at`, `waiting`, and `merge` with what it `waits` on and whether it `skipReview`s. |
| `sc start <issue> [--from <branch>] [--short "<words>"] [--flow <name>]` | Makes a task from the issue and starts its builder, from `main` or the branch `--from` names. Claims the issue, without checking the claim, and assigns it to you. On a task that stopped, starts its threads again, each with `--resume` on its last conversation. On a task past the round limit, lets it go on: counts its rounds from zero again and types the last review's changes into the builder. `--short` sets the short title, and on a task already working changes nothing else. `--flow` names its flow, and on a task already working switches it until the builder's first submit, as **Picking a flow** says. |
| `sc task add <repo> "<title>" "<description>"` | Files a task in the backlog, such as `app-t104`, and starts nothing, as **The backlog** says. With no title and description as words, reads them from stdin, as `sc start <repo>` does. Refuses an empty description. |
| `sc start <repo> "<title>" "<description>" [--short "<words>"] [--flow <name>]` | Makes a task with no issue, such as `app-t103`, and starts its builder. Works in any repository. With no title and description as words, reads them from stdin, such as `sc start app < request.md`: the first line is the title, without a markdown `# `, and the rest, from its first line that isn't blank, is the description. Refuses an empty description, and with stdin a terminal shows how to use it. |
| `sc issue create <repo> "<title>" "<body>" [--asked-file <file>]` | Creates an issue in the repository's tracker and prints its task's name, such as `app-13`. Starts nothing. Refuses in a repository with no tracker, and refuses an empty body, as a builder sees only the title and body. The lead must give `--asked-file` with your words asking for the issue, exactly, written as for a merge when ready, and the engine logs them. Without them it is refused, and told to use `sc task add`. Yours needs none. |
| `sc attach <task>[/<role>]` | Attaches full screen to the task's active thread, or the one named, through its session host. `sc attach lead` attaches to the lead. |
| `sc peek <task>[/<role>]` | Prints what the thread's agent shows now, without attaching. Refuses when the agent isn't running, saying what state the thread is in. |
| `sc interrupt <task>[/<role>]` | Stops the agent's turn, as Esc does, and keeps its session. Refuses when the agent isn't running. |
| `sc tell <task>[/<role>] "<text>"` | Types a message into the task's active thread, or the one named, once it is idle, and keeps it as an update to the task. When it can't go in right away, it says why. Only the lead runs it: you type to an agent by attaching. |
| `sc review <task>` | Reviews the task's last submitted commit again, as a round's review, such as after a review that failed. Refuses while a review of it is waiting or running. |
| `sc stop <task>[/<role>]` | Ends the task's sessions, or one thread's, and keeps the clone, branch and PR. Stopping the task takes you off its issue if Skelcrew assigned you. |
| `sc rm <task> ["<reason>"]` | Ends the work on the task, as **Removing a task** says, then prints what stays, such as `Removed app-12. Issue #12 stays open, and sc start app-12 starts it over.` At a terminal it first says what it will do and asks, such as `Remove app-12? This closes PR #7 and deletes its branch and clone. [y/N]`. Without a terminal, as for the lead, it doesn't ask: the lead confirms with you in its conversation first, naming the PR it will close. |
| `sc merge --when-ready <task> \| <#pr>` | Arms a merge when ready, after asking `y/N` at your terminal, as **Merge when ready** says. Only you can, or the lead when you let it, with `--asked-file <file>` holding your words, and no question. Builders and reviewers never can. A PR's number is in the repository you are in, or the one `--from` names. |
| `sc merge --skip-review <task> \| <#pr>` | Arms a merge without Skelcrew's approval, after asking `y/N` at your terminal with what the review still asks for, as **Merge skipping the review** says. The same people may run it as `--when-ready`, the same way. |
| `sc merge --cancel <task> \| <#pr>` | Disarms either. The lead may run it when you ask. |
| `sc needs-you <task>[/<role>] "<action>"` | Marks the thread as needing you, with the action you must take, written for you, such as `apply the check.yml split in PR #463`. Its word is then that action, wherever it shows. The lead runs it when only you can unblock the thread, and you can too. Builders can't. |
| `sc needs-you --clear <task>[/<role>]` | Takes the mark off. On a thread past its round limit, it is also the decision that you needn't decide it. The same people may run it. |

For the agents themselves:

| Command | Who | What it does |
| --- | --- | --- |
| `sc submit "<summary>"` | Builder | Submits a round for review: Skelcrew pushes, opens the PR if needed and there is a forge, and starts a review |
| `sc tell lead "<text>"` | Builder | Types a message into its repository's lead, once it is idle |
| `sc tell lead <repo> "<text>" \| - [--asked-file <file>]` | Lead | Types a brief into another repository's lead, once it is idle, with the text as words, or on stdin with `-`, and your words from the file when you asked for the work |
| `sc review <task>` | Builder | Reviews its own task's last submitted commit again, such as when you ask for it on the PR. Never another task's |
| `sc check` | Builder, reviewer, you | Runs the repository's whole test suite in the folder it runs in, once a check slot is free |

Every command an agent can run answers quickly, as Claude Code moves a shell command to the background after 2 minutes.

**Check slots.** Many whole test suites at once overload the machine, so the whole suite runs only through `sc check`, and at most `limits.checks` run at once. `sc check` runs the repository's `test:` commands joined with `&&` in one shell, so a `cd` or an `export` holds for the next, in the folder it runs in, and exits with the suite's own code. The engine keeps the queue: a check over the limit waits its turn, first come first served, and prints its place, such as `Waiting for a check slot: number 2 in line.` The suite runs in a process group of its own, which never outlives `sc check`, even killed outright. The slot is freed once every process holding the check's connection to the engine is gone. A process the suite starts that detaches itself into a session or process group of its own is outside the check, and holds the slot only while it keeps that connection: containing it would take means only Linux has. A check killed while it waits gives its place back. A restarted engine counts slots from none, so a suite running across the restart may briefly overlap new ones. Each task has a second socket, mounted into its reviewer's sandbox, on which only `sc check` is allowed. You run it in a checkout of a repository Skelcrew has. With no `test:`, it fails and says so, and a builder then asks the lead. With `test: []` it runs nothing, takes no slot, and says so. A check that waits for a slot during a review counts toward the review's time limit.

## Installing

`sc install` makes the machine match the files:

1. It checks for `tmux`, `bwrap` (0.11 or newer, for reviews, which see a clone through an overlay) or `sandbox-exec`, `git`, and every harness a role uses. If one is missing, it says exactly what to install, such as `brew install tmux`, before it asks anything.
2. On a machine with no harness picked, it asks whether agents run on Claude Code or Codex and saves `harness` in `config.yaml`. When both are installed, it asks which harness reviews run on, offering the other one first, since a second model sees what the builder's misses. It saves that as `roles: { reviewer: { harness: … } }`, and nothing when you pick your own. With only one installed, it says reviews will run on your harness, with no second view.
3. It logs in each harness that has no login yet. For Claude Code it asks you to run `claude setup-token` yourself in another terminal, which gives a long-lived token for agents, and to paste it. Over SSH you run that on your laptop, where the browser is. Skelcrew checks that what you paste looks like a token and saves it in `~/.config/skelcrew/`, readable only by you. Nothing renews it, so your own login is never touched. For Codex it runs `codex login --device-auth` with `CODEX_HOME` set to `~/.local/share/skelcrew/codex/`, on the terminal's alternate screen, and waits for Enter before switching back if Codex fails. That is a login of Skelcrew's own, separate from yours in `~/.codex`, so a renewal on either side never breaks the other. Every Codex agent and review shares it, which is safe, as Codex locks it while it renews.
4. It installs each plugin the files name at its locked version, asking as **Trust** says, into `~/.local/share/skelcrew/plugins/<name>/<version>/`, and runs its `build`. It refuses a plugin that needs a newer Skelcrew, and one named `none`.
5. It runs each plugin's `setup` that hasn't run on this machine, in your terminal.
6. It starts the engine as the background service, as `sc up --bg` does.

Each step is skipped when it is already done. A tool or login that goes missing later shows up where it is used.

A plugin you are writing can be added from a folder, such as `sc add -g ./skelcrew-linear`. It is used where it is, with no tag, and asks as any install does. `sc update` then runs its `build` again, so your edits count, and `sc remove` never deletes your folder.

## The engine

The engine is Skelcrew's daemon: one per machine, on the machine where its agents run. `sc up` runs it in the foreground, logging as it goes, until Ctrl-C stops it. `sc up --bg` installs or updates the systemd user service, with lingering turned on (`loginctl enable-linger`) so it runs after you log out and after a reboot, or on a Mac the launchd agent. It then starts the engine there if none answers, restarts one that runs another release or commit, and returns. Plain `sc`, `sc --list` and `sc attach` do the same before showing anything. The service runs `sc up`. On systemd, the engine reads a changed service file at its next start. launchd keeps the definition it loaded, so on a Mac a changed file is loaded at once, which restarts the engine. An engine run outside the service, such as `sc up` in a terminal, is told apart by its process id. When it runs other code than `sc`, `sc` asks you to stop it rather than restart the service, and starts no service beside it.

1. If an engine is already running, `sc up` says so and exits.
2. If the machine isn't set up, it exits and tells you to run `sc install`. The engine never asks questions, since systemd has no one to answer them.
3. It opens the database, and reconnects to the lead of each repository you have opened and to every live thread, through each one's session host. A session that is gone is brought back on its harness, with its conversation.
4. It opens its socket at `$XDG_RUNTIME_DIR/skelcrew.sock` for the CLI, and one socket per agent, mounted into that agent's sandbox, so Skelcrew knows which thread is calling.
5. It asks each repository's tracker and forge what changed, and logs to stdout, which systemd sends to the journal.

Sessions keep running when the engine stops, so agents keep working through a restart or an upgrade. What the engine itself started, such as a clone or a reviewer, ends with it, and the next engine starts that work again: it reruns every review whose `skelcrew/check` is still pending, and polling picks up any event it missed. Only `sc stop` and `sc rm` end a session.

**Updates.** A release installs a newer one in the background and says so in the list, such as `Skelcrew 0.6.2 installed · restart to use it`. The next `sc` restarts the engine on it. A Skelcrew run from a checkout does the same after `git pull`, when the engine started on another commit of that checkout. Changes not committed don't count. Agents keep running through it. `sc --version` prints `Skelcrew 0.6.2`, and a build from a checkout says so and names its commit.

## The flow

One task, in the `default` flow, in a repository with GitHub as its tracker and forge.

1. **A task is started.** You add the `skelcrew` label to an issue on GitHub, from anywhere. Or you ask the lead, and it runs `sc start app-12`, or starts a task of the backlog, or files an issue first with `sc issue create` when you ask for one, after asking you when the repository is public. You can run both yourself too.
2. **Skelcrew sets up the builder.** A clone of its own at `~/.local/share/skelcrew/threads/app-12/`, made from Skelcrew's clone, on branch `skelcrew/12-<slug>` from `main` (or `--from <branch>`), with the repository's setup commands run once in it.
3. **The builder starts.** A session of its harness in the sandbox, in the task's clone, with the builder role's instructions and the task's title and description as its first message.
4. **The builder finishes a round.** The whole test suite runs once per commit that changes code, in CI or in the reviewer, never in the builder, as several builders running it at once overload the machine. While it works, the builder runs only the tests near its change. Before it submits, it runs the tests related to its change and the repository's lint and typecheck. If it ever must run the whole suite, it runs `sc check`. Then it commits and runs `sc submit "<summary>"`. The summary becomes the PR's description, so code, file names, commands and HTML go in backticks. Skelcrew fetches the branch from the task's clone into its own and pushes it from there, never running git inside the task's folder. On the first round Skelcrew opens the PR, with the line that closes its issue in its body, such as `Closes #12`.
5. **The reviewer reviews**, as **The review** says.
6. **Changes go back to the builder.** Skelcrew types the review into the builder's session. The builder fixes, commits and runs `sc submit` again. Back to step 4.
7. **After the flow's `rounds` of changes, 3 by default, the builder needs you.** Skelcrew stops sending reviews to the builder until you say go on, with `sc start`. A submit or review past the limit is waited on like any other, without needing you, and the limit needs you again only once a review asks for changes again. A merge you arm, or the lead or you clearing the thread with `sc needs-you --clear`, decides it too, so the thread no longer needs you for it, though the review's changes stay held until `sc start`. An approval answers the round limit: the task no longer needs you for it, and goes on to CI and `ready for review` like any other.
8. **Approved and CI green: the task is `ready for review`.**
9. **You merge**, on GitHub, with `m` in the list, or by arming a merge when ready, or one that skips Skelcrew's review. Skelcrew ends the builder's session, removes the clone, marks the thread `done`, the task `merged`, and tells the lead. A PR closed without merging ends it the same way, and the task goes back to `issue` or to `closed`.

### The review

Skelcrew sets the `skelcrew/check` status on the commit to pending and runs a fresh reviewer once, in the sandbox, on the reviewer role's harness, such as with `codex exec` or `claude -p`. It is given the task's description, with the lead's updates after it, under the heading "Changes to the task from the lead, after the thread started", which says they override the description where they differ. A builder's message to the lead never counts, and neither does anything a builder writes, such as its PR's description: a builder must never change what it is reviewed against. The reviewer reads the diff against the base branch and answers in a fixed JSON shape: approve or changes, the review's body, and its findings, one per problem. Changes always name at least one finding, and an approval names none. An answer that breaks this, or names a blank finding, is a review that failed, so nothing reaches the PR and no round counts. Skelcrew sets the check to success or failure, so branch protection can require it.

**One review per PR.** Skelcrew keeps one review on the PR, a GitHub review that only comments, from `skelcrew[bot]`. The first round posts it, and Skelcrew keeps its ID on the task. Each round after edits it in place, with the latest verdict, findings, round and commit. The round-by-round history stays in the task's log, which keeps each review whole. A forge that can't edit it gets a new review only when the verdict or findings changed since the last one posted, so a round that finds the same again adds nothing to the PR. A review deleted from the PR is posted again, so the PR always shows one. GitHub doesn't let a PR's author approve it, and Skelcrew's app opened the PR, so the check carries the verdict, and approving is yours.

**The queue.** At most `limits.reviews` run at once. A review over the limit waits in a queue, first come first served, and its task shows `queued for review`. The queue survives a restart: a review that was waiting joins it again with the time it first joined, and one cut short while it ran goes ahead of those. A review covers the commit it started for: a newer `sc submit` cancels a review still waiting or running.

**Failures.** A reviewer that fails or answers outside the shape sets the check to failure with "review failed". It doesn't need you: the lead hears of it, with the error, and can run it again with `sc review`, or mark the thread if only you can fix what stops it. A round that fails before its review answers, such as on a push that fails, is the same. A reviewer that runs past its time limit is ended with all it started, and runs once more. That goes in the task's log, and the lead hears of it, such as "app-12's review timed out after 30m; retrying". If the second run times out too, the check fails with "review timed out", and the lead hears of it, with the note `app-12: its review timed out twice (30m). sc review app-12 runs it again.`. A note says the error the harness itself reported, such as Codex's `ERROR:` line or Claude Code's error result, never the task text a harness echoes as it starts. You, the lead or the builder can rerun a review with `sc review`.

**Usage limits.** A reviewer that stops on its harness's usage limit doesn't fail the review. Skelcrew reads the reset time from the error, when the harness gives one, such as Codex's "try again at 1:59 PM" or Claude Code's "resets 2pm". The review is held: its check stays pending, nothing is typed into the builder, and nobody needs you. The task shows `limit · 13:59`, in this machine's time, or just `limit`. Once one review meets the limit, no review starts on that harness until the reset, and every held review runs again then, in its place in the queue. With no reset time, they try again after 15 minutes, then 30, then every hour. With a `fallback`, reviews run on the fallback harness meanwhile, if it isn't limited too, and the review says it ran there. The lead hears once per limit, such as "Codex's usage limit is reached until 13:59; reviews resume then", and once more when a review runs on that harness again.

**The reviewer and the tests.** CI runs the whole suite on a commit when its forge shows a CI check, besides `skelcrew/check`, on that commit. Only that proves it: a workflow can skip this PR, such as with a branch or paths filter. So while a check may still come, the review waits for it before it joins the queue, holding no place, and its task shows `reviewing`. It waits up to 2 minutes when CI shows on another of the repository's open PRs, or when the PR's commit has GitHub workflows in `.github/workflows`, read in Skelcrew's own clone. Otherwise it waits up to 40 seconds, a little over one poll, for CI outside GitHub, such as Buildkite. Once a review has waited in vain, with CI on none of the repository's PRs, the repository's reviews never wait for a first check again while the engine runs, until a check shows on one of its PRs. Skelcrew asks again as the review starts, not when it was queued.

With CI on the commit, the reviewer doesn't run the whole suite. Skelcrew writes CI's result in a file the reviewer reads: passed, failed or still running, each check, and the end of each failed check's log. It rewrites the file every 15 seconds while the review runs, skipping a refresh while the one before still waits on the forge. The reviewer reads it as it starts and again before it answers, and names the failing tests of a failed run as problems. Some checks run no tests, such as a deploy preview or a CLA check, so when none of the listed checks runs the tests, the reviewer runs the suite itself. CI still running is never a reason to ask for changes, as ready waits on every check, as **The wait for checks** says. A review that finishes before CI approves clean code and says "CI pending". With no CI on the commit, or no forge, the reviewer runs the whole suite through `sc check`. With no `test:`, it runs no tests and says so. A change that touches only docs and Markdown, every file under `docs/` or ending in `.md`, is tested by no one: the review waits for no CI, and the reviewer runs no tests and says so. The reviewer's instructions say which, on every harness.

**The wait for checks.** A PR, docs-only included, is ready, and an armed merge may merge it, only once the wait for CI's first check on the approved commit has ended, and every check on that commit then passed. The wait is the one a review makes before it joins the queue, by the same rules and limits: up to 2 minutes or 40 seconds, or none at all in a repository where a review already waited in vain. A check that shows ends it, and the PR goes by that check's result like any other. A wait that ends with no CI check on the commit, such as one CI skips with a paths filter, or a repository with no CI, leaves Skelcrew's own check as the only one, so the PR is ready once it passed. A review of any other change makes the wait before it runs. A docs-only review skips it, so the approval makes it instead, as CI can show its first check after the review is done. Until the wait ends, the PR is not ready and an armed merge waits. A restart during the wait starts it again, so no PR waits forever. A failed check is typed into the builder as usual.

**Keeping an approval.** When main moves, an approved PR can fall behind or conflict, and its builder merges main and submits again. A submit that only merges the base branch into the commit last approved keeps that approval, with no reviewer run. The new commit must be exactly what git makes of that merge by itself, with no conflict and nothing else changed, and so must every merge since the approval. The PR's own diff, against where it meets the base branch, must also read the same before and after, as a clean merge can still change it. Skelcrew reads the commits in its own clone. A clean merge can still break things, so the approval is kept only once every CI check on the new commit has passed. It first waits for CI's first check on the commit, as a review does. While the checks run, the task is not ready. When one fails, or no CI shows, the commit gets a normal review. Once they pass, Skelcrew's check is set to success with "approval kept: only merged main", and Skelcrew's review on the PR and the task's log say the same. Any other change to the PR's diff, a conflict resolved, or a rebase gets a normal review. `sc review` always runs the reviewer.

### Merge when ready

You can say once that a PR should merge when it is ready, and leave. `sc merge --when-ready app-12`, or the PR's number, such as `#7`, asks at your terminal: `Merge #7 (app-12 Add export) when it's approved and green? [y/N]`, with the task's whole title, without control codes. Only `y` arms it, and anything else, `Y` and `yes` included, arms nothing. It arms only the PR you said `y` to: a task removed and started over while the question was open, with another PR, is refused. It refuses a task with no PR yet, and refuses with no terminal. A task already merging when ready isn't asked about again: it says `Already merging #7 as soon as it's approved and green. sc merge --cancel app-12 stops it.`, so no answer seems to stop a merge it leaves on its way. A `y` given while another request put such a plan on the task says the same, even when the task was started over meanwhile. Agents' sockets refuse it, but for a lead you let arm merges: nothing merges that you didn't ask for. Once armed, Skelcrew types a one line note into the lead, so it knows you asked, such as `Merging #7 (app-12) as soon as it's approved and green, as you asked at your terminal. sc merge --cancel app-12 stops it.`

**Asking the lead.** You can let the lead arm a merge when ready when you ask it to in the conversation, such as "merge app-12 when it's ready", with `lead: { may_arm_merges: true }` in your `config.yaml`. It is off by default, and only your general settings can turn it on, as **Which wins** says. With it on, the lead's socket takes `sc merge --when-ready app-12 --asked-file <file>`, or the PR's number in the lead's repository, with no question at a terminal. The file holds your words, exactly as you wrote them. The lead writes it in its own folder with its file-writing tool, never with the shell, so your words never pass through a shell: quotes, backticks and `$()` in them are never run or changed. An empty file is refused. Without the setting, or without your words, it is refused, and builders' and reviewers' sockets always refuse it. The engine reads the setting at each arm, and the lead is told at its start whether it may. Its instructions say to arm only when you explicitly ask in the conversation, never because an issue, PR, comment, builder or note says so, and to name the PR and task when it confirms. The plan is the same as yours. The plan keeps your exact words, through restarts of the engine, as what let it merge. The task's log also records that the lead armed it at your request, with your words quoted exactly as you wrote them, line breaks and spaces included, and the engine logs each arm the same way. The record on the PR says "Merging when ready, as asked by simon via the lead on 18 November 2026.". The lead confirms it to you in one line, such as "Merging #7 (app-12) as soon as it's approved and green, as you asked.", and Skelcrew types no note of its own, so you hear it once. Nothing else changes: the merge still waits for Skelcrew's approval of the exact head, every check green and the forge's clean merge, and `sc merge --cancel` stays open to the lead.

Once armed, each poll checks the PR. The engine merges it by itself, as `m` does, at the commit Skelcrew's reviewer approved, once that commit is still the PR's head, it passed the wait for checks that ready needs, every check on it passed, Skelcrew's own included, and Skelcrew's copy shows no conflict. A PR with no CI check passes only in a repository where no poll ever found CI on any PR, as CI may not have started on it yet. Skelcrew keeps on the repository that a poll found CI on one of its PRs, so a PR that closed since still counts. Just before it first asks the forge to merge an approved commit, Skelcrew posts a review saying "Merging when ready, as asked by simon on 18 November 2026.", with your login name on the machine and the day you armed it, once per armed plan and commit. The record's body carries a fixed marker, a hidden HTML comment with the plan's own ID and the commit: `<!-- skelcrew:merge-when-ready plan=3f2a commit=4f9c2e1 -->`. Skelcrew keeps on the task that it posted it. Before it posts one, it also looks in its copy of the PR for a review whose body holds that marker, whoever the forge says wrote it, and counts one there as posted, saving that on the task. So an engine that stopped after the forge took the review but before saving it finds it at the next poll, and a restart never posts it twice. The merge itself waits for a later poll, so it goes by the PR as the forge reports it after the record: a check that failed or started meanwhile, a cancel, a stop, `sc rm` or a new review all stop it. The lead's note then says `app-12 is done: #7 merged into main when ready, as the human asked`.

Until then the plan stays armed, through restarts of the engine, as it is kept on the task, and `sc ps` shows `merges when ready` with what it waits on, such as `merges when ready · waiting on its failing checks to be fixed`. A push after the approval waits for its own approval, and a push Skelcrew never reviewed is never merged. A conflict, a failing check, a thread that failed or stopped, or a forge that refuses or fails all keep it armed. When it still waits after a round on something someone must act on, not just a review or checks still running, the lead gets one note for that round, such as `Still merging #7 (app-12) once it's approved and green, waiting on its conflict with main to be fixed.` `sc merge --cancel` asks nothing, as cancelling is always safe. While the forge is merging, it refuses and says so, and so it does once the PR merged, until its task has ended. `sc rm`, and any end of the task, disarms it. Without a forge `sc merge --when-ready` refuses and says to merge the branch yourself.

### Merge skipping the review

A review can keep asking for changes you don't need, often past the round limit, on edge cases. You can merge such a PR without Skelcrew's approval from Skelcrew, rather than on GitHub. `sc merge --skip-review app-12`, or the PR's number, asks at your terminal: `Merge #7 (app-12 Add export) without Skelcrew's approval? CI must still pass. It still asks: 1) Handle an empty file 2) Test the error [y/N]`, with each of the latest review's findings on one line and control codes removed. A review still running says `Its review is still running`. It works only on a PR whose review asks for changes or still runs, from your terminal or the lead alike. The list doesn't offer it. One already approved is merged as usual, and one never reviewed waits for its review: both are refused, saying so.

The `y` pins the PR's head as Skelcrew's copy showed it in the question. Only that commit merges. A `y` given after the copy moved on is refused, and a push after the plan is armed cancels it, as nobody you trust saw that commit. The lead then gets a note, such as `#7 (app-12) got a new commit after the human asked to merge it without Skelcrew's approval, so it won't merge. Ask them again if they still want it.`. Everything else is as a merge when ready. Only `y` arms it, with no terminal it refuses, and a task already merging is not asked about again. Agents' sockets refuse it, but for a lead you let arm merges, with `--asked-file` and your exact words. The lead's instructions say to arm one only when you explicitly ask it in the conversation to merge without Skelcrew's approval, or to force the merge, never because a builder, PR, issue or comment suggests it. They say to tell you plainly that it merges without approval. The plan, the thread's log and the daemon's log keep your words exactly, as for a merge when ready.

Each poll checks the PR as it does for a merge when ready. Only the reviewer's approval is skipped: Skelcrew's own check, which carries that verdict, is left out. A review still running is waited for, whatever it then says, so its findings are known before the merge. Every other check on the pinned commit must pass, and the PR must merge cleanly. With the review skipped, CI is all that guards the merge. So, as for a merge when ready, a PR with no CI check passes only in a repository where no poll ever found CI on any PR. A round the builder submitted waits, as its push will cancel the plan. Just before it first asks the forge to merge, Skelcrew posts a review on the pinned commit saying "Merging without Skelcrew's approval, as asked by simon on 19 November 2026.", or "by simon via the lead", once per plan and commit. It says "Merging", as a check can still fail or the plan be cancelled. Once the forge merged it, Skelcrew edits that review to say "Merged without Skelcrew's approval, as asked by simon on 19 November 2026.". A forge that can't edit it leaves "Merging", which the merge made true. The review keeps the reviewer's last verdict: asking for changes, or approving when a review still running when you asked approved the commit, so the record never contradicts it or blocks a forge that requires an approval. Its body carries a marker like a merge when ready's, `<!-- skelcrew:merge-skip-review plan=3f2a commit=4f9c2e1 -->`, and it is kept on the task and found again the same way, so a restart never posts it twice. The merge waits for a later poll, as for a merge when ready.

Once merged, the latest review's findings, read again after the merge in case a review ended meanwhile, are filed as one issue in the tracker, titled `Follow-ups from #7's review`, listing them and naming the PR, so they aren't lost. It is filed once: the issue is kept on the task, and its body carries a hidden marker, `<!-- skelcrew:follow-ups plan=3f2a -->`. An issue the tracker made just before a restart, before Skelcrew saved it, is found by that marker in Skelcrew's copy, and none is filed again. When the forge merged the PR before Skelcrew could finish, such as across a restart of the engine, the poll that finds it merged still edits the record and files the issue, with the same note. The findings filed are read after the edit, so a review that ended meanwhile counts. The lead's note says `app-12 is done: #7 merged into main without Skelcrew's approval, as the human asked. Its open findings are in #13.`. An issue that can't be filed, such as with no tracker, is said in that note instead, so you can file it. Until then `sc ps` and `sc show` show `merges without approval` with what it waits on, such as `merges without approval · waiting on its checks`. `sc merge --cancel` disarms it, as it does a merge when ready.

### Without an issue, without a forge

**Without an issue.** You tell the lead what to do, and it starts a task with `sc start app "<title>" "<description>"`, written from what you said. It does this in any repository, and files no issue unless you ask for one. The task is named `app-t100`, on branch `skelcrew/t100-<slug>`, and its PR closes no issue. In a repository with no tracker, this is how every task starts.

**Without a forge.** Skelcrew pushes the builder's branch to the repository's remote with git, on your own git login. It opens no PR and sets no check. The reviewer reviews the branch's diff against the default branch, and the loop runs the same, with each review kept in Skelcrew and typed into the builder. Once approved, the task is `ready for review`: "app-t100 is ready on branch skelcrew/t100-fix-login". You open a PR or merge it yourself. The task is `merged` when a fetch finds that merging the branch into the default branch would change nothing, which a merge, a squash and a rebase all leave. A branch deleted from the remote ends it too. Nothing from CI or a PR reaches the builder.

### Removing a task

`sc rm app-12` ends the work on a task, such as one you want started over. Skelcrew ends its threads, closes the PR as `skelcrew[bot]`, deletes its branch on the forge, removes the clone, takes you off the issue if it assigned you, and marks the threads `done`. With a reason, such as `sc rm app-12 "started over as app-14"`, the PR first gets the comment "Closed by Skelcrew: started over as app-14". The task goes back to `issue`, or to `closed` with no issue. Without a forge, Skelcrew deletes the branch from the remote with git, if it pushed it. The lead can run it, and a builder can't. On a task in the backlog that never started, it only deletes the task, as **The backlog** says, and prints `Removed app-t104 from the backlog.`

### Assigning the issue

Every start of a task on an issue assigns the issue to you, the person the tracker's plugin signed in as, so the tracker shows which issues Skelcrew is on, and for whom. It adds you and never takes another assignee off. The task keeps whether Skelcrew assigned you or you were assigned already. When the task stops, is removed, or its PR closes without merging, Skelcrew takes you off, but only if it put you on. A merge leaves you assigned, as the record of who did it. A task that failed keeps you assigned. An assignment that fails is logged and not tried again, and never stops a task from starting or stopping.

### Needs you

**Needs you means you must act to unblock the thread.** Nothing else sets it, and its word always says what the action is. Waiting on a review, CI or a queue never needs you.

**Questions go to the lead.** You talk to the lead, so a builder brings its questions, its decisions and anything else it needs there, never to you in its own session, on every harness and host. It runs `sc tell lead` with what it needs and its options, and ends its turn to wait for the answer. Its instructions say to frame a question for someone who hasn't read the code: the background in plain words, the problem with a concrete example, what each option means for you, and a recommendation with its reason, without file paths or names from the code unless they help. They tell it never to use its harness's question tool, such as `AskUserQuestion`.

The lead answers a question itself when the answer follows from what you already decided, such as earlier in its conversation, from the repository's spec or design documents, or from a clear technical call. It then tells you in one line what it answered and why, so you can overrule it. A question that is yours by rule always comes to you, however clear the answer seems: editing a spec, trust or security, the work's scope or direction, and merging. The lead brings it to you in its chat, framed the same way and naming the task, and passes your answer on with `sc tell`. You never need to attach to a builder to answer it. All of this is among the lead's core rules, so a repository's own lead role can't drop it.

**The lead marks what only you can unblock.** When only you can unblock a thread, such as a change to a workflow file that only a person can push, the lead marks it with `sc needs-you app-12 "<the action>"`, written for you, such as `apply the check.yml split in PR #463`. The thread then needs you, and its word is that action, in the sidebar, `sc --list`, `sc ps`, `sc show`, `sc pr show` and a host's status, such as herdr's. The lead never marks a thread it can unblock itself, or one that only waits on its review, CI or a queue. `sc needs-you --clear app-12` takes the mark off. Only you and the lead of the thread's repository can run either, and both are among the lead's core rules. The lead gets no note of a mark it set itself, and gets one of each mark you set, even on a thread that needed you already.

**What Skelcrew marks itself**, by the same rule:

- **Ready to merge.** An approved thread with green checks and no merge armed waits on you to merge it, as **Merge when ready** says. `sc ps`, `sc show` and a host's status say `ready to merge`, while the list's word stays `approved`, beside its green mark. One with a merge armed merges by itself, so it doesn't.
- **The round limit**, while nobody has decided, as step 7 of **The flow** says. A merge you armed, `sc start` to go on, or the lead or you marking or clearing the thread decides it, and the thread follows that decision. Decided, it no longer needs you for the limit, so a mark that clears or a merge plan that ends later, such as one you cancel, doesn't bring the limit back. Cleared, it still shows `round limit`, without needing you, until the next review, which asks again.
- **A question** asked with the harness's question tool, and **a harness error**, as below.
- **A missing session host plugin**, which only `sc install` brings back, as **Sessions** says. A mark the thread had already follows the instruction, such as `run sc install: its session host herdr is missing, then check the design`, and is all that is left once the engine finds the plugin again. While the plugin is still missing, marking or clearing the thread keeps the instruction first.

A thread that failed, a review that failed, a round that failed and a builder that isn't running aren't among them: the lead hears of each, and can run the review again or bring the builder back.

**Clearing.** A mark clears when you type to the thread's builder, when the lead or you clear it, and when the thing it is about happens: the builder submits again, the PR merges or closes, the task is removed, or the thread goes on past its round limit. Stopping the thread doesn't clear it, as what you must do still stands. What Skelcrew types into the builder, such as the lead's message or a review's changes, doesn't clear it: the harness's hook gives what was typed, and only text Skelcrew didn't type is yours. The thread's log says each time a mark is set or cleared, who did it and why, and a mark that clears on its own names the mark it cleared.

A builder that asks with its harness's question tool anyway, such as a custom role's, needs you until you attach and answer. On Claude Code that is `AskUserQuestion`.

**A turn that ends without submitting** goes to the lead, not to you: the builder may have written its question as plain text, be stuck, or have only replied. The thread shows `turn ended`, and doesn't need you. The harness's `Stop` hook tells Skelcrew when a turn ends. A turn whose builder ran `sc submit` or `sc review` in it waits on its review, not on you, but not one in which the lead or you asked for the review. A turn that ends while an `AskUserQuestion` is open, or on an error, adds nothing. A turn typed in by Skelcrew, such as a review's changes or a message, is like any other. One exception: a turn that leaves no new work, nothing uncommitted and no commit after the last one submitted, waits on that submit while it is still reviewed, waits on CI or is approved. Such a turn most likely only answered a message, so it doesn't show `turn ended`. Either way, its last message, up to 2000 characters, goes to the lead as a message from the builder, who answers it or brings a question in it to you. A turn in which the builder told the lead something with `sc tell lead` sends nothing more at its end, as the lead already has its words. Bringing a builder back with `sc start`, or the engine starting, ends no turn. Esc flags nothing, as you are looking at the builder anyway.

**The safety net.** A builder that ended a turn without submitting, and that nobody acted on for `needs_you.grace_minutes`, 5 by default, needs you, with its last message as the mark, cut to one line, so nothing waits unseen while the lead is busy or misses it. It is only for a stopped builder with nothing in flight. A turn that ends while its last submit is still being pushed, under review or waiting on CI doesn't start it then, whatever the builder left in its clone, as waiting on those never needs you, and the builder's words went to the lead, which marks the thread when only you can act. Its wait starts once that is over, such as when the review fails, if nobody acted meanwhile. A thread that already needs you for something else isn't marked by it. The lead gets the note that it needs you, as for any thread. Typing to the builder, the lead telling it something, from the moment the lead sends it, a new submit, or the lead or you marking or clearing the thread is acting on it, and stops the wait.

The builder's words reach the lead with `<skelcrew` and `</skelcrew>` removed, so they never pass for Skelcrew's. Whatever is typed into the builder next clears `turn ended` or a question: what you type, or a message from the lead.

**Harness errors.** A builder's harness can stop on an error it can't get past alone, such as a lapsed login. On Claude Code, the `StopFailure` hook says so, and the builder needs you, with the word `error`. You attach, fix what it says, such as with `/login`, and type to it, which clears it. A usage limit or rate limit passes by itself, so it doesn't need you: the task shows `limit · 13:59`, and once the limit resets Skelcrew types "continue" into the builder, if it is still idle on that error. It is a limit only when the hook says so. If "continue" can't be typed, the builder needs you. With no reset time, it tries after 15 minutes, then 30, then every hour. Codex runs no hook on an error, so on Codex an error goes unnoticed, except for the model check before a session starts. A lead that stops on an error isn't flagged, as you see it whenever you open its repository.

**Telling you.** When a thread starts needing you, Skelcrew sends a one line note to its repository's lead, so you hear it where you already are. A task's end brings a note too, so the lead never lists a merged PR as ready: `app-12 is done: #7 merged into main`, or without a forge `app-12 is done: its branch skelcrew/12-add-export merged into main`. A PR closed without merging brings `app-12 ended: #7 closed without merging`, and a branch deleted without a forge `app-12 ended: its branch skelcrew/12-add-export was deleted`. A task you remove brings `app-12 ended: you removed it, closing #7`, with your reason after it. One the lead removed brings none. Each end brings one note at most. On such a note the lead updates what it holds open and, when useful, says what the end unblocks. A task that starts over while its end note still waits drops that note, as the lead would take it for the new attempt. A thread that fails brings a note too, with why, such as `app-12 failed: its setup command failed`, so you can start it again. Starting it again drops that note if it still waits, as the lead would ask you to start a thread that already runs.

## Events

The engine asks each repository's tracker and forge what changed since it last looked, and names the PRs of its live and stopped tasks, which come back whatever changed. GitHub's plugin answers with one GraphQL query per repository, so the number of requests doesn't grow with the number of tasks, and a check that finished still reaches Skelcrew. It polls every 30 seconds while a task is active, and less often while tasks only wait on you. Each event is handled once: Skelcrew records the ID of the last review, comment and check run it acted on.

**Starting from GitHub.** Every minute the engine also looks in its copy for open issues labelled `skelcrew`, and starts a task on each one that hasn't started, as `sc start` does. Before it starts one, it claims the issue with 👀. When two machines run Skelcrew on one repository, only the one whose claim comes first starts it. A claim that fails is tried again on the next poll. Once started, the engine sends the lead a note, such as "started app-12 from GitHub: Fix the login redirect", and the lead gives it a short title with `sc start app-12 --short "<words>"`. A label is the signal because Skelcrew's GitHub App can't be assigned an issue, and only people with triage or write access can add one. Removing the label doesn't stop a task; `sc stop` does. A task that failed, stopped or was removed isn't started again by its label, only by `sc start`. GitHub's plugin creates the label in a repository whose tracker it is. Skelcrew never comments on the issue.

| Event | What Skelcrew does |
| --- | --- |
| Reviewer requests changes | Types the review into the builder, unless the round limit is reached |
| Reviewer approves | Waits on CI, or `ready for review` if CI is already green |
| A check fails | Types the failing check's name and its log, as the forge's `log` gives it, into the builder |
| All checks pass after approval | `ready for review` |
| A person comments or reviews on the PR | Types it into the builder. Your comments always wake the builder, even past the round limit. Once it is typed in, the forge marks it seen: GitHub reacts with 👀, to a review itself rather than its line comments. One that isn't typed in isn't marked. A mark that fails is logged, and never holds up the builder |
| Merge conflict with the base branch | Tells the builder to merge and fix it. An approved task leaves `ready for review` at once, until a new round is approved |
| PR merged or closed | Ends the task's threads and cleans up |
| Bot comments | Ignored |

An event changes the task at once, before the builder hears of it: an approved PR that starts conflicting leaves `ready for review` before its message is typed in, and stays out until the builder's next round. Without a forge, only the reviews and the end of the branch happen.

## Plugins

A plugin lives in a git repository of its own, with a `skelcrew-plugin.yaml` at its root. It is one of two kinds, and says in its manifest what it provides within that kind. Skelcrew's flow knows what a plugin provides, never which plugin provides it.

| Kind | What it is for | Provides | Examples |
| --- | --- | --- | --- |
| I/O | Work in and results out. In: issues become tasks, labels start them, comments and reviews reach builders. Out: PRs, reviews, checks, merges, closed issues and notifications | `tracker`, `forge`, `chat` | GitHub (tracker and forge), Linear, GitLab, Slack |
| Runtime | Where and how agents run | `sessions`, `transport`, `status`, `machine` | herdr. tmux and SSH are built in |

Messages and the sandbox stay in core, between the two. Work comes in through an I/O plugin, becomes a message, and reaches an agent through the runtime. No plugin can provide messages or the sandbox, so the rules about who may reach whom, and what an agent can touch, are Skelcrew's on every setup. Harnesses are never plugins: each is built into Skelcrew, one module per harness, because that module draws the sandbox boundary.

A runtime plugin is always personal, added with `sc add -g`, since how you run and watch your agents is yours. An I/O plugin is usually the repository's, in `plugins:`.

### The manifest

```yaml
name: github
version: 0.4.0          # the same as the tag it is installed from, v0.4.0
skelcrew: 0.6.0         # the oldest Skelcrew release it works with
about: Tasks from GitHub issues, and PRs on GitHub, as Skelcrew's GitHub App
kind: io
provides: [tracker, forge]
build: [[bun, install, --production]]
setup: [bun, setup.ts]
call: [bun, call.ts]
git_credentials: [bun, credentials.ts]
```

Each command is a list of words, run in the plugin's folder and never through a shell. `build` runs once, at install. `setup` runs in your terminal and asks for whatever the plugin needs, such as a sign-in. A command whose first word is `bun` runs on the Bun inside Skelcrew, so a plugin written for Bun needs nothing else installed. A manifest with `jobs:` and no `kind:` is still read: tracker, forge and chat make it I/O, and machine makes it runtime.

Each command gets `SKELCREW_PLUGIN`, its name, and `SKELCREW_PLUGIN_CONFIG`, a folder in `~/.config/skelcrew/plugins/` for its settings and tokens, readable only by you, in a format of its own. `setup` also gets `SKELCREW_REMOTE`, the remote of the checkout `sc` ran in, when there is one.

### I/O plugins

A tracker or forge is asked by running its `call` command with one JSON question on stdin. It prints one JSON answer and exits within 60 seconds. If it exits with an error, its last line of stderr is the error. Exit code 2 means the plugin needs its setup again, such as after its sign-in lapsed, and Skelcrew's error names `sc setup <name>`. When `claims` exits with 2 while Skelcrew brings in a repository in your terminal, Skelcrew runs that plugin's setup there, handed the repository's remote, and then asks again, so the fix happens where you are. Ctrl-C stops it. Every answer is checked before Skelcrew uses it.

| Question | Provides | Answer |
| --- | --- | --- |
| `claims` with a remote, such as `git@github.com:simon/app.git` | Forge | The repository's key, short name, link and clone URL, whether you can push to it and whether it is a fork. Or `null` if it isn't this plugin's. |
| `changed` with a repository, whether the plugin is its tracker, its forge or both, the last `next` (or none), and PR numbers to watch | Tracker, forge | `items`, everything updated since, or everything open without a `next`, and the new `next` |
| `create task` with a repository, title and body | Tracker | The new issue |
| `took` with a repository and issue, before a labelled issue starts, and at each `sc start` on one | Tracker | `{ "took": true }` if this call took it, or `{ "took": false }` if someone already had. GitHub reacts with 👀, and a reaction already there means it was taken. `null`, from an older plugin, counts as taken. `sc start` doesn't look at the answer. |
| `assign` with a repository, issue, and on or off | Tracker | With on, `{ "assigned": true }` if this call assigned you, or `{ "assigned": false }` if you were already. With off, nothing. A tracker with no assignees answers `{ "assigned": false }` and does nothing. |
| `seen` with a repository, PR, kind (comment or review) and ID | Forge | Nothing. GitHub reacts with 👀 |
| `open pr` with a repository, branch, base, title and body | Forge | Its number, or the number of the PR already open from that branch |
| `merge pr` with a repository, PR and the commit you saw approved | Forge | Nothing, or why it couldn't merge. GitHub merges only if the PR's head is still that commit, with the first method the repository allows, of a merge commit, squash and rebase |
| `close pr` with a repository, PR, branch, and a comment or none | Forge | Nothing. GitHub posts the comment, closes the PR, and deletes the branch |
| `review` with a repository, PR, commit, verdict and body | Forge | The review's ID. The forge posts the body unchanged, HTML comments included, and `changed` gives it back unchanged, so Skelcrew can find its markers, such as the one a merge when ready's record carries |
| `edit review` with a repository, PR, review ID, verdict and body | Forge | `{ "edited": true }` once the forge changed that review to the new verdict and body, `{ "edited": false, "gone": true }` when the review no longer exists, such as one someone deleted, or `{ "edited": false }` if the forge can't edit it. `null`, from an older plugin, and an error count as can't, so the review still reaches the PR |
| `status` with a repository, commit, state and description | Forge | Nothing |
| `log` with a repository and check ID | Forge | What failed: the failing tests and their errors, from the check run's annotations and the failed step, or else the end of the job's log |

Skelcrew asks `changed` once per repository of each plugin that is its tracker or its forge, and keeps issues only from its tracker and PRs only from its forge.

An **item** is an issue or a PR: its kind, ID, title, body, state (`open`, `closed` or `merged`), author, labels, link, and when it was created and updated. An ID is the tracker's own, such as `12` on GitHub or `JOTT-12` on Linear. An issue adds the line a PR's body needs to close it on merge, such as `Closes #12`. A PR adds its branch, base, whether it conflicts with the base, its checks, and its reviews and comments. A check has a name, an ID if it has a log, and a state: `running`, `passed`, `failed`, or `cancelled`, which isn't the builder's to fix. A review or comment has an ID, its text and its author, and a review its verdict and its comments on lines. An author says whether it is a bot, whether it is you, and whether it can push to the repository.

Skelcrew runs git itself, for clones, fetches and pushes. `git_credentials` is a git credential helper, which Skelcrew hands to git for each command and never saves.

**The copy.** Skelcrew keeps a copy of each repository's open issues, from its tracker, and open PRs, from its forge. At each poll `changed` brings what changed since its last `next`. Each engine start begins with no `next`, so everything open comes again, and anything no longer there leaves the copy. A closed item leaves once no live task points to it. The list, `sc ls`, `sc show` and `sc ps` read the copy, so none of them waits on the tracker or forge. Only `sc show` asks the forge, for the logs of failed checks. `sc start` polls its repository first, so a builder never starts from an old body.

A chat plugin, such as Slack, would be where you hear that a task needs you and talk to a lead. None exists yet, so chat has no commands: they come with the first chat plugin.

### GitHub

The GitHub plugin, `skelcrew/skelcrew-github`, acts as Skelcrew's GitHub App, `skelcrew`, so every PR, review, comment, reaction and push shows as `skelcrew[bot]`. Skelcrew never acts on GitHub as you, so it is always clear whether you or Skelcrew speaks. Its setup takes two steps, asks you to paste nothing, and skips a step already done:

1. It signs you in with GitHub's device flow for the app. It shows a code, and Enter opens GitHub's page, where you enter it and click Authorize. That tells Skelcrew who you are. The plugin keeps the sign-in in its settings, and renews it through Skelcrew's service, since renewing needs the app's secret. A renewal cancels the sign-in before, so two machines can't share one: each machine signs in on its own.
2. It makes sure the app is installed on the repository `sc` ran in. If it isn't, Enter opens the app's install page, with the repository picked already when it is public. GitHub picks a repository only by its ID, which no one can read for a private repository before the app is on it, so there you pick it yourself. The plugin sees the install through your sign-in. Outside a checkout, setup waits until the app is installed anywhere.

On a remote, setup prints each link instead of opening it.

For each repository, the plugin asks the service for a token, with your sign-in. The service checks that you can reach the repository and the app is installed there, then makes a token for that repository alone, which lasts an hour. `claims` for a repository the app isn't installed on exits with 2, so `sc` there runs the setup, which goes straight to step 2. The app has contents, pull requests, issues and commit statuses to read and write, checks and actions to read, and metadata. It has no permission for workflows, so it can't push a change to `.github/workflows`. A builder that needs one says so, and you make it.

**Skelcrew's service.** The app is shared by everyone who uses Skelcrew, and its secrets can't ship inside Skelcrew. So a small service holds them, and does only what needs them: it makes GitHub tokens and renews your sign-in. It is open source, in `skelcrew/skelcrew-service`. The plugin's one setting is the service's address, `https://skelcrew.dev` unless you set another, and its setup never asks for it. To depend on no one, you run the service yourself, with a GitHub App of your own, and set its address: the same plugin, the same setup. The service is one small serverless function with no database. It sees who asked for a token for which repository, logs no request bodies, and code and issues never pass through it. While it is down, a token can't be renewed, so within the hour Skelcrew can't read, push or post on GitHub, and tasks wait. Once it is back, the next poll catches up. Skelcrew's core never needs the service.

### Runtime plugins

A runtime plugin says what it provides, out of four: the base modules `sessions`, `transport` and `status`, and `machine`. For the base modules, core uses its built-in for any it leaves out. Each function is a command, run as `call` is: one JSON question on stdin, one JSON answer on stdout. `attach` runs in your terminal, as `setup` does.

```yaml
name: herdr
version: 0.1.0
skelcrew: 0.6.0
about: Runs Skelcrew's agents in herdr-core, so herdr's apps show them
kind: runtime
provides: [sessions, transport, status]
session: [bun, session.ts]       # start, paste, keys, read, interrupt, end, list, rename, deliver, idle, status
attach: [bun, attach.ts]
```

**herdr** (`skelcrew/skelcrew-herdr`, https://github.com/herdrdev/herdr-core) provides sessions, transport and status. `start` maps onto `hc run`, `paste` and `keys` onto `hc send`, `read` onto `hc read`, `interrupt` onto `hc interrupt`, `attach` onto herdr-core's client, `end` onto ending the program, `list` onto herdr's labels, `rename` onto the tab's name, `deliver` onto `hc send --if idle`, `idle` onto `hc events`, and `status` onto OSC 7501, written by the plugin's relay in the pane, as **Status** says. herdr's own apps then show Skelcrew's leads and builders on your laptop, desktop and phone.

**Machines.** A runtime plugin that provides `machine` says how to reach a machine that runs Skelcrew, with three commands:

```yaml
name: sprite
kind: runtime
provides: [machine]
add: [bun, add.ts]
exec: [bun, exec.ts]
push: [bun, push.ts]
```

- `add <name>` checks that your laptop has what the machine needs, lists what is missing with the command that fixes it, asks before creating the machine, then readies it for Skelcrew.
- `exec <name> <word>…` runs the words on the machine, as `ssh -t` does, waking it if it sleeps, with your terminal when Skelcrew has one.
- `push <name> <file> <path>` copies a file to the machine, as `scp` does.

`exec` and `push` never create a machine, so a mistyped name creates nothing. `sc --remote <plugin>:<name>` reaches a machine through the machine plugin of that name, and a host with no plugin in front, such as `simon@workbox`, goes over SSH. A machine plugin is used on the laptop you run `--remote` from, never where the engine runs. With no machine plugin of that name, `--remote` refuses a `<plugin>:<name>` host rather than taking it for an SSH host.

## Base modules

How Skelcrew runs agents is split into five base modules. Each has a built-in default, and a runtime plugin can take over some of them, leaving core's built-ins for the rest. The flow speaks only to these modules, never to tmux or to a plugin by name. Each module is plain functions in a file of its own.

| Module | What it does | Built in | A plugin can provide it |
| --- | --- | --- | --- |
| Sessions | Runs each agent in a terminal session, lets you attach, and finds sessions again after a restart | tmux | Yes, such as herdr |
| Transport | Gets text into an agent, and knows when the agent is idle | Paste through the session, idle from Skelcrew's hooks and a screen check | Yes, such as herdr |
| Messages | Decides what is typed into which agent, when, and in what order | Core | No |
| Sandbox | Draws the boundary around every agent | Core: bubblewrap on Linux, `sandbox-exec` on a Mac | No |
| Status | Knows whether each agent works, idles, needs you, is ready or hit an error, and shows it | Core, from Skelcrew's hooks | Only the showing |

### Sessions

Every agent runs in a terminal session of its own: one for each repository's lead and one per builder. The rest of Skelcrew reaches a session only through this module, with plain data in and out.

| Function | What it does |
| --- | --- |
| `start` | Starts a session running the command Skelcrew gives, in a folder, with its environment and its labels. Returns the session's ID. Can keep the session when its agent exits cleanly, so a lead you exited can be told from one that crashed. |
| `paste` | Pastes text into the session as one bracketed paste, in steps: readying the text, pasting it, then forgetting it, so typing can take its last look at the screen just before the paste. |
| `keys` | Sends keys, such as Enter or Esc. |
| `read` | Returns what the session shows now, and whether someone has scrolled back in it. Typing, the status screen check and `sc peek` use it. |
| `interrupt` | Stops the agent's turn, as Esc does. `sc interrupt` uses it. |
| `attach` | Attaches your terminal full screen to the session. It returns when you detach. |
| `end` | Ends the session, and waits until every process it ran has exited, so its clone can be removed. |
| `list` | Lists the host's sessions with Skelcrew's labels and whether each agent still runs, so a starting engine finds the agents still running. |
| `rename` | Receives a session's ID and its new title, as `{ "ask": "rename", "id": "<ID>", "title": "<title>" }`, each time its thread's title changes, such as when the lead gives it a short title, and names the session by it. Its answer isn't read. A plugin's host only: tmux keeps no title. A host that fails it, such as an older plugin, keeps the old name, and Skelcrew logs it. |
| `check` | Says whether one session exists, whether its agent still runs, whether it exited cleanly, and the last screen of one that ended, so Skelcrew reconnects instead of starting an agent twice and can say why one ended. |

Every session carries three labels: its repository (`simon/app`), its task (`app-12`, none for a lead) and its role (`builder`, or `lead`). They stay with the session for as long as it lives, so a starting engine knows whose each session is, and a host's own apps can group and filter by them. A builder's session on a plugin's host also carries its title, for the host's own apps to name it by: its thread's short title, else its full title. `start` hands them over as `labels`, such as `{ "repository": "simon/app", "role": "builder", "task": "app-12", "title": "Login redirect" }`, and `list` gives them back the same way. A host ignores labels it doesn't know. When the title changes, Skelcrew asks the host to `rename` the session. tmux keeps no title, as Skelcrew's list reads titles from its own database.

The built-in host is tmux. Its sessions run on Skelcrew's own tmux server (`tmux -L skelcrew`) with Skelcrew's own config, sent with each new session, and keep every trap in `docs/learnings.md`. The labels are tmux user options on the session. tmux keeps sessions alive, handles attach and detach, and answers the terminal's queries. Skelcrew never runs its own terminal emulator. The config binds Ctrl-\ to detach with no prefix, also in copy mode, where an agent you scrolled back is. It is herdr's key to detach, so an agent is left the same way on either host. Ctrl-4 sends the same key in most terminals, for a keyboard layout where backslash needs AltGr. It hides the status bar, so attaching feels like being inside the harness. tmux reads the key however your terminal sends it: as one byte, as an extended key in the kitty or the xterm form, and in pieces over a slow link. A runtime plugin's host keeps its own key to detach. Only this module runs tmux for agents, and a test fails if anything else does.

Your `session:` setting picks the host for new sessions. Each thread remembers the host it started on, and an agent already running stays there until it ends. A resumed agent, such as after `sc stop` and `sc start`, starts on the current host with its conversation, since the conversation belongs to the harness. If a thread's host plugin is gone when the engine starts, the thread needs you, with the mark `run sc install: its session host herdr is missing`, rather than being moved silently.

### Transport

| Function | What it does |
| --- | --- |
| `deliver` | Types a message into an agent once it is idle, never into a turn still running and never on top of a person's unsent draft. |
| `idle` | Says when an agent becomes idle, so a waiting message can go. |

The built-in transport works on any host's sessions, as it uses only `paste`, `keys` and `read`, with the busy and ready marks each harness module gives. It waits until the agent is idle and its screen is quiet, read a moment apart, with a line holding only the harness's bare prompt. It readies the text, reads once more for a person's draft, pastes it as a bracketed paste, and sends Enter on its own a moment later. No hook can see a draft, so this screen check stays whatever the state says, and a turn can start with no hook, such as when a background task ends.

Mid-turn, Claude Code's spinner and Codex's "Working" line show "esc to interrupt" and redraw every second as their timer counts. The agent's own text can hold those words too, such as a reply about Skelcrew's code, but it sits still. So while those words show, Skelcrew watches the screen a second and a half more, long enough to see the timer tick, before it takes them for the agent's own. An agent whose state is `working` gets no message until its turn ends, even right after a message went in.

A host that can do better provides its own. herdr does: `hc send --if idle` waits for a person's draft and types only when the agent is idle, and `hc events` says when it is.

### Messages

Every message Skelcrew types into an agent goes through this module, on whichever transport is active. It holds the queue and the rules:

- **Who may send what to whom.** The lead may tell any thread of its own repository. A builder may tell only its repository's lead, since its socket says which task it is. Skelcrew itself sends event messages to a builder: a review's changes, a failed check, a person's comment, a merge conflict. It sends notes to the lead: a thread that needs you, a task started from a label, a task's end. A reviewer sends nothing. A lead may brief another repository's lead in Skelcrew, but never its own repository's, with `sc tell lead <repo>`. A builder can't. The brief goes in as a note to that lead, so it shows in both leads' chats, and a lead whose tab you closed by exiting it is brought back first. A lead that can't start yet, such as while its clone is missing, is tried again every minute while the brief waits, and the sending lead is told why, once. A lead already running when its Skelcrew learned of briefs is told these rules once, in a note, as it keeps the instructions it started with. A repository not in Skelcrew is refused, with the `sc repo add` that adds it. When you asked for the work the brief hands over, the sending lead gives your words exactly, with `--asked-file`, as for a merge when ready. They go in an `<asked>` element of their own, before the brief's `<brief>` element, each holding its text exactly, and the outer tag says `asked="yes"`, which only Skelcrew can write. Text that holds a `skelcrew`, `asked` or `brief` tag in any form, such as `</asked >`, which would close or fake a tag, or a control character, such as the end of a bracketed paste, which would end the paste and act as typing, has each `<` written as `&lt;`, each `&` as `&amp;` and each control character but a line break or tab as its code, such as `&#x1b;`, rather than anything removed. Its element says `escaped="yes"`, so the receiving lead reads back exactly what was written. Only such a brief lets the receiving lead start threads from it, and only for exactly what your words ask, never for more the brief proposes. Without it, the receiving lead reports the brief to you and asks. Anything else is refused.
- **The wrapping.** Every message from an agent is wrapped in a tag that says who it is from and the command to answer with: `<skelcrew from="lead" reply="sc tell lead">` into a builder, `<skelcrew from="app-12" reply="sc tell app-12">` into the lead, or `<skelcrew from="app:lead" reply="sc tell lead app">` into another repository's lead, then the text on its own lines, then `</skelcrew>`. Skelcrew removes any skelcrew tag from the text, and a brief's `<asked>` and `<brief>` tags, with spaces or in any case, such as `</skelcrew >`, so a message can't end its tag early, and an agent's message never passes for yours or for your words in a brief. Every other note typed into a lead can quote outside text, such as an issue's title, which must never pass for an agent's message or a brief, and the lead still sees all of it: there the `<` that starts any of these tags is written as `&lt;`. Skelcrew does so as each note is typed in, so a note saved before an upgrade is no exception. Only notes Skelcrew writes itself, with no outside text, keep tags they name, such as a note telling a lead how to read a brief. A lead's brief is escaped instead, as **Who may send what to whom** says. Each control character but a line break or tab, in any message from an agent and in every note typed into a lead, is written as its code, such as `&#x1b;`, so nothing can end the paste early and type the rest as if you had.
- **Order.** Each agent has one queue, first in, first out, kept in the database, so a stop or a restart of the engine loses nothing and reorders nothing. `sc ps` counts what waits.
- **Waiting until idle.** A message waits until the transport says the agent is idle. A message to a thread that isn't running, or that is asking you a question, is refused, not kept, since typing would answer the question for you. A builder that stopped without submitting can be told, and the message clears its `turn ended`. A note to a lead that hasn't started waits until it starts. When a working or waiting builder isn't running while messages wait for it, the lead hears of it after a few seconds, as nothing else would bring it back, and can bring it back with `sc stop` and `sc start`.
- **The lead's chat.** The lead's chat is yours too, so its notes and messages wait while you read or type there. Nothing goes into the lead while you have scrolled back in it, as a paste would throw you back to the bottom, nor while you have unsent text at its prompt. A lead you left scrolled back, such as for a builder, waits until you come back to it and leave the scroll. Once the lead can take them, everything that waited goes in as one message, a blank line apart, so the chat moves once. A thread that needs you, such as for a builder's question, comes first, then a thread that failed and the builders' messages, then Skelcrew's other notes. What would be said is looked at again right before the paste, so a question you answered meanwhile isn't announced, and a note that came meanwhile goes in with the rest.
- **No acknowledgements.** A builder answers the lead only with a result, a question or a disagreement, never just to confirm a message, such as "noted, nothing to do". A message that needs nothing from it gets no reply.
- **Questions mid-delivery.** A question asked while a message is about to go in stops it, and it goes in once the question is over. Asked after its paste, before its Enter, the message is left at the prompt unsent, and once the question is over Skelcrew presses only Enter, so it is never pasted twice. Skelcrew saves that it left it there, so it knows that draft for its own after a restart.
- **Never waiting silently.** When `sc tell` can't go in right away, it says why, such as `app-12's builder can't take it yet: it is mid-turn (it shows esc to interrupt)`, or that earlier messages wait ahead of it. A message from the lead still waiting after 10 minutes brings the lead one note naming the thread and why. When the builder is mid-turn, the note says you can press Esc in it to have the message sooner, and otherwise doesn't suggest it.
- **Dropping stale event messages.** A new round drops Skelcrew's own waiting notices about the older commit, such as a failed check or a merge conflict, and a conflict still there is told again. A notice still being prepared when the round starts is never saved. People's reviews and comments go in messages of their own, apart from Skelcrew's notices, and are never dropped. Neither are messages from the lead. A task that ends drops what waits for it.
- **Task updates.** A message from the lead, once typed in, is kept on the task as an update, with who sent it and when, which the reviewer gets after the description. Every message from the lead counts, so the lead has nothing to remember.

Messages stay in Skelcrew, never on GitHub, and each one goes in the task's log. They stay in core on every host, as Skelcrew's rules and its safety must be the same whichever host runs the agents. A transport only carries text this module already decided to send.

### Sandbox

The sandbox stays in core on every host, drawn by the harness module. A host runs the sandboxed command exactly as Skelcrew gives it, and never changes what the agent can reach.

- **bubblewrap on Linux, `sandbox-exec` on a Mac**, drawing the same boundary: the agent's folder writable, the rest of the system read-only, the home folder and credentials hidden.
- **Claude Code.** Each session gets its own config folder in `~/.local/share/skelcrew/claude/`, where its transcripts stay for `claude --resume`, and logs in with the token from `sc install`. Your `~/.claude` stays hidden. Its own permission prompts and sandbox are turned off, since Skelcrew's draws the boundary. Inherited `CLAUDE_CODE_*` variables are removed. The folder is marked as trusted in the session's copy of its settings, or it waits at a question nobody sees. The first message goes on the command line.
- **Codex.** It gets Skelcrew's `CODEX_HOME` and runs with its own sandbox and approvals turned off. A Codex lead or builder gets a folder of its own for its conversation, and shares the login.
- **The lead** works in its own folder in `~/.local/share/skelcrew/leads/<owner>/<repo>/`. It reads Skelcrew's clone of every repository Skelcrew has, its own included, read-only at `~/.local/share/skelcrew/repos/<owner>/<repo>/`, kept current by the engine's polls. A repository added later shows up in a running lead. It never sees another repository's tasks or conversation. Builders and reviewers see only their own task's clone.
- **The reviewer** sees the task's clone through a throwaway layer, so it can run tests but changes nothing.
- **Priority.** Builders, reviewers and setup commands run at a lower CPU priority than the leads and the engine, so your typing stays quick while their tests pile up.

### Status

Skelcrew keeps each agent's state on its thread: `working`, `idle`, `asking` or `error`. With the thread's needs you and its task's stage, that gives the status a host shows: working, idle, needs you, ready or error.

The state comes from the harness's hooks wherever a hook fires. The lead gets the same hooks as builders, but a lead's hooks only keep its state: they never flag needs you or bring a note.

| Happens | Claude Code | Codex |
| --- | --- | --- |
| A message goes in | `UserPromptSubmit`: `working` | `UserPromptSubmit`: `working` |
| A turn ends normally | `Stop`: `idle` | `Stop`: `idle` |
| A turn ends on an error | `StopFailure`: `error` | No hook |
| The agent asks a question | `PreToolUse` on `AskUserQuestion`: `asking`, and `PostToolUse` makes it `working` again | No question tool: the agent asks the lead with `sc tell lead`, or ends its turn with the question, so `Stop` marks it `idle` and its last message goes to the lead |
| You press Esc | No hook | `Interrupt`: `idle` |

The `Stop` hook also tells Skelcrew the commit the builder's clone has checked out, and its last message when nothing in the clone is uncommitted.

Two gaps have no hook: Esc on Claude Code, and an error on Codex, which prints it and sits at its prompt. For these, every two seconds Skelcrew reads the screen of each agent that is `working`, with the sessions' `read`, so this works on every host. One whose busy mark, "esc to interrupt", is gone at two looks in a row, or sits still at a bare prompt, becomes `idle`. Neither gap flags needs you.

Skelcrew reports the status to the host when the host can show it. A plugin that provides status implements one function:

| Function | What it does |
| --- | --- |
| `status` | Receives a session's ID, its status word (`working`, `idle`, `needs you`, `ready` or `error`) and a short reason, such as `question` or `round limit`, each time the status changes, and shows it on the host. |

The engine calls `status` for every change, from wherever it came: a hook, the screen check, CI going green, or a review. herdr hears status as OSC 7501, an escape code written by the program running in the pane, which the engine, outside the pane, can't write. So `skelcrew-herdr`'s `start` runs the sandboxed command under a small relay of its own, which passes the agent's terminal through untouched and writes OSC 7501 into it when `status` hands it a new status. The relay runs outside the sandbox, as the plugin does, and the sandboxed command inside it is exactly the one Skelcrew gave. tmux shows no status, and Skelcrew's list shows it instead. A host's own view never replaces the hooks: needs you always comes from Skelcrew.

## The list

Two ways to see a repository exist side by side, until you choose which one stays: the split screen and the list. Plain `sc` opens the split screen: a sidebar of the repository's tasks and a tab for each repository, with the lead beside them, on a tmux server of the screen's own. Picking a thread in the sidebar shows its builder beside it. On the screen, Alt-Q leaves, and Ctrl-\ does nothing. `sc attach` attaches full screen to a builder instead, with no sidebar, as the list's Enter does. On tmux, Ctrl-\ detaches back to your shell. A runtime plugin's host keeps its own key to detach. The sidebar's entries count what waits on you. `Threads` says how many threads need you, in yellow: a mark from the lead, you or the safety net, a question, a harness error, or the round limit, such as `1 needs you · 6`. `PRs` says how many are approved and green, in green, such as `1 ready · 5`. An approved thread is ready, not needing you, so it counts only on `PRs`. A repository with no forge has no `PRs`, so `Threads` says how many branches are ready itself, in green, before how many need you: `1 ready · 2 need you · 6`. The tabs' badges count the same way as the list's. `sc --list` shows the list instead. The rest of this section describes the list.

`sc --list` shows a list, with a details pane beside it for the row you are on. You pick a row, and Skelcrew either attaches you full screen to an agent or does what the row offers. Detaching, with Ctrl-\, brings you back to the list, on the same row. While you are attached on tmux, the terminal's title names the agent and the key back, such as `app-24 · ctrl+\ back`, and the title you had comes back with you. Nothing else of Skelcrew's shows over the agent. On a row Enter attaches on tmux, the bottom line says so before you go, as `⏎ open · ctrl+\ back`. A runtime plugin's host has its own key to come back, and its rows say only `⏎ open`. There is no sidebar, and no tmux server of the screen's own.

```
 Skelcrew v0.6.0  [ app ]  [ docs ]  [ site •1 ]

   ● lead    claude                                       │ Rate limit the API
     asks you                                             │ issue #42  github.com/acme/app/issues/42
     asks: start a task on #31 "Export as CSV"?   y/n     │ PR #43     github.com/acme/app/pull/43
                                                          │
 1 Backlog   2                                            │ Building · question
 2 Building  3 · 1 needs you                              │ CI running: test ✓  lint ●  build ●
 ▸ ● app-t103  Rate limit the API                         │ Round 2 · changes asked
     question · #43 · CI running · 14:02                  │   - The limit resets per process, not per user
   ○ app-24  Login redirect                               │
     working · Editing rows.ts · #40 · CI passed · 14:31  │ Add a limit per user to the public API, so one
                                                          │ client can't starve the others. …
 3 Reviewing 1                                            │
 4 Checks    0                                            │ 13:40 submitted · 13:52 reviewed · 14:02 submitted
 5 Ready     1                                            │
 6 Done      4                                            │

 ↑↓ move  ⏎ open  1-6 stages  y/n answer  ⇥/alt+shift+←→ repository  q quit   cpu 63%  mem 9/32G
```

The list is one repository's, picked as **Opening a repository** says. The top line has Skelcrew's version, with the host you gave `--remote` after it on a server, then a tab for each repository, together on the left. The open one is highlighted. Each other one has a badge: a dot and how many of its tasks need you, in yellow, or red when one of them went wrong, then a dot and how many are ready to merge, in green. Each shows only when there are any, and both when both apply, such as `site •2 •1`. An approved task is ready, not needing you, so it counts only in green. Tab or Alt-Shift-Right moves to the next one, Shift-Tab or Alt-Shift-Left to the previous one, each wrapping round, and a click on a tab opens it. The list asks your terminal to report the mouse only while it shows, so an agent you attach to and your shell after you quit get the mouse as usual.

The repository's lead comes first, under the top line, always shown. Its row looks like a task's, so it reads as a row you open: its mark, `lead` and its harness, then under them what it is doing. Requests from the lead that wait for your yes, such as starting a task or adding a repository, show under it, one per line, newest first. Then come the repository's tasks, never its threads on their own, in six stages, in this order:

- **Backlog**: not started yet. The tracker's open issues Skelcrew knows of that no thread works on, the tasks in Skelcrew's backlog, and tasks queued for a builder under `limits.threads`. The newest 10, then a row such as `… 24 more`, which Enter opens to show them all until you leave the list.
- **Building**: a builder is working on it, including after the reviewer asked for changes. A thread that failed or stopped is here too, as its builder is what must start again.
- **Reviewing**: a review is running, or queued for a place under `limits.reviews` or for its harness's usage limit. A review that failed or timed out is here too.
- **Checks**: Skelcrew's reviewer approved, and the task waits on CI for that commit.
- **Ready**: approved and green, ready for you to merge, which includes a merge when ready about to merge it.
- **Done**: merged or closed. Those that ended today, or the last 10 when fewer ended today.

Each task is in exactly one stage, decided from its state alone. Needs you is never a stage: a task that needs you stays in the stage of its work, and its row is marked, whatever its stage. Within a stage, those that need you come first, and each of the two has the task that changed last first. Backlog has the newest issue first.

Each stage's heading has the number key that opens and closes it, its name, how many tasks it has, lined up with the other headings' counts, and how many of them need you, such as `Building 4 · 2 need you`. Being approved and green doesn't count as needing you, so a task under Ready counts there only when something else blocks it on you, such as a question. Every heading's count always shows, so a closed stage still says what waits in it. An open stage's heading sits right above its rows and scrolls with them, so a heading with no rows under it is closed. When the stages don't fit, the lead stays and the stages scroll, keeping the row you are on in view. The first and last lines of the stages then say what is hidden past them, such as `↓ 5 more in Building`, with each heading hidden there pinned in short, such as `Checks 2`. On a terminal too narrow for that, the edge says it in fewer letters, then by number keys, such as `↓ 4:2`, so no count is cut off. The stages never end on an open heading whose rows are below them: it is pinned at the edge instead. Opening a stage moves you to its first row, so its heading and first rows show. Only Building is open when the list starts. The stages you open or close stay so until you leave the list, whichever repository you move to.

A task in Building, Reviewing, Checks or Ready takes two lines, so what it does sits under its title. The first has its mark, its name and its short title, or its title cut with `…` to fit. The second has its word in its colour, then dim the step its builder is on, its PR, its CI and when it last changed, such as `working · Editing rows.ts · #40 · CI passed · 14:31`, with `14:31` today or `12 Nov` before. The step shows only when its harness gives one in words, such as a command's description, never the command itself. A task in Backlog or Done takes one line, in columns from the left: its mark, its name, its title, then when it last changed. Each column is as wide as the widest value showing, so the rows line up. The row you are on is highlighted on all its lines. Details such as a merge when ready or messages waiting are for `sc show`. When a thread needs you, its mark is yellow and its word says why, such as `question`. Its word says what is happening:

| Word | Means |
| --- | --- |
| `working` | The builder is working |
| `queued` | The task waits for a builder under `limits.threads` |
| `queued for review` | A review waits for a place under `limits.reviews` |
| `reviewing` | A review is under way, or waits for CI's first check |
| `checks` | Approved, and waiting on CI for that commit |
| `waiting` | The builder waits, with no review under way, no approval and no changes asked for |
| `changes` | The reviewer asked for changes, and the builder hasn't picked them up yet |
| `limit · 13:59` | The builder or the review waits for its harness's usage limit to reset |
| `approved` | Ready to merge. With a merge armed it merges by itself, so its mark is hollow and it doesn't count as ready |
| `question` | The builder asked with its harness's question tool |
| `turn ended` | The builder ended its turn without submitting, and its last message went to the lead |
| `error` | The builder's harness stopped on an error |
| `round limit` | Review hit its round limit. It needs you until you or the lead decide, as **Needs you** says |
| the action, such as `apply the check.yml split in PR #463` | The lead, you or the safety net marked the thread as needing you, with what you must do. It shows on a queued, failed or stopped thread too, and only a question or an error comes before it |
| `review failed`, `review timed out` | The review couldn't run, or ran past its time limit twice. The lead can run it again, so it doesn't need you |
| `failed`, `stopped` | As the thread's status says. Neither needs you: the lead hears why a thread failed and can start it again |

The marks: a filled `●` needs you or is ready, a hollow `○` doesn't. Green is ready, yellow wants you, red is wrong (its harness errored, filled, or the thread or its review failed, hollow, as the lead can start or run it again), bright is working and dim waits. The word always says what is happening, so nothing is told by colour alone. Text from the tracker has its control codes removed before it reaches your terminal.

| Key | On | What it does |
| --- | --- | --- |
| ↑ ↓ | Anywhere | Move one row |
| `1` to `6` | Anywhere | Open or close Backlog, Building, Reviewing, Checks, Ready or Done |
| Enter | The lead | Attaches full screen to the lead |
| Enter | Backlog | Asks `Start app-31? y/n` in the bottom line, then starts the task, as `sc start` does |
| `s` | Backlog | The same as Enter there: asks, then starts the issue or the task of the backlog |
| Enter | Building, Reviewing, Checks | Attaches full screen to the task's builder, through its session host. Detaching returns to the list, on the same row |
| Enter | Ready, Done | Opens the PR in your browser, or copies its link, as OSC 52, when Skelcrew runs on a server. Without a forge the bottom line shows the approved branch, such as `app-t103 is ready on branch skelcrew/t103-fix-login`. A ready task whose builder needs you attaches to the builder instead, so one Enter reaches what it waits on |
| `m` | Ready | Asks `Merge app#41 into main? y/n`, then merges it on the forge. Not offered without a forge, where the line says so, nor while its builder needs you. If the forge refuses, the line says why |
| `y` `n` | A request from the lead | Answers it |
| Click | A task | Moves to it. A second click on it, or a double click, does what Enter does |
| Click | The lead | Attaches full screen to the lead |
| Click | A heading | Opens or closes its stage |
| Wheel | Anywhere | Moves one row up or down, which scrolls the list |
| Tab, Alt-Shift-Right | Anywhere | The next repository, after the last the first |
| Shift-Tab, Alt-Shift-Left | Anywhere | The previous repository, before the first the last |
| Click | A repository's tab | Opens that repository |
| `q` | Anywhere | Leaves the list. Everything keeps running. Skelcrew prints `Your agents keep running. Run sc --list to come back.` |
| Ctrl-\ | Anywhere | Nothing: it comes back from an agent, so pressing it once too often never leaves the list |

The engine does what the keys ask, as only it talks to the tracker and forge. Merging and starting stay yours: the lead can't press these keys, and the merge confirm says when the PR changes `.agents/`.

The list reads only Skelcrew's database and its copy of the tracker, so it opens at once and never asks GitHub itself. It writes to the terminal only when what it shows changes, so a list sitting open sends almost nothing over a slow link. The machine's load is the exception: the bottom line ends with it, such as `cpu 63%  mem 9/32G`, refreshed every 5 seconds, for the machine the engine runs on. CPU is the busy share of all cores over the last 5 seconds, and memory the system can free counts as free. Each figure is dim, turns yellow from 80% and red from 95%, and gives way before any key on a narrow terminal.

**The details pane.** Beside the list, on its right, a pane shows the row you are on, and follows it as you move. It shows, from the top: the task's full title, the issue's link and the PR's link, its stage and word, its CI with each check, its review round with the verdict and the latest review's findings in short, its description folded after a few lines, and its recent events, such as submitted, reviewed and merged. It is what `sc show` gives, read from Skelcrew's copy and database alone, so it never asks the forge, not even for the logs of failed checks. On a row that isn't a task, such as the lead's, the pane is empty. The pane shows only while the terminal is wide enough for the list and the pane side by side. In a narrower terminal it is hidden, and the list is as it would be without it. The keys do the same with the pane as without it.

**A lead you exit.** Exiting a repository's lead, such as with `/exit` or Ctrl-D, ends only the lead. The repository, its clone and its tasks stay, and the engine keeps polling. The engine notices the exit and doesn't bring that lead back at its start. Opening the repository again, by `sc` in a checkout of it or `sc attach lead`, starts the lead again with its conversation. A lead that crashes is brought back with its conversation when you look at it.

With herdr as the session host, its own apps show the same agents, labelled and with their state. Skelcrew's list keeps working beside them, and is the only place that merges and answers the lead's requests.

## Remote machines

The engine runs on the same machine as its agents. So `--remote` is only "run `sc` on that machine", over plain `ssh -t`. Everything must work over it: no local display, no browser on the same machine, no clipboard. Logins that need a browser use a code and a link you open on your laptop.

- `sc --remote <host> install` sets the server up. Your personal setup is one setup for all your machines, so a server feels like your laptop. It sends your personal files first: `config.yaml`, your lock file and the agents' Claude Code token. `session:` goes with them, so herdr on the laptop means herdr on the server. A runtime plugin that provides only `machine` is skipped there, as it is used where you run `--remote`. Then it runs `sc install` there. Each plugin's setup and `codex login` run there once, in your terminal, since a sign-in that renews itself cancels the one before, and two machines sharing it would break each other. On a server with no Skelcrew, it asks, then puts Skelcrew there first: the laptop's release, built for that machine and checked against its checksums, or one built from your checkout when you run Skelcrew from one.
- `sc --remote <host> up --bg` runs the engine there as its background service.
- `sc --remote <host> <command>` runs `ssh -t <host> sc --from <owner/repo> <command>`, passing the repository you are in on the laptop, so it acts on that repository there. With no command, it opens the server's split screen, and with `--list` its list, where Enter attaches through tmux there.

You send your setup when you change it, as you would run `npm install` after changing `package.json`. A `sc --remote` whose personal lock differs from the server's says so, and names the `install` that fixes it. What runs stays on the machine that runs it: tasks, their clones, the engine and its state. Nothing comes back to the laptop.

`--remote` never sets a machine up without asking. On a machine where Skelcrew is missing or not set up, it asks `simon@workbox isn't set up. Set it up now? [Y/n]`. Yes runs `sc --remote <host> install`, then goes on. No stops, and prints the command to run later. Without a terminal it only prints the command. An SSH host that doesn't exist fails to connect before anything is asked.

`--remote` also keeps Skelcrew there in step with the laptop. The Skelcrew on a server carries the commit it was built from, and each command passes along the laptop's. When they differ, or either has changes not committed, Skelcrew asks before running the command: "Skelcrew on simon@workbox is from abc1234, yours is def5678. Update it?" Yes replaces it and restarts the engine, and agents keep running. No runs the command on the old Skelcrew. A Skelcrew run from a checkout there is never offered an update: `git pull` there updates it. One SSH connection is shared across commands.

Skelcrew keeps everything in your home folder on a server, and runs its engine as a service of your own user. So several people can each run their own Skelcrew on one server, each as their own user.

Seeing and talking to agents from elsewhere is the session host's job. With herdr, herdr's own machines (`hc machine add`) bring the server's terminals to your laptop, desktop and phone, with no `--remote` involved, and merging stays in Skelcrew's list.

## State

One SQLite file per machine, `~/.local/share/skelcrew/skelcrew.db`, with `bun:sqlite`. It holds:

- **repositories**: the name, owner and name on the forge or remote, its lead's session, when you last opened it, whether you exited its lead;
- **tasks**: the repository, name, title, description, short title, flow, stage, the lead's updates, the issue and whether Skelcrew assigned you, the PR, CI, round count, review state and when the latest review was asked for or ended, the last handled ID per event kind, and its place in the queue of `limits.threads`, and its armed merge, when ready or over the review: the plan's own ID, who armed it and when, your exact words when the lead armed it, the commit pinned for a merge skipping the review, what it waits on, the round the lead last heard it still waits after, and each approved commit the record was posted on;
- **threads**: the task, role, harness, model, session host and session ID, state, status, needs you and its mark, branch, when it started and when it last changed;
- **the copy** of each tracker's open issues and each forge's open PRs;
- **messages** waiting for each agent, with whether one was left at the prompt unsent;
- **queues and holds**: the queue of reviews with each one's place and the time it first joined, reviews held on a usage limit with the reset time, and the queue of tasks under `limits.threads`. The queue of check slots is the one kept only in the engine's memory, as **Check slots** says.

Every other armed or queued state is in the database, so the engine's restart and a database migration keep it: an armed merge stays armed with its record, a queued review or task keeps its place, and a held review still waits for its reset.

Every change is also appended to `~/.local/share/skelcrew/threads/<repo>-<task>.log` as one JSON line, so a task's history can be read and replayed, including each review's round, reviewer, verdict and first line. Repository clones live in `~/.local/share/skelcrew/repos/` and task clones in `~/.local/share/skelcrew/threads/`, on one disk, so a task's clone shares its files with the repository's.

A database from an earlier release is moved forward once, when the new engine starts, after saving a copy beside it. An engine refuses to start while another one runs, so a move never happens under one still writing the old way.

**Tokens stay out.** Agents never see a GitHub token, or any plugin's. They don't push or call GitHub. They call `sc` commands, and the engine and its plugins, outside the sandbox, push and post as Skelcrew's GitHub App, or push with your own git login when a repository has no forge. Commits are authored by `skelcrew[bot]`, with you as co-author.

**One seam for harnesses.** Each harness lives in one module: how it starts, resumes and logs in, where its config folder is, what its screen shows when it is busy or ready, how it reports its hooks, and how it draws the sandbox. A small lookup finds it by the name your config uses. The flow never names a harness, so another one, such as opencode or pi, is one more module.

## Not in this version

- Reviewing pull requests Skelcrew didn't open
- Richer flows: custom stages, several reviewers, skipping stages, and picking a flow by label or rule. They come once real use shows what is needed
- Reviewers as threads, which would remember earlier rounds at the cost of the fresh view
- More than one PR per task, such as one per repository
- Harnesses other than Claude Code and Codex
- Windows
- Per-task environments such as a database each (the `setup` commands only)
- Agents talking to each other, beyond the lead and a builder telling each other, and a host's own messaging carrying them
- Triggers, schedules or automations
- Linear, Jira, forges other than GitHub, and a chat plugin such as Slack
- A sandbox for plugins, plugins from anywhere but a git repository or a folder of yours, and a list of plugins to browse
- Plugin settings in `skelcrew.yaml`, such as who may message the lead, since anyone who can push could add themselves
- Machine plugins, with Sprites as the first. A Sprite sleeps when idle and has no systemd, so it will also need ways into the sandbox, the engine's service and wake-ups from GitHub
- A filter for which open issues show as tasks, for a repository with hundreds
- Showing a task's stage on its issue, such as a label
- Starting a task by assigning an issue or mentioning Skelcrew on GitHub
- A remote protocol of our own (SSH only), teams and permissions
- Projects: a named context above repositories, with one lead across several of them, its own memory beyond `AGENTS.md`, and tasks across repositories
- A command of Skelcrew's own to stop the background engine: systemd or launchd's own commands do it

If something seems missing, ask instead of adding it.
