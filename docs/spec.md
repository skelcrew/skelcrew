# Skelcrew spec

Nov 21, 2026 · @Simon · the design of Skelcrew v6.

This spec says what Skelcrew is and what it guarantees. It should rarely need to change. How each part works today, down to keys, wording and output, is in the detail docs, which builders keep true to the code: [the screen](screen.md), [commands](commands.md), [the flow in detail](flow.md), [files and settings](files.md), and [plugins and base modules](runtime.md). Where a detail doc and this spec differ, this spec wins.

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
| Repository | A git repository Skelcrew works on, from a clone of its own, with a lead of its own. It is named by its name on its forge, such as `app`, or without a forge by its remote's path, with the owner added (`simon/app`) only when two share a name. |
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
| Needs you | A flag on a thread: you must act to unblock it, and its word says what to do. The lead sets it when only you can unblock the thread, and Skelcrew sets it for what it sees itself, such as a question asked in the builder's session, a harness error or the round limit. A task in `ready for review` waits on you too, by its stage. |
| Skill | Knowledge an agent loads when it needs it, as a folder with a `SKILL.md`. A folder in `.agents/skills/`. |
| Session host | What runs agents' sessions and lets you attach to them: tmux, or a runtime plugin that provides sessions, such as herdr. |
| Base module | One of the five parts that run agents: sessions, transport, messages, sandbox and status. Each has a built-in default, and a runtime plugin can provide some. |
| Plugin | A program in a repository of its own, of one of two kinds. An I/O plugin brings work in and sends results out, such as GitHub. A runtime plugin provides some of where and how agents run, such as herdr. |
| Lock file | `skelcrew.lock`: the exact version and commit of every plugin a repository uses. |

Tracker items are called issues everywhere: in commands, on the screen and in the lead's words. The word task means Skelcrew's own object only.

## Tasks and threads

### Tasks

A task is Skelcrew's own record of a piece of work, from the first words to the merge. It has a name, a title and a description, which the builder gets as its first message, a short title the lead gives it, a flow, a stage, the lead's updates, a link to the issue it came from and whether Skelcrew assigned you that issue, and a link to the PR it produced, with its CI state and Skelcrew's review state.

| Stage | When |
| --- | --- |
| `issue` | Not started: an open issue with no work running on it, or a task in the backlog. A task started with no issue never has this stage: it starts in `working`. |
| `working` | Agents are on it: the builder works, a review runs, CI runs, or a thread needs you. A task whose thread stopped or failed stays here, so it doesn't vanish, and so does a task queued for a builder. |
| `ready for review` | Skelcrew's reviewer approved the latest round and CI is green on that commit, as **The wait for checks** says. It waits for you to review and merge. Without a forge, the approved branch waits for you. |
| `merged` | The PR merged, or without a forge, the branch's changes reached the default branch. |
| `closed` | The work ended without a merge and there is no open issue behind it, or its issue closed while it was still in stage `issue`. |

`merged` is the end. `closed` is the end unless you start the task again. When the work on a task ends without a merge and its issue is still open, the task goes back to stage `issue`: the same task, with the same name, its earlier attempt kept in its log. Starting it again begins afresh, from the issue as it is then, in a fresh clone on a fresh branch, with no updates carried over. A task with no issue goes to `closed`, and starts again from its own title and description.

Needs you is a flag on a thread, never a stage.

### The backlog

Work you want done later, but not as an issue in the tracker, is filed in Skelcrew's backlog: a task with no issue and no thread, in stage `issue`. The lead parks work there, and creates an issue only when you explicitly ask for one. You can file one too.

The backlog is shared between machines through the repository's git remote, never through the tracker, and never as a branch or a file in the tree. It guarantees:

- a name is never claimed without its task, nor a task filed without its name;
- every machine shows the same backlog within a poll;
- two machines never both start the same task, and an engine that stops half way through a start never loses the task;
- a task removed before it started is gone from the remote too, while its name stays claimed, so it never names other work;
- once a task is removed, or its start is recorded, no ref on the remote holds its words.

A task of the backlog that starts keeps its words in its thread, and ends in `closed` like any task with no issue. How the refs and claims work is in [the flow in detail](flow.md#the-backlog).

### Names

A task has one name, used everywhere. It is the issue's ID with the repository's short name in front when the ID doesn't name a repository: GitHub issue #12 in app is `APP-12`, and Linear's `JOTT-12` stays `JOTT-12`. A task with no issue gets a `t` and a number of Skelcrew's, such as `APP-T103`, so it never clashes with an issue's name, and an issue whose ID has that shape is left out of Skelcrew's copy of the tracker.

- Two machines on one repository never take the same name, as Skelcrew claims each on the remote before using it. A name is never below one claimed before it. One narrow gap, for names from before claims existed, is in [the flow in detail](flow.md#names).
- A name never changes, so you can always tell which issue a task is.
- A name is typed in any case. Skelcrew shows it in uppercase wherever you read it, and stores and matches it in lowercase wherever it is kept, such as folders, branches and sessions, so a file system that ignores case never sees two spellings of one task.

A thread is addressed as its task and its role: `APP-12/builder`. Wherever a command takes a thread, the task's name alone means its active thread: the one that needs you, or else its builder.

### Threads

A thread is one agent on a task. It has its role, its harness and model, kept for the thread's life since a conversation can't move between harnesses, its session on a session host, its state (`working`, `idle`, `asking` or `error`, as **Status** says), its status (`working`, `waiting`, `failed`, `stopped` or `done`), its needs you reasons, and for a builder, the task's branch and clone, which the builder owns.

A task makes at most one PR, from its builder's branch. Work that needs two PRs is two tasks, and the lead says which comes first.

Reviewers are one-off runs: a fresh agent for each round, with no session and no thread. A review is recorded on the task.

### The tracker is a source and a mirror

You plan where you already do. An issue on GitHub shows up in Skelcrew with nothing to write, and the `skelcrew` label starts it. But tasks are Skelcrew's own, so a task can exist with no tracker at all, and Skelcrew's stages stay the same whichever tracker a repository uses.

As a **source**, the tracker gives Skelcrew issues. Every open issue in Skelcrew's copy of the tracker shows as a task in stage `issue`. A task that starts is stored from the issue as it is at that moment. Later edits to the issue don't reach a started task: the lead passes on what matters as an update.

As a **mirror**, Skelcrew shows the task's progress in the tracker through the tracker's own signals, never comments. It claims the issue, assigns it to you, and puts the line that closes it in the PR. A merged PR closes the issue. Closing an issue by hand ends nothing: a task already working carries on until its PR merges or closes, or you remove it, since an issue closed as a duplicate or by mistake must not kill a builder mid-work. A task still in stage `issue` whose issue closes leaves the list. A task with no issue mirrors nothing.

## Files

A repository describes how its agents work in files. Skelcrew ships the same files inside itself as its defaults, so a repository with none of them works exactly as one with the defaults written out. Every setting, its shape and its default is in [files and settings](files.md).

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

The repository's setup, shared with everyone who works on it. It never holds a secret. It names the repository's tracker, its `setup` and `test` commands, the plugins it needs, and `limits.threads`.

**Setup and test.** `setup` runs once in each builder's fresh clone. `test` is the whole test suite, which `sc check` runs. An empty list says on purpose that the repository needs none. Skelcrew never guesses them from the repository's files: a guess is often wrong, and agents would use it without anyone seeing it was a guess. They are settled once, with you. While either is missing, the lead's first proposal is a task that finishes the standard setup: it reads what the repository's CI and package files really run, proposes the missing commands to you, and on a yes fills in only those. For a repository you only drop into, it offers to put them in your own settings instead. Builders are told each command, or that it isn't configured. A builder that needs one that isn't configured never makes one up: it asks the lead, and waits.

**The tracker.** A repository's forge is found on its own: the plugin that claims its remote, if one does. Its tracker is its forge, when the forge can be one, unless `tracker:` names another. `tracker: none` makes the repository work from git alone. When `tracker:` names a plugin that isn't installed, the repository has no tracker, and Skelcrew says which plugin to install. It doesn't fall back to its forge, since its issues are planned elsewhere. A task keeps the issue it started on when the repository's tracker changes.

**`limits.threads`** is the most builders running at once in this repository, since that depends on the repository: each builder runs its tests, uses CI minutes and opens a PR its reviewers must read. A start over the limit is never refused: its task waits in a queue, first come first served unless you reorder it, in stage `working`. The queue survives a restart of the engine. A labelled issue is claimed as it joins the queue, so another machine doesn't start it meanwhile. Without the line there is no limit.

### `.agents/roles/`

One Markdown file per role, named after it: frontmatter with only an optional `harness` and `model`, then its instructions. `lead`, `builder` and `reviewer` always exist, from the built-in defaults when the repository has no file for them. A model name belongs to its harness, so a role on another harness than yours, with no `model`, gets that harness's default. Skelcrew keeps no list of model names.

### `.agents/flows/`

A flow is the stages a task goes through and their settings. Skelcrew ships one flow, `default`: build, review, CI and ready, with the builder and reviewer roles and a round limit of 3. Ready waits for green checks when the repository has a forge.

**A flow without a review** goes build, CI and ready, for changes too small to need a reviewer, such as docs or wording. Skelcrew ships none: a repository adds it. Its task is never shown as approved or reviewing, and everywhere says it is not reviewed. Skelcrew's check passes saying so, so branch protection lets it through, and nothing on the PR claims a review. It counts no rounds. A merge when ready waits only for CI, at the commit last submitted, and a merge skipping the review refuses.

**Picking a flow.** Every task gets `default` unless the repository has other flows. Then the lead picks one as it starts or proposes a task, and tells you which and why whenever it isn't `default`. A task started from the label gets `default`. The flow can change only until the builder first submits. A flow with no review is only for a change too small to need one, and the lead always tells you, as nobody will review it. The built-in lead's instructions say this, so it holds in every repository.

Your own confirmations are never flow settings: you always merge, you always add repositories, and you always say yes before a lead starts work or briefs another lead.

### `.agents/skills/`

A skill is a folder with a `SKILL.md`, in the format Claude Code reads. Skills come from the `.agents/` you approved and are copied into a folder of each session's own as it starts, so an agent that edits its copy changes only its own session, and a builder can never steer its own reviewer through its branch. A harness with no such folder gets them listed in its instructions. Skills in `.claude/skills/` reach Claude Code from the clone on their own.

### `skelcrew.lock`

The exact version and commit of every plugin `skelcrew.yaml` names. `sc add` and `sc update` write it, you commit it, and `sc install` installs exactly what it says on every machine, as `package-lock.json` does.

### Yours, never in a repository

What belongs to you or your machine stays in `~/.config/skelcrew/`: every login, token and plugin setting; the session host; your limits on reviews and test suites at once, which fit your machine; your default harness, model and round limit; the reviewer's fallback harness and time limit; how long a stopped builder waits before it needs you; per-repository overrides; what you declined; whether the lead may arm a merge when you ask, on by default; and your personal plugins, such as every runtime plugin, with a lock file of your own.

### Built-in defaults

Skelcrew ships its defaults as the same files, inside Skelcrew, read the same way as a repository's, with nothing special about them in the code. `sc init` writes them into a checkout as the standard setup, with the forge's plugin pinned and your harness and model for each role, leaving setup and test to the lead. It leaves existing files as they are, but for adding the forge's plugin, and never writes into an existing `.agents/`. It asks before committing and pushing to the default branch, commits only its own files, and shows the commands instead whenever that could take work of yours. Only you can run it.

### Which wins

Each setting comes from the first of these that sets it:

1. **Your per-repository overrides**, in your `config.yaml`. They are you, saying what you want for this repository on your machine.
2. **The repository's files**, from Skelcrew's clone of its default branch.
3. **Your general settings** in `config.yaml`.
4. **The built-in defaults.**

So the repository decides how its agents work, your general settings fill in what it leaves out, and an override is how you differ from your team on purpose. Settings merge key by key. A role's instructions are one value: a repository's `builder.md` replaces the built-in instructions whole.

Some settings exist only in your files: logins, tokens, the session host, your limits, the reviewer's fallback, the review time limit, whether the lead may merge, and personal plugins. A repository's files can't set them. Whether the lead may merge is in your general settings only, never an override nor a repository's files, so no repository can turn it on.

Settings in an older shape are still read. Where both shapes say something, the new one wins. `sc` says once which old key it read and what replaces it, and changes no file itself.

## Trust

Two kinds of thing could reach your machine through the files: plugins, which run as you, and a repository's own files, which steer agents. Each has its rule.

**Plugins run as you, outside the sandbox**, with no sandbox of their own, so they can read what you can. So Skelcrew never installs a plugin silently, unlike npm. For a plugin new to this machine, or whose version or commit changed, it says what the plugin is for, where it comes from, and that it runs as you outside the agents' sandbox, offers every detail of what it runs, and asks. A plugin already installed at its locked version asks nothing. Without a terminal, such as for the engine, nothing is installed and the repository needs you. So a repository's files can make Skelcrew ask you, never make it install. Agents can't install plugins.

**A repository's files steer agents, but can't grant anything.** They can't widen the sandbox: no file mounts a folder, passes an environment variable, or reaches a socket. They can't skip your confirmations, install anything without asking, or set what is yours.

**A repository's `.agents/` needs your OK, the first time and after each change**, as it decides what agents are told and how far they go. Skelcrew shows it and asks when a repository comes in, even one you can push to, as being able to push is not the same as having read what a teammate wrote. Until you approve, tasks run on the built-in roles and flows, or on the version you approved before, and the repository needs you. A task keeps the version it started with. Merging a PR that changes `.agents/` approves nothing, since an agent wrote it: the merge confirm says so, and the approval comes after. What you approved is remembered in your own settings, never in the repository. Files `sc init` writes are the built-in defaults, so they count as approved.

**Plugins aren't agents.** Agents never see a plugin's folders or tokens, which the sandbox hides. What a plugin brings in is outside text: its control codes are removed, and typed into the lead, it steers the lead. So each plugin decides who may reach the lead through it.

## Repositories

Skelcrew keeps its own clone of every repository it works on, at the latest default branch. A repository comes in only when you add it, in your own terminal, such as by opening it with `sc` in a checkout. The lead can't bring one in: it asks you to.

**Opening a repository.** The repository is the context, as the folder is for `claude` in a terminal. `sc` in a checkout opens that repository, matched by its remote even after a rename, adding it first if Skelcrew doesn't have it, so the first `sc` in any clone goes straight to work. Outside any repository, `sc` opens the one you opened last. In a repository with no remote, `sc` opens nothing, as opening another one would look as if Skelcrew had ignored where you are, and says what to do.

The folder only names the repository: agents never work in your checkout, and Skelcrew never sees changes you haven't pushed. The only files Skelcrew writes there are those of commands you run yourself to change them, such as `sc init` and `sc add`, and the only commit it makes there is the one `sc init` asks you about.

**The GitHub plugin.** `sc` in a checkout on GitHub, in a repository whose files name no forge plugin, offers the GitHub plugin, saying first why Skelcrew needs it, then asking as for any plugin. Yes makes GitHub the repository's tracker and forge, with nothing written into the repository. No is remembered for that repository in your own settings, so every checkout of it stays quiet.

**Trusting a repository.** Agents will run a repository's setup and test commands, and read its `AGENTS.md` and settings as instructions. So before cloning, Skelcrew trusts a repository on its own only when its forge says your login can push to it and it isn't a fork, and otherwise asks you. Only you can trust one, in your own terminal, since a yes passed on by the lead could come from an injected instruction. The answer is remembered in your own settings, never in the repository.

**A repository with no forge** must take Skelcrew's pushes on your own git login, so Skelcrew checks the engine can push before adding it, and otherwise shows what git said and what to fix.

**Each lead, its own repository.** A repository's lead works only in that repository: its clone, read-only, its tasks, and its issues and PRs. The engine knows which lead is calling from its socket. It can also read every other repository Skelcrew has, read-only. It starts the first time you open its repository, with an opening turn so you don't have to know to speak first, and from then on runs. When work belongs in another repository, it briefs that repository's lead itself, as **Messages** says. That lead starts work on a brief only when the brief carries your own words, and otherwise asks you.

**Issues in public repositories.** The lead asks you before filing an issue in a public repository's tracker, or one it can't tell is private. For a security hole, it asks each time whether to file it at all. Issues, PRs and commits say what to change, never how a hole could be used, and the builder gets the details from the lead.

## Commands

The command line follows npm: files describe what a repository needs, `sc install` makes the machine match, and `sc add`, `sc remove` and `sc update` change the files and the machine together. Each command, what it takes and what it prints is in [commands](commands.md).

Every command that lists or shows something takes `--json`. Commands that do something print one line or fail with a clear message and a non-zero exit. A command Skelcrew shows you to run reads as a step to take, and only a real error looks like one.

- **Yours only:** opening a repository, setting up the machine, its plugins and repositories, and running the engine, such as `sc`, `sc init`, `sc install`, `sc add`, `sc up` and `sc repo trust`.
- **Yours, and the lead's in its own repository:** seeing and steering tasks and threads, such as `sc ls`, `sc show`, `sc ps`, `sc start`, `sc task add`, `sc stop`, `sc rm`, `sc merge` and `sc needs-you`. Some need your words or your terminal, such as `sc merge`.
- **The agents':** `sc submit` for a builder's round, `sc tell lead` to ask its lead or brief another, `sc review` for a builder's own task, and `sc check`, which reviewers and you can run too.

Every command an agent can run answers quickly, as Claude Code moves a shell command to the background after 2 minutes.

**Check slots.** Many whole test suites at once overload the machine, so the whole suite runs only through `sc check`, as many at once as your limit allows, first come first served, saying where it is in line. A slot is freed when its check ends, however it ends, and nothing the suite starts can hold it. A suite never outlives its check, but for a process that detaches into a session of its own. A restarted engine forgets the slots, so a suite running across the restart may briefly overlap new ones. A reviewer's socket allows only `sc check`. Without `test:` it fails and says so, and with `test: []` it runs nothing.

### Installing

`sc install` makes the machine match the files, and is safe to run again:

1. It checks for the tools Skelcrew needs and every harness a role uses. If one is missing, it says exactly what to install before it asks anything.
2. On a machine with no harness picked, it picks one, asking only when both are installed, and then which harness reviews run on, offering the other one first, since a second model sees what the builder's misses.
3. It logs in each harness that has no login yet, with a login of Skelcrew's own, kept readable only by you, so your own login is never touched and a renewal on either side never breaks the other.
4. It installs each plugin the files name at its locked version, asking as **Trust** says. It refuses a plugin that needs a newer Skelcrew.
5. It runs each plugin's setup that hasn't run on this machine, in your terminal.
6. It starts the engine as the background service.

Each step is skipped when it is already done. A tool or login that goes missing later shows up where it is used. A plugin you are writing can be added from a folder, used where it is, and rebuilt by `sc update`. Skelcrew never deletes your folder.

## The engine

The engine is Skelcrew's daemon: one per machine, on the machine where its agents run. It runs in the foreground in a terminal, or as a background service of your user that keeps running after you log out and after a reboot. Plain `sc` and `sc attach` start it if it isn't running, and restart one that runs another release or commit. An engine run by hand is never replaced behind your back: `sc` asks you to stop it.

- Only one engine runs per machine. It never asks questions, since a service has no one to answer them: on a machine that isn't set up, it exits and says to run `sc install`.
- At its start, it reconnects to the lead of each repository you have opened and to every live thread. A session that is gone is brought back on its harness, with its conversation.
- It has one socket for the CLI, and one per agent, mounted into that agent's sandbox, so Skelcrew always knows which thread is calling.
- Sessions keep running when the engine stops, so agents keep working through a restart or an upgrade. What the engine itself started, such as a clone or a reviewer, ends with it, and the next engine starts that work again, and polling picks up any event it missed. Only `sc stop` and `sc rm` end a session.

**Updates.** A newer release installs in the background and says so on the screen. The next `sc` restarts the engine on it, and agents keep running through it. A Skelcrew run from a checkout does the same once the engine runs another commit of it. `sc --version` names the release, or the commit of a build from a checkout.

## The flow

One task, in the `default` flow, in a repository with GitHub as its tracker and forge. Each step's detail, with the notes and records Skelcrew writes, is in [the flow in detail](flow.md).

1. **A task is started**: by the `skelcrew` label on an issue, from anywhere, or by the lead once you say yes, on an issue, a task of the backlog, or a task with no issue. You can start one yourself too.
2. **Skelcrew sets up the builder**: a clone of its own, on a branch of its own, with the repository's setup run once in it.
3. **The builder starts**, in the sandbox, in that clone, with its role's instructions and the task as its first message.
4. **The builder finishes a round.** The whole test suite runs once per commit that changes code, in CI or in the reviewer, never in the builder, as many builders running it at once overload the machine. The builder runs the tests near its change, commits and runs `sc submit` with a summary, which becomes the PR's description. Skelcrew pushes the branch from its own clone, never running git in the task's folder, and on the first round opens the PR, which closes its issue.
5. **The reviewer reviews**, as **The review** says.
6. **Changes go back to the builder**, typed into its session. It fixes them and submits again: back to step 4.
7. **After the flow's round limit, the builder needs you.** Reviews stop reaching the builder until you say go on. A merge you arm, or clearing the thread, decides it too. An approval answers it.
8. **Approved and CI green: the task is `ready for review`.**
9. **You merge**, on GitHub, from the screen, or by arming a merge. Skelcrew ends the builder's session, removes the clone, marks the task `merged`, and tells the lead. A PR closed without merging ends it the same way, and the task goes back to `issue` or to `closed`.

### The review

Skelcrew sets its own check on the commit to pending and runs a fresh reviewer once, in the sandbox, on the reviewer role's harness. It is given the task's description, with the lead's updates after it, which override it where they differ. Nothing a builder writes counts: a builder must never change what it is reviewed against. The reviewer reads the diff against the base branch and answers in a fixed shape: approve or changes, a body, and its findings, one per problem. Changes name at least one finding, and an approval none. Any other answer is a review that failed: nothing reaches the PR and no round counts. Skelcrew sets its check to the verdict, so branch protection can require it.

**One review per PR**, from Skelcrew's GitHub App, kept up to date with the latest verdict, findings, round and commit, and posted again if deleted. A round that finds the same again adds nothing to the PR. The history stays in the task's log. A PR's author can't approve it on GitHub, so the check carries the verdict, and approving is yours.

**The queue.** Only as many reviews as your limit allows run at once. The rest wait, first come first served, through restarts. A newer submit cancels a review of an older commit, waiting or running.

**Failures** never need you: the lead hears of them, with the error the harness itself reported, and can run the review again or mark the thread if only you can fix it. A reviewer past its time limit is ended with all it started and runs once more, and a second time out fails the check.

**Usage limits.** A reviewer stopped by its harness's usage limit doesn't fail: the review is held, its check stays pending, and nobody needs you. No review starts on that harness until the limit resets, and the held ones then run in their place. With a fallback harness, reviews run there meanwhile. The lead hears once per limit.

**The reviewer and the tests.** The whole suite runs once per commit: in CI when the forge shows a CI check on that commit, or else in the reviewer through `sc check`. So while a CI check may still come, the review briefly waits for one, holding no place in the queue, and a repository whose reviews waited in vain stops waiting until CI shows. With CI, the reviewer reads CI's results, kept current while it runs, and names failing tests as problems, and runs the suite itself when no check runs the tests. CI still running is never a reason to ask for changes, as ready waits on every check. A change to docs and Markdown alone is tested by no one.

**The wait for checks.** A PR is ready, and an armed merge may merge it, only once the wait for CI's first check on the approved commit has ended and every check on that commit passed. A wait that ends with no CI check leaves Skelcrew's own as the only one, and the commit shows as having no CI rather than as passed. A check that shows later still counts. A required check is the forge's to enforce. A restart starts the wait again, so no PR waits forever.

**Keeping an approval.** When main moves, the builder of an approved PR merges main and submits again. That keeps the approval, with no reviewer run, only when every commit since is exactly git's own clean merge of the base branch, the PR's diff reads the same, and every CI check on the new commit then passed. Anything else gets a normal review, and so does `sc review`.

### Merge when ready

You can say once that a PR should merge when it is ready, and leave.

- **Only an explicit yes.** At your terminal Skelcrew names the PR and task and asks, and only `y` arms it, for that PR only. Without a terminal it refuses. A merge already armed isn't asked about again, so no answer seems to cancel it.
- **Only you, or the lead when you ask it.** Builders and reviewers never can. The lead may when you explicitly ask it in the conversation, never because an issue, PR, comment, builder or note says so. It hands over your exact words, never through a shell, and the plan and the logs keep them exactly. This is on by default, and only your general settings turn it off.
- **Only what was approved merges**: the commit Skelcrew's reviewer approved, while it is still the PR's head, its wait for checks ended, every check passed, and it merges cleanly. A push Skelcrew never reviewed is never merged.
- **A record, once.** Just before it first asks the forge to merge, Skelcrew posts on the PR who asked and when, once per plan and commit, even across restarts. The merge waits for a later poll, so a change that came meanwhile still stops it.
- **It stays armed** through restarts, conflicts, failing checks or a refusal, until it merges, you cancel it, or the task ends. The lead hears once per round when it is stuck on something someone must act on. Cancelling is always allowed and asks nothing.

Without a forge it refuses and says to merge the branch yourself.

### Merge skipping the review

A review can keep asking for changes you don't need, often past the round limit. You can merge such a PR from Skelcrew without its reviewer's approval. It works only on a PR whose review asks for changes or still runs: one already approved merges as usual, and one never reviewed waits for its review. The question names each of the review's open findings, so you see what you skip.

Your yes pins the PR's head as you saw it. Only that commit merges, and a push after it cancels the plan, as nobody you trust saw that commit, and the lead hears of it. A review still running is waited for, so its findings are known before the merge. Only the reviewer's approval is skipped: every other check on the pinned commit must pass, and the PR must merge cleanly. The rest is as a merge when ready: who may arm it, the record on the PR, which says plainly that it merged without approval and never contradicts the reviewer's verdict, and restarts.

Once merged, the review's open findings are filed as one follow-up issue naming the PR, so they aren't lost, filed once and never twice across a restart. When no issue can be filed, the lead's note says so, so you can file it.

### Without an issue, without a forge

**Without an issue.** You tell the lead what to do, and it starts a task written from what you said, with no issue, in any repository. Its PR closes no issue. In a repository with no tracker, this is how every task starts.

**Without a forge.** Skelcrew pushes the builder's branch to the repository's remote with git, on your own git login. It opens no PR and sets no check. The reviewer reviews the branch's diff against the default branch, and the loop runs the same. Once approved, the task is `ready for review`, and you open a PR or merge it yourself. The task is `merged` once merging the branch into the default branch would change nothing, however it was merged. A branch deleted from the remote ends it too. Nothing from CI or a PR reaches the builder.

### Removing a task

`sc rm` ends the work on a task, such as one you want started over. Skelcrew ends its threads, closes the PR, with your reason as a comment if you give one, deletes its branch, removes the clone, takes you off the issue if it assigned you, and marks the threads `done`. The task goes back to `issue`, or to `closed` with no issue. At a terminal it says what it will close and delete, and asks. The lead can run it after confirming with you in its conversation, and a builder can't. On a task in the backlog that never started, it only deletes the task.

### Assigning the issue

Every start of a task on an issue assigns the issue to you, so the tracker shows which issues Skelcrew is on, and for whom. It adds you and never takes another assignee off. When the task stops, is removed, or its PR closes without merging, Skelcrew takes you off, but only if it put you on. A merge leaves you assigned, as the record of who did it, and so does a failure. An assignment that fails is logged and never stops a task from starting or stopping.

### Needs you

**Needs you means you must act to unblock the thread.** Nothing else sets it, and its word always says what the action is. Waiting on a review, CI or a queue never needs you.

**Questions go to the lead.** You talk to the lead, so a builder brings its questions and decisions there, never to you in its own session, on every harness and host, and never with its harness's question tool. It frames them for someone who hasn't read the code: the background, an example, what each option means for you, and a recommendation.

The lead answers a question itself when the answer follows from what you already decided, or from a clear technical call, and tells you in one line, so you can overrule it. A question that is yours by rule always comes to you: editing a spec, trust or security, the work's scope or direction, and merging. You never need to attach to a builder to answer one. These are among the lead's core rules, so a repository's own lead role can't drop them.

**Marks.** The lead marks a thread when only you can unblock it, with the action written for you, never one it can unblock itself or one that only waits. Only you and that repository's lead can mark or clear a thread. Skelcrew marks, by the same rule: an approved and green thread with no merge armed, as it waits on you to merge; the round limit, until someone decides it; a question asked with the harness's question tool, until you answer; a harness error it can't get past alone, such as a lapsed login; and a missing session host plugin. A failure of a thread, review or round, and a builder that isn't running, aren't marks: the lead hears of each and can act.

**Clearing.** A mark clears when you type to the builder, when the lead or you clear it, or when what it is about happens, such as a new submit or the task's end. Stopping the thread doesn't clear it, and nor does what Skelcrew itself types in. The thread's log says who set or cleared each mark, and why.

**A turn that ends without submitting** goes to the lead, not to you: its last message goes to the lead, who answers it or brings a question in it to you. A turn that only answered a message, that waits on its own submit, or whose words the lead already has, adds nothing.

**The safety net.** A builder that stopped without submitting, with nothing in flight, and that nobody acted on for a few minutes, needs you, so nothing waits unseen while the lead is busy. A builder the lead just told something gets longer, and one still running a background job hasn't stopped.

**Limits pass by themselves.** A usage or rate limit doesn't need you: once it resets, Skelcrew tells the builder to continue. A lead that stops on an error isn't flagged, as you see it whenever you open it.

**Telling you.** When a thread starts needing you, the lead gets a one line note, so you hear it where you already are. So do a task's end, so the lead never lists a merged PR as ready, and a thread that fails, with why. A note that would mislead once things moved on is dropped.

## Events

The engine asks each repository's tracker and forge what changed since it last looked, and names the PRs of its live and stopped tasks. The number of requests doesn't grow with the number of tasks. It polls often while a task is active, and less often while tasks only wait on you. Each event is handled once.

**Starting from GitHub.** The engine starts a task on each open issue labelled `skelcrew` that hasn't started, claiming the issue first, so when two machines run Skelcrew on one repository only the first claim starts it. The lead hears of it and gives the task a short title. The label is the signal because Skelcrew's GitHub App can't be assigned an issue, and only people with triage or write access can add one. Removing the label doesn't stop a task, and a task that failed, stopped or was removed isn't started again by its label. Skelcrew never comments on the issue.

| Event | What Skelcrew does |
| --- | --- |
| Reviewer requests changes | Types the review into the builder, unless the round limit is reached |
| Reviewer approves | Waits on CI, or `ready for review` if CI is already green |
| A check fails | Types the failing check's name and what failed into the builder |
| All checks pass after approval | `ready for review` |
| A person comments or reviews on the PR | Types it into the builder, even past the round limit, and marks it seen on the forge once it is typed in |
| Merge conflict with the base branch | Tells the builder to merge and fix it. An approved task stops being ready at once, until a new round is approved |
| PR merged or closed | Ends the task's threads and cleans up |
| Bot comments | Ignored |

An event changes the task at once, before the builder hears of it. Without a forge, only the reviews and the end of the branch happen.

## Plugins

A plugin lives in a git repository of its own, with a `skelcrew-plugin.yaml` at its root. It is one of two kinds, and says in its manifest what it provides within that kind. Skelcrew's flow knows what a plugin provides, never which plugin provides it. The protocol's every detail is in [plugins and base modules](runtime.md).

| Kind | What it is for | Provides | Examples |
| --- | --- | --- | --- |
| I/O | Work in and results out. In: issues become tasks, labels start them, comments and reviews reach builders. Out: PRs, reviews, checks, merges, closed issues and notifications | `tracker`, `forge`, `chat` | GitHub (tracker and forge), Linear, GitLab, Slack |
| Runtime | Where and how agents run | `sessions`, `transport`, `status`, `files`, `machine` | herdr. tmux and SSH are built in |

Messages and the sandbox stay in core, between the two. Work comes in through an I/O plugin, becomes a message, and reaches an agent through the runtime. No plugin can provide messages or the sandbox, so the rules about who may reach whom, and what an agent can touch, are Skelcrew's on every setup. Harnesses are never plugins: each is built into Skelcrew, one module per harness, because that module draws the sandbox boundary.

A runtime plugin is always personal, since how you run and watch your agents is yours. An I/O plugin is usually the repository's.

### The manifest

```yaml
name: github
version: 0.4.0          # the same as the tag it is installed from, v0.4.0
skelcrew: 0.6.0         # the oldest Skelcrew release it works with
about: Reads issues, opens pull requests and merges them on GitHub
kind: io
provides: [tracker, forge]
build: [[bun, install, --production]]
setup: [bun, setup.ts]
call: [bun, call.ts]
git_credentials: [bun, credentials.ts]
```

Each command is a list of words, run in the plugin's folder and never through a shell. `build` runs once, at install. `setup` runs in your terminal and asks for whatever the plugin needs, such as a sign-in. A command whose first word is `bun` runs on the Bun inside Skelcrew, so a plugin written for Bun needs nothing else installed. `about` says in plain words what the plugin is for, shown first when Skelcrew asks you to install it. Each command gets the plugin's name and a folder of its own for its settings and tokens, readable only by you.

### I/O plugins

A tracker or forge is asked by running its `call` command with one JSON question on stdin. It prints one JSON answer and exits within 60 seconds, or exits with an error on its last line of stderr. Exit code 2 means the plugin needs its setup again, and Skelcrew says so, or runs it there and then when you are at your terminal. Every answer is checked before Skelcrew uses it, and an older plugin's missing answer is read the safe way.

The questions are `claims` (whether a remote is this plugin's, and the repository's names, links, whether you can push and whether it is a fork), `changed` (every item updated since the last answer, or everything open), `create task`, `took` (claiming an issue, saying whether this call took it), `assign`, `seen`, `open pr`, `merge pr` (only if the PR's head is still the approved commit), `close pr`, `review`, `edit review`, `status` and `log` (what failed in a check). Their fields are in [plugins and base modules](runtime.md#io-plugins). A forge posts and gives back a review's body unchanged, so Skelcrew can find its own markers.

An **item** is an issue or a PR: its kind, ID, title, body, state, author, labels, link and times. An issue adds the line that closes it on merge. A PR adds its branch, base, whether it conflicts, its checks, and its reviews and comments. A `cancelled` check isn't the builder's to fix. An author says whether it is a bot, whether it is you, and whether it can push.

Skelcrew runs git itself, for clones, fetches and pushes. `git_credentials` is a git credential helper, which Skelcrew hands to git for each command and never saves.

**The copy.** Skelcrew keeps a copy of each repository's open issues, from its tracker, and open PRs, from its forge, brought up to date at each poll and read whole again at each engine start. The screen and the commands that list or show read the copy, so none of them waits on the tracker or forge. Only `sc show` asks the forge, for the logs of failed checks. A task starts from a fresh poll, so a builder never starts from an old body.

A chat plugin, such as Slack, would be where you hear that a task needs you and talk to a lead. None exists yet, so chat has no commands: they come with the first chat plugin.

### GitHub

The GitHub plugin acts as Skelcrew's GitHub App, so everything Skelcrew does on GitHub shows as `skelcrew[bot]`, and it is always clear whether you or Skelcrew speaks. Skelcrew never acts on GitHub as you. Its setup signs you in on each machine on its own, asking you to paste nothing, and makes sure the app is installed on the repository. Each repository gets a token of its own lasting an hour. The app has no permission for workflows, so a change to `.github/workflows` is one a builder says it needs, and you make.

**Skelcrew's service.** The app's secrets can't ship inside Skelcrew, so a small open source service holds them, and only makes tokens and renews sign-ins. You can run your own, with an app of your own. It has no database, sees only who asked for which repository, and code and issues never pass through it. While it is down, tasks wait and catch up after. Skelcrew's core never needs it.

### Runtime plugins

A runtime plugin provides some of the base modules `sessions`, `transport` and `status`, and `files` and `machine`. Core uses its built-in for any base module the plugin leaves out, and uses a plugin's transport, status and files only for the sessions it hosts. Each function is a command, run as `call` is. herdr is the first: its own apps then show Skelcrew's leads and builders on your laptop, desktop and phone.

**Files.** A file you drop onto an agent in a host's apps, such as a screenshot, is saved in a folder of that session's. A plugin that provides `files` lets its agent read that folder, read-only, and nothing else of the host's. The host may change nothing in the sandboxed command but swap a placeholder Skelcrew made for that folder, and Skelcrew refuses anything else. On a Mac, an agent gets no dropped files yet.

**Machines.** A plugin that provides `machine` says how to reach a machine that runs Skelcrew: `add` readies one after asking, `exec` runs words there as `ssh -t` does, and `push` copies a file there. Only `add` creates a machine, so a mistyped name creates nothing. It is used on the laptop you run `--remote` from.

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

Every agent runs in a terminal session of its own: one for each repository's lead and one per builder. The rest of Skelcrew reaches a session only through this module, with plain data in and out. Its functions are `start`, `paste` (one bracketed paste), `keys`, `read` (the screen, and whether someone scrolled back), `interrupt`, `attach`, `end` (once every process it ran has exited), `list`, `rename` and `check` (whether a session exists, whether its agent runs and exited cleanly, and its last screen, so Skelcrew reconnects instead of starting an agent twice). Each is described in [plugins and base modules](runtime.md#sessions).

Every session carries its repository, task and role as labels for as long as it lives, so a starting engine knows whose each session is, and a host's own apps can group and filter by them.

The built-in host is tmux, on Skelcrew's own tmux server with its own config, keeping every trap in `docs/learnings.md`. Skelcrew never runs its own terminal emulator. Leaving an agent takes one key, the same on tmux as on herdr. Only this module runs tmux for agents, and a test fails if anything else does.

Your session host setting picks the host for new sessions. A running agent stays on the host it started on until it ends, and a resumed one starts on the current host with its conversation. If a thread's host plugin is gone, the thread needs you, rather than being moved silently.

### Transport

| Function | What it does |
| --- | --- |
| `deliver` | Types a message into an agent once it is idle, never into a turn still running and never on top of a person's unsent draft. |
| `idle` | Says when an agent becomes idle, so a waiting message can go. |

The built-in transport works on any host's sessions, as it uses only `paste`, `keys` and `read`, with the busy and ready marks each harness module gives. No hook can see a draft, so it always checks the screen before typing, whatever the state says. An agent that is working gets no message until its turn ends. A host that can do better provides its own.

### Messages

Every message Skelcrew types into an agent goes through this module, on whichever transport is active. The exact wrapping, escaping and order of notes are in [the flow in detail](flow.md#messages).

- **Who may send what to whom.** The lead may tell any thread of its own repository, and brief another repository's lead, never its own. A builder may tell only its repository's lead. Skelcrew sends event messages to a builder and notes to the lead. A reviewer sends nothing. A brief carries your exact words, in a form only Skelcrew can write, when you asked for the work, and only then may the receiving lead start threads from it, for exactly what your words ask. Anything else is refused.
- **Nothing passes for someone else.** Every message from an agent is wrapped in a tag that says who it is from and how to answer. No agent's text, and no outside text such as an issue's title, can end that tag, fake another, pass for your words, or end the paste early and type as if it were you.
- **Order.** Each agent has one queue, first in, first out, kept in the database, so a restart loses nothing and reorders nothing.
- **Waiting until idle.** A message waits until the agent is idle. One to a thread that isn't running, or that is asking you a question, is refused, since typing would answer it for you. A builder that should be running but isn't while messages wait is reported to the lead.
- **The lead's chat is yours too.** Nothing goes into it while you have scrolled back or have unsent text at its prompt. What waited then goes in as one message, most urgent first, checked again so nothing stale is announced.
- **Never twice, never silently.** A message is never pasted twice, even across a question asked mid-delivery or a restart. When `sc tell` can't go in right away it says why, and one still waiting long after brings the lead a note.
- **No acknowledgements.** A builder answers the lead only with a result, a question or a disagreement.
- **Stale notices go.** A new round drops Skelcrew's own waiting notices about the older commit, and a task that ends drops what waits for it. People's reviews and comments, and the lead's messages, are never dropped.
- **Task updates.** Every message from the lead, once typed in, is kept on the task as an update, which the reviewer gets, so the lead has nothing to remember.

Messages stay in Skelcrew, never on GitHub, and each goes in the task's log. They stay in core on every host, so Skelcrew's rules and safety are the same whichever host runs the agents.

### Sandbox

The sandbox stays in core on every host, drawn by the harness module. A host runs the sandboxed command exactly as Skelcrew gives it, and never changes what the agent can reach, but for the one swap **Files** under **Runtime plugins** allows.

- **bubblewrap on Linux, `sandbox-exec` on a Mac**, drawing the same boundary: the agent's folder writable, the rest of the system read-only, the home folder and credentials hidden.
- **Each harness** gets a config folder and login of Skelcrew's own, never yours, with its own permission prompts and sandbox turned off, since Skelcrew's draws the boundary. Its conversations stay where it can resume them.
- **The lead** works in its own folder, and reads Skelcrew's clone of every repository Skelcrew has, its own included, read-only, kept current. A repository added later shows up in a running lead. It never sees another repository's tasks or conversation. Builders and reviewers see only their own task's clone.
- **The reviewer** sees the task's clone through a throwaway layer, so it can run tests but changes nothing.
- **Priority.** Builders, reviewers and setup commands run at a lower CPU priority than the leads and the engine, so your typing stays quick while their tests pile up.

### Status

Skelcrew keeps each agent's state on its thread: `working`, `idle`, `asking` or `error`. With the thread's needs you and its task's stage, that gives the status a host shows: working, idle, needs you, ready or error.

The state comes from the harness's hooks wherever a hook fires: a message going in, a turn ending, a turn ending on an error, a question asked, Esc. A lead's hooks only keep its state: they never flag needs you or bring a note. Where a harness has no hook, such as for Esc on Claude Code or an error on Codex, Skelcrew reads the screen of each working agent, on every host, and never flags needs you from it.

Skelcrew reports every change of status to the host when the host can show it, through a plugin's `status` function, which receives a session's ID, its status word and a short reason. tmux shows no status, and Skelcrew's screen shows it instead. A host's own view never replaces the hooks: needs you always comes from Skelcrew.

## The screen

The screen is how you see and steer a repository's work. What it shows, its keys and its layout are in [the screen](screen.md). It guarantees:

- **Three ways in.** Plain `sc` shows the repository's list as a sidebar, with the lead or the row you are on beside it. `sc --list` shows the list alone with a details pane. `sc attach` attaches full screen to one agent.
- **The lead first.** The screen starts on the lead, so what you type first goes to it, and the lead's requests for your yes show under it.
- **Tasks, not threads**, in sections: everything that waits on you, always open, so one key reaches it; what waits for a builder, in the order it starts; then the stages. Each task shows in exactly one place, decided from its state alone.
- **Words, not colours.** A task's word always says what is happening. Outside text has its control codes removed first.
- **Always a way back.** One key brings you back from an agent, and pressing it once too often never leaves the screen. Leaving keeps every agent running, and says so.
- **Seeing without touching.** A task's details show what `sc show` gives, with its agent live beside them. Nothing typed there reaches the agent, and its session is never resized.
- **Fast and quiet.** The screen reads only Skelcrew's database and its copy, so it opens at once and never asks the forge, and it redraws only on change, so it works over a slow link. It shows the load of the machine the engine runs on.
- **Yours to decide.** Merging, starting and the queue's order happen only on your keys or commands, never the lead's. The merge confirm says when the PR changes `.agents/`.
- **Your terminal stays yours.** The screen never reads your `~/.tmux.conf`, and takes the mouse only while it shows.

**A lead you exit** ends alone: its repository and tasks stay, and the engine doesn't bring it back until you open the repository again, which resumes its conversation. A lead that crashed is brought back when you look at it. When Skelcrew can't tell which happened, it takes the lead as exited, and says how to start it.

A runtime plugin's host shows the same agents in its own apps, and its sessions on the screen through its own `attach`. Skelcrew's screen is the only place that merges and answers the lead's requests.

## Remote machines

The engine runs on the same machine as its agents. So `--remote` is only "run `sc` on that machine", over plain `ssh -t`. Everything must work over it: no local display, no browser on the same machine, no clipboard. Logins that need a browser use a code and a link you open on your laptop. The steps are in [commands](commands.md#sc---remote).

- **One setup for all your machines.** `sc --remote <host> install` sends your personal files and runs `sc install` there, putting Skelcrew there first if needed, so a server feels like your laptop. Sign-ins that renew themselves are made on each machine, as two sharing one would break each other.
- **Commands act where you are.** `sc --remote <host> <command>` acts on the repository you are in on the laptop. With no command, it opens the server's screen.
- **Nothing without asking.** `--remote` never sets a machine up or updates its Skelcrew without asking, and says when your setup or Skelcrew differs from the server's.
- **What runs stays where it runs**: tasks, clones, the engine and its state.
- **Each person their own.** Skelcrew lives in your home folder and runs as your user, so several people can share a server.

Seeing agents from elsewhere is the session host's job, such as herdr's own machines, and merging stays in Skelcrew.

## State

One SQLite file per machine, with `bun:sqlite`, holds the repositories, tasks, threads, the copy, the messages waiting for each agent, and every queue and hold, as [plugins and base modules](runtime.md#state) lists. Every armed or queued state is in it, so a restart or a migration keeps it: an armed merge stays armed, a queued review or task keeps its place, and a held review still waits. Only the queue of check slots lives in the engine's memory. Every change is also logged per task, as one JSON line, so a task's history can be read and replayed. A database from an earlier release is moved forward once, after saving a copy, never while another engine still writes the old way.

**Tokens stay out.** Agents never see a GitHub token, or any plugin's. They don't push or call GitHub. They call `sc` commands, and the engine and its plugins, outside the sandbox, push and post as Skelcrew's GitHub App, or push with your own git login when a repository has no forge. Commits are authored by `skelcrew[bot]`, with you as co-author.

**One seam for harnesses.** Each harness lives in one module: how it starts, resumes and logs in, where its config folder is, what its screen shows when busy or ready, how it reports its hooks, and how it draws the sandbox. The flow never names a harness, so another one is one more module.

## Not in this version

- Reviewing pull requests Skelcrew didn't open
- Richer flows: custom stages, several reviewers, skipping stages other than the review, and picking a flow by label or rule. They come once real use shows what is needed
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
- An `Up next` section in the screen's sidebar

If something seems missing, ask instead of adding it.
