# glaze-linuxish

A Windows 11 desktop that behaves like a Linux tiling window manager, built on
[GlazeWM](https://github.com/glzr-io/glazewm) and [AltSnap](https://github.com/RamonUnch/AltSnap).

GlazeWM already does the hard part. This fills in the four things that kept
tripping me up after moving over from Hyprland, none of which GlazeWM ships:

| | |
|---|---|
| **BSP layout** | GlazeWM always splits the same way. A small daemon sets the split axis from the shape of the focused window, so the screen partitions like komorebi or bspwm. [How it works](docs/TILING.md) |
| **Mouse gestures on tiled windows** | `Win`+drag to move, `Win`+right-drag to resize, tiled windows included. AltSnap only ever managed floating ones. [How it works](docs/MOUSE.md) |
| **The taskbar over fullscreen games** | Switch workspace, come back, push the mouse down, and an auto-hidden taskbar slides up over your game. Fixed, after finding out that the obvious API for it does nothing. [The whole story](docs/FULLSCREEN-GAMES.md) |
| **Follow the window you just moved** | `Alt+Shift+<n>` sends a window to a workspace *and takes you along*, the way komorebi does. |

New windows also open on whatever monitor and workspace the mouse is on, and
focus follows the cursor — no click needed.

## Install

```powershell
winget install glzr-io.glazewm
winget install OpenJS.NodeJS            # Node 22 or newer
winget install AutoHotkey.AutoHotkey    # v2, not v1
winget install Microsoft.DotNet.SDK.10  # optional, for the taskbar fix

git clone https://github.com/<you>/glaze-linuxish.git $env:USERPROFILE\glaze-linuxish
cd $env:USERPROFILE\glaze-linuxish
.\install.ps1 -WhatIf   # see what it would do
.\install.ps1
```

Then start GlazeWM. AltSnap is optional and installed separately; see
[docs/INSTALL.md](docs/INSTALL.md) for the details, including what to do when
you already have a config you care about.

## Keys

`Alt` is the modifier, not `Win`. There are three good reasons and one of them
cost an afternoon of debugging — [docs/KEYBINDINGS.md](docs/KEYBINDINGS.md) has
the full list and the story.

The short version:

| | |
|---|---|
| `Alt+Q` `Alt+F` | close, float |
| `Alt+E` `Alt+S` | file manager, terminal |
| `Alt+←↑↓→` | move focus |
| `Alt+Shift+←↑↓→` | move the window |
| `Alt+1…0` | switch workspace |
| `Alt+Shift+1…0` | send the window there and follow it |
| `Alt+R` | resize mode |
| `Win`+drag | move / resize with the mouse |

Adding your own goes in a marked region of the config that upgrades never
overwrite: [docs/CUSTOMIZING.md](docs/CUSTOMIZING.md).

## Documentation

| | |
|---|---|
| [Install](docs/INSTALL.md) | requirements, what goes where, symlink mode |
| [Keybindings](docs/KEYBINDINGS.md) | every binding, and why the modifier is Alt |
| [Customizing](docs/CUSTOMIZING.md) | your own bindings, modes and startup commands |
| [Architecture](docs/ARCHITECTURE.md) | the moving parts and how they talk |
| [Tiling](docs/TILING.md) | how the BSP layout is emulated |
| [Mouse](docs/MOUSE.md) | the drag gestures, and living with AltSnap |
| [Fullscreen games](docs/FULLSCREEN-GAMES.md) | the taskbar bug, measured and fixed |
| [Troubleshooting](docs/TROUBLESHOOTING.md) | when something stops working |

## What is in here

```
glazewm/
  config.yaml       GlazeWM configuration
  autotiling.mjs    the daemon: BSP, HTTP bridge, taskbar fix
  autotiling.vbs    launches it without a console window
  glaze-mouse.ahk   Win+drag gestures
  wm-helpers/       C# helper for the parts that need the Win32 window API
altsnap/
  AltSnap.ini       Alt+drag, tuned to not fight with the above
install.ps1         install and build
sync.ps1            pull your live config back into the repo
```

No dependencies beyond the four programs above: the daemon is plain Node with
the global `WebSocket`, and the helper is a single C# file.

## License

MIT.
