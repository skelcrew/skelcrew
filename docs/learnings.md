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
- **A person's draft at the prompt is not idle.** A paste lands after their unsent text, and
  the Enter sends both. Ready means a line holding the bare prompt mark, so a draft makes
  typing wait. A person can start a draft after the last look, so look again right before
  the paste. Codex's draft replaces its placeholder, so its mark alone is `›`. A numbered
  menu also shows the mark before text, and isn't a draft.
- **Pass the first message on the command line, not by typing it.** Typed into the input, a
  long message collapses to "[Pasted text]" and can miss its Enter.

## Starting and stopping Claude Code

- **Remove inherited `CLAUDE_CODE_*` variables**, such as `CLAUDE_CODE_CHILD_SESSION`. If
  Skelcrew is started from inside a Claude Code session, the agent inherits them and
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
  stops until someone answers, and nothing tells you. Skelcrew must notice the question and
  mark the thread needs you.
- **Turn off Claude Code's own sandbox and permission prompts.** A prompt stalls a session
  nobody watches. Its sandbox fails inside Skelcrew's, so keep it off even if your own settings
  turn it on. Skip the warning bypass mode shows first, in the session's settings.
- **Turn off Claude Code's prompt suggestions** with
  `CLAUDE_CODE_ENABLE_PROMPT_SUGGESTION=false`. Its greyed-out suggestions propose steps,
  such as pushing, that belong to Skelcrew.
- **Turn off cross-session messaging** with `CLAUDE_CODE_HARBOR_KITE=false`. Claude Code
  opens a socket at `$CLAUDE_CODE_TMPDIR/cc-socks/<pid>.sock`, and a path over 103 bytes
  falls back to `/tmp/cc-socks-<uid>`. On a Mac the agent's temporary folder is long enough
  to fall back, the sandbox hides `/tmp`, and every session opens with "Cross-session
  messaging is off". The variable is Claude Code's internal name, not a documented one, so
  check it still works after an update.
- **Claude Code can outlive SIGTERM for a few seconds.** Wait for it to exit before
  removing the thread's clone or anything else it uses.

## Starting Codex

- **Run it with `--no-daemon`.** Otherwise Codex starts a background server that outlives
  the run.
- **Its folder holds what it reads as instructions.** `config.toml`, `AGENTS.md`,
  `prompts/`, `rules/`, `skills/` and `plugins/` steer every run, `rules/` can let commands
  past its checks, and `packages/` holds the program it runs. Reviews share Skelcrew's
  `CODEX_HOME`, so a reviewer that wrote any of them would steer every later review. Keep
  them read-only, and only the login and session files writable.
- **Never mount `auth.json` on its own.** From 0.167 Codex renews its login by writing a new
  file and renaming it over the old one, and a file mounted on its own can't be renamed over
  ("Device or resource busy"). By then the old refresh token is spent, so Skelcrew's login goes
  stale for every session and review. Codex follows a link to the file and renames beside
  its target, so link `auth.json` to a writable folder that holds only the login. Up to
  0.163 it rewrote the file in place.
- **Share `auth.lock` with the login.** From 0.167 Codex locks `auth.lock` in its own
  `CODEX_HOME` while it renews. Folders of their own each get a lock of their own, so two
  sessions could renew at once, and one spends the token the other is using. Link it beside
  `auth.json`.
- **Mark the folder trusted, or the session waits.** Without `trust_level = "trusted"` for
  the folder under `projects`, Codex asks first. `"untrusted"` asks too.
- **Hooks wait for a person to trust them.** Codex shows "Hooks need review" at start for
  any hook not trusted yet, even one Skelcrew wrote. `--dangerously-bypass-hook-trust` skips the
  question. A `trusted_hash` per hook does too, but then a repository's own
  `.codex/hooks.json` still asks.
- **A repository's own `.codex/config.toml` wins over `CODEX_HOME`'s.** In a trusted folder,
  `[features] hooks = false` there silenced Skelcrew's `Stop` hook. A `-c` on the command line
  wins over both, so pass what Skelcrew needs that way.
- **An error ends a turn with no `Stop` hook.** An unknown model prints a 400 error and sits
  at its prompt, and nothing tells Skelcrew. Check the model against `codex debug models` first.
- **Its empty input always shows "› Ask Codex to do anything"**, even while a turn runs. So
  a line holding only `›` never shows. It is busy while "esc to interrupt" shows, as Claude
  Code is.
- **Put the first message after `--`**, so a message that starts with `-` is never read as
  an option.
- **Codex picks its own session ID.** It has no `--session-id`. The first line of each file
  in `sessions/`, `session_meta`, holds it, and `codex resume <id>` brings the conversation
  back.
- **Other agents write their own files in `sessions/`.** A review or a sub-agent started from
  a session saves its conversation there too, with `{"subagent": ...}` as the `source` of its
  `session_meta`. Pick the one whose `source` is `cli`, not the newest file.
- **Codex from npm needs its platform package.** `codex` is a launcher that runs the program
  from `@openai/codex-linux-x64`, or the Mac's. A global install puts that inside Codex's own
  package, but a local one puts it beside it, and a sandbox that brings back only Codex's
  package fails with "Missing optional dependency".

## The sandbox

- **The boundary holds against mistakes and overreach, not an agent set on escaping.**
  Decided by Simon. A race that needs an agent to change a file in the instant between
  Skelcrew's check and git's read is out of scope; one a careless agent could trip is not.
- **bwrap being installed doesn't mean it can run.** On Ubuntu 24.04 and later, AppArmor
  blocks the namespaces it needs unless a profile allows them. Check by running
  `bwrap --ro-bind / / true`, not by finding the binary.
- **bwrap has overlays only since 0.11.** Reviews see the thread's clone through
  `--overlay-src` and `--tmp-overlay`. Ubuntu 24.04's bwrap 0.9 passes every other check,
  then fails every review with "Unknown option --overlay-src". Check `bwrap --version` too.
- **bwrap can't start inside Skelcrew's own sandbox.** Once Skelcrew builds Skelcrew, tests that start a
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
  clone into Skelcrew's own clone, and push from there the commit it recorded, to the thread's
  branch only. Remove the clone by deleting its folder.
- **Never use a session's config folder outside the sandbox.** The agent can put commands
  in its `settings.json`, so `claude auth status` run there with your rights would run them.
- **Agents read `.git/config`.** A remote URL with a token in it, or an `extraheader`, would
  be visible to them, so Skelcrew refuses to start the lead while a clone holds one. Hand git
  your gh login for each command, as a credential helper, rather than saving it.
- **Codex needs the Mac Keychain's service.** It checks each site's certificate through
  `com.apple.SecurityServer`, and with it closed every request fails, with nothing but
  "Reconnecting…" and "workspace routing discovery failed". Opening it is safe only while the
  home folder stays hidden: the login keychain is a file there, and with it hidden, an agent
  asking for gh's token or Claude Code's login finds nothing. Checked on a Mac with
  `security find-generic-password` inside the sandbox. Keep `com.apple.securityd.xpc`
  closed: it holds no file the sandbox could hide.
- **Postgres on a Mac needs System V shared memory.** It takes a small segment and its
  semaphores that way, so a sandbox without `ipc-sysv-shm` and `ipc-sysv-sem` stops it from
  starting, and builders can't run the tests. Linux gives each sandbox a private set; macOS
  has one for the machine, so agents could disturb a Postgres you run yourself. Decided by
  Simon: running tests matters more.
- **Agents share the network.** They can reach ports on localhost and abstract sockets.
- **Postgres clients look for their socket in `/tmp`, which the sandbox hides.** With no
  host given they open `/tmp/.s.PGSQL.5432`, so every test that needed the database failed
  with the socket denied. Skelcrew sets `PGHOST=localhost` in every sandbox, so they connect
  over TCP instead. A host the project names itself still wins.
- **zsh writes heredocs to `/tmp/zsh`, which the Mac sandbox hides.** It ignores `TMPDIR`
  and goes by `TMPPREFIX`, so every heredoc failed with "can't create temp file for here
  document". Inside `"$(cat <<'EOF' ...)"` the failure leaves an empty string, and the
  command around it still runs. Skelcrew sets `TMPPREFIX` into the agent's own temporary
  folder. On Linux, `/tmp` is the sandbox's own and writable, so it needs nothing.
- **tmux makes its socket folder in `/tmp`, which the Mac sandbox hides.** It ignores
  `TMPDIR` and goes by `TMUX_TMPDIR`, so a builder running Skelcrew's own tests saw every
  tmux fail with "no suitable socket path". The agent's own temporary folder doesn't work
  either: a socket's path may be at most 104 bytes on a Mac, and that folder's path is about
  84, so tmux failed with "File name too long". Skelcrew gives tmux a short folder of its
  own in `/tmp` and sets `TMUX_TMPDIR` to it. Your tmux and Skelcrew's stay hidden, as they
  must: a tmux socket runs commands with your rights. A `TMUX_TMPDIR` of yours is passed
  over, as it may be long. Inside a sandbox `/tmp` is refused, so the folder goes in the one
  Skelcrew gave that sandbox's tmux, which is short. The shell that removes the folder dies
  with a SIGKILL, so whatever kills a sandbox, a reviewer or a stopped session, removes it.
- **`bun run` lists every folder above the one it starts in.** On a Mac the sandbox refuses
  `~` and `~/.local` with "Operation not permitted", and Bun stops with
  `CouldntReadCurrentDirectory` before running anything. A plain "Permission denied", as from
  a folder with mode 711, it takes in stride. `bun test` and `bun --version` don't list them,
  so they work, which hides the cause. npm and node never list them. Allowing the folder's
  metadata isn't enough. The sandbox lets agents list the folders between the hidden one and
  their own folders, names only. Never the hidden folder itself: your home may hold a
  `package.json`, and Bun fails on reading it.
- **Mount the folder of clones, not each clone.** A mount per clone, made when the sandbox
  starts, misses repositories brought in later. Mount their parent folder, and create it
  first: bwrap refuses to mount a folder that doesn't exist.
- **Start agents' sandboxes under `nice`.** Builders and reviewers running whole test
  suites at once pushed an 8-CPU server to a load of 18, and each run took twice as long.
  `nice -n 10` goes first, before `unshare` and the `setpriv` that drops capabilities on a
  Sprite: lowering a priority needs no capability, and everything started inside keeps it.
  `nice` replaces itself with the command, so stopping a session still finds the sandbox.
  The lead stays at normal priority, as it is what you type into.
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
  and bwrap do, finds another process or none, and so do `ps`, `kill` and Skelcrew's own
  stopping of a session. A builder running Skelcrew's tests on a Sprite failed this way.
- **`unshare --fork` ignores SIGTERM.** It waits for its child instead. End it with SIGKILL,
  and `--kill-child` takes the sandbox down with it.
- **An overlay can't be laid over the Sprite's own disk.** That disk is an overlay already,
  and bwrap's `--tmp-overlay` on a folder there fails with "Invalid argument". `/tmp` is a
  disk of its own, so a test in `/tmp` passes and proves nothing. A reviewer gets a copy
  of the folder instead, made in the review's own folder and removed with it.
- **Hide `sprite-env` in the sandbox too.** Without the control socket it only fails, and
  anything inside that checks for a Sprite, Skelcrew's tests included, takes the sandbox for a
  Sprite whose services it can't reach.
- **The Sprite's `node` writes to `/etc/profile.d` the first time it runs.** It is a script
  that adds a line to `languages_env`, and with `set -e` it fails where `/etc` is
  read-only. In a sandbox on a Sprite where node never ran outside, every node program,
  biome and tsc included, fails with "Read-only file system".
- **Codex reaches its program through two links.** `~/.local/bin/codex` links to
  `~/.codex/packages/standalone/current/bin/codex`, and `current` links to the release.
  Bringing back only the first link and the final file leaves the path broken in the
  sandbox, so every review fails with "codex: not found". Make each link on the way anew
  with `--symlink`, and never mount the folder it sits in: `~/.codex` holds logins. The
  release is marked by `codex-package.json`, and keeps `rg` and `bwrap` beside `bin`.
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
  Skelcrew's sockets go in a folder of its own data folder, made readable only by you.
- **Tell a Sprite by `sprite-env`.** Every Sprite has it in `/.sprite/bin`, on the PATH that
  commands and services get. No environment variable says you are on one.
- **Services get the same PATH as `sprite exec`**, with `~/.local/bin` and `/.sprite/bin`,
  and run as the `sprite` user. Their output goes to `/.sprite/logs/services/<name>.log`.
  `sprite-env services start` prints the service's log for five seconds before it returns.
- **A Sprite service ends everything it started when it stops.** Each service is a cgroup,
  so a tmux server the daemon starts, even in a session of its own, ends with every
  restart. And while any process is left in it, the Sprite takes a crashed service for a
  running one and never starts it again. Skelcrew's tmux server is a Sprite service of its own.
- **`sprite exec` exits 1 when it can't find the program**, as for any failure. Run the
  command through `sh -c` to get 127 for a missing one.
- **`sprite exec --tty` forwards your keyboard**, including what was typed ahead. An
  answer meant for Skelcrew on the laptop is lost if a command on the Sprite runs first.
- **`sprite exec --tty` puts the raw command in your terminal's title** as it connects, and
  writes nothing back at the end. It then writes the Sprite's name in front of any title sent
  as OSC 0, which is tmux's usual way, and leaves OSC 2 alone. It gives the Sprite a terminal
  even when your output goes to a pipe, so only the laptop can tell whether to send a title.
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
- **Ghostty ignores saving and restoring the title** (`CSI 22 t`, `CSI 23 t`). There, only
  your shell's prompt puts the title back, through Ghostty's shell integration.
- **tmux reads a status line as a format, and runs what it says.** `#(...)` in `status-format`
  starts a shell command, `#[...]` restyles the line, and `%` goes through strftime. Text from
  outside, such as an issue's title, needs `#` and `%` doubled, and its control codes removed.
- **`set -t =name` fails with "no such session".** An option's target takes `=name:`.
- **Every `set` redraws the whole screen.** About 3.9 KB on a 120 by 40 terminal, so set a
  status line only when it changed, and all its lines in one run.
- **Ctrl-Q is XON, and is not eaten.** A tty has `ixon` on until tmux makes it raw, and the key
  reached tmux locally, through `ssh -t` and through `sprite exec --tty`.
- **`sprite exec` prints the command it runs.** A test that waits for text in the output
  matches that line at once, unless the text it waits for is split up in the command.
- **tmux drops terminal links on the way to a terminal it doesn't recognise.** A client under
  `script`, which answers no terminal queries, got no OSC 8 at all until the server set the
  `hyperlinks` feature. A tmux inside tmux hides this, as the outer one is recognised.
- **tmux before 3.6 refuses `pane-border-lines spaces`.** It says "unknown value: spaces",
  and the screen never opens, as one bad setting fails the whole command. Ubuntu 24.04 has
  tmux 3.4 and Debian 13 has 3.5a. Read `tmux -V` and leave the setting out there.
- **tmux 3.6 doesn't hold a program's synchronized frames back.** It marks only its own full
  redraws, so a frame written in two halves arrives in two, attached directly or nested.
- **Alt-Shift-Up and Alt-Shift-Down get through.** They arrive as `ESC[1;4A` and `ESC[1;4B`
  through nested tmux and through `sprite exec --tty`, and tmux knows them as `M-S-Up` and
  `M-S-Down`. Alt-Left and Alt-Right move by word in Claude Code's input, and Alt with a digit
  types a character on a Mac, so neither is free.
- **Bun doesn't keep a signal it inherits as ignored.** `trap "" INT; exec bun ...` still dies
  on Ctrl-C. Until a program makes its terminal raw, Ctrl-C can end it, so a pane that must
  stay needs `remain-on-exit`. `respawn-pane -k` starts a dead pane again.
- **`respawn-pane` gives a pane a new terminal.** Anything that holds its `pane_tty` must read
  it again. It also resets the pane, so the mouse modes a page asked for go with it.
- **tmux 3.6 can crash when a client leaves under `destroy-unattached`.** The server segfaults
  if another client, even a one-off command, disconnects at that moment. The session is
  destroyed while the leaving client still points at it. It needs nothing of Skelcrew's: a plain
  server with a busy `list-clients` loop crashed within 8 rounds. Every terminal on that
  server loses its screen, and agents keep running. The sidebar's own commands hit this about
  once in 500 leavings on a loaded machine, so a screen test can fail with `server exited
  unexpectedly`. A `detach-client` sent from the sidebar crashed it about one time in six. To
  leave from the sidebar, have the server run `kill-session` itself, with `run-shell -d -C`:
  that crashed in none of 32 runs.
- **tmux takes keys that arrive together for a paste.** Keys less than `assume-paste-time`
  (1 ms) apart skip key bindings and go to the active pane as text. Three Alt keys in one
  write reached the sidebar as two, and the third was typed into the agent. Set it to 0.
- **A click on a status line reaches no pane.** `MouseDown1Status` fires, and a range drawn
  with `#[range=user|X]` names what was clicked in `#{mouse_status_range}`. `send-keys -F`
  doesn't expand that in the text it types, so `run-shell -C` must expand the whole
  `send-keys` first. A second click soon after the first comes as `DoubleClick1Status`, not
  `MouseDown1Status`, so bind both.
- **A terminal opens a link only when no program has the mouse, or with Shift.** Ghostty
  looks for a link under the pointer only while mouse reporting is off or Shift is held, so
  Cmd-click on the screen goes to tmux and Shift-Cmd-click opens. WezTerm and kitty skip the
  program with Shift too. iTerm2 opens on Cmd-click and also hands the click to the program.
  No escape code asks a terminal to keep link clicks for itself.
- **tmux keeps a program's OSC 52 copy from your terminal** unless `set-clipboard` is `on`.
  Its default, `external`, lets only tmux itself set your clipboard. A terminal tmux doesn't
  recognise also needs the `clipboard` feature.
- **`capture-pane -e` shows a terminal link with an id tmux made up**, as `ESC]8;id=...;url`.
  A test that looks for `ESC]8;;url` finds nothing.

## Tests

- **`homedir()` keeps the HOME the process started with.** Setting `process.env.HOME` inside a
  running process or test changes nothing for `homedir()`, so `openDb()` there opens your real
  database. Open it in a process of its own, started with HOME in its environment.
- **A test's clean-up only runs if the run gets that far.** A killed run skips `afterEach`,
  and its tmux servers and daemons go on forever. A timed-out test gets its `afterEach`, but
  its `finally` waits for a run that may already have ended. `test/leftovers.ts` ends both
  cases, and fails any test that leaves a process. It adopts orphans, so one that exited stays
  a zombie until the run ends, and `process.kill(pid, 0)` still finds it. Ask `stillRunning`.
- **A fake must never wait on a file alone.** The test can remove the folder between two
  looks for the file, and the loop then never ends. A wait also ends when the folder goes,
  or after a limit.
- **Stopping the daemon doesn't stop what it started.** `KillMode=process` leaves its
  children running, so the daemon ends them itself and waits for them. It asks first, as a
  killed git leaves lock files behind.
- **Don't end a session while bubblewrap is starting.** Killed about 10 to 20 ms in,
  `--die-with-parent` can miss, and the sandbox's first process lives on. It is PID 1 of its
  namespace, so only SIGKILL from outside ends it. Wait until the fake has run.
- **Bun gives each test five seconds unless told otherwise.** On a busy machine, a test that
  starts daemons, sandboxes or many processes takes longer, and failed with nothing wrong.
  `setDefaultTimeout` in a preload only reaches the first test file of a run, so
  `bun run check` passes `--timeout` instead.
- **A fixed wait fails on a busy machine.** Timers fire late and processes start slowly, so
  a test that looks after a set time, or counts what happened in it, can look too early.
  Wait for the thing itself: a file, a line on screen, a row, a process gone. Time only
  what can't come too soon, such as the gap between two renewals.
- **`Bun.spawn` without `env` ignores changes to `process.env`.** It hands on the environment
  the process started with. Pass `env: process.env` to hand on a change.
- **`--parallel` loads the preload again for each test file, in the same process.** A
  worker runs several files one after another, each with a fresh preload and `process.env`.
  What one file's preload started still runs during the next, so the leak check counted an
  earlier file's sweep as a leftover. Each file's sweep ends with that file.
- **In a test, listen for a socket's errors before connecting.** With the listener added
  after `createConnection`, Bun can fail the test on a connect to a socket that isn't there
  yet. Make a `new Socket()`, add the listener, then call `connect`.

## The agent's shell commands

- **A shell command can't block for long.** After 2 minutes Claude Code moves a running
  command to the background and ends the agent's turn. So `sc submit` must answer
  quickly, and leave slow work, such as starting a review, to the daemon.

## Bringing in a repository

- **Trust what Skelcrew clones, not the folder.** Whoever can edit `.git/config` controls
  `origin`, and anyone can put files in a checkout. Skelcrew judges push access on the GitHub
  repository `origin` names and clones from GitHub, never from the folder, so the trust
  covers exactly what agents will read.
- **A yes from the lead proves nothing.** It could come from an injected instruction, so a
  repository you can't push to is trusted only from your own terminal.
- **A clone stopped halfway must not look like one.** Clone outside the folder the lead
  sees, then move it in.

## Releasing

- **Bun's cross-built Mac binaries carry a signature that fails verification.** Built on
  Linux, they fail `codesign --verify --strict` with "invalid signature (code or signature
  have been modified)". They still start and serve, so a quick try looks fine, but macOS
  checks pages as they load, and a later page could get the binary killed.
  `codesign --force --sign -` on a Mac fixes it, with no Apple account.
- **Signing changes the binary.** Checksums made before signing fail every Mac install.

## Talking on GitHub

- **Report progress through GitHub's own signals, never comments.** v4 posted seven
  comments, 11,700 characters, on one issue, restating the same summary three times. A
  reaction, the PR's `Closes #N` and the PR's description already show progress where
  people look.
- **A webhook says only "look now".** Anyone can reach a Sprite's public URL, and deliveries
  are lost while the daemon is down. So a delivery, even a signed one, only brings the next
  poll forward, and Skelcrew acts on what the poll reads.
