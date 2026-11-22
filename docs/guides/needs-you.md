# Needs you

Needs you is your inbox. It sits at the top of the sidebar, and shows only while something waits on you.

Waiting on a review, on CI or on the queue never needs you. Only a decision does, or something only you can do.

## What lands there

**Questions from the lead.** Builders never ask you directly. They ask the lead. The lead decides what it can, and brings you the rest as an item: a short question, its options, and what it recommends.

An item under its task looks something like this:

```
  The fix changes how sessions are stored, so everyone is signed out
  once. Sign everyone out on deploy, or keep old sessions working for
  a week? I recommend a: it is simpler and safer.
  a) sign everyone out
  b) keep old sessions for a week
  r) reply
```

**Things Skelcrew sees itself.** Some things put a task under Needs you at once, before the lead has looked:

- The builder asked a question in its own session.
- The builder hit an error, such as a lapsed sign-in.
- The task reached the round limit.
- The builder ended its turn without handing in a round.

These show as `the lead is looking at this`. The lead hears about them, and soon posts an item of its own.

**Tasks ready to merge.** A task that is approved and green, with no merge armed, waits on you too. Its row says `ready to merge`.

## Answering

Move to the item in the sidebar. Then:

| Key | What it does |
| --- | --- |
| `a` to `d` | Pick that option |
| `r` | Type a reply. Enter sends it, Esc drops it. |
| Enter | Open the item full size, to read all of it. Esc goes back. |

On a phone, tap an option, or the reply line.

`sc --list` takes the same keys.

## What happens next

Your answer goes to the lead as a note, such as:

```
You picked a (sign everyone out) on APP-12: <the item's text>
```

It counts as your own words. The lead does exactly what you picked, nothing more. The item then leaves the list.

## Other ways to see it

`sc ls` and `sc ps` show which tasks have an item waiting. `sc show APP-12` shows the item's text and its options.

## Answering in the builder

A question the builder asked in its own session is answered there. Press Enter on its row to attach to the builder, and answer it. If the lead has posted an item on that row, the first Enter opens the item. Press Enter again to attach to the builder, or Shift+Enter on the row to open it full screen. Once you type to it, the mark goes.

An error is fixed in the builder too. For example, a lapsed Claude Code sign-in is fixed with `/login`.

A round limit is answered with `sc start APP-12` to let it go on, or by merging or dropping the task. See [How a task goes](how-a-task-goes.md).
