# Mouse

[← back to the README](../README.md)

Hyprland's `bindm` gestures, ported:

```
bindm = SUPER, mouse:272, movewindow      ->  Win + left drag
bindm = SUPER, mouse:273, resizewindow    ->  Win + right drag
```

Both work on **tiled** windows, which is the part AltSnap cannot do.

## Why AltSnap alone is not enough

AltSnap moves a window with `SetWindowPos`. On a tiled window GlazeWM owns the
geometry and puts it straight back, so the window jitters and lands where it
started.

Moving a tiled window means changing its position **in the tree**, not on the
screen. That is a WM command, not a Win32 call. `glaze-mouse.ahk` sends those
commands through the [HTTP bridge](ARCHITECTURE.md#why-there-is-an-http-bridge),
because AutoHotkey v2 has no sockets but does have `WinHttpRequest`.

## How a drag is interpreted

On mouse down the script asks the bridge what is under the cursor:

```
GET /state?x=<mx>&y=<my>   ->   { found, id, tiling, x, y, width, height, handle }
```

and then behaves differently depending on the answer.

### Tiled, left button

Waits for the release, measures the total displacement, and turns it into a
single direction:

```
direction = |dx| > |dy| ? (dx > 0 ? right : left)
                        : (dy > 0 ? down  : up)
```

then sends `move --direction <direction>`.

Discrete rather than continuous on purpose: moving inside a tree has no
meaningful "halfway", and reshuffling the layout on every pixel of mouse
movement would be unusable. Displacements under 6 px are ignored, so a slightly
sloppy click does not move anything.

### Tiled, right button

Continuous, in steps. Every 28 px of mouse travel is worth one `resize ±4%`, and
the script tracks how many steps it has already applied so the window follows the
cursor instead of running away with every mouse event.

### Floating, either button

Moved and resized directly with `WinMove`. Nothing owns the geometry, so there
is no reason to involve the WM.

## Living with AltSnap

They coexist because they use different modifiers: this script is on `Win`,
AltSnap on `Alt`. AltSnap also disables itself as soon as it sees an A–Z key, so
`Alt`+letter bindings keep working.

The shipped `AltSnap.ini` has `Hotkeys=A4 A5` (both Alt keys), left button to
move and right button to resize — the same layout as the `Win` gestures, so the
muscle memory transfers.

AltSnap is entirely optional. Remove it and you lose the extra snapping on
floating windows; everything else is unaffected.

## Tuning

At the top of `glaze-mouse.ahk`:

| Constant | Default | What it does |
|---|---|---|
| `DRAG_THRESHOLD` | 6 | px before a drag counts as one |
| `RESIZE_STEP` | 4 | % per resize step |
| `PX_PER_STEP` | 28 | px of travel worth one step |
| `DEBUG_ENABLED` | false | writes `glaze-mouse.log` on every gesture |

Turn `DEBUG_ENABLED` on when a gesture does nothing: the log records the point,
the bridge response, and whether the window was tiled. An empty response means
the daemon is not running.

> **AutoHotkey v2 trap**
> Identifiers are **case-insensitive**, so a variable called `DEBUG` collides
> with a function called `Debug()`, and the script fails to load with
> *"This func cannot be used as an output variable"*. It fails at load time, so
> no hotkeys register and nothing is logged. If the gestures are dead and the log
> is empty, that is the first thing to check.
