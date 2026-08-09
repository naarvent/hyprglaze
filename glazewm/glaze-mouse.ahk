#Requires AutoHotkey v2.0
#SingleInstance Force
; Hyprland-style mouse gestures for GlazeWM.
;
;   Win + drag left button   -> move    (Hyprland: bindm = SUPER, mouse:272)
;   Win + drag right button  -> resize  (Hyprland: bindm = SUPER, mouse:273)
;
; GlazeWM owns the geometry of tiled windows, so moving one with SetWindowPos
; achieves nothing: the WM puts it straight back. Those have to go through the
; tree instead, by sending commands to the HTTP bridge autotiling.mjs runs on
; localhost.
;
; Floating windows belong to nobody, so those are moved directly.
; AltSnap keeps Alt for anyone who wants its more advanced snapping.

; The bridge is not always on the first port: if something else already holds
; it, the daemon moves along and writes where it landed to `bridge-port`. So the
; address is resolved rather than assumed — from that file first, then by asking
; each candidate who it is.
BRIDGE_PORTS := [6124, 6125, 6126, 6127]
BRIDGE_PORT_FILE := A_ScriptDir . "\bridge-port"
BRIDGE := ""           ; resolved on first use

DRAG_THRESHOLD := 6    ; px to travel before it counts as a drag
RESIZE_STEP := 4       ; % change per step
PX_PER_STEP := 28      ; px of mouse travel worth one resize step

; NOTE: AutoHotkey v2 identifiers are case-insensitive, so a variable named
; DEBUG would collide with a function named Debug(). Hence the longer name.
DEBUG_ENABLED := false
DEBUG_PATH := A_ScriptDir . "\glaze-mouse.log"

Debug(text) {
    global DEBUG_ENABLED, DEBUG_PATH
    if (DEBUG_ENABLED)
        try FileAppend(A_Now . "  " . text . "`n", DEBUG_PATH)
}

Debug("=== glaze-mouse started ===")

; ------------------------------------------------------------------ helpers

HttpGet(url) {
    try {
        request := ComObject("WinHttp.WinHttpRequest.5.1")
        request.Open("GET", url, false)
        request.SetTimeouts(200, 200, 200, 600)
        request.Send()
        return request.ResponseText
    } catch {
        return ""
    }
}

; A port answering is not enough — it has to be our daemon and not whatever
; else happened to grab it.
IsOurBridge(port) {
    return InStr(HttpGet("http://127.0.0.1:" . port . "/ping"), '"service":"glaze-autotiling"') > 0
}

ResolveBridge() {
    global BRIDGE, BRIDGE_PORTS, BRIDGE_PORT_FILE

    saved := ""
    try saved := Trim(FileRead(BRIDGE_PORT_FILE))
    if (saved != "" && IsOurBridge(saved)) {
        BRIDGE := "http://127.0.0.1:" . saved
        Debug("bridge resolved from bridge-port: " . BRIDGE)
        return true
    }

    for port in BRIDGE_PORTS {
        if (IsOurBridge(port)) {
            BRIDGE := "http://127.0.0.1:" . port
            Debug("bridge found by probing: " . BRIDGE)
            return true
        }
    }

    BRIDGE := ""
    Debug("no bridge found on " . BRIDGE_PORTS.Length . " candidate ports")
    return false
}

Query(route) {
    global BRIDGE
    if (BRIDGE != "") {
        answer := HttpGet(BRIDGE . route)
        if (answer != "")
            return answer
    }
    ; Empty either because we never resolved, or because the daemon restarted
    ; somewhere else. Worth one re-resolve before giving up on the gesture.
    if (!ResolveBridge())
        return ""
    return HttpGet(BRIDGE . route)
}

; Pulls one field out of a flat JSON object. The bridge responses are flat and
; written by us, so a real parser would be overkill.
Field(json, key) {
    if RegExMatch(json, '"' . key . '":\s*"([^"]*)"', &m)
        return m[1]
    if RegExMatch(json, '"' . key . '":\s*([-\d.]+|true|false)', &m)
        return m[1]
    return ""
}

; Not called Send(): AutoHotkey v2 lets a user function shadow the built-in of
; that name, and a reader would reasonably assume the built-in is what runs.
SendCommand(command) {
    Query("/cmd?c=" . UriEncode(command))
}

UriEncode(text) {
    static safe := "abcdefghijklmnopqrstuvwxyzABCDEFGHIJKLMNOPQRSTUVWXYZ0123456789-_."
    out := ""
    for byte in StrToUtf8(text) {
        char := Chr(byte)
        out .= InStr(safe, char, true) ? char : Format("%{:02X}", byte)
    }
    return out
}

StrToUtf8(text) {
    bytes := []
    size := StrPut(text, "UTF-8")
    buf := Buffer(size)
    StrPut(text, buf, "UTF-8")
    loop size - 1
        bytes.Push(NumGet(buf, A_Index - 1, "UChar"))
    return bytes
}

StateUnderCursor() {
    MouseGetPos(&mx, &my)
    return { json: Query("/state?x=" . mx . "&y=" . my), x: mx, y: my }
}

; --------------------------------------------------------------------- move

#LButton:: {
    global DRAG_THRESHOLD
    state := StateUnderCursor()
    Debug("win+LButton at " . state.x . "," . state.y . "  response=" . (state.json = "" ? "<EMPTY: bridge not answering>" : state.json))
    if (Field(state.json, "found") != "true")
        return

    id := Field(state.json, "id")
    isTiling := Field(state.json, "tiling") = "true"
    startX := state.x, startY := state.y

    if (!isTiling) {
        MoveFloating(id, startX, startY)
        return
    }

    ; Tiled: wait for the release and turn the gesture into a direction. Moving
    ; inside the tree is discrete, not continuous — re-shuffling the layout on
    ; every pixel would be nonsense.
    while GetKeyState("LButton", "P")
        Sleep(10)

    MouseGetPos(&endX, &endY)
    dx := endX - startX, dy := endY - startY
    if (Abs(dx) < DRAG_THRESHOLD && Abs(dy) < DRAG_THRESHOLD)
        return

    direction := Abs(dx) > Abs(dy)
        ? (dx > 0 ? "right" : "left")
        : (dy > 0 ? "down" : "up")
    SendCommand("--id " . id . " move --direction " . direction)
}

MoveFloating(id, startX, startY) {
    hwnd := WinExist("A")
    MouseGetPos(, , &winId)
    if (winId)
        hwnd := winId
    if (!hwnd)
        return

    WinGetPos(&wx, &wy, , , "ahk_id " . hwnd)
    offsetX := startX - wx, offsetY := startY - wy

    while GetKeyState("LButton", "P") {
        MouseGetPos(&mx, &my)
        try WinMove(mx - offsetX, my - offsetY, , , "ahk_id " . hwnd)
        Sleep(8)
    }
}

; ------------------------------------------------------------------- resize

#RButton:: {
    global RESIZE_STEP, PX_PER_STEP
    state := StateUnderCursor()
    Debug("win+RButton at " . state.x . "," . state.y . "  response=" . (state.json = "" ? "<EMPTY: bridge not answering>" : state.json))
    if (Field(state.json, "found") != "true")
        return

    id := Field(state.json, "id")
    isTiling := Field(state.json, "tiling") = "true"
    startX := state.x, startY := state.y

    if (!isTiling) {
        ResizeFloating(startX, startY)
        return
    }

    ; Tiled: the drag becomes percentage steps. What has already been applied is
    ; tracked so the resize follows the mouse instead of running away with every
    ; movement event.
    appliedX := 0, appliedY := 0
    while GetKeyState("RButton", "P") {
        MouseGetPos(&mx, &my)
        wantX := Round((mx - startX) / PX_PER_STEP)
        wantY := Round((my - startY) / PX_PER_STEP)

        while (appliedX != wantX) {
            step := (wantX > appliedX) ? 1 : -1
            SendCommand("--id " . id . " resize --width " . (step > 0 ? "+" : "-") . RESIZE_STEP . "%")
            appliedX += step
        }
        while (appliedY != wantY) {
            step := (wantY > appliedY) ? 1 : -1
            SendCommand("--id " . id . " resize --height " . (step > 0 ? "+" : "-") . RESIZE_STEP . "%")
            appliedY += step
        }
        Sleep(16)
    }
}

ResizeFloating(startX, startY) {
    MouseGetPos(, , &hwnd)
    if (!hwnd)
        return
    WinGetPos(&wx, &wy, &width, &height, "ahk_id " . hwnd)

    while GetKeyState("RButton", "P") {
        MouseGetPos(&mx, &my)
        newWidth := Max(120, width + (mx - startX))
        newHeight := Max(80, height + (my - startY))
        try WinMove(wx, wy, newWidth, newHeight, "ahk_id " . hwnd)
        Sleep(8)
    }
}
