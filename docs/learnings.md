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
  removing the thread's clone or anything else it uses.

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
- **The daemon never runs git in a thread's clone.** The builder controls everything in
  it, `.git` included: `git status` or `git diff` there runs a planted `core.fsmonitor`,
  and a link left in `refs` or `objects` sends a write anywhere. Fetch the branch from the
  clone into skel's own clone, and push from there the commit it recorded, to the thread's
  branch only. Remove the clone by deleting its folder.
- **Never use a session's config folder outside the sandbox.** The agent can put commands
  in its `settings.json`, so `claude auth status` run there with your rights would run them.
- **Agents read `.git/config`.** A remote URL with a token in it, or an `extraheader`, would
  be visible to them, so skel refuses to start the lead while a clone holds one. Hand git
  your gh login for each command, as a credential helper, rather than saving it.
- **Agents share the network.** They can reach ports on localhost and abstract sockets.
- **Mount the folder of clones, not each clone.** A mount per clone, made when the sandbox
  starts, misses repositories brought in later. Mount their parent folder, and create it
  first: bwrap refuses to mount a folder that doesn't exist.
- **Don't pass `--new-session`.** It moves Claude Code out of the terminal's process group,
  so it misses resize signals and draws at the wrong width.

## On a Sprite

- **Drop capabilities before starting bwrap.** Commands on a Sprite run with a large set of
  capabilities, and bwrap refuses to start with them ("Unexpected capabilities but not
  setuid"). Wrap it in `setpriv --inh-caps=-all --ambient-caps=-all --bounding-set=-all`.
- **A new `/proc` can't be mounted there.** The Sprite runs inside a container that masks
  parts of `/proc`, so `--proc` fails with "Operation not permitted". Bind the existing one
  read-only. Agents then see other processes and their command lines, but not their
  environment or the files outside the sandbox.
- **Hide `/.sprite/api.sock`.** Every process can reach it. Through it, an agent could start a
  service that runs outside the sandbox, or restore a checkpoint and wipe the disk, and the
  Sprite's own docs tell agents to use it.
- **A Sprite sleeps about 30 seconds after the last activity.** A detached tmux session
  doesn't count as activity, so a daemon waiting on CI would sleep with it. A sleep also
  drops open connections, such as an agent's to its model. A longer sleep stops every
  process, and only Sprite services come back.
- **DNS comes from `/etc/resolv.conf`.** There is no `/run/systemd/resolve`, and no systemd.

## The agent's shell commands

- **A shell command can't block for long.** After 2 minutes Claude Code moves a running
  command to the background and ends the agent's turn. So `skel submit` must answer
  quickly, and leave slow work, such as starting a review, to the daemon.

## Bringing in a repository

- **Trust what skel clones, not the folder.** Whoever can edit `.git/config` controls
  `origin`, and anyone can put files in a checkout. skel judges push access on the GitHub
  repository `origin` names and clones from GitHub, never from the folder, so the trust
  covers exactly what agents will read.
- **A yes from the lead proves nothing.** It could come from an injected instruction, so a
  repository you can't push to is trusted only from your own terminal.
- **A clone stopped halfway must not look like one.** Clone outside the folder the lead
  sees, then move it in.
