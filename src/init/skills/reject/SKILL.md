---
name: reject
description: Send a Skelcrew task's spec or merge back, with the developer's note on what to change. Use only when the developer asks to send task 12 back themselves, or types "/reject 12 Add totals."
disable-model-invocation: true
---

# Send a Skelcrew task back

The developer asked to send back the task the developer named, such as 12, with a note that
says what to change. A spec goes back to Spec. A merge goes back to In progress.

If you weren't given a task number, ask the developer which task, and wait.

If you weren't given a note, ask the developer what to change, and wait. The note is theirs.
Don't write it for them.

The commands below use 12 as the task number. Use the number the developer gave instead.

## 1. Send it back

Run this, with the developer's note in quotes, so it stays one piece:

```
skelcrew reject 12 "<note>"
```

Use the developer's own words. If the note holds a double quote, put it in single quotes
instead.

If it is refused, such as when nothing waits for the developer's approval, say why in one
sentence, and stop. `skelcrew status` shows what does wait.

## 2. Tell the developer what happened

Give the command's answer, such as "Sent #12 back to Spec with your note."

Then say how the work goes on. The note goes to whoever picks the task up next:

- Back in Spec: `/spec 12` works out the spec again, with the note.
- Back in In progress: `/develop 12` builds it again, with the note.
