# Troubleshooting

[← back to the README](../README.md)

## Look here first

```powershell
# GlazeWM's own complaints. A config that fails to parse is NOT applied,
# so one typo silently reverts every change in the file.
Get-Content ~\.glzr\glazewm\errors.log -Tail 20

# What the daemon has been doing.
Get-Content ~\.glzr\glazewm\autotiling.log -Tail 30

# Is the daemon alive? This answers only if it is.
Invoke-RestMethod http://127.0.0.1:6124/focused-workspace
```

## Nothing tiles the way it should

Check the daemon is running. The bridge call above is the quickest test; if it
times out, nothing is listening on 6124.

Start it by hand:

```powershell
node ~\.glzr\glazewm\autotiling.mjs
```

Run in the foreground it prints the same lines it writes to the log, and any
startup error goes to the console instead of vanishing.

If it says `another instance is already running, exiting`, one is up. To find and
stop it:

```powershell
netstat -ano | Select-String '127.0.0.1:6124'   # the last column is the PID
Stop-Process -Id <pid>
```

## The mouse gestures do nothing

1. Is AutoHotkey running? There should be exactly one `AutoHotkey64` process.
2. Is it **v2**? The script will not load under v1.
3. Turn on `DEBUG_ENABLED := true` at the top of `glaze-mouse.ahk`, reload it,
   try a gesture, and read `glaze-mouse.log`. An empty bridge response means the
   daemon is down.

If the script fails to load at all, suspect an identifier collision: AutoHotkey
v2 is **case-insensitive**, so a variable named `DEBUG` clashes with a function
named `Debug()` and the whole file refuses to load — no hotkeys, no log. See
[Mouse](MOUSE.md#tuning).

## A keybinding does nothing

Almost always a config that did not parse. Check `errors.log`; GlazeWM keeps
running with the previous configuration, so the symptom is "my new binding does
nothing" rather than anything more obvious.

If the config is fine, check whether Windows is eating the combination —
[the list of ones to avoid](KEYBINDINGS.md#windows-shortcuts-worth-leaving-alone).

## A letter key stops typing

Look at your bindings for that letter with `Win`. `Win+S` is the famous one: bind
it and the plain `s` key stops producing anything, while `Shift+S` still works.
The tell is that it depends on Shift being **physically held**, not on the
letter's case — with Caps Lock on it still fails.

## An application fights the tiling

Some windows do not survive being resized. Add an ignore rule in `config.yaml`:

```yaml
window_rules:
  - commands: ['ignore']
    match:
      - window_process: { equals: 'TheApp' }
```

To find the process or class name:

```powershell
~\.glzr\glazewm\wm-helpers.exe classify <hwnd> normal
```

## The taskbar shows over a fullscreen game

Its own page: [Fullscreen games](FULLSCREEN-GAMES.md#verifying-it).

## GlazeWM will not take commands from a script

GlazeWM runs elevated, so launching `glazewm.exe` from a normal shell fails with
*"the requested operation requires elevation"*. The IPC socket does **not** need
elevation, so go through it instead:

```powershell
Invoke-RestMethod "http://127.0.0.1:6124/cmd?c=$([uri]::EscapeDataString('wm-reload-config'))"
```

## Reinstalling wiped my bindings

It should not: `install.ps1` carries the `PERSONAL` regions across. If your
bindings were outside those regions, they were replaced — the previous file is
next to the new one as `config.yaml.bak`. Move them inside the region and it will
not happen again. See [Customizing](CUSTOMIZING.md#where-your-settings-go).

## Starting over

```powershell
Copy-Item ~\.glzr\glazewm\config.yaml.bak ~\.glzr\glazewm\config.yaml
```

then `Alt+Shift+R`. Deleting `config.yaml` entirely also works: GlazeWM writes a
fresh default on the next start.
