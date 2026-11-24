# The screen

`sc` opens the screen for the repository you are in. This guide shows how to find your way around it.

## The two sides

The screen has two sides.

- **The sidebar**, on the left, lists the repository's lead and its tasks.
- **The right side** shows the row you are on: the lead, or a task's details with its agent at work.

A blue box shows where your typing goes. Only one side has it at a time.

The screen starts on the lead, so what you type first goes to the lead.

## The sidebar

The sidebar's top line says, on its right, how many builders run out of the repository's limit, such as `3/5 threads · 2 queued`. It turns white once every builder is busy. `sc --list` shows it on the line above its rows.

The lead is the first row. Below it, tasks are grouped in sections:

| Section | What is in it |
| --- | --- |
| Needs you | Tasks waiting on your answer. It shows only while something waits. |
| Backlog | Issues and tasks not started yet. |
| Task queue | Tasks waiting for a free builder, and builders you paused with `sc stop`. |
| Building | A builder is working on it. |
| Reviewing | A reviewer is reviewing its latest round. |
| Checks | Waiting for CI, once the review approved it. |
| Ready | Approved and green, with a merge already armed. |
| Done | Merged or closed lately. |

Each task shows once, in one section. A task that is approved and green, and waits for you to merge it, shows under Needs you, as `ready to merge`. Its row has a short word that says what is happening, such as `working` or `ready to merge`.

## Moving around

Press Alt+Tab (⌥Tab on a Mac) or Ctrl+\ to bring your typing to the sidebar. Then:

| Key | What it does |
| --- | --- |
| ↑ ↓ | Move one row |
| 0 to 6 | Open or close a section: 0 is Backlog, 6 is Done |
| Enter | Open the row you are on |
| Shift+Enter | Open the row's agent full screen. |
| `s` | Start a task from the Backlog |
| `m` | Merge a task that is `ready to merge` |
| Shift+R | Restart the row's agent, keeping its conversation |
| Tab or Shift+Tab | Give your typing back to the right side |

Each key asks before it starts, merges or restarts anything.

The keys you can use on a row show at the bottom of the screen.

Some keys work from anywhere, even while you type to an agent:

| Key | What it does |
| --- | --- |
| Alt+↑ ↓ | Move one row |
| Alt+Shift+↑ ↓ | Jump to the next or previous section |
| Alt+0 to Alt+6 | Open or close a section |
| Alt+Shift+← → | Switch to another repository's tab |
| Alt+Tab, or Ctrl+\ | Switch your typing between the sidebar and the right side |
| Ctrl+D twice | Leave the screen |

You can also click. A click on a row opens it, and a click on a section's heading opens or closes it.

## Opening the lead or a builder

Enter on the lead's row gives your typing to the lead.

Enter on a task opens it:

- A task at work attaches you to its builder, on the right side. You type to it as you would in Claude Code or Codex.
- A task that is ready to merge, or under Ready or Done, opens its pull request.
- A task in the Backlog asks whether to start it.

Moving to a task without pressing Enter shows its details on the right: its stage, CI, review and recent events, with its agent live beside them. Nothing you type there reaches the agent.

## Switching your typing

Alt+Tab switches your typing between the sidebar and the right side, both ways. From the lead or a builder it brings your typing to the sidebar. From the sidebar it gives it back to where it was. A builder you attached to is detached when you leave it, and the right side shows the task's details again. Alt+Tab attaches you to it again.

On a task's details, with no agent to go back to, your typing stays in the sidebar. It never leaves the screen.

Ctrl+\ does the same as Alt+Tab, and needs no Alt key. If backslash is awkward on your keyboard, Ctrl+4 does the same in most terminals.

Plain Tab and Shift+Tab reach the agent on the right. In the sidebar they give your typing back to the right side, as Alt+Tab does, so a missed Alt never switches repository.

Esc then Tab typed very fast in an agent's prompt looks the same as Alt+Tab to the screen, so it switches too.

## Alt keys on a Mac

The Alt keys, such as ⌥Tab, ⌥↑ and ⌥W, need your terminal to send ⌥ as Alt. Most Mac terminals don't by default. Set it once:

| Terminal | Setting |
| --- | --- |
| Ghostty | `macos-option-as-alt = true` in its config |
| iTerm2 | Settings > Profiles > Keys > General: Left Option key: Esc+ |
| Terminal.app | Settings > Profiles > Keyboard: Use Option as Meta key |
| kitty | `macos_option_as_alt yes` in `kitty.conf` |
| WezTerm | The left ⌥ is Alt by default. For the right one too, set `config.send_composed_key_when_right_alt_is_pressed = false` |
| Alacritty | `option_as_alt = "Both"` under `[window]` |

Do you use ⌥ to type characters, such as `@` or `€`? Then leave the setting off, and map ⌥Tab, or any key you like, to send Ctrl+\ instead. Ctrl+\ is the byte `\x1c`:

| Terminal | Mapping |
| --- | --- |
| Ghostty | `keybind = alt+tab=text:\x1c` |
| iTerm2 | Settings > Profiles > Keys > Key Mappings: add ⌥Tab, action Send Hex Code, `0x1c` |
| Terminal.app | Settings > Profiles > Keyboard: add Tab with Option, action Send Text, `\034` |
| kitty | `map alt+tab send_text all \x1c` |
| WezTerm | `{ key = 'Tab', mods = 'ALT', action = wezterm.action.SendString '\x1c' }` in `config.keys` |

On Linux and Windows, the desktop usually takes Alt+Tab to switch windows. Use Ctrl+\ there, or map a free key to send it.

## Full screen

Shift+Enter gives the row's agent the whole terminal. Alt+Tab or Ctrl+\ brings the sidebar back, and pressed again gives the agent the whole terminal again.

In an item you opened from Needs you, `a` answers it with option a. Esc back to the list first.

To open a builder full screen without the screen, use `sc attach`:

```sh
sc attach APP-12
```

Ctrl+\ detaches you and brings you back to your shell. That is on tmux, the default. A runtime plugin, such as herdr, has its own key.

## The list

`sc --list` shows the same sections as a list, with a details pane beside it in a wide terminal. Enter attaches to an agent full screen, and Ctrl+\ comes back to the list. Alt+Shift+← → switches repository. Tab and Shift+Tab do nothing there, as the list has no right side.

## Leaving

Ctrl+D twice leaves the screen. Your agents keep running, and the screen says so:

```
Your agents keep running. Run sc to come back.
```

## Narrow screens

On a terminal under 80 columns wide, such as a phone's, the screen shows one side at a time.

- The sidebar fills the screen, with its keys listed at the bottom.
- Tap a row, or press Enter, to open it. The lead or the builder then fills the screen.
- Alt+Tab or Ctrl+\ brings the sidebar back.
