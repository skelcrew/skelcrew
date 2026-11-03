# Learnings

Traps earlier versions found the hard way. Each one cost at least one bug. Read the part
that covers the code you are about to write.

## Typing into a session

- **Wait until the pane is quiet before typing.** Text typed while Claude Code is still
  starting or busy can be lost. Compare two `tmux capture-pane` snapshots a moment apart
  rather than waiting a fixed time.
- **Send text as a bracketed paste, then Enter on its own a moment later.** Without the
  paste marks, Claude Code treats the Enter after a long message as a new line, and the
  message is never sent. `tmux paste-buffer -p` adds the marks.
- **Idle means more than a quiet pane.** Claude Code is idle when "esc to interrupt" is
  gone, a line holding only the `❯` prompt is on screen, and nothing has changed for a
  moment. A bell or a changing window title doesn't mean a turn ended.
- **Pass the first message on the command line, not by typing it.** Typed into the input, a
  long message collapses to "[Pasted text]" and can miss its Enter.

## Starting and stopping Claude Code

- **Remove inherited `CLAUDE_CODE_*` variables**, such as `CLAUDE_CODE_CHILD_SESSION`. If
  skel is started from inside a Claude Code session, the agent inherits them and
  misbehaves, for example by writing no transcript.
- **Mark the folder trusted, or the session waits forever.** Claude Code asks whether to
  trust a folder even in bypass mode, and nobody is watching to answer. Set
  `hasTrustDialogAccepted` for the folder in the session's copy of `~/.claude.json`.
- **Share `~/.claude` writable, but not your setup in it.** A copied login breaks: when
  Claude Code refreshes its token, the old refresh token stops working, so the original
  or the copy goes stale. `claude --resume` also needs the transcripts where it looks for
  them. Keep `settings.json`, `CLAUDE.md`, hooks, plugins, commands, agents and skills
  read-only, since your own Claude Code runs code from them.
- **Give each session a throwaway copy of `~/.claude.json`.** Claude Code writes to it as it
  runs, and it lists the MCP servers your own runs start.
- **Check the login with `claude auth status --json`.** `~/.claude.json` exists after any
  launch, logged in or not, so finding it proves nothing.
- **`AskUserQuestion` waits on a screen nobody watches.** A builder that asks with it
  stops until someone answers, and nothing tells you. skel must notice the question and
  mark the thread needs you.
- **Turn off Claude Code's own sandbox and permission prompts.** A prompt stalls a session
  nobody watches. Its sandbox fails inside skel's, so keep it off even if your own settings
  turn it on. Skip the warning bypass mode shows first, in the session's settings.
- **Claude Code can outlive SIGTERM for a few seconds.** Wait for it to exit before
  removing the worktree or anything else it uses.

## The sandbox

- **bwrap being installed doesn't mean it can run.** On Ubuntu 24.04 and later, AppArmor
  blocks the namespaces it needs unless a profile allows them. Check by running
  `bwrap --ro-bind / / true`, not by finding the binary.
- **bwrap can't start inside skel's own sandbox.** Once skel builds skel, tests that start a
  real sandbox can't run there. That is the one place they may skip.
- **Hide the home folder, then put back only what the agent needs.** Programs often live
  under it: Claude Code under nvm keeps node beside it, and its package where its link
  points. Bring back the command's folder and the folder its link resolves into,
  read-only.
- **Hide `/run`.** The ssh agent, keyring, D-Bus, systemd and docker listen there, and some
  run commands for whoever connects. Bring back only the DNS resolver,
  `/run/systemd/resolve`.
- **A worktree commits into the repository's `.git`, not its own folder.** Objects, refs and
  the locks a rebase takes all live there, so `.git` must be writable. But the daemon's
  push runs git outside the sandbox with your rights, so `.git/config`, `hooks` and `info`
  stay read-only, as do the worktree's `commondir`, `gitdir` and `config.worktree`. Cover a
  missing one with `/dev/null`, or the agent could create it.
- **Hide other threads.** `.skel/` holds every thread's worktree and socket, and a socket
  answers whoever connects. Hide the folder, then bring back only the agent's own.
- **Don't pass `--new-session`.** It moves Claude Code out of the terminal's process group,
  so it misses resize signals and draws at the wrong width.

## The agent's shell commands

- **A shell command can't block for long.** After 2 minutes Claude Code moves a running
  command to the background and ends the agent's turn. So `skel done`, `skel ask` and
  `skel review` must answer quickly, and leave slow work, such as starting a review or
  waiting for your answer, to the daemon.
