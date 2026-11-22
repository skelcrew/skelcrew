# The screen

`sc` opens the screen for the repository you are in. This guide shows how to find your way around it.

## The two sides

The screen has two sides.

- **The sidebar**, on the left, lists the repository's lead and its tasks.
- **The right side** shows the row you are on: the lead, or a task's details with its agent at work.

A blue box shows where your typing goes. Only one side has it at a time.

The screen starts on the lead, so what you type first goes to the lead.

## The sidebar

The lead is the first row. Below it, tasks are grouped in sections:

| Section | What is in it |
| --- | --- |
| Needs you | Tasks waiting on your answer. It shows only while something waits. |
| Backlog | Issues and tasks not started yet. |
| Task queue | Tasks waiting for a free builder, and builders you paused with `sc stop`. |
| Building | A builder is working on it. |
| Reviewing | A reviewer is reviewing its latest round. |
| Checks | Waiting for CI, once the review approved it. |
| Ready | Approved and green. It waits for you to merge. |
| Done | Merged or closed lately. |

Each task shows once, in one section. Its row has a short word that says what is happening, such as `working` or `ready to merge`.

## Moving around

Press Ctrl+\ to bring your typing to the sidebar. Then:

| Key | What it does |
| --- | --- |
| ↑ ↓ | Move one row |
| 0 to 6 | Open or close a section: 0 is Backlog, 6 is Done |
| Enter | Open the row you are on |
| Shift+Enter, or `a` | Open the row's agent full screen |
| `s` | Start a task from the Backlog |
| `m` | Merge a task under Ready |
| Shift+R | Restart the row's agent, keeping its conversation |

Each key asks before it starts, merges or restarts anything.

The keys you can use on a row show at the bottom of the screen.

Some keys work from anywhere, even while you type to an agent:

| Key | What it does |
| --- | --- |
| Alt+↑ ↓ | Move one row |
| Alt+Shift+↑ ↓ | Jump to the next or previous section |
| Alt+0 to Alt+6 | Open or close a section |
| Alt+Shift+← → | Switch to another repository's tab |
| Alt+Q | Leave the screen |

You can also click. A click on a row opens it, and a click on a section's heading opens or closes it.

## Opening the lead or a builder

Enter on the lead's row gives your typing to the lead.

Enter on a task opens it:

- A task at work attaches you to its builder, on the right side. You type to it as you would in Claude Code or Codex.
- A task under Ready or Done opens its pull request.
- A task in the Backlog asks whether to start it.

Moving to a task without pressing Enter shows its details on the right: its stage, CI, review and recent events, with its agent live beside them. Nothing you type there reaches the agent.

## Getting back

Ctrl+\ always brings your typing back to the sidebar. From a builder you attached to, it also detaches you, and the right side shows the task's details again.

Pressing it once too often does nothing. It never leaves the screen.

If backslash is awkward on your keyboard, Ctrl+4 does the same in most terminals.

## Full screen

Shift+Enter, or `a`, gives the row's agent the whole terminal. Ctrl+\ brings the sidebar back.

To open a builder full screen without the screen, use `sc attach`:

```sh
sc attach APP-12
```

Ctrl+\ detaches you and brings you back to your shell. That is on tmux, the default. A runtime plugin, such as herdr, has its own key.

## The list

`sc --list` shows the same sections as a list, with a details pane beside it in a wide terminal. Enter attaches to an agent full screen, and Ctrl+\ comes back to the list.

## Leaving

Alt+Q leaves the screen. Your agents keep running, and the screen says so:

```
Your agents keep running. Run sc to come back.
```

## Narrow screens

On a terminal under 80 columns wide, such as a phone's, the screen shows one side at a time.

- The sidebar fills the screen, with its keys listed at the bottom.
- Tap a row, or press Enter, to open it. The lead or the builder then fills the screen.
- Ctrl+\ brings the sidebar back.
