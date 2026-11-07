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
| Isolated | Each thread gets a branch, clone and sandbox. Your own checkouts are never touched. No GitHub token inside, and no secret you didn't give that repository. |
| Connected | Tasks come from GitHub issues and PRs go back to it. More tools can be added behind the same seam. |
| Build ⇄ review | A builder and a fresh adversarial reviewer on another model loop until the change is ready. A model reviewing its own work shares its blind spots. |
| In your harness | You stay in Claude Code. There is no new app to live in. |

## The launch

skel launches as a beta on Monday 16 November 2026. It is a quiet launch: the repository goes public, skel installs on macOS and Linux, and a first video shows it working. Many small launches follow, each with a short video, and we reach out to developers directly. Windows comes later.

Everything until then serves two moments, and the launch is ready when someone who isn't Simon gets through both on their own machine, with no help.

1. **Install it on your laptop, and it is useful at once.** One line installs skel. The first `skel` connects GitHub and the harness and opens the lead. Add the `skel` label to an issue on GitHub, and within 2 minutes skel picks it up, starts a thread and says so. A reviewed PR follows.
2. **Move it to a server.** `skel remote add sprite:<name>`, or `skel remote add <host>` for a server of your own, sets the machine up and prints the command that connects to it. Run that, and the work carries on with the laptop closed.

Until the launch, the work is making these two moments smooth, fixing the bugs people hit on the way, polishing what they see, and building skel for macOS and Linux. Anything that doesn't serve them waits until after the launch. If something seems missing, ask instead of adding it.

**The video.** Recorded for real, with a visible clock and a time lapse.

1. On a Mac: run the install line, then `skel` in a checkout of app. The first run, then the lead.
2. On GitHub, add the `skel` label to an issue in app. Within 2 minutes skel starts a thread, and the lead says so. A reviewed PR follows.
3. On the laptop: `skel remote add sprite:demo`. The first run there, then skel prints `skel --remote sprite:demo`. Run it, and the lead opens, running on a Sprite.
4. On GitHub, add the `skel` label to two issues in app and one in site. Within a minute skel starts three threads, and the lead says so.
5. Close the laptop.
6. Open it later and run `skel --remote sprite:demo` again. The lead says what happened: two PRs are reviewed and green, one of them after the builder fixed a failing check on its own. The third thread needs you: its builder has a question.
7. Pick the third thread in the sidebar and answer its question. Merge the two PRs on GitHub. skel cleans up.

The repositories in the video are small real apps with fast CI and real issues, not skel itself.

## Words

| Word | Meaning |
| --- | --- |
| Lead | Your Claude Code session on the server. One per machine, always running, across all your repositories. You talk to it; it writes tasks and starts threads. |
| Repository | A GitHub repository skel works on, from a clone of its own. It is named by its GitHub name, such as `app`, with the owner added (`simon/app`) only when two share a name. |
| Task | What you want done, in words, as an item in the tracker you connect skel to. skel is made to work from a tracker, and keeps no tasks of its own: you plan where you already do. Each tracker keeps its own word: in this version the tracker is GitHub, where a task is an open issue. A task can exist without a thread: one you create on GitHub shows up in skel, and nothing happens until it is started, with `skel start` or the `skel` label. |
| Thread | skel's core: the work on one task, from its first message to the merged PR. Its branch, clone, sandbox, builder session and history. One thread per task at a time. Named by the task's own ID in its tracker, with the repository added when that ID doesn't name one: GitHub issue #12 in app is `app-12`, since its number is only unique within app, while a tracker whose IDs are already unique, such as Linear's `JOTT-12`, would keep its own. A thread never gets a second number, so the name in skel is always the one in the tracker. A dash, because no shell reads a dash as anything special, so it never needs quoting. |
| Builder | The thread's agent. A Claude Code session that stays alive from start until the PR merges or closes. |
| Reviewer | A fresh agent for each review round, on Codex by default, reading the PR adversarially. It runs once and answers with a verdict, with no session to attach to. It never inherits the builder's context. |
| Secret | A value a repository's commands need, such as a test API key, which you give skel for that one repository. Its builders and reviewers can use it. The lead can't. |
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

On a server or Sprite, `skel remote add` runs these steps from your laptop and installs the daemon. The lead starts at the first `skel --remote`.

**The sidebar.** `skel` puts a narrow sidebar on the left of your terminal, with the agent you are looking at on the right. The sidebar lists the lead first, then every thread that isn't done, each on two lines: a mark and its full name, then, dim, a word for what it is doing and the harness doing it, such as `approved · claude`. While a review runs that is `reviewing · codex`, so you can see which agent has the thread right now. A thread whose word is `working` also ends that line with how long ago it started: `<1m`, then `5m`, `2h`, `3d`, such as `working · claude · 5m`. No other row shows a time, the lead included, as a time would write to the terminal each minute, and on a Sprite a terminal that stays quiet lets it sleep. The row you are looking at has a grey background across the whole sidebar, on all its lines. Headings, marks and hints start two columns in, and all text stops two columns before the sidebar's edge, which matches the one blank row at the top, as a terminal cell is about twice as tall as wide. It updates on its own. At the bottom, three dim lines show the keys: `⌥↑↓ move`, `⌥⇧↑↓ list` and `⌃Q quit`. They are always there, except on a terminal too short for them and a whole row, where the row comes first.

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

The lead's mark is `◆`. Every thread's mark is a circle: a green `●` while it works, a yellow `●` when it needs you, a red `●` when it failed, and a dim `○` while it waits or after it stopped. A thread that failed stays red even if it also needs you. The word under the name always says what's going on, so nothing is told by colour alone. The word is yellow too on a thread that needs you, and dim otherwise. These words only describe the thread: its status and needs you stay as they are.

Above the agent, a strip of one line says what you are looking at. For a thread, it has its name, its task's title, its PR's number, whether its checks pass, and its latest review: the round, the reviewer and the verdict, such as `round 2 · codex · approved`. So you can see that a review ran, and how it went, without leaving the agent. As room runs out, the title gives way first, then the review. For the lead, the strip is empty, as the sidebar already shows what needs you. While a page shows, it has the row's name and title. It is always there, so the agent's height doesn't change as you switch.

Above the sidebar, on the same line as the strip, `skel` is in bold white, in line with the marks. On a remote it goes on, dim, with a dot and the name you gave `--remote`: `skel · sprite:demo`, or `skel · simon@workbox`. On your own machine it is just `skel`. A release also shows its number, dim, right after the name: `skel 0.4.2 · sprite:demo`, or `skel 0.4.2`. It is the release of the skel running there. A build from a checkout shows no number. When room runs out the place is cut first. The header has no blank rows above or below it: the thin line sits in the middle of its row, so half a row falls on each side of it, and your terminal's own padding gives about the same above. A thin, faint line runs under all of this, across the whole terminal, and joins the line at the sidebar's right edge. One empty column parts that edge from the agent.

Pick a row to look at it. Click it, or move from anywhere, even while typing to an agent. Alt-Up and Alt-Down move one row, carrying on through all three lists, top to bottom. Alt-Shift-Up and Alt-Shift-Down jump to the first row of the previous or next list. Moving lands only on rows you can see, and steps over an agent that isn't running. The right side switches at once, and on a thread you type straight to its agent. So answering a builder's question is one click, with nothing to detach from. Ctrl-Q leaves the whole screen, and everything keeps running. skel then prints one line: `Your agents keep running. Run skel to come back.`

The sidebar has three lists, the three stages of a task: ISSUES, THREADS and PRS. The rows described above are THREADS. Each list shows what is really open, on its own, so a task in review is in all three, and a row goes when what it stands for ends. A PR's merge usually ends all three at once, since it ends the thread and closes the issue. Nothing has to match: a thread can have no issue or no PR yet, and a PR can have no thread.

- **ISSUES** are the open issues in your repositories, as `skel task ls` shows them, newest first. Those with a thread are dim and come last, so what is waiting stands out.
- **PRS** are the open PRs in your repositories, newest first, including ones skel didn't open. A PR from a thread shows the same mark and word as its thread. A PR with no thread shows a dim `○`.

Each row of ISSUES and PRS has two lines, like a thread's. An issue has no mark, so its lines start where the `Issues` heading does. A PR has its mark where a thread's mark is, and its lines start where a thread's name does. The first is the title, cut with `…` to fit. The second, dim, is the name, such as `app-24` or `app#26`, and a PR from a thread adds its word, in the colour a thread's word has: `app#26 · approved`.

It is an overview, never a replacement for the tracker or GitHub. A row with no agent is a terminal link, so Cmd-click opens it in your browser, since skel may run on another machine than your browser. A plain click does the same as moving to it: it shows the row's page. Each list shows as many rows as fit its third, then a count of the rest, leaving out dim rows first. skel asks GitHub for these lists only while a screen is open, so they never keep a Sprite awake. They come in the daemon's usual poll and query, and it saves them, so the sidebar only reads the database and never asks GitHub itself. A screen opening brings a poll at once, so the lists fill within seconds rather than at the next poll.

List headings are dim, written `Issues`, `Threads` and `PRs`, with one blank line between a heading and its first row. Rows sit together, with no blank lines between them. A thin line parts one list from the next, in the faint colour of the sidebar's edge, and joins that edge. ISSUES, THREADS and PRS each have one third of the sidebar's height, above the keys, whether or not they are full, so each list stays in the same place on screen. What doesn't divide goes to THREADS. A list with nothing in it keeps its third and its heading, and says `none`, dim. THREADS scrolls inside its third, always keeping the row you are on in view. On a terminal too short for a third to hold a heading, its blank line and one row, or for THREADS to hold the row you are on, ISSUES and PRS go, and THREADS has the whole sidebar, with no heading, as it is the list you move through.

Landing on a row of ISSUES or PRS shows its page on the right, in place of the agent. An issue's page has its title, state, author, labels, description and a link to GitHub. A PR's page has its title, state, branch, checks, latest review, description and a link to GitHub. A page is read-only, with no diff and no comments. The wheel scrolls it, and typing goes nowhere. Moving back to a thread puts you straight in its agent. skel asks for a page once, when you land on its row, and the daemon asks GitHub, so a page sitting open writes nothing to the terminal and lets a Sprite sleep. What GitHub returns comes from outside, so its control codes are removed before it reaches your terminal.

The sidebar only shows, switches, links and opens pages. It has no commands of its own, and creates, starts and stops nothing: you ask the lead, or run `skel`.

**A new machine.** `skel remote add simon@workbox` is how a server joins skel. It first says what it will do. Then it puts skel there and runs the first run on that machine. It ends by printing the command that connects, and doesn't connect: `skel --remote simon@workbox`. The skel it puts there is the laptop's release, built for that machine, or one built from your checkout when you run skel from one. skel keeps no list of remotes, as the machine itself shows whether it is set up. Running it again is safe, and picks up whatever a run that stopped partway left undone.

From a laptop, `skel --remote simon@workbox` runs `ssh -t simon@workbox skel --from <owner/repo>`, passing the GitHub name of the repository you are in on the laptop, so the lead knows it too. Any command works the same way: `skel --remote simon@workbox ls`. There is no protocol of our own; SSH (and Tailscale, if you use it) does the connecting.

`--remote` only connects, and never sets a machine up. On a machine where skel is missing, or its first run hasn't finished, it says so and prints the `skel remote add` to run. A mistyped name never creates or installs anything.

`--remote` also keeps skel there up to date. The skel it copies to a server or Sprite carries the commit it was built from, and each command passes along the laptop's. When they differ, or either has changes not committed, skel asks before running the command: "skel on sprite:demo is from abc1234, yours is def5678. Update it?" Yes replaces skel there with one built from your checkout and restarts the daemon, and agents keep running. No runs the command on the old skel. A skel run from a checkout there is never offered an update: `git pull` there updates it.

**On a Sprite.** `skel remote add sprite:demo` and `skel --remote sprite:demo` do the same with Fly.io's `sprite` command in place of `ssh`, so you need no server of your own. `skel remote add sprite:demo` goes from nothing to a Sprite that is ready:

1. **It checks the laptop**: that `sprite` is installed and logged in. It lists everything that is missing with the command that fixes it, such as `sprite login`, creates nothing, and ends with the command to run again.
2. **It asks before creating the Sprite**: "No Sprite named demo. Create it?", so a mistyped name never makes a second one you pay for.
3. **It sets the Sprite up**: installs bubblewrap, puts skel there, and makes the Sprite's URL public, so GitHub's webhooks can wake it.
4. **It runs the first run inside the Sprite**, then prints `skel --remote sprite:demo`.

After that, `skel --remote sprite:demo` attaches to the lead, and `skel --remote sprite:demo ls` runs any command there, waking the Sprite if it sleeps. In a terminal, skel first prints `skel · connecting to sprite:demo…`, as waking can take a while.

Everything must work over a plain `ssh -t` or `sprite console`: no local display, no browser on the same machine, no clipboard. Logins that need a browser, such as GitHub's and Claude's, use a code and a link you open on your laptop.

**Repositories.** skel keeps its own clone of every repository it works on, in `~/.local/share/skel/repos/<owner>/<repo>/`, and keeps it at the latest default branch. A repository comes in the first time you work on it: when you run `skel` in a checkout of it, or when a command names it by its full GitHub name, such as `skel task ls skelcrew/skel-github`. After that its short name works everywhere. So when you ask the lead for work in another repository, it brings it in by running one of those, after asking you. There is no command to add a repository. `skel repo ls` lists them and `skel repo rm <name>` removes skel's clone.

Before cloning, skel decides whether to trust the repository. It trusts it on its own when your GitHub login can push to it, unless it is a fork: agents will run its setup and test commands, and read its AGENTS.md and settings as instructions, and you already vouch for what is in it. For any other repository, `skel` run in a checkout of it asks you whether you trust it. Brought in any other way, it waits until you run `skel repo trust <name>` in your own terminal, since a yes passed on by the lead could come from an injected instruction. The answer is remembered in \~/.config/skel/, never in the repository, so a clone can't bring its own yes.

A repository can say how to set up and test it in a committed `skel.yaml`. Without one, the builder works it out, as it would in any checkout. A committed file never holds a secret, and can't ask for one: see Secrets.

## The daemon

One daemon per machine, run by the systemd user service or Sprite service the first run installed. `skel serve` runs it in the foreground; the folder it is started in makes no difference.

1. If a daemon is already running, `skel serve` says so and exits, pointing you to `skel`.
2. If the first run isn't done, it exits and tells you to run `skel`. It never asks questions, since systemd or the Sprite has no one to answer them.
3. It opens the database, starts skel's tmux server, and reconnects to the lead and every live thread. A session that is gone is brought back with `claude --resume`.
4. It opens its socket at `$XDG_RUNTIME_DIR/skel.sock` for the CLI, and one socket per agent, mounted into that agent's sandbox, so skel knows which thread is calling.
5. It polls GitHub and logs to stdout, which systemd sends to the journal.
6. On a Sprite, it keeps the Sprite awake while there is work: a builder working, a review running, or a PR waiting on CI. It holds a task on the Sprite's control socket that expires a few minutes after its last renewal, so if the daemon dies, the hold expires too. Once every thread waits on you or is done, it lets the Sprite sleep, which costs nothing for compute. A GitHub webhook to the Sprite's URL wakes it when you comment on or merge a PR, and polling then picks up the event. A webhook that never arrives is caught when the Sprite next wakes, for example at your next `skel --remote`.

The tmux sessions keep running when the daemon stops, so agents keep working through a restart or an upgrade, and the daemon reconnects to them when it comes back. What the daemon itself started, such as a clone or a reviewer, ends with it, and the next daemon starts that work again. Only `skel stop` ends a session.

## The flow

One thread, from start to merge.

1. **A task is started.** You add the `skel` label to an issue on GitHub, from anywhere, even your phone. Or the lead runs `skel task create app "<title>" "<body>"`, which creates a GitHub issue, then `skel start app-12`. You can run both yourself too.
2. **skel sets up the thread.** A clone of its own at `~/.local/share/skel/threads/app-12/`, made from skel's clone of the repository, on branch `skel/12-<slug>` from `main` (or `--from <branch>`), with the repository's setup commands run once in it, with the repository's secrets if the thread gets them.
3. **The builder starts.** A Claude Code session in the sandbox, in the thread's clone, with the task's title and body as its first message. Its instructions name the secrets it can use, if any.
4. **The builder finishes a round.** It commits and runs `skel submit "<summary>"`. skel fetches the branch from the thread's clone into its own and pushes it from there, never running git inside the thread's folder. A commit holding a secret isn't pushed, and the builder is told. On the first round skel opens the PR, with `Closes #12` in its body.
5. **The reviewer reviews.** skel sets the `skel/review` status check on the commit to pending and runs a fresh reviewer once, in the sandbox, with `codex exec` (or `claude -p` without Codex). It is given the task and the names of the secrets it can use, reads the diff against the base branch, runs the tests, and answers in a fixed JSON shape: approve or changes, and the review's body. skel posts it as a GitHub review and sets the check to success or failure, so branch protection can require it. Reviews run one at a time, since they share skel's Codex login, and a renewal by one could leave the others with a token that no longer works. A review covers the commit it started for: a newer `skel submit` cancels a review still waiting or running. A reviewer that fails, answers outside the shape, or runs past 30 minutes sets the check to failure with "review failed", and the thread needs you. You or the lead can rerun a review with `skel review`, such as after a review that failed.
6. **Changes go back to the builder.** skel types the review into the builder's live session. The builder fixes, commits and runs `skel submit` again. Back to step 4.
7. **After 3 rounds of changes, the thread needs you.** skel stops sending reviews to the builder until you say go on, with `skel start`.
8. **Approved and CI green: the thread needs you.** Its status is `waiting`, on you.
9. **You merge on GitHub.** skel ends the builder session, removes the thread's clone, and marks the thread `done`. A PR closed without merging does the same.

At any point the builder can ask you a question with Claude Code's own `AskUserQuestion`. skel notices, and the thread needs you until you pick it in the sidebar and answer it.

**Telling you.** When a thread starts needing you, skel types a one line note into the lead's session (when the lead is idle), so you hear it where you already are.

## Events

The daemon polls GitHub with one GraphQL query per repository, fetching every open thread's PR with its reviews, comments, checks and merge state, so the number of requests doesn't grow with the number of threads. While a screen is open, the same query brings the open issues and PRs for the sidebar. It polls every 30 seconds while a thread is active, and less often for threads that only wait on you. Webhooks are a faster wake-up, never the only source, since deliveries are missed while the daemon is down. On a server they may be added later; on a Sprite they wake it from sleep. Calls go through `gh`. Each event is handled once: skel records the ID of the last review, comment and check run it acted on.

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
| `skel --remote <host> [command]` | Runs any skel command on the server, over `ssh -t`. With `sprite:<name>` as the host, runs it on that Sprite instead. Keeps skel there up to date with your checkout, after asking. |
| `skel remote add <host>` | Sets up a server, or with `sprite:<name>` a Sprite, creating it after asking if it doesn't exist. Runs the first run there and prints the `skel --remote` command that connects. Run it on your laptop. |
| `skel serve` | Runs the daemon in the foreground, for systemd or a Sprite service. One per machine. |
| `skel repo ls` | Lists the repositories skel works on, with their short names. |
| `skel repo rm <name>` | Removes skel's clone of a repository and its secrets. It refuses while the repository has live threads, and names them. Only you can run it: the lead never needs to, and asks you instead. |
| `skel repo trust <name>` | Trusts a repository your login can't push to, so skel clones it. Only you can run it. |
| `skel secret add <repo> <NAME>` | Asks for a secret's value without showing it, and saves it for that repository, replacing any value it had. Only you can run it, in your own terminal, for a repository you can push to. |
| `skel secret ls [<repo>]` | Lists secrets by repository and name, never their values. Only you can run it. |
| `skel secret rm <repo> <NAME>` | Removes a secret. It doesn't revoke the key: do that where it was issued. Only you can run it. |
| `skel task ls [<repo>]` | Open tasks, newest first, with the thread on each one if it has one. `--json` for tools. |
| `skel task show <repo>-<task>` | A task's title and body, which is all its builder sees, with its thread if it has one. `--json` for tools. |
| `skel task create <repo> "<title>" "<body>"` | Creates a task, as a GitHub issue, and prints its name, such as `app-13`. It doesn't start a thread. |
| `skel ps [<repo>]` | Threads, with status and needs you, newest first. Done threads only with `--all`. `--json` for tools. |
| `skel start <repo>-<task> [--from <branch>]` | Starts a thread on a task. On a stopped thread, resumes it: starts its builder again with `--resume` on its last session. On a thread past the round limit, lets it go on: counts its rounds from zero again and types the last review's changes into the builder. |
| `skel attach <repo>-<task>` | Opens the same screen as `skel`, with that builder on the right. Ctrl-Q detaches. |
| `skel review <repo>-<task>` | Reviews the thread's last submitted commit again, as a round's review, such as after a review that failed. It refuses while a review of it is waiting or running. |
| `skel stop <repo>-<task>` | Ends the session and keeps the clone, branch and PR. |

For the builder and reviewer inside a thread:

| Command | Who | What it does |
| --- | --- | --- |
| `skel submit "<summary>"` | Builder | Submits a round for review: skel pushes, opens the PR if needed, starts a review |
| `skel secret run <command>` | Builder, reviewer | Runs a command with the repository's secrets in its environment, and masks them in what it prints |

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

**The screen.** The sidebar lives in a second tmux server, `tmux -L skel-screen`, one session per open terminal, ended when you leave. Its left pane runs the sidebar, on a server with terminal links turned on (the `hyperlinks` terminal feature), and draws the line at its own right edge, as tmux's border is blank. tmux has two status lines: the header above the sidebar and the strip share the first, and the thin line under them is the second. Its right pane is an ordinary tmux client attached to the agent's session on `tmux -L skel`, and picking a row switches that client to another session. Landing on an issue or PR replaces that client with a small `skel page` command, in the same pane, and moving back to a thread starts a client again. So a page lives and ends with the screen, on your side, outside any sandbox. Agents' sessions stay single-pane and know nothing of the screen: typing into them, reading them and checking them work as if it weren't there, and leaving the screen ends nothing.

**State.** One SQLite file per machine, `~/.local/share/skel/skel.db`, with `bun:sqlite`. It holds repositories (name, GitHub owner and name, how many issues and PRs are open) and threads (repository, task, branch, status, needs you, round count, builder session ID, PR number, when it started, whether it gets secrets), and the last handled ID per event kind. Every change is also appended to `~/.local/share/skel/threads/<repo>-<task>.log` as one JSON line, so a thread's history can be read and replayed. That includes each review's round, reviewer, verdict and first line. The strip shows all but the first line. skel keeps no tasks of its own. It saves only a copy of each repository's newest open issues and PRs for the sidebar, which it replaces at each poll while a screen is open. `skel task ls` asks GitHub. Repository clones live in `~/.local/share/skel/repos/` and thread clones in `~/.local/share/skel/threads/`, on one disk, so a thread's clone shares its files with the repository's.

**Surviving restarts.** When the daemon starts, it brings back the lead and every thread that was `working` or `waiting` with `claude --resume <session>`, runs again every review whose `skel/review` check is still pending, and polling picks up any event it missed.

**Isolation.** Each thread gets its own branch and clone, so nothing a builder does in it reaches your checkouts, skel's clone or another thread. Each agent runs inside bubblewrap: its folder is writable, the rest of the system is read-only, your home folder and credentials are hidden, and only a repository's own secrets come back, for those who get them. The lead works in its own folder in `~/.local/share/skel/lead/` and sees skel's clone of every repository read-only, including ones brought in while it runs, so it can plan across them while the work happens in threads. The reviewer sees the thread's clone through a throwaway layer, so it can run the tests but changes nothing.

**Tokens stay out.** Agents never see your GitHub token. They don't push or call GitHub. They call skel commands, and the daemon, outside the sandbox, pushes and posts with your `gh` login. Commits are authored by you, with skel as co-author. An agent can read the login its harness runs on, as the harness needs it, and so can the code it runs.

**One seam for GitHub.** All GitHub calls live in one module, so Linear, Jira, local tasks or another forge can be added later without touching the flow.

**One seam for Sprites.** Creating a Sprite, running commands on it and keeping it awake live in one module, so other machines that skel creates or that sleep can be added later without touching the flow.

## Secrets

A builder or reviewer sometimes needs a value skel can't give it any other way: a token to install from a private package registry, or a test API key for tests that call a real service. A secret is such a value, which you give skel for one repository. Most repositories need none, and then nothing here shows.

Secrets are for what a repository runs in the sandbox: its setup commands, its tests, and a tool the builder uses, such as a payment provider's command line in test mode. skel's own logins are not secrets, and neither is a token only the daemon uses.

**Adding one.** `skel secret add app STRIPE_TEST_KEY` asks for the value without showing it, as the first run asks for the Claude token, then says "Agents working on app can read this. Use a key you can replace, never a production one." The command takes no value as an argument, so a value never lands in your shell's history or a process list. It refuses to run inside a sandbox or without a terminal, so neither the lead nor an agent can hand one in. A value is one line of at least 8 characters, so that masking it is exact and doesn't garble ordinary output. A key that is a file goes in as base64, and the repository's tests decode it.

A value is never shown again. `skel secret ls` shows names only, and adding a name again replaces its value. When a builder needs a secret it doesn't have, it asks you, and the thread needs you, as for any question. You run `skel secret add` in your own terminal and answer, and the builder goes on, with no restart. A value pasted into the lead or a builder has already gone to the model, so replace it.

**Never a GitHub token.** `skel secret add` refuses the names `GH_TOKEN` and `GITHUB_TOKEN`, any value with the start of a GitHub token, such as `ghp_` or `github_pat_`, and the value of your `gh` login. So packages on GitHub Packages and private GitHub repositories as dependencies stay out of an agent's reach. This catches a mistake, and can't recognise every token.

**Which repositories.** A secret belongs to one repository, by its full GitHub name. There are no secrets for all repositories, so one brought in later starts with none. `skel secret add` asks GitHub first, and works only for a repository your login can push to and that isn't a fork. `skel repo trust` isn't enough: someone else decides what that repository's setup commands do. Everyone who can push to a repository can run code with its secrets, as with secrets in CI.

What a repository may use is written only on your machine. `skel.yaml` has no setting for secrets, and nothing in a clone can ask for one, so a clone can't get a secret you never gave it, and a fork, with a full name of its own, starts with none.

**Which agents.** A repository's setup commands, builders and reviewers all get its secrets. The reviewer runs the same tests as the builder, and all it runs is code the builder wrote with the same secrets in reach. The lead never gets one: it reads every repository and every issue.

A thread whose task was written by someone who can't push to the repository gets none. On a public repository anyone can write an issue, and a label only says someone wanted it done, so this text is the easiest way to steer an agent. skel looks at the issue's author once, as the thread starts, and saves the answer with the thread. Its builder and reviewer work on without secrets. To run that task with them, read it and write a task of your own.

**How a secret reaches a command.** Never through the agent's own environment. The repository's folder of secrets is mounted read-only in the sandbox, and `SKEL_SECRETS` says where. `skel secret run <command>` runs one command with the secrets as environment variables, for it and what it starts: `skel secret run bun test`. skel runs setup commands this way on its own. The builder's and reviewer's instructions list the secrets by name and tell them to use `skel secret run`. So a stray `env` or a debug line in the agent's shell shows nothing, and the harness never holds a value. Because the folder is mounted, rather than each file, a secret added or removed reaches a running builder at once. A process already running keeps what it was given.

`skel secret run` needs no daemon or socket, so it works in a review too. It runs in the agent's own shell, and takes as long as its command does.

**Keeping secrets out of what skel keeps and sends.** skel replaces an exact value with `[secret NAME]` wherever the text passes through it:

- In the output of `skel secret run`, line by line, before the agent reads it. This is what stops a key a test prints from reaching the model.
- In what skel writes or sends: the PR's body, a review's body, what it types into a builder, and the thread's log.

A commit holding a value is never pushed. Before pushing, skel reads the new commits in its own clone, their messages included. If one holds a value, it pushes nothing and tells the builder which secret it found and to take it out of the branch's history. Once on GitHub, a value can't be taken back.

**What this can't protect.** The README says this too.

- **An agent can read every secret it is given.** The folder is there to read, and a command can print a value in a way masking doesn't catch. `skel secret run` guards against accidents, as the sandbox guards against mistakes and overreach, not against an agent set on it.
- **Nothing stops a secret leaving.** The network is open, as agents need their model and package registries. An agent steered by text in a repository, a dependency or a web page can send a secret anywhere, and so can a test. skel doesn't filter the network: one allowed host can be enough to carry a value out, and the rule would differ on Linux, a Sprite and a Mac.
- **Masking matches exact values.** A value encoded or split passes through. A value an agent reads by other means goes to its model's company, and stays in its transcript. skel never rewrites transcripts.

So the protection is in what you give. Use a key with a test mode, a spending limit or a narrow scope, and one you can revoke. After a leak, revoke it where it was issued: `skel secret rm` only stops later use.

**Where they are kept.** In `~/.config/skel/secrets/<owner>/<repo>/<NAME>`, one plain file per secret, readable only by you, like the Claude token beside it. The daemon has to read them with nobody there, on servers and Sprites that have no keyring, so a passphrase can't work, and encrypting with a key kept beside the file would add nothing. A Mac's Keychain would be a second way of storing for one system, and could stop an unattended daemon at a prompt each time a release changes the program. The sandbox hides this folder, apart from the repository's own. Plain files keep secrets from other accounts and from agents you gave nothing, but not from programs you run yourself, and backups of your home folder hold them. On a Sprite they sit on Fly.io's machine, with the Claude token.

**On another machine.** Secrets stay on the machine where you add them. `skel --remote sprite:demo secret add app STRIPE_TEST_KEY` asks in your terminal, and the value goes over the same connection as your typing and is saved on the Sprite, never on the laptop. Nothing copies secrets between machines: `skel remote add` brings none, so you add them again where the work runs.

## Building blocks

These are the parts that need care. `docs/learnings.md` explains the traps behind each one.

- **Typing into a session.** Wait until the pane is quiet (compare `tmux capture-pane` a moment apart), load the text with `tmux load-buffer`, paste it with `tmux paste-buffer -p` so it arrives as a bracketed paste, then send Enter on its own a moment later.
- **The sandbox.** bubblewrap with the agent's folder writable, the rest of the system read-only, and the home folder and credentials hidden. Each Claude Code session gets its own config folder in `~/.local/share/skel/claude/`, where its transcripts stay for `claude --resume`, and logs in with the token from the first run. Nothing renews the token, so your own login is never touched, and your `~/.claude` stays hidden like the rest of the home folder. Its own permission prompts and sandbox are turned off, since skel's sandbox draws the boundary. A repository's folder of secrets is mounted read-only at its own path, and made first if need be, as bubblewrap refuses a folder that doesn't exist. It is a folder rather than each file, so a secret added later shows up. Codex gets skel's `CODEX_HOME` and runs with its own sandbox and approvals turned off too. On a Sprite, the sandbox also hides the Sprite's control socket, through which an agent could start a service outside the sandbox or restore a checkpoint.
- **Starting Claude Code.** Remove inherited `CLAUDE_CODE_*` variables. Mark the folder as trusted in the session's copy of its settings, or it waits at a question nobody sees. Pass the first message on the command line.
- **Agent commands.** Every command an agent can run answers quickly: Claude Code moves a shell command to the background after 2 minutes. `skel secret run` is the one exception, and takes as long as the command it runs, as that command would on its own.
- **Detaching.** skel's tmux config binds Ctrl-Q to detach with no prefix and hides the status bar, so attaching feels like being inside Claude Code.

## Not in this version

- Reviewing pull requests skel didn't open (a likely early addition, in which code from a fork must never get a secret)
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
- Secrets for all repositories, for one role or for one thread, and secrets as files
- Limiting what the network can reach from a sandbox
- A keychain, password manager or vault behind secrets
- Tokens for GitHub Packages, or for private GitHub repositories as dependencies

If something seems missing, ask instead of adding it.

## Milestones

Each one is something you use every day from the day it lands, and lands as small pull requests that pass `bun run check`. skel builds skel.

Already in: skel on a Linux server, one thread to a reviewed PR, parallel threads and needs you, follow-through on GitHub, `skel --remote` over SSH and on a Sprite, and the sidebar.

Launch milestones, in order:

1. **skel on a Mac.** The same skel, lead and flow on macOS, so you can install it on your laptop. The daemon runs as a launchd agent instead of a systemd service. Agents run in macOS's own sandbox, `sandbox-exec`, drawing the same boundary bubblewrap draws on Linux. Earlier versions of skel used it. The first run checks for `tmux`, `gh` and the harness, and says exactly what to install, such as `brew install tmux gh`. A laptop sleeps, so skel says once, after the first run, that work stops while the lid is closed, and that `skel remote add` keeps it going.
2. **Installables.** Every release builds skel for macOS and Linux, on arm64 and x64, and publishes the binaries with release notes. One line from skel.run installs the right one. `skel --version` says which release you have. A version tag such as `v0.4.2` makes a release. `skel --version` prints `skel 0.4.2`, and a build from a checkout says so and names its commit. The install line downloads the binary for your system and CPU, checks it against the release's checksums, and puts it in `~/.local/bin`, with no sudo. It says if that folder isn't on your PATH, and stops with a clear message on Windows or anything else skel isn't built for. On a machine with a release, `skel remote add` downloads that same release's Linux binary and checks it the same way.
3. **Updates.** There will be a release most days, so updating works like Claude Code's: skel downloads and installs a new release in the background, and tells you. The sidebar shows a short notice, such as `skel 0.4.2 installed · restart to use it`. Leave with Ctrl-Q and run `skel` again, and skel restarts the daemon on the new release before attaching. Agents keep running through it, since their sessions live in tmux and only the daemon restarts. `skel --remote` keeps skel on a server or Sprite at the same release as the laptop.
4. **The first two minutes.** From the install line to a picked up issue, without reading anything but what skel prints. The first run is short and every step says what comes next. Once it is done, the lead says how to start work: add the `skel` label to an issue. skel looks for labeled issues as soon as a repository comes in, then often enough that a label is picked up within 2 minutes.
5. **Someone else installs it.** By Thursday 12 November, a developer who isn't Simon installs skel on their own machine and hands it a real issue, with no help. Everything that stops them is fixed before the launch.
6. **The launch.** A README with the install line, a quickstart, what agents can and can't touch, which accounts the harness and reviewer use, the known limits, and where to report bugs: GitHub issues. Until secrets land, the known limits say that a repository needing a private package registry can't be set up, and that tests needing a live key can't run in the sandbox, though CI still runs them. Record the video. Make the repository public on 16 November.

After the launch:

7. **Secrets.** `skel secret add`, `ls`, `rm` and `run`, as Secrets says. None of it touches the install path, and it waits until after the launch, unless someone installing skel is stopped by it. Two things must be in first, since a transcript can hold a value: `~/.local/share/skel` is readable only by you, and each thread's reviews have a Codex sessions folder of their own, so that a review can't read another repository's.

## Done when

Someone who isn't Simon installs skel on macOS or Linux from the README, with no help, and gets a reviewed PR from an issue they labeled, picked up within 2 minutes. `skel remote add sprite:<name>` takes them from there to a Sprite that is ready, and the command it prints opens the lead there. The video runs as written, start to finish, with nothing faked. The repository is public.
