# Skel rewrite spec

Nov 3, 2026 · @Simon

## Goal

skel is Claude Code, but always on, in parallel, isolated, and seeing each task through to the merge.

You run `skel` and talk to your lead: a Claude Code session on your server that knows all your repositories. The lead writes tasks and starts threads. Each thread works in one repository, as a builder agent in its own branch, clone and sandbox. It opens a PR, a fresh reviewer on another model, Codex by default, reviews it adversarially, and they go back and forth until it is ready. CI failures and your PR comments wake the builder again. You merge.

There are no roles, phases or flows as files. We trust capable agents and add an adversarial review.

The repository starts with three documents: this spec, `AGENTS.md` for how to write code here, and `docs/learnings.md` for the traps to avoid. The code starts empty. Keep it small, plain and tested.

## Qualities

| Quality | What it means |
| --- | --- |
| Always on | skel runs on a server. Start and attach from your laptop, close the lid, and the work carries on. |
| Unattended, where it makes sense | Agents stay alive, wake on events, and only ask you when they need you. You approve and you merge. |
| Parallel | Many threads at once, across repositories, without juggling chat windows. |
| Isolated | Each thread gets a branch, clone and sandbox. Your own checkouts are never touched. No tokens inside. |
| Connected | Tasks come from GitHub issues and PRs go back to it. More tools can be added behind the same seam. |
| Build ⇄ review | A builder and a fresh adversarial reviewer on another model loop until the change is ready. A model reviewing its own work shares its blind spots. |
| In your harness | You stay in Claude Code. There is no new app to live in. |

## The demo

Everything in this version serves this two minute demo, recorded for real with a visible clock and a time lapse.

1. On the laptop: `skel --remote sprite:demo`. The lead opens, running on a Sprite.
2. On GitHub, add the `skel` label to two issues in app and one in site. Within a minute skel starts three threads, and the lead says so.
3. Close the laptop.
4. Open it later and run the same command. The lead says what happened: two PRs are reviewed and green, one of them after the builder fixed a failing check on its own. The third thread needs you: its builder has a question.
5. Attach to the third thread and answer its question. Merge the two PRs on GitHub. skel cleans up.

The demo repositories are small real apps with fast CI and real issues, not skel itself.

## Words

| Word | Meaning |
| --- | --- |
| Lead | Your Claude Code session on the server. One per machine, always running, across all your repositories. You talk to it; it writes tasks and starts threads. |
| Repository | A GitHub repository skel works on, from a clone of its own. It is named by its GitHub name, such as `app`, with the owner added (`simon/app`) only when two share a name, or by a short name you give it. |
| Task | What you want done, in words, as an item in the tracker you connect skel to. skel is made to work from a tracker, and keeps no tasks of its own: you plan where you already do. Each tracker keeps its own word: in this version the tracker is GitHub, where a task is an open issue. A task can exist without a thread: one you create on GitHub shows up in skel, and nothing happens until it is started, with `skel start` or the `skel` label. |
| Thread | skel's core: the work on one task, from its first message to the merged PR. Its branch, clone, sandbox, builder session and history. One thread per task at a time. Named by the task's own ID in its tracker, with the repository added when that ID doesn't name one: GitHub issue #12 in app is `app-12`, since its number is only unique within app, while a tracker whose IDs are already unique, such as Linear's `JOTT-12`, would keep its own. A thread never gets a second number, so the name in skel is always the one in the tracker. A dash, because no shell reads a dash as anything special, so it never needs quoting. |
| Builder | The thread's agent. A Claude Code session that stays alive from start until the PR merges or closes. |
| Reviewer | A fresh agent for each review round, on Codex by default, reading the PR adversarially. It runs once and answers with a verdict, with no session to attach to. It never inherits the builder's context. |
| Event | Something that happened to a thread: a review, a PR comment, a failed check, a merge. |
| Needs you | A flag on a thread: the builder asked a question, review hit its round limit, or the PR is approved and green. |

A thread's status is one of `working`, `waiting` (on review, CI or you), `failed` or `done`. Needs you is a separate flag, so a thread can wait on CI and need you at once.

## Running skel

skel runs on a Linux machine that stays on: a server of your own, or a Sprite, a Linux machine skel creates for you on Fly.io. `skel`, from any folder, attaches your terminal to the lead, and starts the daemon and the lead first if they are not running. Ctrl-\] detaches; the lead keeps running.

The repository you attach from is the lead's default, as the folder is for `claude` in a terminal. skel matches it by its GitHub name, and when it differs from last time, a one line note, such as "the human is attached from app", goes along with your next message to the lead, without a turn of its own. "Fix the flaky test" then means app's, and every other repository stays in reach. Outside any repository, or in one that isn't on GitHub, there is no default. The folder only names the repository: skel never works in your checkout, and never sees changes you haven't pushed. While skel has no repositories yet, `skel` says so before attaching: "skel has no repositories yet. Run skel in a checkout of one, or ask the lead for one by its GitHub name."

**The first run.** The first `skel` on a machine takes three steps before the lead starts:

1. **Connect to GitHub.** If `gh auth status` fails, skel runs `gh auth login` in your terminal. skel uses that login for everything it does on GitHub, outside the sandbox.
2. **Pick a harness.** skel checks that the harness is installed, and saves the choice in `~/.config/skel/config.yaml`. For Claude Code it then runs `claude setup-token`, which gives a long-lived login token for agents, and saves the token you paste in `~/.config/skel/`, readable only by you. In this version Claude Code is the only harness offered, but the question is asked so the choice is visible and stored.
3. **Log in the reviewer.** When `codex` is installed, skel runs `codex login --device-auth` with `CODEX_HOME` set to `~/.local/share/skel/codex/`. That is a login of skel's own, separate from yours in `~/.codex`, so a renewal on either side never breaks the other. Without `codex`, skel says reviews will run on Claude Code, on the builder's own model, so they lose the second view, and the step is skipped.

Before the first step, skel checks that `tmux`, `bwrap`, `gh` and the harness are installed, and if one is missing, says exactly what to install instead of failing halfway. After the last step, it installs the daemon as a systemd user service and turns on lingering (`loginctl enable-linger`), so the daemon keeps running after you log out and starts again after a reboot. On a Sprite, which has no systemd, it installs the daemon as a Sprite service instead, which the Sprite starts at boot and restarts when it crashes.

Each step is skipped when it is already done. Once the first run has finished, `skel` skips it entirely and goes straight to the lead: a tool or login that goes missing later shows up where it is used.

For now, `skel` only wraps the harness: it sets up the lead and puts you in it, full screen. Later, tasks and threads show next to the harness, in a sidebar beside the lead.

From a laptop, `skel --remote simon@workbox` runs `ssh -t simon@workbox skel --from <owner/repo>`, passing the GitHub name of the repository you are in on the laptop, so the lead knows it too. Any command works the same way: `skel --remote simon@workbox ls`. There is no protocol of our own; SSH (and Tailscale, if you use it) does the connecting.

**On a Sprite.** `skel --remote sprite:demo` does the same with Fly.io's `sprite` command in place of `ssh`, so you need no server of your own. The first time, it goes from nothing to a running lead:

1. **It checks the laptop**: that `sprite` is installed and logged in, and which repository you are in. It lists everything that is missing with the command that fixes it, such as `sprite login`, creates nothing, and ends with the command to run again.
2. **It asks before creating the Sprite**: "No Sprite named demo. Create it?", so a mistyped name never makes a second one you pay for.
3. **It sets the Sprite up**: installs bubblewrap and copies skel's binary there.
4. **It runs the first run inside the Sprite**, then attaches you to the lead.

After that, `skel --remote sprite:demo` attaches to the lead, and `skel --remote sprite:demo ls` runs any command there, waking the Sprite if it sleeps.

Everything must work over a plain `ssh -t` or `sprite console`: no local display, no browser on the same machine, no clipboard. Logins that need a browser, such as GitHub's and Claude's, use a code and a link you open on your laptop.

**Repositories.** skel keeps its own clone of every repository it works on, in `~/.local/share/skel/repos/<owner>/<repo>/`, and keeps it at the latest default branch. A repository comes in the first time you work on it: when you run `skel` in a checkout of it, or when a command names it by its full GitHub name, such as `skel task ls skelcrew/skel-github`. After that its short name works everywhere. So when you ask the lead for work in another repository, it brings it in by running one of those, after asking you. There is no command to add a repository. `skel repo ls` lists them and `skel repo rm <name>` removes skel's clone.

A long name makes long thread names, so `skel repo name my-company-backend-api api` gives a repository a short name of your choosing. `api-123` then works everywhere, and so does the full GitHub name. skel refuses a short name another repository already goes by. Renaming changes only what you type: a thread keeps its folder, log and session.

Before cloning, skel decides whether to trust the repository. It trusts it on its own when your GitHub login can push to it, unless it is a fork: agents will run its setup and test commands, and read its AGENTS.md and settings as instructions, and you already vouch for what is in it. For any other repository, `skel` run in a checkout of it asks you whether you trust it. Brought in any other way, it waits until you run `skel repo trust <name>` in your own terminal, since a yes passed on by the lead could come from an injected instruction. The answer is remembered in \~/.config/skel/, never in the repository, so a clone can't bring its own yes.

A repository can say how to set up and test it in a committed `skel.yaml`. Without one, the builder works it out, as it would in any checkout.

## The daemon

One daemon per machine, run by the systemd user service or Sprite service the first run installed. `skel serve` runs it in the foreground; the folder it is started in makes no difference.

1. If a daemon is already running, `skel serve` says so and exits, pointing you to `skel`.
2. If the first run isn't done, it exits and tells you to run `skel`. It never asks questions, since systemd or the Sprite has no one to answer them.
3. It opens the database, starts skel's tmux server, and reconnects to the lead and every live thread. A session that is gone is brought back with `claude --resume`.
4. It opens its socket at `$XDG_RUNTIME_DIR/skel.sock` for the CLI, and one socket per agent, mounted into that agent's sandbox, so skel knows which thread is calling.
5. It polls GitHub and logs to stdout, which systemd sends to the journal.
6. On a Sprite, it keeps the Sprite awake while there is work: a builder working, a review running, or a PR waiting on CI. It holds a task on the Sprite's control socket that expires a few minutes after its last renewal, so if the daemon dies, the hold expires too. Once every thread waits on you or is done, it lets the Sprite sleep, which costs nothing for compute. A GitHub webhook to the Sprite's URL wakes it when you comment on or merge a PR, and polling then picks up the event. A webhook that never arrives is caught when the Sprite next wakes, for example at your next `skel --remote`.

Stopping the daemon stops only the daemon. The tmux sessions keep running, so agents keep working through a restart or an upgrade, and the daemon reconnects to them when it comes back. Only `skel stop` ends a session.

## The flow

One thread, from start to merge.

1. **A task is started.** You add the `skel` label to an issue on GitHub, from anywhere, even your phone. Or the lead runs `skel task create app "<title>" "<body>"`, which creates a GitHub issue, then `skel start app-12`. You can run both yourself too.
2. **skel sets up the thread.** A clone of its own at `~/.local/share/skel/threads/app-12/`, made from skel's clone of the repository, on branch `skel/12-<slug>` from `main` (or `--from <branch>`), with the repository's setup commands run once in it.
3. **The builder starts.** A Claude Code session in the sandbox, in the thread's clone, with the task's title and body as its first message.
4. **The builder finishes a round.** It commits and runs `skel submit "<summary>"`. skel fetches the branch from the thread's clone into its own and pushes it from there, never running git inside the thread's folder. On the first round skel opens the PR, with `Closes #12` in its body.
5. **The reviewer reviews.** skel sets the `skel/review` status check on the commit to pending and runs a fresh reviewer once, in the sandbox, with `codex exec` (or `claude -p` without Codex). It is given the task, reads the diff against the base branch, runs the tests, and answers in a fixed JSON shape: approve or changes, and the review's body. skel posts it as a GitHub review and sets the check to success or failure, so branch protection can require it. Reviews run one at a time, since they share skel's Codex login, and a renewal by one could leave the others with a token that no longer works. A review covers the commit it started for: a newer `skel submit` cancels a review still waiting or running. A reviewer that fails, answers outside the shape, or runs past 30 minutes sets the check to failure with "review failed", and the thread needs you.
6. **Changes go back to the builder.** skel types the review into the builder's live session. The builder fixes, commits and runs `skel submit` again. Back to step 4.
7. **After 3 rounds of changes, the thread needs you.** skel stops sending reviews to the builder until you say go on.
8. **Approved and CI green: the thread needs you.** Its status is `waiting`, on you.
9. **You merge on GitHub.** skel ends the builder session, removes the thread's clone, and marks the thread `done`. A PR closed without merging does the same.

At any point the builder can ask you a question with Claude Code's own `AskUserQuestion`. skel notices, and the thread needs you until you attach with `skel attach` and answer it.

**Telling you.** When a thread starts needing you, skel types a one line note into the lead's session (when the lead is idle), so you hear it where you already are.

## Events

The daemon polls GitHub with one GraphQL query per repository, fetching every open thread's PR with its reviews, comments, checks and merge state, so the number of requests doesn't grow with the number of threads. It polls every 30 seconds while a thread is active, and less often for threads that only wait on you. Webhooks are a faster wake-up, never the only source, since deliveries are missed while the daemon is down. On a server they may be added later; on a Sprite they wake it from sleep. Calls go through `gh`. Each event is handled once: skel records the ID of the last review, comment and check run it acted on.

**Starting from GitHub.** Every minute the daemon also asks each repository for open issues labeled `skel`, in the same query, and starts a thread on each one that has none, exactly as `skel start` does. It reacts to the issue with 👀, so you can see on GitHub that skel took it, and types a one line note into the lead, such as "started app-12 from GitHub: Fix the login redirect". skel never comments on the issue: a builder's question waits in skel, where the thread needs you and the lead tells you, and you answer it with `skel attach`. A label is the signal because skel acts with your GitHub login, so assigning an issue to yourself can't mean "skel, take this", and a GitHub App can't be assigned an issue. Only people with triage or write access can add a label, so a stranger can't start work. Removing the label doesn't stop a running thread; `skel stop` does. A thread that failed or was stopped isn't started again by its label, only by `skel start`. skel creates the label in a repository the first time it brings it in.

| Event | What skel does |
| --- | --- |
| Reviewer requests changes | Types the review into the builder's session, unless the round limit is reached |
| Reviewer approves | Marks the thread waiting on CI, or needs you if CI is already green |
| A check fails | Types the failing check's name and log tail into the builder's session |
| All checks pass after approval | Needs you: ready to merge |
| A person comments or reviews on the PR | Types it into the builder's session. Your comments always wake the builder, even past the round limit |
| Merge conflict with the base branch | Tells the builder to merge it and fix the conflict |
| PR merged or closed | Ends the thread and cleans up |
| Bot comments | Ignored |

## Commands

For you, and for the lead:

| Command | What it does |
| --- | --- |
| `skel [--from <owner/repo>]` | Attaches to the lead, starting the daemon and the lead if needed, and tells it which repository you are in, bringing that repository in first if it is new. `--remote` passes `--from` for you. |
| `skel --remote <host> [command]` | Runs any skel command on the server, over `ssh -t`. With `sprite:<name>` as the host, runs it on that Sprite instead, creating it after asking if it doesn't exist. |
| `skel --remote <host> update` | Replaces skel on the server or Sprite with one built from your checkout, and restarts the daemon there. Agents keep running. A skel run from a checkout there is left for `git pull`. |
| `skel serve` | Runs the daemon in the foreground, for systemd or a Sprite service. One per machine. |
| `skel repo ls` | Lists the repositories skel works on, with their short names. |
| `skel repo rm <name>` | Removes skel's clone of a repository. It refuses while the repository has live threads, and names them. Only you can run it: the lead never needs to, and asks you instead. |
| `skel repo name <name> <short>` | Gives a repository a short name, used in its thread names. |
| `skel repo trust <name>` | Trusts a repository your login can't push to, so skel clones it. Only you can run it. |
| `skel task ls [<repo>]` | Open tasks, newest first, with the thread on each one if it has one. `--json` for tools. |
| `skel task show <repo>-<task>` | A task's title and body, which is all its builder sees, with its thread if it has one. `--json` for tools. |
| `skel task create <repo> "<title>" "<body>"` | Creates a task, as a GitHub issue, and prints its name, such as `app-13`. It doesn't start a thread. |
| `skel ps [<repo>]` | Threads, with status and needs you, newest first. `--json` for tools. |
| `skel start <repo>-<task> [--from <branch>]` | Starts a thread on a task. On a stopped thread, starts its builder again with `--resume` on its last session. |
| `skel attach <repo>-<task>` | Attaches your terminal to the builder's session. Ctrl-\] detaches. |
| `skel stop <repo>-<task>` | Ends the session and keeps the clone, branch and PR. |

For the builder inside a thread:

| Command | Who | What it does |
| --- | --- | --- |
| `skel submit "<summary>"` | Builder | Submits a round for review: skel pushes, opens the PR if needed, starts a review |

Agents talk to the daemon over a socket mounted into their sandbox, which also tells skel which thread they belong to. The lead and the agents never call GitHub themselves.

Settings come in two layers, and both are optional. `~/.config/skel/config.yaml` holds your defaults:

```yaml
harness: claude
builder:  { model: opus }
reviewer: { harness: codex }
max_rounds: 3
```

A repository's `skel.yaml` holds what that repository needs, and can override the defaults:

```yaml
setup: [bun install]
test: [bun test]
```

## State and isolation

**Sessions.** Every agent runs in tmux, on skel's own tmux server (`tmux -L skel`) with skel's own config: one session for the lead and one per builder. A reviewer runs once and needs no session. tmux keeps them alive, handles attach and detach, and answers the terminal's queries. skel never runs its own terminal emulator.

**State.** One SQLite file per machine, `~/.local/share/skel/skel.db`, with `bun:sqlite`. It holds repositories (name, GitHub owner and name) and threads (repository, task, branch, status, needs you, round count, builder session ID, PR number), and the last handled ID per event kind. Every change is also appended to `~/.local/share/skel/threads/<repo>-<task>.log` as one JSON line, so a thread's history can be read and replayed. Open tasks are not stored; `skel task ls` asks GitHub. Repository clones live in `~/.local/share/skel/repos/` and thread clones in `~/.local/share/skel/threads/`, on one disk, so a thread's clone shares its files with the repository's.

**Surviving restarts.** When the daemon starts, it brings back the lead and every thread that was `working` or `waiting` with `claude --resume <session>`, runs again every review whose `skel/review` check is still pending, and polling picks up any event it missed.

**Isolation.** Each thread gets its own branch and clone, so nothing a builder does in it reaches your checkouts, skel's clone or another thread. Each agent runs inside bubblewrap: its folder is writable, the rest of the system is read-only, your home folder and credentials are hidden. The lead works in its own folder in `~/.local/share/skel/lead/` and sees skel's clone of every repository read-only, including ones brought in while it runs, so it can plan across them while the work happens in threads. The reviewer sees the thread's clone through a throwaway layer, so it can run the tests but changes nothing.

**Tokens stay out.** Agents never see your GitHub token. They don't push or call GitHub. They call skel commands, and the daemon, outside the sandbox, pushes and posts with your `gh` login. Commits are authored by you, with skel as co-author.

**One seam for GitHub.** All GitHub calls live in one module, so Linear, Jira, local tasks or another forge can be added later without touching the flow.

**One seam for Sprites.** Creating a Sprite, running commands on it and keeping it awake live in one module, so other machines that skel creates or that sleep can be added later without touching the flow.

## Building blocks

These are the parts that need care. `docs/learnings.md` explains the traps behind each one.

- **Typing into a session.** Wait until the pane is quiet (compare `tmux capture-pane` a moment apart), load the text with `tmux load-buffer`, paste it with `tmux paste-buffer -p` so it arrives as a bracketed paste, then send Enter on its own a moment later.
- **The sandbox.** bubblewrap with the agent's folder writable, the rest of the system read-only, and the home folder and credentials hidden. Each Claude Code session gets its own config folder in `~/.local/share/skel/claude/`, where its transcripts stay for `claude --resume`, and logs in with the token from the first run. Nothing renews the token, so your own login is never touched, and your `~/.claude` stays hidden like the rest of the home folder. Its own permission prompts and sandbox are turned off, since skel's sandbox draws the boundary. Codex gets skel's `CODEX_HOME` and runs with its own sandbox and approvals turned off too. On a Sprite, the sandbox also hides the Sprite's control socket, through which an agent could start a service outside the sandbox or restore a checkpoint.
- **Starting Claude Code.** Remove inherited `CLAUDE_CODE_*` variables. Mark the folder as trusted in the session's copy of its settings, or it waits at a question nobody sees. Pass the first message on the command line.
- **Agent commands.** Every command an agent can run answers quickly: Claude Code moves a shell command to the background after 2 minutes.
- **Detaching.** skel's tmux config binds Ctrl-\] to detach with no prefix and hides the status bar, so attaching feels like being inside Claude Code.

## Not in this version

- Tasks and threads shown next to the harness (the sidebar comes later)
- Reviewing pull requests skel didn't open (a likely early addition)
- Roles, phases and flows as files
- Harnesses other than Claude Code, and Codex for the reviewer
- macOS, and threads on other machines
- Per-thread environments such as a database each (the `setup` commands only)
- Projects with their own memory beyond `AGENTS.md`
- Agents talking to each other, beyond skel telling the lead
- Triggers, schedules or automations
- Reaching you outside the lead's session, such as a `notify` command for your phone
- Slack, Linear, Jira or forges other than GitHub
- Threads started from plain text, without a task. They would be named with a marker, such as `app-t1`, so they never clash with a task's name
- Starting a thread by assigning an issue or mentioning skel on GitHub
- A remote protocol of our own (SSH only), teams and permissions

If something seems missing, ask instead of adding it.

## Milestones

Each one is something you use every day from the day it lands, and lands as small pull requests that pass `bun run check`. From milestone 2 on, skel builds skel.

1. **skel on the server.** You `ssh workbox` yourself and run `skel`. The first run, the daemon as a systemd user service, `skel serve`, skel's own clones of your repositories, brought in when you run `skel` in one, `skel repo` and `skel repo trust`. The lead runs in bubblewrap inside tmux and sees your repositories. Ctrl-\] detaches, and logging out leaves everything running. This replaces herdr plus Claude.
2. **One thread to a reviewed PR.** `skel task create`, `skel task ls`, `skel start`, `skel ps`, `skel attach`, `skel submit`, the reviewer's Codex login. Builder and reviewer loop, with the reviewer on Codex, skel pushes and opens the PR, the `skel/review` check, the round limit, needs you when approved.
3. **Parallel and needs you.** Several threads at once across repositories, the note in the lead's session, questions marked needs you, the lead knowing which repository you attached from.
4. **Follow-through.** Polling for failed checks, PR comments, conflicts and merges. Starting threads on issues labeled `skel`. Cleanup on merge or close. Surviving a restart with `--resume`. `skel stop`, and `skel start` on a stopped thread.
5. **Remote, on a Sprite.** `skel --remote sprite:<name>` from the laptop: the laptop check, creating the Sprite after asking, bubblewrap and skel's binary installed in it, the first run there, the daemon as a Sprite service, keeping the Sprite awake while there is work, and a webhook to wake it. From no server at all to a running lead with one command. `skel --remote <host>` over SSH, offering to copy skel's binary with `scp` when it is missing. The lead brings in repositories when you ask for work in one.
6. **The demo.** Pick the demo repositories and their tasks, run the script for real, record it.

## Done when

The demo runs as written, start to finish, with nothing faked: three issues in two repositories labeled `skel` on GitHub, the laptop closed, two reviewed green PRs and one question waiting when it opens again, one CI failure fixed by its builder, and the threads' clones gone after you merge.

