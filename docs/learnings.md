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
- **bwrap can't mount a new `/proc` there, but `unshare` can.** The Sprite runs inside a
  container that masks parts of `/proc`, so the kernel refuses a new one to bwrap, which
  runs without capabilities: "Operation not permitted". Commands on a Sprite have
  `CAP_SYS_ADMIN` outside any user namespace, so run `unshare --pid --fork --kill-child
  --mount --mount-proc` first, then drop capabilities and start bwrap without
  `--unshare-pid`. Mask again what the container masked, since the new `/proc` shows it.
- **A `/proc` borrowed from outside a process list breaks programs inside it.** Its numbers
  are the outside ones, so a program that looks itself up by its own number, as setpriv
  and bwrap do, finds another process or none, and so do `ps`, `kill` and skel's own
  stopping of a session. A builder running skel's tests on a Sprite failed this way.
- **`unshare --fork` ignores SIGTERM.** It waits for its child instead. End it with SIGKILL,
  and `--kill-child` takes the sandbox down with it.
- **An overlay can't be laid over the Sprite's own disk.** That disk is an overlay already,
  and bwrap's `--tmp-overlay` on a folder there fails with "Invalid argument". `/tmp` is a
  disk of its own, so a test in `/tmp` passes and proves nothing. A reviewer gets a copy
  of the folder instead, made in the review's own folder and removed with it.
- **Hide `sprite-env` in the sandbox too.** Without the control socket it only fails, and
  anything inside that checks for a Sprite, skel's tests included, takes the sandbox for a
  Sprite whose services it can't reach.
- **The Sprite's `node` writes to `/etc/profile.d` the first time it runs.** It is a script
  that adds a line to `languages_env`, and with `set -e` it fails where `/etc` is
  read-only. In a sandbox on a Sprite where node never ran outside, every node program,
  biome and tsc included, fails with "Read-only file system".
- **Hide `/.sprite/api.sock`.** Every process can reach it. Through it, an agent could start a
  service that runs outside the sandbox, or restore a checkpoint and wipe the disk, and the
  Sprite's own docs tell agents to use it.
- **A Sprite sleeps about 30 seconds after the last activity.** A detached tmux session
  doesn't count as activity, so a daemon waiting on CI would sleep with it. A sleep also
  drops open connections, such as an agent's to its model. A longer sleep stops every
  process, and only Sprite services come back.
- **A running Sprite service doesn't keep it awake either**, whatever the Sprite's own docs
  say. A task on the control socket does: `PUT /v1/tasks/<name>` with `{"expire": 300}`
  holds it for that many seconds, at most an hour, and the same call renews it. `DELETE`
  lets go, and answers 404 once the task has expired. `sprite-env curl /v1/tasks` lists them.
- **DNS comes from `/etc/resolv.conf`.** There is no `/run/systemd/resolve`, and no systemd.
- **There is no `/run/user/<uid>`, and no `XDG_RUNTIME_DIR`.** `/run` belongs to root, so
  skel's sockets go in a folder of its own data folder, made readable only by you.
- **Tell a Sprite by `sprite-env`.** Every Sprite has it in `/.sprite/bin`, on the PATH that
  commands and services get. No environment variable says you are on one.
- **Services get the same PATH as `sprite exec`**, with `~/.local/bin` and `/.sprite/bin`,
  and run as the `sprite` user. Their output goes to `/.sprite/logs/services/<name>.log`.
  `sprite-env services start` prints the service's log for five seconds before it returns.
- **A Sprite service ends everything it started when it stops.** Each service is a cgroup,
  so a tmux server the daemon starts, even in a session of its own, ends with every
  restart. And while any process is left in it, the Sprite takes a crashed service for a
  running one and never starts it again. skel's tmux server is a Sprite service of its own.
- **`sprite exec` exits 1 when it can't find the program**, as for any failure. Run the
  command through `sh -c` to get 127 for a missing one.
- **`sprite exec --tty` forwards your keyboard**, including what was typed ahead. An
  answer meant for skel on the laptop is lost if a command on the Sprite runs first.
- **`sprite file push` writes through a link**, like scp. Remove what is there first.
- **A Sprite's URL wants a Fly.io login unless it is public.** Without one, it answers a
  redirect to a login page, which GitHub's webhooks can't follow. Only `sprite` on the
  laptop can change that, with `sprite config update --url-auth public -s <name>`: the
  Sprite's own `sprite` has no login.
- **The URL reaches port 8080 on the Sprite**, unless a service claims another with
  `--http-port`. `sprite-env info` prints the URL, as `sprite_url` in JSON. Agents share the
  Sprite's network, so once the URL is public, whatever listens on 8080 is on the internet.
  The daemon holds the port.
- **A request to the URL wakes a sleeping Sprite in well under a second, and only for as
  long as the request is open.** After five minutes asleep, a webhook delivery got its answer
  in 0.17 seconds, and the Sprite slept again at once: the poll the daemon started after
  answering ran only 20 seconds later, when `sprite exec` woke it. With a hold of a minute
  taken before answering, the poll ran 0.2 seconds after the delivery was sent.
- **There is no command that says whether `sprite` is logged in.** `sprite list` fails,
  telling you to run `sprite login`, when it isn't.

## The screen

- **A Sprite keeps a terminal alive after the link drops.** `sprite exec --tty` is a session
  that goes on without you, so `sprite exec` can reconnect, and tmux never sees a hangup. A
  screen left that way stays, attached to nobody, until the Sprite stops or `sprite sessions
  kill` ends it. It doesn't keep an idle Sprite awake. Nothing inside the Sprite can tell:
  only `sprite api /exec` on the laptop says, as `is_active`.
- **`destroy-unattached` also ends a session made detached**, as soon as any other client
  leaves. Make the session attached, in one go.
- **tmux's default mouse keys take you into copy mode**, where your typing stops reaching the
  agent. Remove them all, then bind what you need.
- **Without a key of its own, a click reaches only the pane you type to.** `send-keys -M`
  hands it to the pane under the mouse, and leaves your typing where it was.
- **A key sent to a pane in copy mode goes to copy mode.** `send-keys Enter` would be taken
  for a copy, and a message typed in would never be sent. `paste-buffer` and `capture-pane`
  don't care. Leave copy mode before typing into a session.
- **Claude Code draws in two ways.** Its classic drawing leaves output in tmux's history.
  Its full-screen drawing (`tui: fullscreen`, or `CLAUDE_CODE_NO_FLICKER=1`) has the alternate
  screen, no tmux history, and asks for the mouse. The wheel must suit both.
- **tmux's `mode-keys` turns to vi when `$EDITOR` says vi**, and then none of the keys bound
  in the `copy-mode` table apply. Set it.
- **`unbind -a -T prefix` fails the second time**, as the first removed that table.
- **tmux shares a resize among panes.** The `window-resized` hook sets the sidebar back;
  `client-resized` doesn't run for this.
- **tmux 3.6 doesn't hold a program's synchronized frames back.** It marks only its own full
  redraws, so a frame written in two halves arrives in two, attached directly or nested.

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

## Talking on GitHub

- **Report progress through GitHub's own signals, never comments.** v4 posted seven
  comments, 11,700 characters, on one issue, restating the same summary three times. A
  reaction, the PR's `Closes #N` and the PR's description already show progress where
  people look.
- **A webhook says only "look now".** Anyone can reach a Sprite's public URL, and deliveries
  are lost while the daemon is down. So a delivery, even a signed one, only brings the next
  poll forward, and skel acts on what the poll reads.
