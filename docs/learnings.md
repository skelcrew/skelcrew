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
  `hasTrustDialogAccepted` for the folder in the session's `.claude.json`.
- **Don't share your `~/.claude` with agents, and don't copy your login.** A copied login
  breaks: when Claude Code renews it, the old refresh token stops working, so the original
  or the copy goes stale. A shared, writable `~/.claude` lets an agent write memory files
  or settings your own sessions load as instructions. Renewal takes a lock folder Claude
  Code creates and deletes, so a throwaway layer over `~/.claude` can't share it either.
  Give each session its own config folder and a token from `claude setup-token`, which
  never renews.
- **Check a login with `claude auth status --json`.** `.claude.json` exists after any
  launch, logged in or not, so finding it proves nothing.
- **`AskUserQuestion` waits on a screen nobody watches.** A builder that asks with it
  stops until someone answers, and nothing tells you. skel must notice the question and
  mark the thread needs you.
- **Turn off Claude Code's own sandbox and permission prompts.** A prompt stalls a session
  nobody watches. Its sandbox fails inside skel's, so keep it off even if your own settings
  turn it on. Skip the warning bypass mode shows first, in the session's settings.
- **Turn off Claude Code's prompt suggestions** with
  `CLAUDE_CODE_ENABLE_PROMPT_SUGGESTION=false`. Its greyed-out suggestions propose steps,
  such as pushing, that belong to skel.
- **Claude Code can outlive SIGTERM for a few seconds.** Wait for it to exit before
  removing the worktree or anything else it uses.

## Starting Codex

- **Run it with `--no-daemon`.** Otherwise Codex starts a background server that outlives
  the run.
- **Its folder holds what it reads as instructions.** `config.toml`, `AGENTS.md`,
  `prompts/`, `rules/`, `skills/` and `plugins/` steer every run, `rules/` can let commands
  past its checks, and `packages/` holds the program it runs. Reviews share skel's
  `CODEX_HOME`, so a reviewer that wrote any of them would steer every later review. Keep
  them read-only, and only the login and session files writable.
- **Check how it saves `auth.json` before mounting it on its own.** If Codex writes a new
  file and renames it over the old one, a renewal inside the sandbox never reaches skel's
  copy, and skel's login goes stale.

## The sandbox

- **The boundary holds against mistakes and overreach, not an agent set on escaping.**
  Decided by Simon. A race that needs an agent to change a file in the instant between
  skel's check and git's read is out of scope; one a careless agent could trip is not.
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
- **A worktree commits into the repository's `.git`, not its own folder.** Objects and refs
  live there, so they must be writable. But the daemon runs git outside the sandbox with
  your rights, and git follows a `commondir` file in `.git` or any worktree's folder to a
  config that can run commands. So give the builder a throwaway `.git` top level and bring
  back only `objects`, `refs` and its own worktree folder writable, with `commondir`,
  `gitdir`, `config.worktree` and the whole `objects/info` folder read-only. A read-only
  file in a writable folder can be renamed away, a mounted folder can't. Cover a missing
  file with an empty one, not `/dev/null`, which a `nodev` mount refuses to open.
- **Keep reflogs out of reach.** Git outside appends to a reflog by following whatever is
  there, so a link planted in `logs` makes a push write into any file of yours.
- **The daemon never runs git in a worktree.** `git status` or `git diff` there runs a
  planted submodule's `core.fsmonitor`. It runs git in the main repository only, and pushes
  the commit it recorded (`git -C repo push origin <sha>:refs/heads/skel/<n>`), since a
  builder can move any ref, including `main` and other threads' branches.
- **Check `.git` before running git in a repository.** A builder can leave a folder link in
  `refs` or `objects`, which a fetch or gc outside follows to write into any folder of
  yours, or a stray lock that stops it. A check can't help while the builder still runs,
  since it can change `.git` right after the check passes.
- **Remove a worktree without running git in it.** `git worktree remove` runs `git status`
  there, which runs a planted `core.fsmonitor`. Check nothing needs saving, then use
  `--force`, or delete the folder and run `git worktree prune`.
- **Never use a session's config folder outside the sandbox.** The agent can put commands
  in its `settings.json`, so `claude auth status` run there with your rights would run them.
- **Agents read `.git/config`.** A remote URL with a token in it, or an `extraheader`, would
  be visible to them, so skel refuses to start agents for such a repository.
- **Agents share the network.** They can reach ports on localhost and abstract sockets.
- **Hide other threads.** `.skel/` holds every thread's worktree. Hide the folder, then
  bring back only the agent's own. Create it first, or threads started after the lead show
  up in its sandbox.
- **Don't pass `--new-session`.** It moves Claude Code out of the terminal's process group,
  so it misses resize signals and draws at the wrong width.

## The agent's shell commands

- **A shell command can't block for long.** After 2 minutes Claude Code moves a running
  command to the background and ends the agent's turn. So `skel done` must answer
  quickly, and leave slow work, such as starting a review, to the daemon.

## Adding a repository

- **Push access says nothing about what is in the folder.** skel judges it from `origin`,
  and whoever can edit `.git/config` controls `origin`. When the lead runs `skel init`, it
  must not trust a repository from `origin` alone.
