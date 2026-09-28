# Core invariants

These are the rules the core must never break, whatever happens. The developer approves
every change to this list. The property tests feed the core thousands of random input sequences and check
every rule after every step. Each per-transition test is written against this list.

A rule belongs here if breaking it would let an agent do something only the developer may
do, lose work, or leave the developer looking at a wrong picture.

## Only the core decides

1. **An agent never approves a spec.** With `spec_approval: always`, every
   `task.ready` comes from an approval sent by the developer.
2. **Agents and plugins never take the developer's decisions.** No agent, plugin or
   scheduler input ever produces a spec approval, a merge approval, a retry, a drop, a
   revert or a project change.
3. **Outside moves are requests.** An issue dragged to Done in another tool never moves a
   task.
4. **A rejected input changes nothing.** It produces no events and no commands.

## Nothing merges unchecked

5. **No task reaches Done without passing every gate** in `workflow.yml` on its latest
   build.
6. **A task that touches a critical path merges only after the developer approves it.**
7. **A merge only starts after the checks pass.** Every `task.merged` follows a
   `task.merge_started`, and every `task.merge_started` follows `task.checks_passed` on the
   same build.

## Limits hold

8. **Never more than `max_running` agents at once**, counting spec and develop sessions.
9. **The scheduler never starts a blocked task, or a task in a parked project.**
10. **A task never gets more failed rounds than `max_attempts`** without being blocked.
11. **A task over its safety cap is blocked.** The cap counts from the last retry.
12. **At most one open question per task.**

## Nothing gets lost

13. **Every agent the core started is either stopped or still stored on its task.** The
    same goes for every worktree. A transition that forgets to clean up breaks this.
14. **Each build gets its own branch.** A build number is never reused, so a new build
    never lands on code written for an old spec.

## The picture stays true

15. **No leftover flags.** A question from the spec agent only exists while the task is in
    Spec. A question from the develop agent only exists in In progress or Checks.
16. **A blocked task has no agent running.**
17. **Dropped is final.** A dropped task records no more events. A late worktree or
    agent is only removed or stopped. A Done task only accepts a revert, the answer
    to it, and a late usage report so the record keeps the true cost.

## Replay

18. **The same input always gives the same result.** Same task, same input, same config:
    the same decision.
19. **Replaying the log rebuilds the task exactly.** Folding a task's events through
    `evolveTask` from nothing gives the same task the core had before.
20. **Every event belongs to its task and its moment.** Its task ID and time match the
    input that caused it.
