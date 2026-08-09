# Install

[← back to the README](../README.md)

## Requirements

| | Why | Required |
|---|---|---|
| Windows 11 | The focused-window border and the taskbar fix use APIs that behave differently on Windows 10 | yes |
| [GlazeWM](https://github.com/glzr-io/glazewm) 3.10+ | the window manager itself | yes |
| Node.js 22+ | the daemon uses the global `WebSocket`, so it has no dependencies at all | yes |
| AutoHotkey **v2** | the mouse gestures. v1 will not run this script, the syntax is different | for the mouse |
| .NET SDK 10 | builds the native helper | for the taskbar fix |
| [AltSnap](https://github.com/RamonUnch/AltSnap) | `Alt`+drag on floating windows | optional |

```powershell
winget install glzr-io.glazewm
winget install OpenJS.NodeJS
winget install AutoHotkey.AutoHotkey
winget install Microsoft.DotNet.SDK.10
```

AltSnap is not on winget; grab it from its releases page.

Missing pieces are not fatal. `install.ps1` warns and carries on, and each part
degrades on its own: no AutoHotkey means no mouse gestures, no .NET means no
taskbar fix, everything else still works.

## Running it

```powershell
git clone https://github.com/<you>/hyprglaze.git $env:USERPROFILE\hyprglaze
cd $env:USERPROFILE\hyprglaze
.\install.ps1 -WhatIf
.\install.ps1
```

`-WhatIf` prints every action without performing any of them. Worth doing once.

What the script does:

1. Copies the files into place, backing up anything it overwrites as `.bak`.
2. Rewrites the absolute paths in `config.yaml` to your user. GlazeWM does not
   expand environment variables inside its config, so `%USERPROFILE%` is not an
   option — the paths have to be substituted for real.
3. Builds `wm-helpers.exe` from source and drops the build output afterwards.

Then start GlazeWM, or press `Alt+Shift+R` if it is already running.

## Where things end up

| From | To |
|---|---|
| `glazewm/` | `~\.glzr\glazewm\` |
| `glazewm/wm-helpers/` | `~\.glzr\glazewm\wm-helpers\` |
| `altsnap/` | `%APPDATA%\AltSnap\` |

The daemon and the mouse script are started by GlazeWM itself, from
`startup_commands` in the config. Nothing is added to your Windows startup.

## If you already have a config you care about

`install.ps1` overwrites `config.yaml`, keeping a `.bak` next to it. Two ways to
avoid losing work:

- Move your own bindings into the `PERSONAL` region first. Those are carried
  across every reinstall — see [Customizing](CUSTOMIZING.md).
- Or install to a scratch user profile, look at the result, and merge by hand.

## Symlink mode

```powershell
.\install.ps1 -Link
```

Creates symbolic links into the repo instead of copying, so anything you edit is
version-controlled immediately and `sync.ps1` becomes unnecessary. Needs Windows
developer mode enabled, or an elevated shell.

The catch: path rewriting is skipped, because it would write your user name into
the repo. If your Windows user name differs from the one in the checked-in
config, fix `startup_commands` by hand once.

## Uninstalling

Close GlazeWM, then delete `~\.glzr\glazewm\` and `%APPDATA%\AltSnap\`. Nothing
is installed anywhere else, no services, no registry keys, no startup entries.
