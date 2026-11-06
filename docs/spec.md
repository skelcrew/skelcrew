# Skel rewrite spec

Nov 3, 2026 · @Simon · updated Nov 6 for the launch on Nov 16

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

## The launch

skel launches as a beta on Monday 16 November 2026. It is a quiet launch: the repository goes public, skel installs on macOS and Linux, and a first video shows it working. Many small launches follow, each with a short video, and we reach out to developers directly. Windows comes later.

Everything until then serves two moments, and the launch is ready when someone who isn't Simon gets through both on their own machine, with no help.

1. **Install it on your laptop, and it is useful at once.** One line installs skel. The first `skel` connects GitHub and the harness and opens the lead. Add the `skel` label to an issue on GitHub, and within 2 minutes skel picks it up, starts a thread and says so. A reviewed PR follows.
2. **Move it to a server with one command.** `skel --remote sprite:<name>`, or `skel --remote <host>` for a server of your own, and the work carries on with the laptop closed.

Until the launch, the work is making these two moments smooth, fixing the bugs people hit on the way, polishing what they see, and building skel for macOS and Linux. Anything that doesn't serve them waits until after the launch. If something seems missing, ask instead of adding it.

**The video.** Recorded for real, with a visible clock and a time lapse.

1. On a Mac: run the install line, then `skel` in a checkout of app. The first run, then the lead.
2. On GitHub, add the `skel` label to an issue in app. Within 2 minutes skel starts a thread, and the lead says so. A reviewed PR follows.
3. On the laptop: `skel --remote sprite:demo`. The lead opens, running on a Sprite.
4. On GitHub, add the `skel` label to two issues in app and one in site. Within a minute skel starts three threads, and the lead says so.
5. Close the laptop.
6. Open it later and run the same command. The lead says what happened: two PRs are reviewed and green, one of them after the builder fixed a failing check on its own. The third thread needs you: its builder has a question.
7. Pick the third thread in the sidebar and answer its question. Merge the two PRs on GitHub. skel cleans up.

The repositories in the video are small real apps with fast CI and real issues, not skel itself.

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

A thread's status is one of `working`, `waiting` (on review, CI or you), `failed`, `stopped` or `done`. Needs you is a separate flag, so a thread can wait on CI and need you at once.

## Running skel

skel runs on a Linux machine that stays on: a server of your own, or a Sprite, a Linux machine skel creates for you on Fly.io. `skel`, from any folder, attaches your terminal to the lead, and starts the daemon and the lead first if they are not running. Ctrl-Q detaches; the lead keeps running.

The repository you attach from is the lead's default, as the folder is for `claude` in a terminal. skel matches it by its GitHub name, and when it differs from last time, a one line note, such as "the human is attached from app", goes along with your next message to the lead, without a turn of its own. "Fix the flaky test" then means app's, and every other repository stays in reach. Outside any repository, or in one that isn't on GitHub, there is no default. The folder only names the repository: skel never works in your checkout, and never sees changes you haven't pushed. While skel has no repositories yet, `skel` says so before attaching: "skel has no repositories yet. Run skel in a checkout of one, or ask the lead for one by its GitHub name."

**The first run.** The first `skel` on a machine takes three steps before the lead starts:

1. **Connect to GitHub.** If `gh auth status` fails, skel runs `gh auth login` in your terminal. skel uses that login for everything it does on GitHub, outside the sandbox.
2. **Pick a harness.** skel checks that the harness is installed, and saves the choice in `~/.config/skel/config.yaml`. For Claude Code it then runs `claude setup-token`, which gives a long-lived login token for agents, and saves the token you paste in `~/.config/skel/`, readable only by you. In this version Claude Code is the only harness offered, but the question is asked so the choice is visible and stored.
3. **Log in the reviewer.** When `codex` is installed, skel runs `codex login --device-auth` with `CODEX_HOME` set to `~/.local/share/skel/codex/`. That is a login of skel's own, separate from yours in `~/.codex`, so a renewal on either side never breaks the other. Without `codex`, skel says reviews will run on Claude Code, on the builder's own model, so they lose the second view, and the step is skipped.

Before the first step, skel checks that `tmux`, `bwrap`, `gh` and the harness are installed, and if one is missing, says exactly what to install instead of failing halfway. After the last step, it installs the daemon as a systemd user service and turns on lingering (`loginctl enable-linger`), so the daemon keeps running after you log out and starts again after a reboot. On a Sprite, which has no systemd, it installs the daemon as a Sprite service instead, which the Sprite starts at boot and restarts when it crashes.

Each step is skipped when it is already done. Once the first run has finished, `skel` skips it entirely and goes straight to the lead: a tool or login that goes missing later shows up where it is used.

**The sidebar.** `skel` puts a narrow sidebar on the left of your terminal, with the agent you are looking at on the right. The sidebar lists the lead first, then every thread that isn't done, each on two lines: a mark and its full name, then, dim, a word for what it is doing and the harness doing it, such as `approved · claude`. While a review runs that is `reviewing · codex`, so you can see which agent has the thread right now. It updates on its own. At the bottom, two dim lines show the keys: `⌥↑↓ switch` and `⌃Q  quit`. They are always there, except on a terminal too short for them and a whole row, where the row comes first.

| Word | Means |
|---|---|
| `working` | The builder is working |
| `reviewing` | A review is waiting or running |
| `checks` | Waiting on CI |
| `changes` | The reviewer asked for changes, and the builder hasn't picked them up yet |
| `question` | Needs you: the builder asked a question |
| `approved` | Needs you: approved and green, ready to merge |
| `round limit` | Needs you: review hit its round limit |
| `review failed` | Needs you: the review itself couldn't run |
| `failed`, `stopped` | As the thread's status says |

The ones that need you are yellow, with a `?` mark. These words only describe the thread: its status and needs you stay as they are.

Above the agent, a strip of two lines says what you are looking at. For a thread, the first line has its name, its task's title, its PR's number and whether its checks pass. The second has its latest review: the round, the reviewer, the verdict and the first line of what it said. So you can see that a review ran, and what it found, without leaving the agent. For the lead, the strip counts the threads, such as `2 approved · 1 working`. It is always there, so the agent's height doesn't change as you switch.

Pick a row to look at that agent. Click it, or move with Alt-Up and Alt-Down from anywhere, even while typing to an agent. The right side switches at once, and you type straight to whichever agent it shows. So answering a builder's question is one click, with nothing to detach from. Ctrl-Q leaves the whole screen, and everything keeps running. skel then prints one line: `Your agents keep running. Run skel to come back.`

The sidebar has three lists, the three stages of a task: ISSUES, THREADS and PRS. The rows described above are THREADS. Each list shows what is really open, on its own, so a task in review is in all three, and a row goes when what it stands for ends. A PR's merge usually ends all three at once, since it ends the thread and closes the issue. Nothing has to match: a thread can have no issue or no PR yet, and a PR can have no thread.

- **ISSUES** are the open issues in your repositories, as `skel task ls` shows them, newest first. Those with a thread are dim and come last, so what is waiting stands out.
- **PRS** are the open PRs in your repositories, newest first, including ones skel didn't open. A PR from a thread shows the same word as its thread.

It is an overview, never a replacement for the tracker or GitHub. A row with no agent is a link: it opens in your browser, as a terminal link, since skel may run on another machine than your browser. The agent on the right stays as it is. Each list shows a few rows, then a count of the rest, leaving out dim rows first. skel asks GitHub for these lists only while a screen is open, so they never keep a Sprite awake.

The sidebar only shows, switches and links. It has no commands of its own, and creates, starts and stops nothing: you ask the lead, or run `skel`.

From a laptop, `skel --remote simon@workbox` runs `ssh -t simon@workbox skel --from <owner/repo>`, passing the GitHub name of the repository you are in on the laptop, so the lead knows it too. Any command works the same way: `skel --remote simon@workbox ls`. There is no protocol of our own; SSH (and Tailscale, if you use it) does the connecting.

`--remote` also keeps skel there up to date. The skel it copies to a server or Sprite carries the commit it was built from, and each command passes along the laptop's. When they differ, or either has changes not committed, skel asks before running the command: "skel on sprite:demo is from abc1234, yours is def5678. Update it?" Yes replaces skel there with one built from your checkout and restarts the daemon, and agents keep running. No runs the command on the old skel. A skel run from a checkout there is never offered an update: `git pull` there updates it.

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
5. **The reviewer reviews.** skel sets the `skel/review` status check on the commit to pending and runs a fresh reviewer once, in the sandbox, with `codex exec` (or `claude -p` without Codex). It is given the task, reads the diff against the base branch, runs the tests, and answers in a fixed JSON shape: approve or changes, and the review's body. skel posts it as a GitHub review and sets the check to success or failure, so branch protection can require it. Reviews run one at a time, since they share skel's Codex login, and a renewal by one could leave the others with a token that no longer works. A review covers the commit it started for: a newer `skel submit` cancels a review still waiting or running. A reviewer that fails, answers outside the shape, or runs past 30 minutes sets the check to failure with "review failed", and the thread needs you. You or the lead can rerun a review with `skel review`, such as after a review that failed.
6. **Changes go back to the builder.** skel types the review into the builder's live session. The builder fixes, commits and runs `skel submit` again. Back to step 4.
7. **After 3 rounds of changes, the thread needs you.** skel stops sending reviews to the builder until you say go on, with `skel start`.
8. **Approved and CI green: the thread needs you.** Its status is `waiting`, on you.
9. **You merge on GitHub.** skel ends the builder session, removes the thread's clone, and marks the thread `done`. A PR closed without merging does the same.

At any point the builder can ask you a question with Claude Code's own `AskUserQuestion`. skel notices, and the thread needs you until you pick it in the sidebar and answer it.

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
| `skel --remote <host> [command]` | Runs any skel command on the server, over `ssh -t`. With `sprite:<name>` as the host, runs it on that Sprite instead, creating it after asking if it doesn't exist. Keeps skel there up to date with your checkout, after asking. |
| `skel serve` | Runs the daemon in the foreground, for systemd or a Sprite service. One per machine. |
| `skel repo ls` | Lists the repositories skel works on, with their short names. |
| `skel repo rm <name>` | Removes skel's clone of a repository. It refuses while the repository has live threads, and names them. Only you can run it: the lead never needs to, and asks you instead. |
| `skel repo name <name> <short>` | Gives a repository a short name, used in its thread names. |
| `skel repo trust <name>` | Trusts a repository your login can't push to, so skel clones it. Only you can run it. |
| `skel task ls [<repo>]` | Open tasks, newest first, with the thread on each one if it has one. `--json` for tools. |
| `skel task show <repo>-<task>` | A task's title and body, which is all its builder sees, with its thread if it has one. `--json` for tools. |
| `skel task create <repo> "<title>" "<body>"` | Creates a task, as a GitHub issue, and prints its name, such as `app-13`. It doesn't start a thread. |
| `skel ps [<repo>]` | Threads, with status and needs you, newest first. Done threads only with `--all`. `--json` for tools. |
| `skel start <repo>-<task> [--from <branch>]` | Starts a thread on a task. On a stopped thread, resumes it: starts its builder again with `--resume` on its last session. On a thread past the round limit, lets it go on: counts its rounds from zero again and types the last review's changes into the builder. |
| `skel attach <repo>-<task>` | Opens the same screen as `skel`, with that builder on the right. Ctrl-Q detaches. |
| `skel review <repo>-<task>` | Reviews the thread's last submitted commit again, as a round's review, such as after a review that failed. It refuses while a review of it is waiting or running. |
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

**The screen.** The sidebar lives in a second tmux server, `tmux -L skel-screen`, one session per open terminal, ended when you leave. Its left pane runs the sidebar, on a server with terminal links turned on (the `hyperlinks` terminal feature), and the strip sits above the right pane. Its right pane is an ordinary tmux client attached to the agent's session on `tmux -L skel`, and picking a row switches that client to another session. So agents' sessions stay single-pane and know nothing of the screen: typing into them, reading them and checking them work as if it weren't there, and leaving the screen ends nothing.

**State.** One SQLite file per machine, `~/.local/share/skel/skel.db`, with `bun:sqlite`. It holds repositories (name, GitHub owner and name) and threads (repository, task, branch, status, needs you, round count, builder session ID, PR number), and the last handled ID per event kind. Every change is also appended to `~/.local/share/skel/threads/<repo>-<task>.log` as one JSON line, so a thread's history can be read and replayed. That includes each review's round, reviewer, verdict and first line, which the strip shows. Open tasks are not stored; `skel task ls` asks GitHub. Repository clones live in `~/.local/share/skel/repos/` and thread clones in `~/.local/share/skel/threads/`, on one disk, so a thread's clone shares its files with the repository's.

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
- **Detaching.** skel's tmux config binds Ctrl-Q to detach with no prefix and hides the status bar, so attaching feels like being inside Claude Code.

## Not in this version

- Reviewing pull requests skel didn't open (a likely early addition)
- Roles, phases and flows as files
- Harnesses other than Claude Code, and Codex for the reviewer
- Windows, and threads on other machines
- Per-thread environments such as a database each (the `setup` commands only)
- Projects with their own memory beyond `AGENTS.md`
- Agents talking to each other, beyond skel telling the lead
- Triggers, schedules or automations
- Reaching you outside the lead's session, such as a `notify` command for your phone
- Slack, Linear, Jira or forges other than GitHub
- Errors from Sentry as tasks, planned as the launch after this one
- Threads started from plain text, without a task. They would be named with a marker, such as `app-t1`, so they never clash with a task's name
- Starting a thread by assigning an issue or mentioning skel on GitHub
- A remote protocol of our own (SSH only), teams and permissions

If something seems missing, ask instead of adding it.

## Milestones

Each one is something you use every day from the day it lands, and lands as small pull requests that pass `bun run check`. skel builds skel.

Already in: skel on a Linux server, one thread to a reviewed PR, parallel threads and needs you, follow-through on GitHub, `skel --remote` over SSH and on a Sprite, and the sidebar.

Launch milestones, in order:

1. **skel on a Mac.** The same skel, lead and flow on macOS, so you can install it on your laptop. The daemon runs as a launchd agent instead of a systemd service. Agents run in macOS's own sandbox, `sandbox-exec`, drawing the same boundary bubblewrap draws on Linux. Earlier versions of skel used it. The first run checks for `tmux`, `gh` and the harness, and says exactly what to install, such as `brew install tmux gh`. A laptop sleeps, so skel says once, after the first run, that work stops while the lid is closed, and that `skel --remote` keeps it going.
2. **Installables.** Every release builds skel for macOS and Linux, on arm64 and x64, and publishes the binaries with release notes. One line from skel.run installs the right one. `skel --version` says which release you have.
3. **Updates.** There will be a release most days, so updating works like Claude Code's: skel downloads and installs a new release in the background, and tells you. The sidebar shows a short notice, such as `skel 0.4.2 installed · restart to use it`. Leave with Ctrl-Q and run `skel` again, and skel restarts the daemon on the new release before attaching. Agents keep running through it, since their sessions live in tmux and only the daemon restarts. `skel --remote` keeps skel on a server or Sprite at the same release as the laptop.
4. **The first two minutes.** From the install line to a picked up issue, without reading anything but what skel prints. The first run is short and every step says what comes next. Once it is done, the lead says how to start work: add the `skel` label to an issue. skel looks for labeled issues as soon as a repository comes in, then often enough that a label is picked up within 2 minutes.
5. **Someone else installs it.** By Thursday 12 November, a developer who isn't Simon installs skel on their own machine and hands it a real issue, with no help. Everything that stops them is fixed before the launch.
6. **The launch.** A README with the install line, a quickstart, what agents can and can't touch, which accounts the harness and reviewer use, the known limits, and where to report bugs: GitHub issues. Record the video. Make the repository public on 16 November.

## Done when

Someone who isn't Simon installs skel on macOS or Linux from the README, with no help, and gets a reviewed PR from an issue they labeled, picked up within 2 minutes. `skel --remote sprite:<name>` takes them from there to a running lead on a Sprite with one command. The video runs as written, start to finish, with nothing faked. The repository is public.
