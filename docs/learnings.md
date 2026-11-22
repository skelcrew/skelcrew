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
- **Idle means more than a quiet pane.** Claude Code is idle when no live "esc to
  interrupt" shows, a line holding only the `❯` prompt is on screen, and nothing has changed
  for a moment. A bell or a changing window title doesn't mean a turn ended.
- **The busy mark can sit in the agent's own text.** A builder that greps Skelcrew's code, or
  replies about it, leaves "esc to interrupt" on its screen after its turn ends, even just
  above its input, and looks busy forever, Esc or not. Where the mark sits can't tell the two
  apart. Whether it is live can: Claude Code's spinner and Codex's "Working" line redraw at
  least every second, as their timer counts, and reply text sits still. Two looks half a
  second apart often fall between two ticks, so a still mark is watched a second and a half
  more. The Stop hook can't stand in: a turn may start with nothing typed in, such as when a
  background task ends, and neither Esc nor a builder running before the hook was set up fires
  it.
- **A person's draft at the prompt is not idle.** A paste lands after their unsent text, and
  the Enter sends both. Ready means a line holding the bare prompt mark, so a draft makes
  typing wait. A person can start a draft after the last look, so look again right before
  the paste. Codex's draft replaces its placeholder, so its mark alone is `›`. A numbered
  menu also shows the mark before text, and isn't a draft.
- **Pass the first message on the command line, not by typing it.** Typed into the input, a
  long message collapses to "[Pasted text]" and can miss its Enter.
- **Never paste into the lead while you scroll back or type there.** A paste throws a
  scrolled-back pane to the bottom, and lands after your unsent text. So the lead's notes
  wait until you are at the bottom with an empty prompt.
- **The human's words go through a file, never a shell.** The lead writes them for
  `--asked-file` with its file-writing tool. Passed through a shell, quotes, backticks and
  `$()` in them would run or change.
- **Read a yes or no as a line, not a key.** Read one key at a time, the Enter after it
  stays in the input and answers the next question.

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
- **Pass instructions in a file, not on the command line.** tmux refuses a start command
  past about 16 KB with "command too long", and a lead's instructions grew close to that.
  Claude Code reads them with `--append-system-prompt-file`. Codex takes developer
  instructions from a profile, `$CODEX_HOME/<name>.config.toml` chosen with `-p <name>`. An
  argument won't do either: Linux refuses one past 128 KB. An `AGENTS.md` won't do: Codex
  gives it less weight than developer instructions. A repository's `.codex/config.toml` beats
  the profile, but Codex loads it only for a folder trusted in a config file, not with `-c`.
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
- **Turn off Claude Code's agent view** with `CLAUDE_CODE_DISABLE_AGENT_VIEW=1`. Its
  background service (`claude daemon`) runs in the session's config folder. In November 2026
  the records showed this:
  - Skelcrew's journal: it started a lead with `--session-id`, brought it back once with
    `--resume` on that id, and never started it again, freeze included. That conversation's
    file stayed in use for two more days, so the process in the lead's session kept running.
  - The lead's `daemon.log` and conversation files: a minute after that first start, a second
    conversation began, which the service ran, started by a slash command (`bg spawned <id>
    (slash)`). The human worked in it, through agent view, under an id Skelcrew never stored.
  - The day after, as the human started the screen again after a freeze, the service handed
    out a spare session in its place (`bg claimed-spare <id> (fleet)`). It was a new
    conversation on Claude Code's default model, without the lead's instructions.

  In 2.1.325, `claude daemon run` quits when agent view is off, so that service never starts.
  A lead already running with it on can't be restarted safely: Skelcrew would resume the id it
  stored, not the conversation in use. So Simon chose to leave such leads running, with no code
  to restart them. Each gets agent view off at its next start. Upgrading is one step by hand,
  done once for each such lead, before its next start:
  1. Find the conversation you want to keep by what is in it, never by which file is newest: a
     spare Claude Code handed out later is newer, and holds none of your work. This prints, for
     each of the lead's conversations, its id, the model of its last answer, how many messages
     it has and the start of the last one typed in:

     ```sh
     for f in ~/.local/share/skelcrew/claude/<lead>/projects/*/*.jsonl; do bun -e '
     const lines = (await Bun.file(process.argv[1]).text()).split("\n").filter(Boolean)
       .map((l) => { try { return JSON.parse(l) } catch { return {} } });
     const typed = lines.filter((l) => l.type === "user" && typeof l.message?.content === "string");
     const model = lines.filter((l) => l.type === "assistant").at(-1)?.message?.model ?? "none";
     console.log(process.argv[1].split("/").at(-1).replace(".jsonl", ""), model,
       `${typed.length} messages`, JSON.stringify((typed.at(-1)?.message.content ?? "").slice(0, 80)));
     ' "$f"; done
     ```

     Pick the one whose last message is the last thing you said to the lead. One on the default
     model with few messages is a spare.
  2. Set the repository's `lead_session` in `~/.local/share/skelcrew/skelcrew.db` to that file's
     name without `.jsonl`:
     `UPDATE repositories SET lead_session = '<id>' WHERE owner = '<owner>' AND repo = '<repo>'`.
  3. Exit the lead with `/exit` and open it again with `sc`. It comes back on that conversation,
     with agent view off, its model and its instructions.

  Skipping the step brings the lead back on the conversation Skelcrew stored, which may be an
  older one.
- **Claude Code can outlive SIGTERM for a few seconds.** Wait for it to exit before
  removing the thread's clone or anything else it uses.
- **`Stop` runs on neither an error nor Esc.** Its hooks reference says `Stop` "does not run if
  the stoppage occurred due to a user interrupt", and a turn that ends on an API error runs
  `StopFailure` instead. Its input has `last_assistant_message`, the turn's last text.
- **Turn off Claude Code's tips in a lead's settings.** They crowd the lead's greeting.
  Its announcements, such as of a new model, come from Anthropic's servers, and no setting
  turns them off.

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
- **Esc runs `Interrupt`, not `Stop`.** In Codex's `run_turn`, an interrupted turn returns
  before its `Stop` hooks, which run only when the model needs no follow-up. The abort path
  runs the `Interrupt` hooks instead. `Stop`'s input has `last_assistant_message`.

## Starting Pi

Checked against Pi 1.6.0, in tmux and in print mode, with a fake model server.

- **Pi's npm package is `@earendil-works/pi-coding-agent`.** `@mariozechner/pi-coding-agent`
  stopped at 0.73 and is deprecated. Pi needs Node 22.19 or newer: on Node 20 it stops at once
  with "does not provide an export named 'enableCompileCache'".
- **Pass `--no-approve`, or the session waits.** In a folder with `.pi/` or `.agents/skills/`,
  Pi asks whether to trust it before anything else, and nobody is there to answer. The flag also
  keeps that folder's settings, extensions and skills out, as unapproved skills must be.
- **Its input has no prompt mark, and its busy line changes words.** The empty input is a blank
  line between two rules. While it works it shows "Working", "Retrying (1/3) in 2s..." or
  "Compacting context...". So Skelcrew's extension draws a line of its own above the input: a
  ready mark while Pi is idle with nothing typed, and a busy line counting seconds otherwise.
- **A turn ends at `agent_settled`, not `agent_end`.** Pi tries a 429 three times, and each try
  ends with `agent_end`. Only `agent_settled` comes once, after the retries, with `aborted` true
  for Esc. A turn that ended on an error has an assistant message with `stopReason: "error"`
  and Pi's words in `errorMessage`, such as `429: {"message":"..."}`. The status comes first, so a 429
  anywhere else, such as in a request ID, is no limit. A provider can echo a key in that message,
  and Skelcrew logs it, so the extension takes keys out first.
- **`input` fires for the first message too.** The message on the command line comes as typed,
  with `source: "interactive"`. A long paste shows as "[paste #1 +40 lines]", but `input` gets
  its whole text.
- **`--session-id` both starts and brings back a session.** Pi saves it in `--session-dir` as
  `<time>_<id>.jsonl`, and only once a message went in.
- **`pi -p` reads its prompt from stdin, whole.** Run with stdin open and nothing written, it
  waits forever.
- **Pi has no setting that holds an answer to a shape.** The reviewer gets a tool from
  Skelcrew's extension, whose parameters are the shape, and Pi checks its arguments against it.
- **`auth.json` can hold a command Pi runs for a key.** A key written as `!command` runs when Pi
  needs it. Every session can write the shared login, so Skelcrew never runs pi on it with your
  rights, except for the first run's login, when it holds no provider.
- **Pi writes `auth.json` in place, through a link.** It locks the file a link leads to, with
  a `.lock` folder beside it, so sessions linked to one login renew it in turn.
- **Interactive Pi downloads `fd` and `rg` when they aren't on the PATH.** It saves them in its
  agent folder's `bin/`, so each lead and builder downloads them once, at its first start, and
  keeps them. Reviews run in print mode, whose tools never need them, so they download nothing.
  Installing `fd` and `ripgrep` on the machine skips the download.
- **Bun can't import one file both as text and as a module.** Skelcrew writes the extension's
  own source into each session, so `pi.ts` imports it as text, and repeats the marks the screen
  is read by. A test pins the two together.

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
  real sandbox can't run there. That is the one place they may skip. They skip on
  `SKELCREW_TESTS_IN_SANDBOX`, which `scripts/test.ts` sets, never on `SKELCREW_SANDBOX`.
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
  `nice -n 10` goes first, and everything started inside keeps it. If something that drops
  capabilities ever comes before bwrap, nice still goes first: lowering a priority needs none.
  `nice` replaces itself with the command, so stopping a session still finds the sandbox.
  The lead stays at normal priority, as it is what you type into.
- **Don't pass `--new-session`.** It moves Claude Code out of the terminal's process group,
  so it misses resize signals and draws at the wrong width.
- **On a Mac, a host can't show an agent its dropped files.** `sandbox-exec` reads its rules
  from a profile Skelcrew writes to a file before the command runs, not from the command's
  words. So a host has no word to swap for the folder of dropped files.

## On a Sprite

Skelcrew no longer supports Sprites itself. These are for the Sprite machine plugin to come.

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
  outside, such as a repository's name, needs `#` and `%` doubled, and its control codes
  removed.
- **`set -t =name` fails with "no such session".** An option's target takes `=name:`.
- **Every `set` redraws the whole screen.** About 3.9 KB on a 120 by 40 terminal, so set a
  status line only when it changed, and all its lines in one run.
- **A pane in copy mode looks up keys only in copy mode's table.** Keys bound with `bind -n`
  never fire there. With a catch-all `Any` binding that leaves copy mode, the detach key left
  copy mode instead, and reached the agent: Alt-Q as Esc, which stopped its turn. You only
  had to scroll an agent back. Bind the detach key in the `copy-mode` table too.
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
- **A box round a pane must be tmux's own lines.** tmux always leaves a border row between
  panes stacked one above the other, such as the agent and the footer. A box drawn by the
  sidebar and the footer would break there, one row short of its corners. tmux's lines join
  with proper corners, and `pane-active-border-style` colours the whole ring round the active
  pane, corners included, and nothing else. A line between two panes is in both rings.
- **tmux draws no line at the window's edges.** A pane one column wide at each outer edge gives
  tmux a line to draw there. The status line draws the boxes' tops, as tmux has no line above
  a pane at the top.
- **A zoomed pane has no lines round it.** `resize-pane -Z` hides every other pane, and with
  them the lines between panes. Only the status line still shows, so it is the one place left
  to mark where your typing goes.
- **A pane's index is its place on the screen**, left to right, then down. A split goes into
  tmux's list beside the pane it splits, and `swap-pane` swaps both places at once. A pad at
  the left edge makes the sidebar pane 1, not 0.
- **tmux 3.6 doesn't hold a program's synchronized frames back.** It marks only its own full
  redraws, so a frame written in two halves arrives in two, attached directly or nested.
- **Alt-Shift-Up and Alt-Shift-Down get through.** They arrive as `ESC[1;4A` and `ESC[1;4B`
  through nested tmux and through `sprite exec --tty`, and tmux knows them as `M-S-Up` and
  `M-S-Down`. Alt-Left and Alt-Right move by word in Claude Code's input, and Alt with a digit
  types a character on a Mac, so neither is free.
- **Mac terminals often send Option-Left and Option-Right as `Esc b` and `Esc f`**, where others
  send `ESC[1;3D` and `ESC[1;3C`. tmux reads the first two as M-b and M-f, not as M-Left and
  M-Right. A screen key on Alt-Left must take Alt-B and Alt-F too, and all four move a word in an
  agent's prompt, so none of them is free for the screen.
- **A key binding of tmux takes the key from every pane.** Binding Shift-Enter in the screen's
  tmux, to attach full screen from the sidebar, would take it from Claude Code, where it is a new
  line. The binding hands it on with `send-keys S-Enter` unless the sidebar has your typing. A
  terminal that never sends Shift-Enter apart from Enter, such as Terminal.app, needs another key
  for the same thing.
- **Bun doesn't keep a signal it inherits as ignored.** `trap "" INT; exec bun ...` still dies
  on Ctrl-C. Until a program makes its terminal raw, Ctrl-C can end it, so a pane that must
  stay needs `remain-on-exit`. `respawn-pane -k` starts a dead pane again.
- **`respawn-pane` gives a pane a new terminal.** Anything that holds its `pane_tty` must read
  it again. It also resets the pane, so the mouse modes its last program asked for go with it.
- **tmux 3.6 can crash when a client leaves under `destroy-unattached`.** The server segfaults
  if another client, even a one-off command, disconnects at that moment. The session is
  destroyed while the leaving client still points at it. It needs nothing of Skelcrew's: a plain
  server with a busy `list-clients` loop crashed within 8 rounds. Every terminal on that
  server loses its screen, and agents keep running. The sidebar's own commands hit this about
  once in 500 leavings on a loaded machine, so a screen test can fail with `server exited
  unexpectedly`. A `detach-client` sent from the sidebar crashed it about one time in six. To
  leave from the sidebar, have the server run `kill-session` itself, with `run-shell -d -C`:
  that crashed in none of 32 runs.
- **Leaving keys must end the session, not detach.** Alt-Q, Ctrl-Q and Ctrl-\ were bound to
  `detach-client` and hit the crash above. The screen tests that leave with Ctrl-Q failed 9
  times in 300 runs, eight at once on eight cores. Each failure was the crash: the terminal
  showed `[server exited unexpectedly]` and the screen's server was gone. tmux then exits with
  1, so Skelcrew reported that the screen couldn't open. The test waited for Skelcrew to return,
  which it never did normally. In tmux 3.6's source, the next client to disconnect after a
  detach runs `server_check_unattached`. That frees the session while the detached client still
  points at it. `kill-session` goes through `server_destroy_session`, which unhooks every client
  first. In a plain tmux with two `list-clients`/`list-panes` loops, `detach-client` crashed 16
  times in 120. `kill-session` crashed in none of 180, and `run-shell -C kill-session`,
  `run-shell -d 0.5 -C kill-session` and `detach-client -E true` in none of 60 each. A terminal that just closes is safe:
  killing the outer terminal under the same loops crashed none of 180 times. Its client is
  gone before the session is freed.
- **tmux takes keys that arrive together for a paste.** Keys less than `assume-paste-time`
  (1 ms) apart skip key bindings and go to the active pane as text. Three Alt keys in one
  write reached the sidebar as two, and the third was typed into the agent. Set it to 0.
- **tmux turns Shift+Enter into Enter**, so the prompt is sent instead of a newline. Both
  servers need `extended-keys on` and the `extkeys` terminal feature: the screen's asks your
  terminal for extended keys, and the agents' asks the screen in front of it. Either one alone
  still delivers Enter. tmux ignores a pane's request made while the option was off, and
  hands extended keys only to a program that asked with `CSI > 4;2 m`. Codex reads Shift+Enter
  only in the CSI u form (`ESC[13;2u`), so the agents' server sets `extended-keys-format csi-u`,
  which tmux before 3.5 refuses. Claude Code reads both forms. Terminal.app sends plain Enter
  for Shift+Enter whatever tmux does.
- **Claude Code asks for extended keys only in a terminal it recognises.** It reads `TERM`,
  `TERM_PROGRAM` and `TMUX`. `TERM=tmux-256color` alone is not enough, so a session started
  with `env -i` must keep tmux's `TERM_PROGRAM=tmux`. Without it Claude Code never asks, tmux
  hands it plain Enter, and Shift+Enter sends the prompt, though every tmux setting is right.
  A test agent that asks for extended keys unconditionally hides this. `extended-keys always`
  would also work, but only for panes made after it is set, so running agents keep Enter.
  An agent already running can't get a new environment. Writing `CSI > 4;2 m` into its pane's
  terminal (`pane_tty`) asks for it instead: tmux reads it as the agent's own request, and
  Claude Code then reads `ESC[13;2u` as a newline.
- **An agent on a plugin's host gets no terminal unless Skelcrew gives it one.** tmux sets
  `TERM` in its panes, so agents there draw in colour. A host such as herdr hands the agent
  exactly the environment Skelcrew passes. The daemon under systemd has no `TERM` or
  `COLORTERM`, so Claude Code drew without colour there, and only there. So a plugin's host is
  always asked for `TERM=xterm-256color` and `COLORTERM=truecolor`, never the daemon's own.
- **The screen's tmux asks your terminal for extended keys only once it knows the terminal.**
  It sends `CSI > 4;2 m` after the terminal answers its `CSI > c` and `CSI > q` queries. A test
  pty that answers nothing never gets asked.
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
- **A drag through two tmux servers needs every raw mouse event passed on.** The front one
  must hand on `MouseDrag1Pane`, `MouseDragEnd1Pane`, `SecondClick1Pane` and
  `TripleClick1Pane` with `send-keys -M`. tmux fires `DoubleClick1Pane` a moment after the
  second press, so passing that on too gives the inner server a press of its own.
- **A drag that leaves a pane ends in the other pane.** tmux sends the moves and the release
  to the pane under the mouse, so the pane where the drag began never gets its release.
  tmux ends a selection where the last move was, and ignores a place outside its window.
- **tmux picks a mouse event's binding as the event arrives.** A press, a drag and a release
  in one read reach the inner server before `copy-mode -M` has run, so the release finds no
  binding. A test must pace them, as a hand does.
- **In copy mode, a mouse event with no binding goes to `Any`.** With `Any` bound to leave
  copy mode, a press while scrolled back threw you back to the live agent. Bind the press and
  the release.
- **tmux sends no OSC 52 while the pane waits to be drawn.** A copy straight after
  `copy-mode` reached no terminal. tmux's own double click waits 0.3 seconds first.
- **`set-clipboard on` lets any program read tmux's newest copy.** tmux answers `OSC 52 ?`
  with it, so an agent could read what you copied from another. `external` answers nothing but
  also drops an agent's own copy. Delete each copy once it is sent, and use the
  `pane-set-clipboard` hook for the agents' own.
- **Claude Code copies on its own.** Its full-screen drawing selects with the mouse, then copies
  by OSC 52, and also with `pbcopy` on a Mac or `tmux load-buffer` when it finds tmux.
- **Bun's `os.cpus()` reads the times when you first look at them, not when you call it.**
  Keep its result, wait, and read it then, and it holds the times from that moment: the CPU
  figure from two samples read 0%. Seen on Bun 1.3.14 on Linux. Copy the numbers out as you
  call it.
- **A screen outlives the daemon's restart, and keeps its queries.** Bun's `db.query` keeps a
  query's column names. When a newer release makes the `task_threads` view again, SQLite
  prepares the query again, but Bun puts each value under the old names. A column added in the
  middle shifted every name after it, and the sidebar read `tmux` as `seen` and stopped on
  "JSON Parse error". Seen on Bun 1.3.14. New columns go at the view's end.
- **Option with a digit types a character on a Mac**, such as `¡` for Option-1. So Alt-1 to
  Alt-6 and Alt-Q need the terminal to send Option as Alt. Ctrl-Q quits too, even while you
  type to an agent, for a Mac terminal that doesn't.
- **Alt-W is taken from agents, as Alt-Q is.** The screen's tmux keeps it, to ask whether to
  close or remove the open repository, so no agent ever sees it. Emacs-style keys in an agent's
  prompt, where Alt-W copies, don't get it. Alt-W needs Option sent as Alt on a Mac, and plain
  `w` does the same while your typing is in the sidebar.
- **Ctrl-\ is herdr's key to detach, so it is Skelcrew's too.** An agent is then left the
  same way on either host. The screen's tmux takes it before any pane, so herdr's own client
  inside the screen never detaches and leaves the right side empty. Ctrl-4 sends the same
  byte in most terminals, for a keyboard where backslash needs AltGr.
- **Hide Claude Code's notices over its input box in the live strip.** Its effort notice,
  such as `◐ medium · /effort`, and the tip under its busy line push the agent's output out
  of a strip of 3 lines. Keep every other line, whatever its indent, as it may be output.
- **Ask for the mouse only while the list shows.** Otherwise an agent you attach to, and
  your shell after you quit, lose the mouse.

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
  `scripts/test.ts` passes `--timeout` instead.
- **A flaky test can be a real race.** A test that failed now and then on "branch was deleted"
  had found a poll ending a thread while sc rm was removing it. Read the code the failure names
  before blaming the test.
- **A fixed wait fails on a busy machine.** Timers fire late and processes start slowly, so
  a test that looks after a set time, or counts what happened in it, can look too early.
  Wait for the thing itself: a file, a line on screen, a row, a process gone. Time only
  what can't come too soon, such as the gap between two renewals.
- **A file a fake writes can be read half written.** `> file` empties the file before the
  command writes it, so a test that waits for the file to have something can read only part.
  Have the fake write beside it and rename it into place, as `mv` does in one step.
- **Wait for the last thing, not the first.** The forge gets a review's check before the daemon
  saves the thread, and a note can reach the lead a piece at a time. A test that waits for the
  first and then reads the second can read it too early. Wait for what the test then reads.
- **Wait for the state a key starts from.** The sidebar can draw another row before the one you
  opened, and a key pressed then moves from there. A drag let go before tmux is in copy mode
  copies nothing. Wait for the row, or for copy mode, before the next key.
- **On a loaded CI runner, raise the limit, don't sleep.** A first clone or a builder's start
  took over 15 seconds there. A longer limit on a wait for the thing costs nothing when it
  comes fast.
- **`Bun.spawn` without `env` ignores changes to `process.env`.** It hands on the environment
  the process started with. Pass `env: process.env` to hand on a change.
- **Tests must not inherit the agent's `SKELCREW_SANDBOX` and `SKELCREW_SOCKET`.** A builder's
  `bun test` handed them to every sc, tmux server and daemon its tests started. The sidebar
  refused to start, sc called the real daemon, and dozens of screen tests each failed only
  after a 20 second wait. The run looked hung. `scripts/test.ts` starts the run without them,
  and `test/inherited.ts` stops a plain `bun test` inside the sandbox with a message.
- **A test's Skelcrew must never reach a real daemon.** A builder ran `test/submit.test.ts` in its
  sandbox with a stand-in for bubblewrap. The stand-in set the test builder's `SKELCREW_SOCKET`
  to `/run/skelcrew/skelcrew.sock` but skipped the mount that puts the test's socket there. That
  path held the real daemon's socket, so the fake builder ran `sc submit` on the real builder's
  own thread about four times: it pushed, replaced the PR description and started reviews. The rule:
  - `scripts/test.ts` drops every `SKELCREW_` variable, the laptop ones too, and gives the run a
    home and a runtime folder of its own. A process that spreads `process.env` then finds no
    daemon, and none of your settings or data.
  - A run that sees `/run/skelcrew` is inside a sandbox, even without `SKELCREW_SANDBOX`, so the
    tests that start a sandbox skip. Never run them there with a stand-in.
  - `test/inherited.ts` stops a plain `bun test` that has any `SKELCREW_` variable.
  - `runSkel`, `runSkelInTerminal` and `startDaemon` throw on a socket outside the test's own
    folder, with `..` and links resolved. Give every sc a test starts some other way the test's
    `XDG_RUNTIME_DIR`.
- **A parallel run prints a test file only once it ends.** A file whose tests each fail
  slowly kept the screen blank for over half an hour. `--dots` shows each test as it ends,
  and `scripts/test.ts` stops the whole run after 15 minutes.
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
- **launchd keeps the definition it loaded.** systemd reads a changed service file at the
  daemon's next start. On a Mac the changed file must be loaded at once, which restarts the
  daemon.
- **`sc init` never switches to the default branch.** Switching could fail where the branch
  tracks a file `sc init` just wrote. On another branch it shows the commands that commit
  there, and says to merge it.
- **GitHub picks a repository on the app's install page only by its ID.** Nobody can read a
  private repository's ID before the app is on it, so there you pick it yourself.
- **git maintains a clone in the background, and other git trips over it.** After a fetch,
  commit or merge, git may start `git maintenance` detached. It holds
  `objects/maintenance.lock` for a moment. A clone from that folder copies its files and fails
  when the lock vanishes mid-copy, as a CI run did. A fetch also writes a commit graph when
  your own settings ask for `fetch.writeCommitGraph`, with lock files of its own. Skelcrew runs
  its git with `maintenance.auto=false`, `gc.auto=0` and `fetch.writeCommitGraph=false`. It
  writes them into every clone it makes, and into its older clones at their first update. A
  plain `git clone` never starts maintenance; a `git fetch` does. Only a clone from a folder on
  the same disk copies its files: a fetch from that folder goes through git's own transport and
  never failed in 467 tries against nonstop maintenance, where 5 clones did.
- **A fake git that looks for a word sees the options too.** Skelcrew's git options include
  `fetch.writeCommitGraph=false`, so a fake git matching `*fetch*` takes an `ls-remote` for a
  fetch. Match `*" fetch "*` instead.

## Runtime plugins

- **An older plugin fails a question it doesn't know.** herdr's plugin 0.1.4 answers `rename`
  with Zod's `Invalid discriminator value. Expected 'start' | 'list' | …` at `ask`, listing the
  questions it does know. `sc repo add` renamed every running builder, so it printed one such
  error per thread, about threads you didn't ask about. A manifest says what a plugin provides,
  not which questions it answers, so Skelcrew asks once and learns from the answer. Only that
  answer counts: comparing a failure with the answer to a made-up question would take a write
  that failed for a moment, in a plugin's one generic error, for a missing question, and
  stop renames for good. What it learned is saved with the plugin's version, so a restart
  doesn't ask again, and an update does.

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
- **Skelcrew's GitHub App can't be assigned an issue.** So a label starts a task, and only
  people with triage or write access can add one.
- **A review on GitHub carries a verdict.** A review on a PR nobody reviewed would show as
  "Approved.", so a flow with no review posts none. A merge's record keeps the reviewer's
  last verdict, so it never contradicts it or blocks a forge that requires an approval. It
  says "Merging", not "Merged", as a check can still fail.
- **CI can show its first check after a docs-only review ends.** That review waits for no CI,
  so its approval makes the wait for checks instead.
