# The screen

What `sc` and `sc --list` show, and the keys that work there: the list, its sections, rows, words and marks, the details pane and the sidebar.

It describes how Skelcrew works today, in more detail than [the spec](spec.md). Builders keep it true to the code, changing it in the same pull request as the code. Where it and [docs/spec.md](spec.md) differ, the spec wins, and the code should follow the spec.

## The list

Plain `sc` opens the screen: the repository's list as a sidebar on the left, and on the right the lead or the task you are on, as **The screen** says. `sc --list` shows the list alone, full screen, with a details pane beside it. Both show the same rows, stages, words and marks, which this section describes for the list first. `sc attach` attaches full screen to one agent instead, with neither, as the list's Enter does. On tmux, Ctrl-\ detaches back to your shell. A runtime plugin's host keeps its own key to detach.

`sc --list` shows a list, with a details pane beside it for the row you are on. You pick a row, and Skelcrew either attaches you full screen to an agent or does what the row offers. Detaching, with Ctrl-\, brings you back to the list, on the same row. While you are attached on tmux, the terminal's title names the agent and the key back, such as `APP-24 · ctrl+\ back`, and the title you had comes back with you. Nothing else of Skelcrew's shows over the agent. On a row where Enter attaches, the bottom line says so before you go, as `⏎ attach`, with `· ctrl+\ back` on tmux. A runtime plugin's host has its own key to come back, and its rows say only `⏎ attach`. Elsewhere Enter says `⏎ open`. The list needs no tmux server of its own.

```
 Skelcrew v0.6.0  [ app ]  [ docs ]  [ site •1 ]

   ● lead    claude                                       │ Rate limit the API
     asks you                                             │ issue #42  github.com/acme/app/issues/42
     asks: start a task on #31 "Export as CSV"?   y/n     │ PR #43     github.com/acme/app/pull/43
                                                          │
 Needs you 1                                            │ Building · question
 ▸ ● APP-T103  Rate limit the API                         │ CI running: test ✓  lint ●  build ●
     question · #43 · CI running · 14:02                  │ Round 2 · changes asked
                                                          │   - The limit resets per process, not per user
   Up next   1  Building 2/2 · 1 queued                   │
   ○ APP-26  Dark mode                                    │ Add a limit per user to the public API, so one
     starts next · 14:45                                  │ client can't starve the others. …
                                                          │
 1 Backlog   2                                            │ 13:40 submitted · 13:52 reviewed · 14:02 submitted
 2 Building  2                                            │
   ○ APP-24  Login redirect                               │
     working · Editing rows.ts · #40 · CI passed · 14:31  │
   ○ APP-25  Export as CSV                                │
     working · #44 · CI running · 14:40                   │
                                                          │
 3 Reviewing 1                                            │
 4 Checks    0                                            │
 5 Ready     1                                            │
 6 Done      4                                            │

 ↑↓ move  ⏎ open  1-6 stages  y/n answer  ⇥/alt+shift+←→ repository  q quit   cpu 63%  mem 9/32G
```

The list is one repository's, picked as [Opening a repository](commands.md#opening-a-repository) says. The top line has Skelcrew's version, with the host you gave `--remote` after it on a server, then a tab for each repository, together on the left. The open one is highlighted. Each other one has a badge: a dot and how many of its tasks need you, in yellow, or red when one of them went wrong, then a dot and how many are ready to merge, in green. Each shows only when there are any, and both when both apply, such as `site •2 •1`. A task that waits on you only to merge it, under Needs you as `ready to merge`, counts only in green, never also in yellow. Tab or Alt-Shift-Right moves to the next one, Shift-Tab or Alt-Shift-Left to the previous one, each wrapping round, and a click on a tab opens it. The list asks your terminal to report the mouse only while it shows, so an agent you attach to and your shell after you quit get the mouse as usual.

The repository's lead comes first, under the top line, always shown. Its row looks like a task's, so it reads as a row you open: its mark, `lead` and its harness, then under them what it is doing. Requests from the lead that wait for your yes, such as starting a task or adding a repository, show under it, one per line, newest first. Then come the repository's tasks, never its threads on their own, in eight sections: Needs you, Up next, then six stages, in this order:

- **Needs you**: every task that waits on you, whatever its stage, so one row and Enter reach it. Its word is what you must do, such as `question`, `ready to merge` or the action the lead marked it with, as [Needs you](flow.md#needs-you) says.

- **Up next**: what waits for a builder. First the tasks queued under `limits.threads`, in the order they will start, numbered, the first marked `starts next`. Then the threads paused with `sc stop`, the newest task first, as they start only when you `sc start` them. A queued or paused task that needs you shows under Needs you instead, and its details still say what it waits on.
- **Backlog**: not started yet. The tracker's open issues Skelcrew knows of that no thread works on, and the tasks in Skelcrew's backlog. The newest 10, then a row such as `… 24 more`, which Enter opens to show them all until you leave the list.
- **Building**: a builder is working on it, including after the reviewer asked for changes. A thread that failed is here too, as its builder is what must start again.
- **Reviewing**: a review is running, or queued for a place under `limits.reviews` or for its harness's usage limit. A review that failed or timed out is here too.
- **Checks**: Skelcrew's reviewer approved, and the task waits on CI for that commit.
- **Ready**: approved and green. One that waits for you to merge it shows under Needs you, so Ready holds those with a merge when ready armed, which merge by themselves.
- **Done**: merged or closed. Those that ended today, or the last 10 when fewer ended today.

Each task is in exactly one stage, decided from its state alone, and shows in exactly one section. Needs you and Up next are sections, not stages: a task that needs you or waits for a builder keeps the stage of its work, which decides what Enter and `m` do on it, and shows under Needs you or Up next instead of under its stage. Once it no longer needs you, such as when its mark clears, it goes back under its stage. The row you are on stays yours as it moves between sections, and a closed section it moves into opens. Needs you and each stage have the task that changed last first. Up next has its tasks in the order they start. Backlog has the newest issue first.

Each stage's heading has the number key that opens and closes it, its name and how many tasks it has, lined up with the other headings' counts, such as `2 Building  4`. The Needs you heading has no number key, and its count is yellow while any task waits on you. The Up next heading has no number key either, and after its count says, dim, how full the builders are: how many run of how many `limits.threads` allows, and how many tasks wait, such as `Building 4/4 · 3 queued`. Without `limits.threads` it says nothing more. On a narrow terminal that goes first. Every heading's count always shows, so a closed section still says what waits in it. An open section's heading sits right above its rows and scrolls with them, so a stage's heading with no rows under it is closed. Needs you or Up next with no task in it is still open: its heading shows alone, with its count `0`. When the sections don't fit, the lead stays and the sections scroll, keeping the row you are on in view. The first and last lines of the sections then say what is hidden past them, such as `↓ 5 more in Building`, with each heading hidden there pinned in short, such as `Checks 2`. On a terminal too narrow for that, the edge says it in fewer letters, then by number keys, with `!` for Needs you and `>` for Up next, such as `↓ 4:2`, so no count is cut off. The sections never end on an open heading whose rows are below them: it is pinned at the edge instead. Opening a section moves you to its first row, so its heading and first rows show. Needs you and Up next are always open: they have no number key, and a click on their heading does nothing, so what waits on you never hides, nor what starts next. Building is open when the list starts, and you start on the first task under Needs you, or on the lead when none waits on you. The sections you open or close stay so until you leave the list, whichever repository you move to.

A task in Needs you, Up next, Building, Reviewing, Checks or Ready takes two lines, so what it does sits under its title. The first has its mark, its name and its short title, or its title cut with `…` to fit. The second has its word in its colour, then dim the step its builder is on, its PR, its CI and when it last changed, such as `working · Editing rows.ts · #40 · CI passed · 14:31`, with `14:31` today or `12 Nov` before. The step shows only when its harness gives one in words, such as a command's description, never the command itself. A task in Backlog or Done takes one line, in columns from the left: its mark, its name, its title, then when it last changed. Each column is as wide as the widest value showing, so the rows line up. The row you are on is highlighted on all its lines. Details such as a merge when ready or messages waiting are for `sc show`. When a thread needs you, its mark is yellow and its word says why, such as `question`. A task that waits on you only to merge it is the exception: its mark is green, beside `ready to merge`. Its word says what is happening:

| Word | Means |
| --- | --- |
| `working` | The builder is working |
| `starts next`, `2nd in line` | The task waits for a builder under `limits.threads`, at that place in the queue, so it shows under Up next |
| `paused` | The thread was stopped with `sc stop`, and waits for `sc start`, under Up next |
| `queued for review` | A review waits for a place under `limits.reviews` |
| `reviewing` | A review is under way, or waits for CI's first check |
| `checks` | Approved, or submitted in a flow with no review, and waiting on CI for that commit |
| `waiting` | The builder waits, with no review under way, no approval and no changes asked for |
| `changes` | The reviewer asked for changes, and the builder hasn't picked them up yet |
| `limit · 13:59` | The builder or the review waits for its harness's usage limit to reset |
| `ready to merge` | Approved and green, and waits on you to merge it, so it shows under Needs you |
| `approved` | Approved and green with a merge armed: it merges by itself, so its mark is hollow, it doesn't count as ready and it stays under Ready |
| `ready to merge, not reviewed` | Green in a flow with no review, and waits on you to merge it, so it shows under Needs you. The word says nobody reviewed it |
| `not reviewed` | Green in a flow with no review, with a merge armed: it merges by itself and stays under Ready, as `approved` does |
| `question` | The builder asked with its harness's question tool |
| `turn ended` | The builder ended its turn without submitting, and its last message went to the lead |
| `error` | The builder's harness stopped on an error |
| `round limit` | Review hit its round limit. It needs you until you or the lead decide, as [Needs you](flow.md#needs-you) says |
| the action, such as `apply the check.yml split in PR #463` | The lead, you or the safety net marked the thread as needing you, with what you must do. It shows on a queued, failed or stopped thread too, and only a question or an error comes before it |
| `review failed`, `review timed out` | The review couldn't run, or ran past its time limit twice. The lead can run it again, so it doesn't need you |
| `submit failed`, `check failed` | In a flow with no review, pushing the submit or opening its PR failed, or Skelcrew couldn't set its check. The lead can run it again, so it doesn't need you |
| `failed` | As the thread's status says. It doesn't need you: the lead hears why a thread failed and can start it again |

The marks: a filled `●` needs you or is ready, a hollow `○` doesn't. Green is ready, yellow wants you, red is wrong (its harness errored, filled, or the thread, its review, or a submit its flow doesn't review failed, hollow, as the lead can start or run it again), bright is working and dim waits. The word always says what is happening, so nothing is told by colour alone. Text from the tracker has its control codes removed before it reaches your terminal.

| Key | On | What it does |
| --- | --- | --- |
| ↑ ↓ | Anywhere | Move one row |
| `1` to `6` | Anywhere | Open or close Backlog, Building, Reviewing, Checks, Ready or Done |
| Enter | The lead | Attaches full screen to the lead |
| Enter | Backlog | Asks `Start APP-31? y/n` in the bottom line, then starts the task, as `sc start` does. When every builder `limits.threads` allows is busy, or tasks already wait, it asks `Queue APP-31? 4 of 4 builders busy, so it starts after the 3 queued. y/n` instead. Either way, the bottom line then says what happened, such as that the task waits in the queue, which it can also do after `Start`, when a builder took the last place while you were asked |
| `s` | Backlog | The same as Enter there: asks, then starts or queues the issue or the task of the backlog |
| Shift-↑ Shift-↓ | A queued task in Up next | Moves it one place earlier or later in the queue, which changes the order the tasks start in, and the bottom line says its place, such as `APP-26 starts next`. The engine keeps the order, so a restart keeps it. On a paused task the bottom line says `sc start` brings it back |
| Enter | Up next | Says in the bottom line what the task waits on, as no builder runs for it yet |
| Enter | Building, Reviewing, Checks | Attaches full screen to the task's builder, through its session host. Detaching returns to the list, on the same row |
| Enter | Ready, Done | Opens the PR in your browser, or copies its link, as OSC 52, when Skelcrew runs on a server. Without a forge the bottom line shows the approved branch, such as `APP-T103 is ready on branch skelcrew/t103-fix-login`. A ready task whose builder needs you attaches to the builder instead, so one Enter reaches what it waits on |
| `o` | A task, while the details pane shows | Shows the agent's whole screen in the pane, or only its last 3 lines again. The bottom line offers it beside Enter, as `⏎ attach · o output` |
| Page Up, Page Down | A task, while the details pane shows | Scrolls the task's details in the pane a page up or down. The bottom line offers them after `o`, as `o output · pgup/pgdn scroll` |
| `m` | Ready | Asks `Merge app#41 into main? y/n`, then merges it on the forge. Not offered without a forge, where the line says so, nor while its builder needs you. If the forge refuses, the line says why |
| `y` `n` | A request from the lead | Answers it |
| Click | A task | Moves to it. A second click on it, or a double click, does what Enter does |
| Click | The lead | Attaches full screen to the lead |
| Click | A heading | Opens or closes its stage. Needs you and Up next stay open |
| Wheel | The details pane | Scrolls the task's details 3 lines up or down |
| Wheel | Anywhere else | Moves one row up or down, which scrolls the list |
| Tab, Alt-Shift-Right | Anywhere | The next repository, after the last the first |
| Shift-Tab, Alt-Shift-Left | Anywhere | The previous repository, before the first the last |
| Click | A repository's tab | Opens that repository |
| `q` | Anywhere | Leaves the list. Everything keeps running. Skelcrew prints `Your agents keep running. Run sc --list to come back.` |
| Ctrl-\ | Anywhere | Nothing: it comes back from an agent, so pressing it once too often never leaves the list |

The engine does what the keys ask, as only it talks to the tracker and forge. Merging, starting and the order of the queue stay yours: the lead can't press these keys, and the merge confirm says when the PR changes `.agents/`.

The list reads only Skelcrew's database and its copy of the tracker, so it opens at once and never asks GitHub itself. It writes to the terminal only when what it shows changes, so a list sitting open sends almost nothing over a slow link. The machine's load is the exception: the bottom line ends with it, such as `cpu 63%  mem 9/32G`, refreshed every 5 seconds, for the machine the engine runs on. CPU is the busy share of all cores over the last 5 seconds, and memory the system can free counts as free. Each figure is dim, turns yellow from 80% and red from 95%, and gives way before any key on a narrow terminal.

**The details pane.** Beside the list, on its right, a pane shows the row you are on, and follows it as you move. It shows, from the top: the task's full title, the issue's link and the PR's link, its stage and word, what a queued or paused task waits on, wrapped whole, such as `3rd in line: 4 of 4 builders busy`, `2nd in line: APP-21 waits for its issue's claim to reach the tracker` when a claim holds the queue back, or `Paused with sc stop: sc start APP-9 brings it back`, its CI with each check, its review round with the verdict and the latest review's findings in short, its whole description, and its recent events, such as submitted, reviewed and merged. They have the list's look: the title bold, labels dim, each check with its mark, CI's and the review's verdicts in the list's colours, green for passed or approved, yellow for running or changes, red for failed, the links as terminal links, the findings indented, the description dimmer, and the events dim with their times. The description keeps its own line breaks, with each run of blank lines made one. A line wider than the pane wraps at its words, and a list item's lines after its first start under its text, past its marker, so a list still reads as one. A thin rule parts them from the live view. It is what `sc show` gives, read from Skelcrew's copy and database alone, so it never asks the forge, not even for the logs of failed checks. On a row that isn't a task, such as the lead's, the pane is empty. The list takes a little over a quarter of the terminal, 28%, and the pane the rest. The list is never narrower than 40 columns, so a row's name, short title and word fit, with longer ones cut with `…`. It is never wider than 58, which a task's two lines need. The pane shows only on a terminal at least 114 columns wide, so its agent's lines can be read. In a narrower terminal it is hidden, and the list is as it would be without it. The keys do the same with the pane as without it. Under the task's details, under a thin line, the pane shows the row's agent at work, live. By default it is a strip of the agent's last 3 lines of output, blank lines left out, at the bottom of the pane wherever the details end, so the details have the rest of the pane and the strip never moves. `o` makes it the agent's whole screen, filling the rest of the pane's height under the details, which then take half the pane at most, and `o` again makes it the strip. It stays as you move, until you press `o` again. Enter still attaches to the agent. The live view always keeps its room, a line over it and the strip's 3 lines, or a few of the agent's lines while it shows the whole screen. When the details need more than is left, they scroll, and the live view stays where it is, at the bottom of the pane. A dim `↓ more` on their last line says there is more below. Page Up and Page Down scroll them a page, and the mouse's wheel over the pane 3 lines. Moving to another row shows its details from their top. It is the bottom of the agent's screen, without its harness's own input box and status lines, as nobody can type there from the list, and without the harness's notices and tips over the box, which would push the agent's output out of the strip. Each harness knows its input box by its shape, such as Claude Code's `❯` prompt between two rules. For Claude Code these are its effort notice right on its box, such as `◐ medium · /effort`, and its tip under its busy line, such as `⎿  Tip: Use /btw…`, each known by what it says. The busy line stays, as it shows the agent at work. Any other line stays too, whatever its indent or place, as it may be the agent's output. A screen where the box isn't found shows whole. It is read without attaching, as `sc peek` reads it, so it works on any session host. It is read several times a second, only for the row you are on, and only while the list shows. Colours are kept, and a line wider than the pane is cut on the right, not wrapped. The agent's session is never resized, and no key typed in the list reaches it. A row with no agent running says so in one line, such as `Builder not running`.

**A lead you exit.** Exiting a repository's lead, such as with `/exit` or Ctrl-D, ends only the lead. The repository, its clone and its tasks stay, and the engine keeps polling. The engine notices the exit and doesn't bring that lead back at its start. Opening the repository again, by `sc` in a checkout of it or `sc attach lead`, starts the lead again with its conversation. A lead that crashes is brought back with its conversation when you look at it.

With herdr as the session host, its own apps show the same agents, labelled and with their state. Skelcrew's list keeps working beside them, and is the only place that merges and answers the lead's requests.

## The screen

Plain `sc` shows the list as a sidebar, on the left of your terminal, and on the right what the row you are on is. It runs on a tmux server of the screen's own, whatever your session host, with one session per open terminal, ended when you leave. Your own `~/.tmux.conf` never applies to it.

```
 Skelcrew v0.6.0  [ app ]  [ docs ]  [ site •1 ]
                                                   │ Rate limit the API
   ● lead    claude                                │ issue #42  github.com/acme/app/issues/42
     asks you                                      │ PR #43     github.com/acme/app/pull/43
                                                   │ Building · question
 Needs you 1                                       │ CI running: test ✓  lint ●  build ●
 ▸ ● APP-T103  Rate limit the API                  │ Round 2 · changes asked
     question · #43 · CI running · 14:02           │ 13:40 submitted · 13:52 reviewed
                                                   │ ───────────────────────────────────
 1 Backlog   2                                     │ ● Should the limit be per user or per
 2 Building  2                                     │   API key?
   ○ APP-24  Login redirect                        │   1. Per user
     working · Editing rows.ts · #40 · 14:31       │   2. Per API key
   ○ APP-25  Export as CSV                         │
     working · #44 · CI running · 14:40            │
 3 Reviewing 1                                     │
 4 Checks    0                                     │
 5 Ready     1                                     │
 6 Done      4                                     │
                                                   │
 alt+↑↓ move  ⏎ open  alt+1-6 stages  alt+q quit   cpu 63%  mem 9/32G
```

**The sidebar** is the list, as the rest of this section describes it, in a column of its own. It is as wide as the list beside its details pane, by the same rule, and narrower on a terminal where that would leave the right side less than half. Its top line has Skelcrew's version and the repositories' tabs, with their badges, and its bottom line the keys and the machine's load. Under the top line come the lead's row and the requests that wait for your yes, then the list's sections: `Needs you`, `Up next`, then the six stages, Backlog, Building, Reviewing, Checks, Ready and Done, which open and close as in the list. Shift-↑ and Shift-↓ move a queued task in Up next as in the list, and the bottom line says its place. The screen always starts on the lead's row, so what you type first goes to the lead, even while a task waits on you: Alt-Shift-↓ reaches the first task under `Needs you`, past any requests. The sidebar is wide enough that a task's two lines usually fit whole, such as `working · Editing rows.ts · #40 · CI passed · 14:31`, and it keeps that width when the terminal is resized. The right side takes the rest, and always keeps at least half the terminal, so the lead or an agent stays usable there. In a terminal too narrow for both, the sidebar narrows to the other half, and its rows are cut with `…` as the list's are on a narrow terminal.

**The right side** follows the row you are on:

- **On the lead's row**, it is the lead's session, live, and what you type goes to the lead.
- **On a task's row**, or a request's, it is the details pane, exactly as the list's: the task's details, which scroll as there, with its agent's screen live under them, read-only, as **The details pane** says. On the screen it always shows, however narrow the terminal, since the right side keeps its half: only the full-screen list hides it. A request's row shows the lead's screen live, read-only, with no details. Nothing you type reaches the agent there, so the list's own keys work.
- **After Enter on a task** whose Enter attaches in the list, its agent's session takes the right side, attached through its session host, and what you type goes to it. Ctrl-\ comes back to the details and live view, on the same row. Moving to another row comes back too, and shows that row.

On the lead's row, Enter goes to the lead, as everything you type there does, and never attaches full screen. Enter on any other task's row or request's row does what it does in the list: on Backlog it asks in the bottom line and starts the task, and on Ready or Done it opens the PR or shows the approved branch.

**A runtime plugin's host** shows its sessions on the screen through its own `attach`, run inside the right side as in any terminal. You get the agent's terminal there, without the host's own sidebars or apps, and you run the host itself, outside `sc`, for all it offers. The screen's tmux takes Ctrl-\ before anything in a pane sees it. So herdr's key to detach, the same key, never reaches herdr's client on the screen, and can never detach it and leave the right side empty. If a host's `attach` ends while its agent still runs, the right side goes back to the task's details and live view, or attaches to the lead again on its row. The screen tells the two apart with the sessions module's `check`: only an attach that ended while the lead's session still runs, as when its client was detached, is attached again. A lead that crashed is brought back with its conversation and attached, as **A lead you exit** says. A lead you exited, such as with `/exit`, stays ended, as it says too. `check` says which of the two it was, by whether the lead exited cleanly. A plugin's host that can't yet say how a session ended leaves that unknown, and the screen then takes the lead as exited: it stays ended, as starting a lead you exited is worse than one line asking you to. The right side then says so, and how to start it again: `The lead ended. Run sc attach lead to start it again.`

**Keys.** On the lead's row and on an agent you attached to, your typing goes to the agent, so the screen's own keys there use Alt. Everywhere else, on a task's row or a request's, your typing goes to the sidebar, and the list's keys work without Alt too. Alt-1 to Alt-6 need Option sent as Alt on a Mac, as Alt-Q does, since Option with a digit otherwise types a character, such as `¡`.

| Key | On | What it does |
| --- | --- | --- |
| Alt-↑ Alt-↓ | Anywhere | Move one row. Moving off an agent you attached to comes back from it first |
| Alt-Shift-↑ Alt-Shift-↓ | Anywhere | Move to the first row of the previous or next section: the lead, `Needs you`, or an open stage |
| Alt-1 to Alt-6 | Anywhere | Open or close Backlog, Building, Reviewing, Checks, Ready or Done, as `1` to `6` do in the list |
| Alt-Shift-Left, Alt-Shift-Right | Anywhere | The previous or next repository, each wrapping round |
| Alt-Q, Ctrl-Q | Anywhere | Leaves the screen. Everything keeps running. Skelcrew prints `Your agents keep running. Run sc to come back.` in place of tmux's own `[exited]`. Ctrl-Q isn't shown. It is for a Mac terminal that doesn't send Option as Alt, which has no other way to leave, so it quits even while you type to an agent |
| Click | The lead | Moves to it, so the right side shows the lead, ready to type to. It never attaches full screen, as in the list |
| Click, wheel | Anything else in the sidebar | As in the list, wherever your typing goes |
| Wheel | A task's details on the right | Scrolls the details 3 lines up or down, as over the list's details pane |
| Ctrl-\ | An agent you attached to | Comes back to the task's details and live view |
| Ctrl-\ | Anywhere else | Nothing, so pressing it once too often never leaves the screen, and it never reaches a pane |
| The list's keys | A task's row or a request's | As in the list: ↑ ↓, `1` to `6`, Enter, `o`, Page Up and Page Down, `s`, `m`, `y` `n`, Tab and Shift-Tab. `q` does nothing, so text meant for an agent never closes the screen |

Only Alt-Left and Alt-Right without Shift stay the agent's, as some terminals send them to move a word while you type.

