# Needs you

Needs you is your inbox. It sits at the top of the sidebar, and shows only while something waits on you.

Waiting on a review, on CI or on the queue never needs you. Only a decision does, or something only you can do.

## What lands there

**Questions from the lead.** Builders never ask you directly. They ask the lead. The lead decides what it can, and brings you the rest as an item: a short title, the question, its options, and what it recommends.

In the sidebar, each item takes two lines: the task, then the item's title and how many options it has.

```
  158 Pi harness
    Pi sign-ins expire · 3 options
  170 Review lists
    Force merge? · y/n
```

Press Enter on it to read it whole. The item opens in a box, and the task's details show the same box:

```
  ┌──────────────────────────────────────────────────────────┐
  │ Sign everyone out?                                       │
  │                                                          │
  │ The fix changes how sessions are stored, so everyone is  │
  │ signed out once. Sign everyone out on deploy, or keep    │
  │ old sessions working for a week? I recommend a: it is    │
  │ simpler and safer.                                       │
  │                                                          │
  │ a) sign everyone out                                     │
  │ b) keep old sessions for a week                          │
  │ r) reply                                                 │
  └──────────────────────────────────────────────────────────┘
```

**Things Skelcrew sees itself.** Some things put a task under Needs you at once, before the lead has looked. Each is an item of Skelcrew's own, with options that act at once:

| What happened | Its options |
| --- | --- |
| The task reached the round limit: "Review still wants changes after 3 rounds", with the latest findings | Go on: fix the findings, as `sc start`. Merge without approval, as `sc merge --skip-review`. Stop the builder, as `sc stop`. |
| Approved and green, with no merge armed: "Ready to merge" | Merge it. Not yet. |
| The builder asked a question in its own session, or ended its turn without handing in a round | Open the builder. Let the lead handle it. |
| The builder hit an error, such as a lapsed sign-in, or its session host is missing | Start it again. Open the builder. |

The lead hears about each, and may post an item of its own, which then takes its place. "Let the lead handle it" and "Not yet" take the item off your list until something new happens.

## Answering

Move to the item in the sidebar and press Enter to open it. Then:

| Key | What it does |
| --- | --- |
| `a` to `d` | Pick that option. A merge asks y/n first. |
| `r` | Type a reply to the lead's item. Enter sends it, Esc drops it. |
| ↑ ↓ | Scroll a long item |
| Esc | Go back to the list |

On a phone, tap an option, or the reply line.

`sc --list` takes the same keys.

## What happens next

Your answer goes to the lead as a note, such as:

```
You picked a (sign everyone out) on APP-12: <the item's text>
```

It counts as your own words. The lead does exactly what you picked, nothing more. The item then leaves the list. A pick on one of Skelcrew's own items runs at once, and the lead hears of it the same way.

## Other ways to see it

`sc ls` and `sc ps` show which tasks have an item waiting. `sc show APP-12` shows the item's title, text and options.

## Answering in the builder

A question the builder asked in its own session is answered there. Press Enter on its row to open its item, then `a` (Open the builder) to attach to the builder, and answer it. Shift+Enter on the row opens the builder full screen. Once you type to it, the mark goes.

An error is fixed in the builder too. For example, a lapsed Claude Code sign-in is fixed with `/login`.

A round limit is answered by its item's options, or with `sc start APP-12` to let it go on, or by merging or dropping the task. See [How a task goes](how-a-task-goes.md).
