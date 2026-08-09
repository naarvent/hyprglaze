# Architecture

[← back to the README](../README.md)

Four processes, three of them small — and no modifications to any of the two
programs involved. GlazeWM is the stock build; the shipped `AltSnap.ini` is an
ordinary AltSnap config. Everything is driven from outside through the IPC.

```
GlazeWM (elevated)
   │  IPC WebSocket on ws://127.0.0.1:6123
   │
   ├── autotiling.mjs   Node, unelevated
   │      ├─ BSP layout                        -> TILING.md
   │      ├─ fullscreen-game taskbar fix       -> FULLSCREEN-GAMES.md
   │      ├─ HTTP bridge on 127.0.0.1:6124
   │      └─ shells out to wm-helpers.exe      C#, Win32 window API
   │              ▲
   │              │ GET requests
   │              │
   ├── glaze-mouse.ahk  AutoHotkey v2          -> MOUSE.md
   │
   └── AltSnap          Alt+drag on floating windows
```

## Why there is an HTTP bridge

GlazeWM speaks WebSocket. AutoHotkey v2 has no sockets, but it does have
`WinHttpRequest`, which is built into Windows. So the daemon runs a minimal HTTP
server on port **6124** and translates: scripts talk to it over HTTP, it talks to
GlazeWM over WebSocket.

### The port is also the lock

Only one process can listen on a port, which makes the bind a free
single-instance lock — better than a PID file, because acquiring it is atomic
(no gap between checking and claiming) and the OS releases it even if the
process is killed outright.

The subtlety is that a failed bind means *someone is here*, not *another copy of
me is here*. Getting that wrong is a silent failure: if any unrelated program
happened to hold 6124, the daemon would exit reporting "another instance is
already running" and you would lose tiling, mouse gestures and the taskbar fix
with nothing obviously broken to look at.

So a taken port is **probed**:

| Probe result | Meaning | What happens |
|---|---|---|
| answers `/ping` as this service | genuinely a second copy | this process exits, the lock did its job |
| anything else | a stranger holds the port | move to the next candidate |

Candidates are 6124 to 6127.

Moving has a cost: the port is also the **address**, and a client still asking
6124 would be talking to the stranger. So the daemon writes the port it settled
on to `~\.glzr\glazewm\bridge-port`, and clients resolve it — that file first,
then probing `/ping` on each candidate if the file is missing or stale. Both
`glaze-mouse.ahk` and any script using the bridge do this, and re-resolve
automatically if a request comes back empty, which also covers the daemon
restarting on a different port mid-session.

### Endpoints

| Route | Returns |
|---|---|
| `/ping` | `{ok, service: "hyprglaze", port, pid}` — identifies the daemon, used to resolve the port |
| `/state?x=&y=` | which window is at that screen point, and whether it is tiled |
| `/cmd?c=` | runs a GlazeWM command verbatim |
| `/windows?process=` | windows of a process, with their handles |
| `/focused-workspace` | the workspace you are on |
| `/place?handle=&ws=&fx=&fy=&fw=&fh=&fit=` | floats one window into a fraction of a workspace |

`/place` takes fractions of the workspace rather than pixels, so the same call
lands correctly on any monitor. `fit=stretch` fills the rectangle; `fit=center`
keeps the window's own size and centres it inside. Windows are addressed by
Win32 handle, not title — Windows Terminal does not propagate the tab title to
the window title, so several terminals are all called "Terminal" and cannot be
told apart by name.

## Elevation

GlazeWM **runs elevated**, which has practical consequences:

- You cannot launch `glazewm.exe` from a normal shell; it demands elevation.
- The **IPC accepts unelevated connections**, because it is a plain TCP socket
  on localhost. That is why the daemon does not need admin.
- To reload the config from outside, send `command wm-reload-config` over the
  WebSocket. `Alt+Shift+R` does the same from the keyboard.

## Startup

GlazeWM starts both scripts itself, from `startup_commands`:

```yaml
startup_commands:
  - 'shell-exec wscript C:\Users\USERNAME\.glzr\glazewm\autotiling.vbs'
  - 'shell-exec C:\Users\USERNAME\AppData\Local\Programs\AutoHotkey\v2\AutoHotkey64.exe C:\Users\USERNAME\.glzr\glazewm\glaze-mouse.ahk'
```

The `.vbs` exists only to launch the daemon **without a console window**
(`WScript.Shell.Run` with its second argument at `0`).

> **Paths with spaces**
> GlazeWM's `shell-exec` parser does not accept them, quoted or otherwise. Hence
> the 8.3 short paths such as `C:\PROGRA~1\...`. To get one:
> ```cmd
> for %I in ("C:\Program Files\Some App\app.exe") do @echo %~sI
> ```

## Event handling

The daemon subscribes to `focus_changed`, `window_managed`, `window_unmanaged`
and `workspace_activated`.

Events arrive in bursts — opening a window fires `window_managed` and
`focus_changed` almost together — so they are coalesced with a 50 ms debounce.
The types seen are **accumulated in a set** rather than overwritten. Keeping only
the last one meant `focus_changed` clobbered the `window_managed` that came with
it, and window openings were never processed at all. That bug was invisible for a
while: the layout still looked plausible, just never quite right.

Reconnection is exponential backoff up to 30 s, giving up after ten attempts —
if GlazeWM is gone for good, the daemon exits and its `startup_commands` entry
brings it back next time.

## The native helper

`wm-helpers.exe` covers the parts Node cannot reach, which is anything needing
the Win32 window API. It is a single C# file, and every subcommand prints one
line of JSON.

| Subcommand | Does |
|---|---|
| `fix-fullscreen [--dry]` | finds the window covering a monitor and nudges it |
| `nudge <hwnd>` | moves a window 1px and back |
| `classify <hwnd> <state>` | reports how a window is fullscreen — diagnostics |
| `mark-fullscreen <hwnd> <0\|1>` | `ITaskbarList2::MarkFullscreenWindow` |

It is invoked as a process, not kept resident: it only runs on a workspace
change, and only when something is actually covering a monitor.

Why `mark-fullscreen` is in there despite not fixing anything is explained in
[Fullscreen games](FULLSCREEN-GAMES.md).

## Files

Everything lives in `~\.glzr\glazewm\`:

| File | What |
|---|---|
| `config.yaml` | GlazeWM configuration |
| `autotiling.mjs` | the daemon |
| `autotiling.vbs` | hidden launcher for it |
| `glaze-mouse.ahk` | mouse gestures |
| `wm-helpers.exe` | native helper, built by `install.ps1` |
| `wm-helpers/` | its source |
| `bridge-port` | which port the bridge ended up on; written at startup, removed on exit |
| `autotiling.log` | daemon log, self-truncating at 512 KB |
| `errors.log` | GlazeWM's own complaints — check this first |
