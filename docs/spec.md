# Skel rewrite spec

Nov 3, 2026 · @Simon

## Goal

skel is Claude Code, but always on, in parallel, isolated, and seeing each issue through to the merge.

You run `skel` and talk to your lead: a Claude Code session on your server that knows all your repositories. The lead writes issues and starts threads. Each thread works in one repository, as a builder agent in its own branch, worktree and sandbox. It opens a PR, a fresh reviewer agent reviews it adversarially, and they go back and forth until it is ready. CI failures and your PR comments wake the builder again. You merge.

There are no roles, phases or flows as files. We trust capable agents and add an adversarial review.

The repository starts with three documents: this spec, `AGENTS.md` for how to write code here, and `docs/learnings.md` for the traps to avoid. The code starts empty. Keep it small, plain and tested.

## Qualities

| Quality | What it means |
| --- | --- |
| Always on | skel runs on a server. Start and attach from your laptop, close the lid, and the work carries on. |
| Unattended, where it makes sense | Agents stay alive, wake on events, and only ask you when they need you. You approve and you merge. |
| Parallel | Many threads at once, across repositories, without juggling chat windows. |
| Isolated | Each thread gets a branch, worktree and sandbox. No tokens inside. |
| Connected | Issues come from GitHub and PRs go back to it. More tools can be added behind the same seam. |
| Build ⇄ review | A builder and a fresh adversarial reviewer loop until the change is ready. |
| In your harness | You stay in Claude Code. There is no new app to live in. |

## The demo

Everything in this version serves this two minute demo, recorded for real with a visible clock and a time lapse.

1. On the laptop: `skel --remote simon@workbox`. The lead opens, running on the server.
2. "Make issues for these two bugs in app and this one in site, and start them." The lead creates three GitHub issues in two repositories and starts three threads.
3. Close the laptop.
4. Open it later and run the same command. The lead says what happened: two PRs are reviewed and green, one of them after the builder fixed a failing check on its own. The third thread needs you: its builder has a question.
5. Attach to the third thread and answer its question. Merge the two PRs on GitHub. skel cleans up.

The demo repositories are small real apps with fast CI and real issues, not skel itself.

## Words

| Word | Meaning |
| --- | --- |
| Lead | Your Claude Code session on the server. One per machine, always running, across all your repositories. You talk to it; it writes issues and starts threads. |
| Repository | A GitHub repository you added with `skel init`. It has a short name, such as `app`. |
| Issue | An open GitHub issue in a repository. It states the intent: what you want, in words. skel lists every one; nothing happens until it is started. |
| Thread | The work on one issue: its branch, worktree, sandbox, builder session and history. One thread per issue at a time. Named by repository and issue, such as `app#12`. |
| Builder | The thread's agent. A Claude Code session that stays alive from start until the PR merges or closes. |
| Reviewer | A fresh Claude Code session for each review round, reading the PR adversarially. It never inherits the builder's context. |
| Event | Something that happened to a thread: a review, a PR comment, a failed check, a merge. |
| Needs you | A flag on a thread: the builder asked a question, review hit its round limit, or the PR is approved and green. |

A thread's status is one of `working`, `waiting` (on review, CI or you), `failed` or `done`. Needs you is a separate flag, so a thread can wait on CI and need you at once.

## Running skel

skel runs on a Linux server. `skel`, from any folder, attaches your terminal to the lead, and starts the daemon and the lead first if they are not running. Ctrl-\] detaches; the lead keeps running.

The repository you attach from is the lead's default, as the folder is for `claude` in a terminal. skel matches it by its GitHub name, and when it differs from last time, types a one line note into the lead, such as "you attached from app". "Fix the flaky test" then means app's, and every other repository stays in reach. Outside any repository there is no default. Inside one that isn't added, skel suggests `skel init` first.

**The first run.** The first `skel` on a machine takes two steps before the lead starts:

1. **Connect to GitHub.** If `gh auth status` fails, skel runs `gh auth login` in your terminal. skel uses that login for everything it does on GitHub, outside the sandbox.
2. **Pick a harness.** skel checks that the harness is installed and logged in, and saves the choice in `~/.config/skel/config.yaml`. In this version Claude Code is the only harness offered, but the question is asked so the choice is visible and stored.

Before the first step, skel checks that `tmux`, `bwrap`, `gh` and the harness are installed, and if one is missing, says exactly what to install instead of failing halfway. After the last step, it installs the daemon as a systemd user service and turns on lingering (`loginctl enable-linger`), so the daemon keeps running after you log out and starts again after a reboot.

Each step is skipped when it is already done, so running `skel` again goes straight to the lead. While no repository is added, `skel` says so and how to add one, with `skel init` in its folder, and starts the lead anyway.

For now, `skel` only wraps the harness: it sets up the lead and puts you in it, full screen. Later, issues and threads show next to the harness, in a sidebar beside the lead.

From a laptop, `skel --remote simon@workbox` runs `ssh -t simon@workbox skel --from <owner/repo>`, passing the GitHub name of the repository you are in on the laptop, so the lead knows it too. Any command works the same way: `skel --remote simon@workbox ls`. There is no protocol of our own; SSH (and Tailscale, if you use it) does the connecting.

Everything must work over a plain `ssh -t`: no local display, no browser on the same machine, no clipboard. Logins that need a browser, such as GitHub's and Claude's, use a code and a link you open on your laptop.

`skel init`, in a repository's folder, adds that repository (`skel init <path>` adds another). It checks that its `origin` remote is on GitHub and that your login can reach it, and takes its folder name as the short name (`--name` to choose another). It trusts the repository on its own when your GitHub login can push to it: agents will run its setup and test commands, and read its AGENTS.md and settings as instructions, and you already vouch for what is in it. For any other repository it asks whether you trust the folder. The answer is remembered in \~/.config/skel/, never in the repository, so a clone can't bring its own yes. Then it guesses the setup and test commands it can, such as `bun install` and `bun test` for a repository with a `bun.lock`, asks you to confirm or change them, and writes them to the repository's `skel.yaml` for you to commit. With no commands, it writes no file. It also adds `.skel/` to `.git/info/exclude`. `skel repo ls` lists repositories and `skel repo rm app` removes one.

The lead can add a repository too, when you ask for work in one that isn't added. It asks you to confirm, then runs `skel init` with a path or `owner/repo`, and goes over the setup and test commands with you in the conversation. A repository you can't push to then waits until you run `skel trust <name>` in your own terminal, since a yes from the lead could come from an injected instruction.

## The daemon

One daemon per machine, run by the systemd user service the first run installed. `skel serve` runs it in the foreground; the folder it is started in makes no difference.

1. If a daemon is already running, `skel serve` says so and exits, pointing you to `skel`.
2. If the first run isn't done, it exits and tells you to run `skel`. It never asks questions, since systemd has no one to answer them.
3. It opens the database, starts skel's tmux server, and reconnects to the lead and every live thread. A session that is gone is brought back with `claude --resume`.
4. It opens its socket at `$XDG_RUNTIME_DIR/skel.sock` for the CLI, and one socket per agent, mounted into that agent's sandbox, so skel knows which thread is calling.
5. It polls GitHub and logs to stdout, which systemd sends to the journal.

Stopping the daemon stops only the daemon. The tmux sessions keep running, so agents keep working through a restart or an upgrade, and the daemon reconnects to them when it comes back. Only `skel stop` ends a session.

## The flow

One thread, from start to merge.

1. **The lead starts an issue.** It runs `skel issue app "<title>" "<body>"` to create a GitHub issue, then `skel start app#12`. You can run both yourself too.
2. **skel sets up the thread.** Branch `skel/12-<slug>` from `main` (or `--from <branch>`), a worktree at `.skel/worktrees/12` in the repository, the repository's setup commands run once in it.
3. **The builder starts.** A Claude Code session in the sandbox, in the worktree, with the issue's title and body as its first message.
4. **The builder finishes a round.** It commits and runs `skel done "<summary>"`. skel pushes the branch. On the first round skel opens the PR, with `Closes #12` in its body.
5. **The reviewer reviews.** skel sets the `skel/review` status check on the commit to pending and starts a fresh reviewer session. It reads the diff against the base branch, runs the tests, and ends with `skel review approve "<body>"` or `skel review changes "<body>"`. skel posts it as a GitHub review and sets the check to success or failure, so branch protection can require it.
6. **Changes go back to the builder.** skel types the review into the builder's live session. The builder fixes, commits and runs `skel done` again. Back to step 4.
7. **After 3 rounds of changes, the thread needs you.** skel stops sending reviews to the builder until you say go on.
8. **Approved and CI green: the thread needs you.** Its status is `waiting`, on you.
9. **You merge on GitHub.** skel ends the builder session, removes the worktree and the local branch, and marks the thread `done`. A PR closed without merging does the same.

At any point the builder can ask you a question with Claude Code's own `AskUserQuestion`. skel notices, and the thread needs you until you attach with `skel attach` and answer it.

**Telling you.** When a thread starts needing you, skel types a one line note into the lead's session (when the lead is idle), so you hear it where you already are. An optional `notify` command (for example a curl to ntfy) reaches your phone.

## Events

The daemon polls GitHub with one GraphQL query per repository, fetching every open thread's PR with its reviews, comments, checks and merge state, so the number of requests doesn't grow with the number of threads. It polls every 30 seconds while a thread is active, and less often for threads that only wait on you. Webhooks may be added later as a faster wake-up, never as the only source, since deliveries are missed while the daemon is down. Calls go through `gh`. Each event is handled once: skel records the ID of the last review, comment and check run it acted on.

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
| `skel [--from <owner/repo>]` | Attaches to the lead, starting the daemon and the lead if needed, and tells it which repository you are in. `--remote` passes `--from` for you. |
| `skel --remote <host> [command]` | Runs any skel command on the server, over `ssh -t`. |
| `skel serve` | Runs the daemon in the foreground, for systemd. One per machine. |
| `skel init [<path> \| <owner/repo>] [--name <name>]` | Adds a repository and its setup and test commands. `skel repo ls` and `skel repo rm <name>` list and remove. |
| `skel trust <name>` | Trusts a repository your login can't push to, after the lead added it. Only you can run it. |
| `skel ls [<repo>]` | Open issues and threads, with status and needs you, newest first. `--json` for tools. |
| `skel issue <repo> "<title>" "<body>"` | Creates a GitHub issue and prints its number. |
| `skel start <repo>#<issue> [--from <branch>]` | Starts a thread on an issue. |
| `skel attach <repo>#<issue>` | Attaches your terminal to the builder's session. Ctrl-\] detaches. |
| `skel say <repo>#<issue> "<text>"` | Types a message into the builder's session without attaching. |
| `skel stop <repo>#<issue>` | Ends the session and keeps the worktree, branch and PR. |
| `skel resume <repo>#<issue>` | Starts the builder again with `--resume` on its last session. |

For agents inside a thread:

| Command | Who | What it does |
| --- | --- | --- |
| `skel done "<summary>"` | Builder | Ends a round: skel pushes, opens the PR if needed, starts a review |
| `skel review approve "<body>"` | Reviewer | Posts an approving review and passes the check |
| `skel review changes "<body>"` | Reviewer | Posts a review requesting changes and fails the check |

Agents talk to the daemon over a socket mounted into their sandbox, which also tells skel which thread they belong to. The lead and the agents never call GitHub themselves.

Settings come in two layers, and both are optional. `~/.config/skel/config.yaml` holds your defaults:

```yaml
harness: claude
builder:  { model: opus }
reviewer: { model: opus }
max_rounds: 3
notify: curl -d "$SKEL_MESSAGE" ntfy.sh/my-topic
```

A repository's `skel.yaml` holds what that repository needs, and can override the defaults:

```yaml
setup: [bun install]
test: [bun test]
```

## State and isolation

**Sessions.** Every agent runs in tmux, on skel's own tmux server (`tmux -L skel`) with skel's own config: one session for the lead and one per builder and reviewer. tmux keeps them alive, handles attach and detach, and answers the terminal's queries. skel never runs its own terminal emulator.

**State.** One SQLite file per machine, `~/.local/share/skel/skel.db`, with `bun:sqlite`. It holds repositories (name, path, GitHub owner and name) and threads (repository, issue, branch, worktree, status, needs you, round count, builder session ID, PR number), and the last handled ID per event kind. Every change is also appended to `~/.local/share/skel/threads/<repo>-<issue>.log` as one JSON line, so a thread's history can be read and replayed. Open issues are not stored; `skel ls` asks GitHub. Worktrees live inside each repository, in `.skel/worktrees/`, on the same disk as the clone.

**Surviving restarts.** When the daemon starts, it brings back the lead and every thread that was `working` or `waiting` with `claude --resume <session>`, and polling picks up any event it missed.

**Isolation.** Each thread gets its own branch and worktree. Each agent runs inside bubblewrap: its folder is writable, the rest of the system is read-only, your home folder and credentials are hidden. The lead works in its own folder in `~/.local/share/skel/lead/` and sees every added repository read-only, so it can plan across them while the work happens in threads. The reviewer's worktree is read-only too.

**Tokens stay out.** Agents never see your GitHub token. They don't push or call GitHub. They call skel commands, and the daemon, outside the sandbox, pushes and posts with your `gh` login. Commits are authored by you, with skel as co-author.

**One seam for GitHub.** All GitHub calls live in one module, so Linear, local issues or another forge can be added later without touching the flow.

## Building blocks

These are the parts that need care. `docs/learnings.md` explains the traps behind each one.

- **Typing into a session.** Wait until the pane is quiet (compare `tmux capture-pane` a moment apart), load the text with `tmux load-buffer`, paste it with `tmux paste-buffer -p` so it arrives as a bracketed paste, then send Enter on its own a moment later.
- **The sandbox.** bubblewrap with the agent's folder writable, the rest of the system read-only, and the home folder and credentials hidden. Claude Code shares your login and transcripts in `~/.claude`, sees your settings, hooks, plugins and skills there read-only, and gets a throwaway copy of `~/.claude.json`. Its own permission prompts and sandbox are turned off, since skel's sandbox draws the boundary.
- **Starting Claude Code.** Remove inherited `CLAUDE_CODE_*` variables. Mark the folder as trusted in the session's copy of its settings, or it waits at a question nobody sees. Pass the first message on the command line.
- **Agent commands.** Every command an agent can run answers quickly: Claude Code moves a shell command to the background after 2 minutes.
- **Detaching.** skel's tmux config binds Ctrl-\] to detach with no prefix and hides the status bar, so attaching feels like being inside Claude Code.

## Not in this version

- Issues and threads shown next to the harness (the sidebar comes later)
- Reviewing pull requests skel didn't open (a likely early addition)
- Roles, phases and flows as files
- Harnesses other than Claude Code
- macOS, and threads on other machines
- Per-thread environments such as a database each (the `setup` commands only)
- Projects with their own memory beyond `AGENTS.md`
- Agents talking to each other, beyond skel telling the lead
- Triggers, schedules or automations
- Slack, Linear, local issues or forges other than GitHub
- Starting a thread by assigning or mentioning on GitHub
- A remote protocol of our own (SSH only), teams and permissions

If something seems missing, ask instead of adding it.

## Milestones

Each one is something you use every day from the day it lands, and lands as small pull requests that pass `bun run check`. From milestone 2 on, skel builds skel.

1. **skel on the server.** You `ssh workbox` yourself and run `skel`. The first run, the daemon as a systemd user service, `skel serve`, `skel init`, `skel repo`. The lead runs in bubblewrap inside tmux and sees your repositories. Ctrl-\] detaches, and logging out leaves everything running. This replaces herdr plus Claude.
2. **One thread to a reviewed PR.** `skel issue`, `skel start`, `skel ls`, `skel attach`, `skel done`, `skel review`. Builder and reviewer loop, skel pushes and opens the PR, the `skel/review` check, the round limit, needs you when approved.
3. **Parallel and needs you.** Several threads at once across repositories, the note in the lead's session, `notify`, questions marked needs you, `skel say`, the lead knowing which repository you attached from.
4. **Follow-through.** Polling for failed checks, PR comments, conflicts and merges. Cleanup on merge or close. Surviving a restart with `--resume`. `skel stop`, `skel resume`.
5. **Remote.** `skel --remote <host>` from the laptop. When skel is missing on the server, it offers to copy its binary there with `scp`. `skel init` also accepts `owner/repo` and clones it into `~/code/` with `gh repo clone`. The lead adds repositories when you ask for work in one, and `skel trust`. From an empty server to a running lead with one command.
6. **The demo.** Pick the demo repositories and their issues, run the script for real, record it.

## Done when

The demo runs as written, start to finish, with nothing faked: three issues in two repositories from one sentence to the lead, the laptop closed, two reviewed green PRs and one question waiting when it opens again, one CI failure fixed by its builder, and the worktrees gone after you merge.

