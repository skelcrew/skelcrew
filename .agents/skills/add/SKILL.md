---
name: add
description: Capture a task as an Idea in Skelcrew, to spec later. Use when the developer asks to add a task or keep an idea, such as when the developer asks to add a task called "CSV export", or types "/add CSV export". Also use it while brainstorming tasks with the developer, for each task they agree to keep.
---

# Add an idea to Skelcrew

You add a task to Skelcrew as an Idea. An Idea waits until the developer asks for its spec.

## 1. Find the title

The title is what the developer gave, such as `CSV export`. Keep their words. If it runs
past about eight words, suggest a shorter title, and wait for them to agree.

If you weren't given a title, ask the developer what the task is, and wait.

## 2. Add it

Run this, with the title in single quotes:

```
skelcrew add '<title>'
```

Single quotes keep the title as it is. Inside double quotes, the shell would still run
anything in backticks and replace words that start with `$`. If the title holds a single
quote, write that quote as `'\''`. For example, `Don't cache` becomes `'Don'\''t cache'`.

It prints the new task's number, such as "Added #12: CSV export."

Skelcrew keeps only the title. Anything more the developer said about the task stays here,
in this conversation, as context. Don't try to store it anywhere else.

## 3. Tell the developer

Say what you added in one line, with its number, such as "Added #12: CSV export." If you
added several while brainstorming, list them, one line each.

Then say how to go on: `/spec 12` specs it, with the developer, when they are ready.

## While brainstorming

Add a task only once the developer has agreed to keep it. Never add one because it seemed
like a good idea to you. Suggest it first, and wait.

Adding is all you do here. You never ask for a spec, start work, or change a task.
