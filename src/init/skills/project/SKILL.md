---
name: project
description: Make a Skelcrew project from a description, with a name and a goal you propose. Use when the developer asks to make a project, or to group some tasks, such as "a place for everything about exporting reports", or types "/project exporting reports".
---

# Make a project in Skelcrew

A project groups tasks. It has a short name and a one-line goal. The developer describes
what the project is for, in their own words. You propose a name and a goal from that, and
make the project once they agree.

## 1. Find the description

The description is what the developer gave, such as `a place for everything about
exporting reports`. If you weren't given one, ask the developer what the project is for,
and wait.

## 2. See which projects exist

Run:

```
skelcrew status
```

Each project shows as a line such as `Project Reports page:`. Two names that differ only in
capitals or spaces are the same name to Skelcrew: `Reports page` and `reports-page` clash.
If a project already fits the description, say so, and ask whether the developer wants that
one instead.

## 3. Propose a name and a goal

From the description, propose a name and a goal:

- **The name** is two or three words, such as `Reports export`. It must not clash with a
  project that exists. Keep the developer's words where you can.
- **The goal** is one sentence that says what is done when the project is done, such as
  `Export what the reports page shows, as CSV and PDF.`

Say both in one short message, and ask if they are right. Wait for the developer to agree.
They may change either one. Use their words when they do.

## 4. Make it

Once the developer agrees, run this, with the name and the goal in single quotes:

```
skelcrew project new '<name>' '<goal>'
```

Single quotes keep the text as it is. If the text holds a single quote, write that quote as
`'\''`. For example, `Don't cache` becomes `'Don'\''t cache'`.

It prints the project's ID, such as `reports-export`, and how to add tasks to it.

## 5. Tell the developer

Say what you made in one line, such as "Made the project Reports export." Then say how to go
on: `/add` adds a task to it, when they name the project.

Making the project is all you do here. You never add tasks, archive a project, or move a
task, unless the developer asks for that next.
