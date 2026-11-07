# Subagents

Nov 7, 2026 · draft · after the launch

## Goal

A builder can split its task and hand the parts to subagents. Each subagent starts from its prompt alone, works in parallel or stacked on another, and reports back into the builder's input. The builder answers what it can and passes the rest to you. You only hear about outcomes and decisions that are yours.

This is Capy's model of subagents, fitted to skel. It replaces the earlier "agents hear back" draft. The spec lists "agents talking to each other" and "threads started from plain text" as not in this version, so this waits until after the launch on 16 November.

## Words

| Word | Meaning |
| --- | --- |
| Subagent | An agent a builder starts for part of its task. It has its own session and conversation, and none of the builder's history. |
| Parent | The agent that started a subagent: the thread's builder, or another subagent. |
| Shared | A subagent that sees its parent's clone read-only, uncommitted changes included. For reading, investigating and testing. |
| Fresh | A subagent with a clone and branch of its own. For writing. It ships its own PR. |
| Stacked | A fresh subagent that starts from another subagent's branch instead of the base branch, so overlapping work can't conflict. |

A subagent is named by its place in the tree: app-12's first subagent is `app-12.1`, and that one's third is `app-12.1.3`. Subagents nest at most three levels deep. A name never changes and is never reused within a thread.

## The flow

1. **The builder drafts a subagent.** `skel sub draft "<prompt>" --shared` or `--fresh` prints its name, such as `app-12.1`. The builder must choose shared or fresh: there is no default, since a writer on a shared clone would collide with its parent. `--after app-12.1` stacks a fresh subagent on another one's branch. `--model` picks another model than the parent's.
2. **The builder starts it.** `skel sub start app-12.1`, or `--start` on the draft to do both at once. A draft does nothing until started. A builder that wants your view first asks you with `AskUserQuestion`, as for any other decision.
3. **skel sets the subagent up.** A shared subagent gets its parent's clone through a throwaway layer, as the reviewer does, so it can run the tests but changes nothing. A fresh one gets its own clone at `~/.local/share/skel/threads/app-12.1/`, on branch `skel/12-1-<slug>` from the base branch, or from the branch named by `--after`. Its setup commands run once. Then a Claude Code session starts in the sandbox with the prompt as its first message.
4. **The subagent works.** Its progress doesn't wake the parent. The parent can look in with `skel sub read app-12.1`, which shows the end of its screen, and can steer it with `skel send app-12.1 "<text>"`.
5. **The subagent finishes.** It runs `skel done "<summary>"`. A fresh subagent commits first, and skel fetches its branch into skel's own clone, as for `skel submit`. skel types the summary into the parent, with the diff's file list for a fresh one. This wakes the parent.
6. **The parent checks a writer's work.** It reads the diff in skel's clone, then either sends feedback with `skel send`, which wakes the subagent again, or ships it with `skel sub ship app-12.1`.
7. **A shipped subagent follows the normal flow.** skel pushes its branch and opens a PR, with `Part of #12` in its body, and against the stacked branch when it has one. Reviews, CI failures and PR comments go to the subagent's session, as they go to a builder's. Approved and green, the thread needs you. You merge, and the subagent is done.

**The thread** is done when its builder's own PR merges. A builder that only coordinates opens no PR. Its thread is done once all its subagents are done and it runs `skel done` itself.

## Hearing back

Only an outcome or a question wakes a parent. Everything skel types into a parent is tagged with its sender:

```
<skel from="app-12.1">The flaky test is a race in session cleanup. Fixed in 2 files.</skel>
```

| What happened | Who hears it |
| --- | --- |
| A subagent ran `skel done` | Its parent |
| A subagent asked a question with `AskUserQuestion` | Its parent, with the question |
| A subagent failed or its session ended | Its parent, with the last lines of its screen |
| A shipped subagent's PR is approved and green | You: the thread needs you |
| A parent escalated a question | You: the thread needs you, naming the subagent |

**Questions.** A subagent's question goes to its parent first. The parent answers it with `skel send`, or passes it on with `skel sub escalate app-12.1`. The thread then needs you, and the lead tells you, as for a builder's question. You answer it by picking `app-12.1` in the sidebar. A parent never answers a question that is yours to decide: a choice of product, scope or risk is escalated, a fact it knows is answered.

Notes wait until the parent is idle, are kept in the database, and survive a restart, like the notes skel types into the lead. A note about something the parent has since seen, such as a question it already answered, is dropped.

## Commands

For a builder or a subagent, about its own subagents:

| Command | What it does |
| --- | --- |
| `skel sub draft "<prompt>" --shared\|--fresh [--after <name>] [--model <model>] [--start]` | Drafts a subagent and prints its name |
| `skel sub start <name>` | Starts a draft |
| `skel sub ls` | Its subagents, with placement, status and model |
| `skel sub read <name>` | The end of a subagent's screen |
| `skel send <name> "<text>"` | Types into a subagent: feedback, an answer or a change of task |
| `skel sub ship <name>` | Sends a fresh subagent's work to review and a PR |
| `skel sub escalate <name>` | Hands a subagent's question to you |
| `skel sub stop <name>` | Ends a subagent's session, keeping its clone, branch and PR |

For a subagent:

| Command | What it does |
| --- | --- |
| `skel done "<summary>"` | Reports the outcome to the parent |

An agent can only name its own subagents. The socket says who is calling, so a subagent can't reach a sibling or another thread.

For you, nothing new: `skel ps` lists subagents under their thread, `skel attach app-12.1` opens one, and `skel stop app-12` ends a thread with all its subagents.

## Status

A subagent's status is `draft`, `working`, `waiting` (on its parent, review, CI or you), `failed`, `stopped` or `done`. In the sidebar, subagents are rows under their thread, indented one step per level, with the same marks and words as a thread. A shared subagent's word ends with `· shared`.

## Rules

- **Agents ask, skel starts.** A builder never starts an agent itself. It asks the daemon, which owns every session, sandbox and clone.
- **Writers touch disjoint parts.** Parallel fresh subagents must work on separate parts of the code. When in doubt, stack: a merge conflict costs more than the wait.
- **The review stays independent.** Shipping goes through skel's reviewer, on another model. A parent checking its subagent's diff doesn't replace it.
- **Four at a time.** A thread has at most four subagents working at once, across all levels, so one task can't take the machine. More can be drafted.
- **They end with the thread.** When a thread is done or stopped, its subagents' sessions end. Their clones go when their own PRs merge or close.
- **No new GitHub access.** Subagents call skel commands like builders, and never see a token.
- **A Sprite stays awake** while any subagent works, as for a builder.

## Prompts

**The builder** learns when to split: when parts can be done separately, or when an investigation would fill its own context. Shared for reading, fresh for writing. Disjoint writers, else stack. Check a writer's diff before shipping. Answer questions with facts you know, and escalate choices.

**A subagent** learns that its prompt is its whole task, that `skel done` ends it with a short summary, and that details belong in commits or the PR.

## Not in this draft

- The lead starting subagents. The lead starts threads, which is its way to split work.
- Messages between siblings, or between threads.
- Harnesses other than Claude Code for subagents.

## Open questions

1. Should the builder's own Claude Code subagents be turned off, so there is one way to split work? They cost nothing, but they are invisible in skel.
2. Should a subagent's PR merge into its parent's branch instead of main, giving one PR per task?
3. Is three levels right, or is one level enough to start?
