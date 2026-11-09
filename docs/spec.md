# Skel rewrite spec

Nov 3, 2026 · @Simon · updated Nov 6 for the launch on Nov 16

## Goal

skel is Claude Code, but always on, in parallel, isolated, and seeing each task through to the merge.

You run `skel` in a checkout and talk to that repository's lead: a Claude Code or Codex session on your server that knows the repository. The lead writes tasks and starts threads. Each thread works in one repository, as a builder agent in its own branch, clone and sandbox. It opens a PR, a fresh reviewer, on another model if you choose one, reviews it adversarially, and they go back and forth until it is ready. CI failures and your PR comments wake the builder again. You merge.

There are no roles, phases or flows as files. We trust capable agents and add an adversarial review.

The repository starts with three documents: this spec, `AGENTS.md` for how to write code here, and `docs/learnings.md` for the traps to avoid. The code starts empty. Keep it small, plain and tested.

## Qualities

| Quality | What it means |
| --- | --- |
| Always on | skel runs on a server. Start and attach from your laptop, close the lid, and the work carries on. |
| Unattended, where it makes sense | Agents stay alive, wake on events, and only ask you when they need you. You approve and you merge. |
| Parallel | Many threads at once, across repositories, without juggling chat windows. |
| Isolated | Each thread gets a branch, clone and sandbox. Your own checkouts are never touched. No tokens inside. |
| Connected | Tasks come from GitHub issues and PRs go back to it, through the GitHub plugin. Any other tool is a plugin too, installed from its own repository. Without any, skel works from git alone. |
| Build ⇄ review | A builder and a fresh adversarial reviewer loop until the change is ready. Put the reviewer on another model: a model reviewing its own work shares its blind spots. |
| In your harness | You stay in Claude Code or Codex. There is no new app to live in. |

## The launch

skel launches as a beta on Monday 16 November 2026. It is a quiet launch: the repository goes public, skel installs on macOS and Linux, and a first video shows it working. Many small launches follow, each with a short video, and we reach out to developers directly. Windows comes later.

Everything until then serves two moments, and the launch is ready when someone who isn't Simon gets through both on their own machine, with no help.

1. **Install it on your laptop, and it is useful at once.** One line installs skel. The first `skel` offers the GitHub plugin. Say yes, and it connects GitHub and the harness, and offers `skel init`, which names GitHub as the repository's tracker, then opens the lead. Push the `skel.yaml` it wrote, add the `skel` label to an issue on GitHub, and within 2 minutes skel picks it up, starts a thread and says so. A reviewed PR follows.
2. **Move it to a server.** `skel remote add sprite:<name>`, or `skel remote add <host>` for a server of your own, sets the machine up and prints the command that connects to it. Run that, and the work carries on with the laptop closed.

Until the launch, the work is making these two moments smooth, fixing the bugs people hit on the way, polishing what they see, and building skel for macOS and Linux. Anything that doesn't serve them waits until after the launch. If something seems missing, ask instead of adding it.

**The video.** Recorded for real, with a visible clock and a time lapse.

1. On a Mac: run the install line, then `skel` in a checkout of app. The first run, then the lead.
2. On GitHub, add the `skel` label to an issue in app. Within 2 minutes skel starts a thread, and the lead says so. A reviewed PR follows.
3. On the laptop: `skel remote add sprite:demo`. The first run there, then skel prints `skel --remote sprite:demo`. Run it, and the lead opens, running on a Sprite.
4. On GitHub, add the `skel` label to two issues in app and one in site. Within a minute skel starts three threads, and the leads of app and site each say so.
5. Close the laptop.
6. Open it later and run `skel --remote sprite:demo` again. app's lead says what happened: its two PRs are reviewed and green, one of them after the builder fixed a failing check on its own. site's tab shows `•1`: its thread needs you, as its builder has a question.
7. Switch to site's tab, pick its thread in the sidebar and answer its question. Merge the two PRs on GitHub. skel cleans up.

The repositories in the video are small real apps with fast CI and real issues, not skel itself.

## Words

| Word | Meaning |
| --- | --- |
| Lead | Your agent session on the server for one repository, on your harness. One per repository: it starts the first time you open that repository, and from then on is always running. It sees only its own repository. You talk to it; it writes tasks and starts threads. |
| Repository | A git repository skel works on, from a clone of its own, with a lead of its own. It is named by its name on its forge, such as GitHub's `app`, or without a forge by its remote's path, with the owner added (`simon/app`) only when two share a name. |
| Task | What you want done, in words, as an item in the tracker you connect skel to. skel is made to work from a tracker, and keeps no tasks of its own: you plan where you already do. Each tracker keeps its own word: on GitHub a task is an open issue. A repository's committed `skel.yaml` names its tracker, such as `tracker: github`. A task can exist without a thread: one you create on GitHub shows up in skel, and nothing happens until it is started, with `skel start` or the `skel` label. In a repository whose `skel.yaml` names no tracker, a thread's task is what you told the lead, and it lives with the thread. |
| Thread | skel's core: the work on one task, from its first message to the merge. Its branch, clone, sandbox, builder session and history. One thread per task at a time. Named by the task's own ID in its tracker, with the repository added when that ID doesn't name one: GitHub issue #12 in app is `app-12`, since its number is only unique within app, while a tracker whose IDs are already unique, such as Linear's `JOTT-12`, would keep its own. A thread never gets a second number, so the name in skel is always the one in the tracker. A thread with no tracker behind it gets a `t` and a number of skel's, such as `app-t1`, so it never clashes with a task's name. A dash, because no shell reads a dash as anything special, so it never needs quoting. |
| Harness | The coding agent an agent runs on: Claude Code or Codex. |
| Builder | The thread's agent. A session of its harness that stays alive from start until the PR merges or closes. |
| Reviewer | A fresh agent for each review round, on the harness your config names for it, reading the PR adversarially. It runs once and answers with a verdict, with no session to attach to. It never inherits the builder's context. |
| Event | Something that happened to a thread: a review, a PR comment, a failed check, a merge. |
| Needs you | A flag on a thread: the builder asked a question, review hit its round limit, or the PR is approved and green, or, without a forge, the branch is approved. |
| Plugin | A program in a repository of its own that connects skel to one outside tool, such as GitHub or Slack. You install it with `skel plugin install`. |

A thread's status is one of `working`, `waiting` (on review, CI or you), `failed`, `stopped` or `done`. Needs you is a separate flag, so a thread can wait on CI and need you at once.

## Running skel

skel runs on a Linux machine that stays on: a server of your own, or a Sprite, a Linux machine skel creates for you on Fly.io. `skel`, from any folder, attaches your terminal to a repository's lead, and starts the daemon and that lead first if they are not running. Ctrl-Q detaches; the lead keeps running.

The repository is the context, as the folder is for `claude` in a terminal. `skel` in a checkout opens that repository, matched by its remote: its lead on the right, and its threads, issues and PRs in the sidebar. A repository skel doesn't have yet is added first, as `skel repo add` does, so the first `skel` in a checkout, yours or a teammate's clone, goes straight to work. Outside any repository, or in one with no remote, `skel` opens the repository you opened last. The folder only names the repository: agents never work in your checkout, and skel never sees changes you haven't pushed. The one thing skel writes there is the starter `skel.yaml` of `skel init`, a command you run yourself. While skel has no repositories yet, `skel` outside one says so and attaches to nothing: "skel has no repositories yet. Run skel in a checkout of one."

**The first run.** The first `skel` on a machine takes three steps before the lead starts:

1. **Offer the GitHub plugin.** skel asks whether to install it, for tasks from GitHub issues and PRs on GitHub. Yes runs `skel plugin install skelcrew/skel-plugin-github`, which shows what the plugin runs and asks before installing it. Its setup installs skel's GitHub App on the repositories you pick and signs you in, with nothing to paste, as **GitHub** under Plugins says. Everything skel does on GitHub is then done as `skel[bot]`, outside the sandbox. No skips it, and skel works from git alone until you install a plugin. With the plugin, in a checkout whose `skel.yaml` names no tracker, skel then offers to run `skel init` there, so GitHub's issues become the repository's tasks.
2. **Pick a harness.** skel asks whether the lead and builders run on Claude Code or Codex, checks that it is installed, and saves the choice as `harness` in `~/.config/skel/config.yaml`. Then it logs that harness in for agents. For Claude Code it runs `claude setup-token`, which gives a long-lived login token for agents, and saves the token you paste in `~/.config/skel/`, readable only by you. For Codex it runs `codex login --device-auth` with `CODEX_HOME` set to `~/.local/share/skel/codex/`. That is a login of skel's own, separate from yours in `~/.codex`, so a renewal on either side never breaks the other. Every Codex agent and review shares it.
3. **Pick the reviewer's harness.** When both Claude Code and Codex are installed, skel asks which harness reviews run on. It offers the other one first, since a second model sees what the builder's model misses, and your own harness second. It saves the other one as `reviewer: { harness: … }` in `config.yaml`, and nothing when you pick your own. Then it logs the reviewer in as step 2 would, if its harness has no login yet. When only one is installed, skel doesn't ask, and says reviews will run on your harness, with no second view.

Before the first step, skel checks that `tmux`, `bwrap`, `git` and Claude Code or Codex are installed, and if one is missing, says exactly what to install instead of failing halfway. After the last step, it installs the daemon as a systemd user service and turns on lingering (`loginctl enable-linger`), so the daemon keeps running after you log out and starts again after a reboot. On a Sprite, which has no systemd, it installs the daemon as a Sprite service instead, which the Sprite starts at boot and restarts when it crashes.

Each step is skipped when it is already done. Once the first run has finished, `skel` skips it entirely and goes straight to the lead: a tool or login that goes missing later shows up where it is used.

On a server or Sprite, `skel remote add` runs these steps from your laptop and installs the daemon. The lead starts at the first `skel --remote`.

**The sidebar.** `skel` puts a narrow sidebar on the left of your terminal, with the agent you are looking at on the right. The sidebar is the open repository's: it lists its lead first, then every thread of the repository that isn't done, each on two lines: a mark and its full name, then, dim, a word for what it is doing and the harness doing it, such as `approved · claude`. While a review runs that is `reviewing · codex`, so you can see which agent has the thread right now. A thread whose word is `working` also ends that line with how long ago it started: `<1m`, then `5m`, `2h`, `3d`, such as `working · claude · 5m`. No other row shows a time, the lead included, as a time would write to the terminal each minute, and on a Sprite a terminal that stays quiet lets it sleep. The row you are looking at has a grey background across the whole sidebar, on all its lines. Headings, marks and hints start two columns in, and all text stops two columns before the sidebar's edge, which matches the one blank row at the top, as a terminal cell is about twice as tall as wide. It updates on its own. At the bottom, four dim lines show the keys: `⌥↑↓ move`, `⌥⇧↑↓ list`, `⌥←→ repo` and `⌃Q quit`. They are always there, except on a terminal too short for them and a whole row, where the row comes first.

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

**Repositories are tabs.** A row of tabs runs across the top of the terminal, above the header, one tab per repository, in name order, starting in line with the marks. A tab is the repository's name, and when threads in it need you or have failed, a yellow dot and how many: `site •1`. The open repository's tab is bold white on the grey a picked row has, and the others are dim. Alt-Left and Alt-Right switch to the repository before or after, and a click on a tab switches to it. Switching swaps both sides at once: the sidebar shows the new repository, and the right side its lead, which starts then if it never has. When the tabs don't fit, those furthest from the open one give way, and a dim count says how many are left out. The row is there even with one repository, so the agent's height doesn't change when a second one comes. The badges are how you hear of other repositories: one repository's lead never mentions another's threads.

Pick a row to look at it. Click it, or move from anywhere, even while typing to an agent. Alt-Up and Alt-Down move one row, carrying on through the lists, top to bottom. Alt-Shift-Up and Alt-Shift-Down jump to the first row of the previous or next list. Moving lands only on rows you can see, and steps over an agent that isn't running. The right side switches at once, and on a thread you type straight to its agent. So answering a builder's question is one click, with nothing to detach from. Ctrl-Q leaves the whole screen, and everything keeps running. skel then prints one line: `Your agents keep running. Run skel to come back.`

The sidebar has up to three lists, the three stages of a task: ISSUES, THREADS and PRS. The rows described above are THREADS. The lists follow the repository's plugins: ISSUES is there when it has a tracker, and PRS when it has a forge. Each list shows what is really open, on its own, so a task in review is in all three, and a row goes when what it stands for ends. A PR's merge usually ends all three at once, since it ends the thread and closes the issue. Nothing has to match: a thread can have no issue or no PR yet, and a PR can have no thread.

- **ISSUES** are the open issues in the repository, as `skel task ls` shows them, newest first. Those with a thread are dim and come last, so what is waiting stands out.
- **PRS** are the open PRs in the repository, newest first, including ones skel didn't open. A PR from a thread shows the same mark and word as its thread. A PR with no thread shows a dim `○`.

Each row of ISSUES and PRS has two lines, like a thread's. An issue has no mark, so its lines start where the `Issues` heading does. A PR has its mark where a thread's mark is, and its lines start where a thread's name does. The first is the title, cut with `…` to fit. The second, dim, is the name, such as `app-24` or `app#26`, and a PR from a thread adds its word, in the colour a thread's word has: `app#26 · approved`.

It is an overview, never a replacement for the tracker or GitHub. A row with no agent is a terminal link, so Cmd-click opens it in your browser, since skel may run on another machine than your browser. A plain click does the same as moving to it: it shows the row's page. Each list shows as many rows as fit its share, then a count of the rest, leaving out dim rows first. The lists come from skel's copy of the tracker, so the sidebar only reads the database and never asks GitHub itself.

List headings are dim, written `Issues`, `Threads` and `PRs`, with one blank line between a heading and its first row. Rows sit together, with no blank lines between them. A thin line parts one list from the next, in the faint colour of the sidebar's edge, and joins that edge. The lists share the sidebar's height evenly, above the keys, whether or not they are full, so each list stays in the same place on screen. What doesn't divide goes to THREADS. A list with nothing in it keeps its share and its heading, and says `none`, dim. THREADS scrolls inside its share, always keeping the row you are on in view. On a terminal too short for a share to hold a heading, its blank line and one row, or for THREADS to hold the row you are on, ISSUES and PRS go, and THREADS has the whole sidebar, with no heading, as it is the list you move through.

Landing on a row of ISSUES or PRS shows its page on the right, in place of the agent. An issue's page has its title, state, author, labels, description and a link to GitHub. A PR's page has its title, state, branch, checks, latest review, description and a link to GitHub. A page is read-only, with no diff and no comments. The wheel scrolls it, and typing goes nowhere. Moving back to a thread puts you straight in its agent. A page reads skel's copy of the tracker, so it opens at once and asks GitHub nothing, and a page sitting open writes nothing to the terminal and lets a Sprite sleep. What the tracker sent comes from outside, so its control codes are removed before it reaches your terminal.

The sidebar only shows, switches, links and opens pages. It has no commands of its own, and creates, starts and stops nothing: you ask the lead, or run `skel`.

**A new machine.** `skel remote add simon@workbox` is how a server joins skel. It first says what it will do. Then it puts skel there and runs the first run on that machine. It ends by printing the command that connects, and doesn't connect: `skel --remote simon@workbox`. The skel it puts there is the laptop's release, built for that machine, or one built from your checkout when you run skel from one. skel keeps no list of remotes, as the machine itself shows whether it is set up. Running it again is safe, and picks up whatever a run that stopped partway left undone.

From a laptop, `skel --remote simon@workbox` runs `ssh -t simon@workbox skel --from <owner/repo>`, passing the GitHub name of the repository you are in on the laptop, so it opens that repository there. Any command works the same way: `skel --remote simon@workbox ls`. There is no protocol of our own; SSH (and Tailscale, if you use it) does the connecting.

`--remote` only connects, and never sets a machine up. On a machine where skel is missing, or its first run hasn't finished, it says so and prints the `skel remote add` to run. A mistyped name never creates or installs anything.

`--remote` also keeps skel there up to date. The skel it copies to a server or Sprite carries the commit it was built from, and each command passes along the laptop's. When they differ, or either has changes not committed, skel asks before running the command: "skel on sprite:demo is from abc1234, yours is def5678. Update it?" Yes replaces skel there with one built from your checkout and restarts the daemon, and agents keep running. No runs the command on the old skel. A skel run from a checkout there is never offered an update: `git pull` there updates it, and the next `skel` there restarts its daemon on it.

**On a Sprite.** `skel remote add sprite:demo` and `skel --remote sprite:demo` do the same with Fly.io's `sprite` command in place of `ssh`, so you need no server of your own. `skel remote add sprite:demo` goes from nothing to a Sprite that is ready:

1. **It checks the laptop**: that `sprite` is installed and logged in. It lists everything that is missing with the command that fixes it, such as `sprite login`, creates nothing, and ends with the command to run again.
2. **It asks before creating the Sprite**: "No Sprite named demo. Create it?", so a mistyped name never makes a second one you pay for.
3. **It sets the Sprite up**: installs bubblewrap, puts skel there, and makes the Sprite's URL public, so wake-ups from GitHub can reach it.
4. **It runs the first run inside the Sprite**, then prints `skel --remote sprite:demo`.

After that, `skel --remote sprite:demo` attaches to a repository's lead, and `skel --remote sprite:demo ls` runs any command there, waking the Sprite if it sleeps. In a terminal, skel first prints `skel · connecting to sprite:demo…`, as waking can take a while.

Everything must work over a plain `ssh -t` or `sprite console`: no local display, no browser on the same machine, no clipboard. Logins that need a browser, such as GitHub's and Claude's, use a code and a link you open on your laptop.

**Repositories.** skel keeps its own clone of every repository it works on, in `~/.local/share/skel/repos/<owner>/<repo>/`, and keeps it at the latest default branch. A repository comes in when you add it, in your own terminal: with `skel` in a checkout of it, `skel init`, or `skel repo add`, which takes a checkout's path, its full name on its forge, such as `simon/site`, or nothing for the checkout you are in. After that its short name works everywhere. The lead can't bring one in: it works only on its own repository, so it asks you to add the other one and open it. `skel repo ls` lists them and `skel repo rm <name>` removes skel's clone.

Before cloning, skel decides whether to trust the repository. It trusts it on its own when its forge says your login can push to it, unless it is a fork: agents will run its setup and test commands, and read its AGENTS.md and settings as instructions, and you already vouch for what is in it. For any other repository, one with no forge included, skel asks you whether you trust it as you add it, and `skel repo trust <name>` trusts one without the question. Only you can do either, in your own terminal, since a yes passed on by the lead could come from an injected instruction. The answer is remembered in \~/.config/skel/, never in the repository, so a clone can't bring its own yes.

A repository with no forge must take skel's pushes on your own git login, so skel checks that as it comes in. The daemon runs `git push --dry-run` of a new branch from skel's clone, as it will push for a thread, outside your terminal and without your SSH agent. If git refuses, skel shows what git said and what to fix, such as a key the daemon can use or a credential helper, and doesn't add the repository. Running the same command again checks again.

A repository can say how to set up and test it, and which harness and model each agent uses, in a committed `skel.yaml`. Without one, the builder works it out, as it would in any checkout. `skel init`, run in a checkout, writes a starter `skel.yaml` there and adds the repository, as `skel repo add` does. The starter says at the top that the file is shared with everyone who works on the repository and never holds a secret. It has your current harness and model for the lead, builder and reviewer as real lines, and setup and test as commented examples. `skel init` asks which of your installed trackers holds the repository's tasks, or none, and writes `tracker:` for it. In a checkout with a `skel.yaml` already, it only adds that line. skel reads `skel.yaml` from its own clone, so `skel init` ends by saying the file counts only once you commit it and push it to the default branch. It stops outside a git repository, and when the repository has no remote.

**Each lead, its own repository.** A repository's lead sees only that repository: its clone, read-only, its threads, and its issues and PRs. Its commands work only there, as the daemon knows which lead is calling from its socket, as it knows a builder's thread. It starts the first time you open its repository, by `skel` or its tab, and from then on runs like any lead. Asked about work in another repository, it says so, and you switch to that repository's tab.

## The daemon

One daemon per machine, run by the systemd user service or Sprite service the first run installed. `skel serve` runs it in the foreground; the folder it is started in makes no difference.

1. If a daemon is already running, `skel serve` says so and exits, pointing you to `skel`.
2. If the first run isn't done, it exits and tells you to run `skel`. It never asks questions, since systemd or the Sprite has no one to answer them.
3. It opens the database, starts skel's tmux server, and reconnects to the lead of each repository you have opened, and every live thread. A session that is gone is brought back on its harness, with its conversation.
4. It opens its socket at `$XDG_RUNTIME_DIR/skel.sock` for the CLI, and one socket per agent, mounted into that agent's sandbox, so skel knows which thread is calling.
5. It asks each repository's tracker and forge what changed, and logs to stdout, which systemd sends to the journal.
6. On a Sprite, it keeps the Sprite awake while there is work: a builder working, a review running, or a PR waiting on CI. It holds a task on the Sprite's control socket that expires a few minutes after its last renewal, so if the daemon dies, the hold expires too. Once every thread waits on you or is done, it lets the Sprite sleep, which costs nothing for compute. A wake-up from GitHub, passed on by skel's service, wakes it when you comment on or merge a PR, and polling then picks up the event. A wake-up that never arrives is caught when the Sprite next wakes, for example at your next `skel --remote`.

The tmux sessions keep running when the daemon stops, so agents keep working through a restart or an upgrade, and the daemon reconnects to them when it comes back. What the daemon itself started, such as a clone or a reviewer, ends with it, and the next daemon starts that work again. Only `skel stop` ends a session.

## The flow

One thread, from start to merge, in a repository with GitHub as its tracker and forge.

1. **A task is started.** You add the `skel` label to an issue on GitHub, from anywhere, even your phone. Or the lead runs `skel task create app "<title>" "<body>"`, which creates a GitHub issue, then `skel start app-12`. You can run both yourself too.
2. **skel sets up the thread.** A clone of its own at `~/.local/share/skel/threads/app-12/`, made from skel's clone of the repository, on branch `skel/12-<slug>` from `main` (or `--from <branch>`), with the repository's setup commands run once in it.
3. **The builder starts.** A session of its harness in the sandbox, in the thread's clone, with the task's title and body as its first message.
4. **The builder finishes a round.** It commits and runs `skel submit "<summary>"`. skel fetches the branch from the thread's clone into its own and pushes it from there, never running git inside the thread's folder. On the first round skel opens the PR, with the line that closes its task in its body, such as `Closes #12`.
5. **The reviewer reviews.** skel sets the `skel/review` status check on the commit to pending and runs a fresh reviewer once, in the sandbox, on its harness, such as with `codex exec` or `claude -p`. It is given the task, reads the diff against the base branch, runs the tests, and answers in a fixed JSON shape: approve or changes, and the review's body. skel posts it as a GitHub review that only comments, from `skel[bot]`, and sets the check to success or failure, so branch protection can require it. GitHub doesn't let a PR's author approve it, and skel's app opened the PR, so the check carries the verdict, and approving is yours. Reviews run one at a time, since they share skel's Codex login, and a renewal by one could leave the others with a token that no longer works. A review covers the commit it started for: a newer `skel submit` cancels a review still waiting or running. A reviewer that fails, answers outside the shape, or runs past 30 minutes sets the check to failure with "review failed", and the thread needs you. You or the lead can rerun a review with `skel review`, such as after a review that failed.
6. **Changes go back to the builder.** skel types the review into the builder's live session. The builder fixes, commits and runs `skel submit` again. Back to step 4.
7. **After 3 rounds of changes, the thread needs you.** skel stops sending reviews to the builder until you say go on, with `skel start`.
8. **Approved and CI green: the thread needs you.** Its status is `waiting`, on you.
9. **You merge on GitHub.** skel ends the builder session, removes the thread's clone, and marks the thread `done`. A PR closed without merging does the same.

**Without a tracker.** In a repository whose `skel.yaml` names no tracker, you tell the lead what to do, and it starts a thread with `skel start app "<title>" "<body>"`, written from what you said. That title and body are the thread's task, kept with the thread. The thread is named `app-t1`, on branch `skel/t1-<slug>`, and the rest of the flow is the same.

**Without a forge.** In a repository with no forge, skel still pushes the thread's branch to the repository's remote with git, on your own git login, such as your SSH key. It opens no PR and sets no check. The reviewer reviews the branch's diff against the default branch in the thread's clone, and the build ⇄ review loop runs the same, with each review kept in skel and typed into the builder. Once approved, the thread needs you: "app-t1 is ready on branch skel/t1-fix-login". You open a PR or merge it yourself. The thread ends when a fetch finds that merging the branch into the default branch would change nothing, which a merge, a squash and a rebase all leave. A branch deleted from the remote ends it too. Without a forge, nothing from CI or a PR reaches the builder: no failed checks, no comments and no merge conflicts.

At any point the builder can ask you a question. On Claude Code it uses Claude Code's own `AskUserQuestion`. Codex has no such tool, so there the builder ends its turn without `skel submit`, and Codex's `Stop` hook tells skel. Either way skel notices, and the thread needs you until you pick it in the sidebar and answer it.

**Telling you.** When a thread starts needing you, skel types a one line note into the session of its repository's lead (when that lead is idle), so you hear it where you already are. A note for a repository whose lead hasn't started yet is kept until it starts, as notes already wait for a lead that isn't running.

**Messages.** The lead and a builder can tell each other something with `skel tell`, such as a builder saying its task needs another thread's work first. skel types the message into the other's session once it is idle, as it does the lead's notes, wrapped in a tag that says who it is from and the command to answer with: `<skel from="lead" reply="skel tell lead">` into a builder, or `<skel from="app-12" reply="skel tell app-12">` into the lead, then the text on its own lines, then `</skel>`. The tag marks where a message starts and ends, so an agent's message never passes for yours, and the text inside stays plain and readable. skel removes `<skel` and `</skel>` from the text, so a message can't end its tag early. The lead can tell any of its repository's threads' builders. A builder can tell only its repository's lead, since its socket says which thread it is. A message to a builder that isn't running, or that is asking you a question, is refused, not kept. Messages stay in skel, never on GitHub, and each one goes in the thread's log.

## Events

The daemon asks each repository's tracker and forge what changed since it last looked, and names the PRs of the repository's live and stopped threads, which come back whatever changed. GitHub's plugin answers with one GraphQL query per repository, so the number of requests doesn't grow with the number of threads, and a check that finished, which GitHub doesn't count as a change to its PR, still reaches skel. It polls every 30 seconds while a thread is active, and less often for threads that only wait on you. Wake-ups are faster, never the only source, since deliveries are missed while the daemon is down. On a server they may be added later; on a Sprite they wake it from sleep. GitHub's plugin calls GitHub's API itself, as skel's app. Each event is handled once: skel records the ID of the last review, comment and check run it acted on.

**Starting from GitHub.** Every minute the daemon also looks in its copy for open issues labeled `skel`, which the same query brought, and starts a thread on each one that has none, exactly as `skel start` does. It reacts to the issue with 👀, so you can see on GitHub that skel took it, and types a one line note into its repository's lead, such as "started app-12 from GitHub: Fix the login redirect". skel never comments on the issue: a builder's question waits in skel, where the thread needs you and the lead tells you, and you answer it with `skel attach`. A label is the signal because skel's GitHub App can't be assigned an issue. Only people with triage or write access can add a label, so a stranger can't start work. Removing the label doesn't stop a running thread; `skel stop` does. A thread that failed or was stopped isn't started again by its label, only by `skel start`. GitHub's plugin creates the label in a repository whose tracker it is, when it is first asked there what changed.

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

Without a forge, only the reviews and the end of the branch happen, as the flow says.

## Plugins

A plugin connects skel to one outside tool. It lives in a git repository of its own, with a `skel-plugin.yaml` at its root, and you install it with `skel plugin install`. GitHub is a plugin, `skelcrew/skel-plugin-github`, which the first run offers. skel's flow holds nothing of it: it knows what a plugin does, never which plugin does it.

**What a plugin does.** A plugin does one or more of four jobs. Each job has its own commands, and is used at its own time:

| Job | What it is | Commands | Used by |
| --- | --- | --- | --- |
| Tracker | Where tasks come from, such as GitHub issues or Linear. It says what changed in a repository's tasks, and creates one. | `call` | The daemon |
| Forge | Where code goes, such as GitHub or GitLab. It claims repositories, lends git its login to push, opens PRs, posts reviews, sets the `skel/review` check, and says what changed in a repository's PRs. | `call`, `git_credentials` | The daemon |
| Chat | Where you hear that a thread needs you, and talk to a lead, such as Slack, once skel has teams. | None in this version | |
| Machine | Where skel runs, such as a Sprite. It creates a machine, runs commands on it and copies files to it. | `add`, `exec`, `push` | `skel remote add` and `skel --remote`, on your laptop |

A plugin can do several: GitHub is a tracker and a forge. No chat plugin comes in this version, so chat has no commands yet: they come with the first chat plugin. A job grows only when a plugin needs it. Harnesses are never plugins: each stays built into skel, one module per harness, because that module draws the sandbox boundary around its agents.

**A repository's tracker and forge.** Each repository has at most one forge and one tracker, and works with neither, as the flow says. Its forge is found on its own: the plugin that claims its remote, if one does. Its tracker is never picked for you, not even its forge. The repository's committed `skel.yaml` names it, such as `tracker: linear`, so a repository on GitHub can plan in Linear. Which team or project holds the repository's tasks stays in the tracker's own settings, as its setup asks, such as Linear's team for each repository. When `skel.yaml` names a tracker that isn't installed, the repository has no tracker, and `skel repo ls` says which plugin to install. skel never installs anything because of `skel.yaml`.

**The manifest.**

```yaml
name: github
version: 0.1.0          # the same as the tag it is installed from, v0.1.0
skel: 0.5.0             # the oldest skel release it works with
about: Tasks from GitHub issues, and PRs on GitHub, as skel's GitHub App
jobs: [tracker, forge]
build: [[bun, install, --production]]
setup: [bun, setup.ts]
call: [bun, call.ts]
git_credentials: [bun, credentials.ts]
```

Each command is a list of words, run in the plugin's folder and never through a shell. `build` and `setup` are optional, and each job needs the commands the table gives it. `build` runs once, at install. `setup` runs in your terminal, at install, and asks for whatever the plugin needs, such as a token. A command whose first word is `bun` runs on the Bun inside skel, so a plugin written for Bun needs nothing else installed. Anything else it needs, you install yourself, as its README says.

**Installing.** `skel plugin install <owner/repo>` clones the repository's newest version tag from GitHub into `~/.local/share/skel/plugins/<name>/<version>/`. It refuses a plugin that needs a newer skel. It shows the manifest and every command the plugin will run, and asks before going on. Then it runs `build` and `setup`. `skel plugin update [<name>]` moves one plugin, or all, to its newest tag the same way. `skel plugin rm <name>` removes its folders, with its settings and tokens. It refuses for the tracker or forge of a repository skel has. `skel plugin ls` lists what is installed, with each plugin's version and jobs, such as `github 0.1.0 tracker, forge`.

For a plugin you are writing, `skel plugin install <path>`, such as `./skel-plugin-linear`, uses that folder where it is, with no tag, and shows and asks as any install does. `skel plugin update <name>` then runs its `build` again, so your edits count. `skel plugin rm <name>` removes its settings and tokens, and never your folder. A plugin belongs to the machine the daemon runs on, so for a server or Sprite you run `skel --remote sprite:demo plugin install skelcrew/skel-plugin-github`. A machine plugin is the one exception: it belongs on your laptop, where you run `skel remote add` and `skel --remote`.

**What a plugin is handed.** Each command gets `SKEL_PLUGIN`, its name, and `SKEL_PLUGIN_CONFIG`, a folder in `~/.config/skel/plugins/` for its settings and tokens, readable only by you. Their format is the plugin's own.

**Calls.** skel asks a tracker or forge by running its `call` command with one JSON question on stdin. The command prints one JSON answer and exits within 60 seconds. If it exits with an error, its last line of stderr is the error. Every answer is checked before skel uses it.

| Question | Job | Answer |
| --- | --- | --- |
| `claims` with a remote, such as `git@github.com:simon/app.git` | Forge | The repository's key, short name, link and clone URL, whether you can push to it and whether it is a fork. Or `null` if it isn't this plugin's. |
| `changed` with a repository, whether the plugin is its tracker, its forge or both, the last `next` (or none), and PR numbers to watch | Tracker, forge | `items`, everything updated since, or everything open without a `next`, and the new `next` |
| `create task` with a repository, title and body | Tracker | The new item |
| `took` with a repository and task | Tracker | Nothing. GitHub reacts with 👀 |
| `open pr` with a repository, branch, base, title and body | Forge | Its number, of the PR already open from that branch if there is one |
| `review` with a repository, PR, commit, verdict and body | Forge | The review's ID |
| `status` with a repository, commit, state and description | Forge | Nothing |
| `log` with a repository and check ID | Forge | The end of the failed check's log |
| `wake` and `unwake` with a repository and URL | Tracker, forge | Nothing. GitHub asks skel's service to start or stop passing wake-ups for the repository to that URL. A plugin with no wake-ups does nothing. |

skel asks `changed` once per repository of each plugin that is its tracker or its forge, and keeps tasks only from its tracker and PRs only from its forge. So GitHub, as both, answers both in one query, and as the forge alone it leaves issues out.

An **item** is a task or a PR in skel's words: its kind, ID, title, body, state (`open`, `closed` or `merged`), author, labels, link, and when it was created and updated. An ID is the tracker's own, such as `12` on GitHub or `JOTT-12` on Linear. One of only digits doesn't name its repository, so a thread on it gets the repository's short name in front, as `app-12`. A task adds the line a PR's body needs to close it on merge, such as `Closes #12`, which skel puts in the PR it opens. A PR adds its branch, base, whether it conflicts with the base, its checks, and its reviews and comments. A check has a name, an ID if it has a log, and a state: `running`, `passed`, `failed`, or `cancelled`, which isn't the builder's to fix. A review or comment has an ID, its text and its author, and a review its verdict and its comments on lines of code. An author says whether it is a bot, whether it is you, and whether it can push to the repository.

skel runs git itself, for clones, fetches and pushes. `git_credentials` is a git credential helper, which skel hands to git for each command and never saves. GitHub's hands git the repository's token from skel's app, as the user `x-access-token`.

**The copy.** skel keeps a copy of each repository's open tasks, from its tracker, and open PRs, from its forge, as items. At each poll `changed` brings what changed since its last `next`. Each daemon start begins with no `next`, so the tracker and forge send everything open, and anything no longer there leaves the copy. A closed item leaves once no live thread points to it. The copy is the tracker's, not tasks of skel's own: you change tasks in the tracker, and skel follows. The sidebar, pages, `skel task ls` and `skel task show` read the copy, so none of them waits on the tracker. `skel start` polls its repository first, so a builder never starts from an old body.

**Waking up.** A delivery to `/<name>` on the daemon's port brings that plugin's next poll forward, for every repository it is the tracker or forge of. On a Sprite that sleeps, the delivery wakes it first. A delivery only says "look now", so skel doesn't check who sent it, reads nothing in it, and acts only on what the plugin then reads from its tool.

**Trust.** A plugin runs as you, outside the sandbox, with no sandbox of its own. It can read what you can, your git login and other plugins' tokens included. You trust it when you install it, as you trust an extension in your editor, which is why install shows what it runs and asks first. Only you install, update or remove one: `skel plugin` is refused for the lead and every agent. A repository's `skel.yaml` can't make you install or run a plugin, and only picks its tracker among the ones you installed. Where a team plans is the team's choice, the same for everyone who works on the repository, while what runs on your machine stays yours. Plugins aren't agents. Agents never see a plugin's folders or tokens, which live in your home folder, which the sandbox hides. What a plugin brings in is outside text: its control codes are removed, and typed into the lead, it steers the lead. So each plugin decides who may reach the lead through it.

**skel's service.** skel's GitHub App is shared by everyone who uses skel, and its secrets can't ship inside skel, where anyone could read them. So a small service holds them, and does only what needs them: it makes GitHub tokens, renews your sign-in, and passes on wake-ups from GitHub's events. It is open source, in a public repository of its own, `skelcrew/skel-service`. The GitHub plugin takes one setting, the service's address, which its setup asks for with `https://skel.run` filled in. To depend on no one, you run the service yourself, with a GitHub App of your own, and give the plugin its address: the same plugin, the same setup, and one way through the code. skel's core never needs the service: with no plugins, skel runs on git alone.

The service is one small serverless function with no database. Its only lasting record is each Sprite's wake-up address. It sees who asked for a token for which repository, and each token works only for that repository, for an hour. Code and issues never pass through it: git and the GitHub plugin talk to GitHub directly. The app sends all its events to one URL, the service's. The service checks each event's signature, reads only which repository it is for, passes a bare "look now" to each address registered for it, and drops the rest. It logs no request bodies. While the service is down, a GitHub token can't be renewed, so within the hour skel can't read, push or post on GitHub, and threads wait. Nothing is lost: once it is back, the next poll catches up.

**GitHub.** The GitHub plugin acts as skel's GitHub App, `skel`, so every PR, review, comment, reaction and push shows as `skel[bot]`. skel never acts on GitHub as you, so it is always clear whether you or skel speaks. Its setup asks for the service's address, then takes two steps, and asks you to paste nothing:

1. It opens the app's install page, which the service names, such as `github.com/apps/skel/installations/new`, or prints it on a remote. You pick repositories and click Install.
2. It signs you in with GitHub's device flow for the app: a code and a link, then Authorize. That tells skel who you are, so `claims` can say whether you can push, and an author can say whether it is you. The plugin keeps the sign-in in its settings, and renews it through the service when GitHub expires it, since renewing needs the app's secret.

For each repository, the plugin asks the service for a token, with your sign-in. The service checks that you can reach the repository and the app is installed there, then makes a token for that repository alone, which lasts an hour. The plugin keeps it in its settings and gets a new one before it runs out. `claims` for a repository the app isn't installed on fails with the link that installs it there. The app asks GitHub for: contents, pull requests, issues and commit statuses, to read and write; checks and actions, to read, for a failed check and its log; and metadata. It has no permission for workflows, so it can't push a change to `.github/workflows`. A thread that needs one says so, and you make it. Its events are issues, comments, PRs, reviews, checks and statuses, used only for wake-ups.

**Machines.** `skel remote add <plugin>:<name>` and `skel --remote <plugin>:<name>` reach a machine through the machine plugin of that name. A host with no plugin in front, such as `simon@workbox`, goes over SSH, which stays built into skel, as git does while GitHub is a plugin. skel runs a machine's commands in your terminal, with the machine's name and any other words after them, and goes by their exit code:

- `add <name>` checks that your laptop has what the machine needs, and lists what is missing with the command that fixes it. It asks before creating the machine, then readies it for skel, such as installing bubblewrap and making its URL public for webhooks. `skel remote add` runs it, then copies skel there with `push` and runs the first run there with `exec`.
- `exec <name> <word>…` runs the words on the machine, as `ssh -t` does, waking it if it sleeps. It passes your terminal when skel has one.
- `push <name> <file> <path>` copies a file to the machine, as `scp` does.

`exec` and `push` never create a machine, so a mistyped name creates nothing. What skel does while it runs on a machine stays built in, since it decides what agents can reach, as a harness does. On a Sprite that is hiding the control socket in the sandbox, keeping the Sprite awake only while there is work, and the Sprite service. For the launch, Sprites stay built in too, and `sprite:<name>` needs no plugin. After the launch, the Sprite steps in `skel remote add` and `skel --remote` move into the first machine plugin, with the same `sprite:<name>`.

## Commands

Every command that lists or shows something takes `--json`, for tools. Commands that do something, such as start, stop, review, submit, tell and task create, print one line or fail with a clear message and a non-zero exit, with or without `--json`.

For you, and for the lead:

| Command | What it does |
| --- | --- |
| `skel [--from <owner/repo>]` | Attaches to the lead of the repository you are in, starting the daemon and that lead if needed, and adding the repository first if it is new. Outside a repository, the one you opened last. `--remote` passes `--from` for you. |
| `skel init` | Run in a checkout: writes a starter `skel.yaml` there, with the tracker you pick, which you commit and push, and adds the repository. Only you can run it. |
| `skel --remote <host> [command]` | Runs any skel command on the server, over `ssh -t`. With `sprite:<name>` as the host, runs it on that Sprite instead. Keeps skel there up to date with your checkout, after asking. |
| `skel remote add <host>` | Sets up a server, or with `sprite:<name>` a Sprite, creating it after asking if it doesn't exist. Runs the first run there and prints the `skel --remote` command that connects. Run it on your laptop. |
| `skel serve` | Runs the daemon in the foreground, for systemd or a Sprite service. One per machine. |
| `skel repo add [<path> \| <owner/repo>]` | Adds a repository: the checkout at the path, the one named, or the checkout you are in. Asks whether you trust it when it needs to. Only you can run it. |
| `skel repo ls` | Lists the repositories skel works on, with their short names, trackers and forges, and a tracker `skel.yaml` names that isn't installed. `--json` for tools. |
| `skel repo rm <name>` | Removes skel's clone of a repository. It refuses while the repository has live threads, and names them. Only you can run it: the lead never needs to, and asks you instead. |
| `skel repo trust <name>` | Trusts a repository your login can't push to, so skel clones it. Only you can run it. |
| `skel plugin install <owner/repo> \| <path>` | Installs a plugin from its newest version tag on GitHub, or from a folder of yours as it is, after showing what it runs and asking. Runs its setup. Only you can run it. |
| `skel plugin update [<name>]` | Moves a plugin, or all of them, to its newest tag. One from a folder is built again from it. Only you can run it. |
| `skel plugin rm <name>` | Removes a plugin, with its settings and tokens. A folder you installed from stays. Only you can run it. |
| `skel plugin ls` | Lists the plugins installed, with their versions and jobs: tracker, forge, chat or machine. Only you can run it. |
| `skel task ls [<repo>]` | Open tasks, newest first, from skel's copy of the tracker, with the thread on each one if it has one. `--json` for tools. |
| `skel task show <repo>-<task>` | A task's title and body, which is all its builder sees, with its thread if it has one. `--json` for tools. |
| `skel task create <repo> "<title>" "<body>"` | Creates a task in the repository's tracker, such as a GitHub issue, and prints its name, such as `app-13`. It doesn't start a thread. It refuses in a repository with no tracker. |
| `skel ps [<repo>]` | Threads, with status and needs you, newest first. Done threads only with `--all`. `--json` for tools. |
| `skel start <repo> "<title>" "<body>"` | Starts a thread on what the title and body say, in a repository with no tracker, and prints its name, such as `app-t1`. With a tracker, a task belongs there, so it refuses. |
| `skel start <repo>-<task> [--from <branch>]` | Starts a thread on a task. On a stopped thread, resumes it: starts its builder again with `--resume` on its last session. On a thread past the round limit, lets it go on: counts its rounds from zero again and types the last review's changes into the builder. |
| `skel attach <repo>-<task>` | Opens the same screen as `skel`, with that builder on the right. Ctrl-Q detaches. |
| `skel review <repo>-<task>` | Reviews the thread's last submitted commit again, as a round's review, such as after a review that failed. It refuses while a review of it is waiting or running. |
| `skel stop <repo>-<task>` | Ends the session and keeps the clone, branch and PR. |
| `skel tell <repo>-<task> "<text>"` | Types a message into the thread's builder, once it is idle. Only the lead runs it: you type to a builder by picking it in the sidebar. |

For the builder inside a thread:

| Command | Who | What it does |
| --- | --- | --- |
| `skel submit "<summary>"` | Builder | Submits a round for review: skel pushes, opens the PR if needed and there is a forge, starts a review |
| `skel tell lead "<text>"` | Builder | Types a message into its repository's lead, once it is idle |

Agents talk to the daemon over a socket mounted into their sandbox, which also tells skel which thread they belong to. The lead and the agents never call GitHub themselves.

Settings come in two layers, and both are optional. What everyone who works on a repository shares lives in its committed `skel.yaml`: its tracker, setup, test, the harness and model for the lead, builder and reviewer, and the round limit. skel reads it from its own clone, so a change counts once it is pushed to the default branch.

```yaml
# Shared with everyone who works on this repository. Never put a secret here.
tracker: github
setup: [bun install]
test: [bun test]
lead:     { model: opus }
builder:  { model: opus }
reviewer: { harness: codex }
max_rounds: 3
```

What is yours stays in `~/.config/skel/`: every login and token, which machine runs skel, plugins and their settings, and your own defaults in `config.yaml`, used wherever `skel.yaml` says nothing. A secret never goes in a repository. A repository's `skel.yaml` names no plugin but its tracker.

```yaml
harness: claude
model: opus
lead:     { model: sonnet }
builder:  { harness: codex, model: gpt-6.1-sol }
reviewer: { harness: codex }
max_rounds: 3
```

The lead, the builder and the reviewer each run on their own `harness` when `skel.yaml` or your `config.yaml` gives one, such as `builder: { harness: codex }`, and otherwise on the top-level `harness`. A second view on another model is yours to choose, such as `reviewer: { harness: codex }`. A thread keeps the harness it started on, since a conversation can't move from one harness to another. Each role takes a `model` the same way. A model name belongs to its harness, so the top-level `model` applies only to a role on the top-level harness. A role on another harness with no `model` of its own gets that harness's default: `opus` for Claude Code, and Codex's own pick for Codex. skel passes a model to the harness as written and keeps no list of names, so a harness that names models as `provider/model` gets exactly that.

## State and isolation

**Sessions.** Every agent runs in tmux, on skel's own tmux server (`tmux -L skel`) with skel's own config: one session for each repository's lead and one per builder. A reviewer runs once and needs no session. tmux keeps them alive, handles attach and detach, and answers the terminal's queries. skel never runs its own terminal emulator.

**The screen.** The sidebar lives in a second tmux server, `tmux -L skel-screen`, one session per open terminal, ended when you leave. Its left pane runs the sidebar, on a server with terminal links turned on (the `hyperlinks` terminal feature), and draws the line at its own right edge, as tmux's border is blank. tmux has three status lines: the tabs are the first, the header above the sidebar and the strip share the second, and the thin line under them is the third. Its right pane is an ordinary tmux client attached to the agent's session on `tmux -L skel`, and picking a row switches that client to another session. Landing on an issue or PR replaces that client with a small `skel page` command, in the same pane, and moving back to a thread starts a client again. So a page lives and ends with the screen, on your side, outside any sandbox. Agents' sessions stay single-pane and know nothing of the screen: typing into them, reading them and checking them work as if it weren't there, and leaving the screen ends nothing.

**State.** One SQLite file per machine, `~/.local/share/skel/skel.db`, with `bun:sqlite`. It holds repositories (name, owner and name on the forge or remote, its lead's session ID, when you last opened it, how many issues and PRs are open) and threads (repository, task, branch, status, needs you, round count, builder session ID, PR number, when it started, and the title and body of one with no tracker), and the last handled ID per event kind. Every change is also appended to `~/.local/share/skel/threads/<repo>-<task>.log` as one JSON line, so a thread's history can be read and replayed. That includes each review's round, reviewer, verdict and first line. The strip shows all but the first line. skel keeps no tasks of its own, beyond what a thread with no tracker was started on. It keeps a copy of each tracker's open issues and each forge's open PRs, brought up to date at each poll, which is the tracker's and changes only when the tracker does. Repository clones live in `~/.local/share/skel/repos/` and thread clones in `~/.local/share/skel/threads/`, on one disk, so a thread's clone shares its files with the repository's.

A machine that ran skel with one lead for all its repositories keeps that lead, the first time a release with a lead per repository runs. It becomes the lead of the repository you last attached from, or of the first by name when there is none. It keeps its tmux session, its folder `~/.local/share/skel/lead/`, its config folder and its socket, so it goes on running through the upgrade, and `--resume` still finds its conversation. skel types a note into it saying which repository it now leads. Every other repository gets a lead of its own the first time you open it. Threads keep their names, folders and sessions. Notes still waiting for the lead go to that same repository.

**Surviving restarts.** When the daemon starts, it brings back the lead of each repository you have opened, and every thread that was `working` or `waiting`, each on its harness with its conversation, runs again every review whose `skel/review` check is still pending, and polling picks up any event it missed.

**Isolation.** Each thread gets its own branch and clone, so nothing a builder does in it reaches your checkouts, skel's clone or another thread. Each agent runs inside bubblewrap: its folder is writable, the rest of the system is read-only, your home folder and credentials are hidden. Each repository's lead works in its own folder in `~/.local/share/skel/leads/<owner>/<repo>/` and sees only skel's clone of its repository, read-only, so it can plan while the work happens in threads. It never sees another repository's clone, threads or conversation. The reviewer sees the thread's clone through a throwaway layer, so it can run the tests but changes nothing.

**Tokens stay out.** Agents never see a GitHub token, or any plugin's. They don't push or call GitHub. They call skel commands, and the daemon and its plugins, outside the sandbox, push and post as skel's GitHub App, or push with your own git login when a repository has no forge. Plugins run as you, and aren't agents. Commits are authored by `skel[bot]`, with you as co-author.

**One seam for tools.** Every GitHub call lives in the GitHub plugin, and the flow speaks to outside tools only through a plugin's commands and calls. So Linear, Jira or another forge is a new plugin, with no change to the flow.

**One seam for harnesses.** Each harness lives in one module: how it starts, resumes and logs in, where its config folder is, and what its screen shows when it is busy or ready for a message. A small lookup finds it by the name your config uses. The flow never names a harness, so another one, such as opencode or pi, is one more module.

**One seam for Sprites.** Creating a Sprite, running commands on it and keeping it awake live in one module. Its creating, running and copying are what the machine job asks of a plugin, so they can move into one after the launch without touching the flow.

## Building blocks

These are the parts that need care. `docs/learnings.md` explains the traps behind each one.

- **Typing into a session.** It works the same on every harness, with the marks its module gives. Wait until the pane is quiet (compare `tmux capture-pane` a moment apart), load the text with `tmux load-buffer`, paste it with `tmux paste-buffer -p` so it arrives as a bracketed paste, then send Enter on its own a moment later.
- **The sandbox.** bubblewrap with the agent's folder writable, the rest of the system read-only, and the home folder and credentials hidden. Each Claude Code session gets its own config folder in `~/.local/share/skel/claude/`, where its transcripts stay for `claude --resume`, and logs in with the token from the first run. Nothing renews the token, so your own login is never touched, and your `~/.claude` stays hidden like the rest of the home folder. Its own permission prompts and sandbox are turned off, since skel's sandbox draws the boundary. Codex gets skel's `CODEX_HOME` and runs with its own sandbox and approvals turned off too. A Codex lead or builder gets a folder of its own for its conversation, as a Claude Code session does, and shares the login in skel's `CODEX_HOME`. On a Sprite, the sandbox also hides the Sprite's control socket, through which an agent could start a service outside the sandbox or restore a checkpoint.
- **Starting Claude Code.** Remove inherited `CLAUDE_CODE_*` variables. Mark the folder as trusted in the session's copy of its settings, or it waits at a question nobody sees. Pass the first message on the command line.
- **Agent commands.** Every command an agent can run answers quickly: Claude Code moves a shell command to the background after 2 minutes.
- **Detaching.** skel's tmux config binds Ctrl-Q to detach with no prefix and hides the status bar, so attaching feels like being inside Claude Code.

## Not in this version

- Reviewing pull requests skel didn't open (a likely early addition)
- Roles, phases and flows as files
- Harnesses other than Claude Code and Codex, such as opencode or pi
- Windows, and threads on other machines
- Per-thread environments such as a database each (the `setup` commands only)
- Projects with their own memory beyond `AGENTS.md`
- Agents talking to each other, beyond the lead and a builder telling each other
- Triggers, schedules or automations
- Reaching you outside the lead's session other than through a plugin, such as a `notify` command for your phone
- Linear, Jira or forges other than GitHub
- A sandbox for plugins, plugins from anywhere but a GitHub repository or a folder of yours, builds for each platform, and a list of plugins to browse
- Machine plugins. Sprites stay built in, and become the first machine plugin after the launch
- Errors from Sentry as tasks, planned as the launch after this one
- Starting a thread by assigning an issue or mentioning skel on GitHub
- A remote protocol of our own (SSH only), teams and permissions
- Projects: a named context above repositories, with one lead across several of them, which brings back planning across repositories. Work for a team and personal work would never share a lead, history or secrets. A project would own its lead, threads, settings and repositories, and show as one tab, with each row labelled by its repository. A thread could span repositories, with a clone and a linked PR in each. Team projects would live on a shared skel server, with a screen connected to several daemons at once. Open: where a project's settings live when it has several repositories, how a project is named across machines and people, and whether a thread can move between its repositories
- Plugin settings in `skel.yaml`, such as who may message the lead. Anyone who can push to the repository could then add themselves to who reaches your lead, so they stay in your `config.yaml`
- Slack, for when skel has teams: a chat plugin, `skelcrew/skel-plugin-slack`, acting as skel's shared Slack app through skel's service. A direct message to the app, or an `@skel` mention, starts a conversation, answered in its thread, and a later reply there carries it on. A message that starts with a repository, such as `app: …`, goes to that lead, and any other to the one used last. The plugin reacts with 👀, drops guests, other workspaces and bots, itself included, and passes on only people on your list, handing the lead the thread as plain text. Notes come to you as direct messages. Messages pass through the service in flight and are never stored, to a connection skel holds, or by waking a Sprite through its URL. No buttons, status line or Slack's look for AI apps. Open: Slack lets an app outside its Marketplace read one thread a minute, so replies that come together wait their turn; a message for a skel that doesn't connect again within a few minutes is lost; and teammates' skels in one workspace each get its messages. What it needs from skel comes with it: a `run` command the daemon keeps running, skel's events on its stdin (each note typed into a lead, a lead's `skel reply`, and wake-ups), and `skel note` to type a message into a lead.
- Agents shown under their thread in the sidebar: a thread has one agent with a session, its builder, and its row already says which agent has it
- A picker for repositories that have no tab, and listing threads across all repositories in one view

If something seems missing, ask instead of adding it.

## Milestones

Each one is something you use every day from the day it lands, and lands as small pull requests that pass `bun run check`. skel builds skel.

Already in: skel on a Linux server, one thread to a reviewed PR, parallel threads and needs you, follow-through on GitHub, `skel --remote` over SSH and on a Sprite, and the sidebar.

Launch milestones, in order:

1. **skel on a Mac.** The same skel, lead and flow on macOS, so you can install it on your laptop. The daemon runs as a launchd agent instead of a systemd service. Agents run in macOS's own sandbox, `sandbox-exec`, drawing the same boundary bubblewrap draws on Linux. Earlier versions of skel used it. The first run checks for `tmux`, `gh` and the harness, and says exactly what to install, such as `brew install tmux gh`. A laptop sleeps, so skel says once, after the first run, that work stops while the lid is closed, and that `skel remote add` keeps it going.
2. **Installables.** Every release builds skel for macOS and Linux, on arm64 and x64, and publishes the binaries with release notes. One line from skel.run installs the right one. `skel --version` says which release you have. A version tag such as `v0.4.2` makes a release. `skel --version` prints `skel 0.4.2`, and a build from a checkout says so and names its commit. The install line downloads the binary for your system and CPU, checks it against the release's checksums, and puts it in `~/.local/bin`, with no sudo. It says if that folder isn't on your PATH, and stops with a clear message on Windows or anything else skel isn't built for. On a machine with a release, `skel remote add` downloads that same release's Linux binary and checks it the same way.
3. **Updates.** There will be a release most days, so updating works like Claude Code's: skel downloads and installs a new release in the background, and tells you. The sidebar shows a short notice, such as `skel 0.4.2 installed · restart to use it`. Leave with Ctrl-Q and run `skel` again, and skel restarts the daemon on the new release before attaching. A skel run from a checkout does the same after `git pull`: when the daemon started on another commit of that checkout, `skel` restarts it on the new one. Changes not committed don't count. Agents keep running through it, since their sessions live in tmux and only the daemon restarts. `skel --remote` keeps skel on a server or Sprite at the same release as the laptop.
4. **The first two minutes.** From the install line to a picked up issue, without reading anything but what skel prints. The first run is short and every step says what comes next. Once it is done, skel offers `skel init` and says to push the `skel.yaml` it writes. The lead says how to start work: add the `skel` label to an issue once `tracker: github` is pushed, or else tell the lead what to do. skel looks for labeled issues as soon as a repository comes in, then often enough that a label is picked up within 2 minutes.
5. **Someone else installs it.** By Thursday 12 November, a developer who isn't Simon installs skel on their own machine and hands it a real issue, with no help. Everything that stops them is fixed before the launch.
6. **GitHub as a plugin.** Two PRs. The first is the plugin system in skel, tested with a fake plugin. The second is GitHub: the plugin in `skelcrew/skel-plugin-github`, with the copy of the tracker, skel's shared GitHub App, and skel's service at skel.run, with its code public in `skelcrew/skel-service`. The first run offers the plugin. Until it has been tried by hand on a real machine, `main` keeps GitHub built in, and the built-in code goes once it has.
7. **The launch.** A README with the install line, a quickstart, what agents can and can't touch, which accounts the harness and reviewer use, the known limits, and where to report bugs: GitHub issues. It says plainly that the GitHub plugin goes through skel.run unless you choose otherwise, what the service sees, and how to run your own. Record the video. Make the repository public on 16 November.

## Done when

Someone who isn't Simon installs skel on macOS or Linux from the README, with no help, and gets a reviewed PR from an issue they labeled, picked up within 2 minutes. `skel remote add sprite:<name>` takes them from there to a Sprite that is ready, and the command it prints opens the lead there. The video runs as written, start to finish, with nothing faked. The repository is public.
