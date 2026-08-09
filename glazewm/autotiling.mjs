#!/usr/bin/env node
/**
 * Autotiling daemon for GlazeWM v3 — emulates komorebi's BSP/dwindle layout.
 *
 * The idea is the one sway's `autotiling` script uses: GlazeWM inserts every
 * new window as a sibling of the focused one, following the tiling direction
 * of the parent container. Set that direction from the shape of the focused
 * window before each insertion — always split along the longer side — and what
 * comes out is a binary partition of the screen.
 *
 * It also owns two things that grew out of the same event loop: an HTTP bridge
 * the other scripts talk to, and the fullscreen-game taskbar fix.
 *
 * Requires Node 22+ for the global WebSocket. No dependencies, no elevation:
 * GlazeWM's IPC is a plain TCP socket on localhost.
 */

const IPC_URL = 'ws://127.0.0.1:6123';

// The bridge is an HTTP server for glaze-mouse.ahk, which has no sockets but
// does speak HTTP through WinHttpRequest. Its port doubles as a single-instance
// lock, because only one process can listen on a port.
//
// Using it as a lock needs care: a failed bind means "someone is here", not
// "another copy of me is here". So a taken port is probed. If it answers /ping
// as this service, it really is a second copy and this one exits. If it is a
// stranger, the bridge moves to the next port instead of dying silently.
//
// Moving costs something: the port is also the address clients use, so it is
// written to PORT_FILE and clients resolve it from there.
const BRIDGE_PORTS = [6124, 6125, 6126, 6127];
const SERVICE = 'glaze-autotiling';
const PORT_FILE = fileURLToPath(new URL('./bridge-port', import.meta.url));

const EVENTS = ['focus_changed', 'window_managed', 'window_unmanaged', 'workspace_activated'];
const MAX_RETRIES = 10; // roughly two minutes of backoff before giving up
const MAX_PASSES = 6; // deepest tree the rebalancer will walk
const SETTLE_MS = 300; // let the WM finish moving things before we look
const PLACE_GAP = 6; // px between placed windows, matches inner_gap

const LOG_PATH = new URL('./autotiling.log', import.meta.url);
const MAX_LOG_BYTES = 512 * 1024;

import { appendFileSync, existsSync, statSync, truncateSync, writeFileSync, rmSync } from 'node:fs';
import { createServer } from 'node:http';
import { execFile } from 'node:child_process';
import { fileURLToPath } from 'node:url';

// Native helper, source in wm-helpers/. Node cannot reach the Windows window
// API, and the taskbar fix needs SetWindowPos.
const HELPER = fileURLToPath(new URL('./wm-helpers.exe', import.meta.url));

/** Runs wm-helpers and returns its JSON, or null if anything goes wrong. */
function helper(...args) {
  return new Promise((resolve) => {
    execFile(HELPER, args, { timeout: 5000, windowsHide: true }, (err, stdout) => {
      if (err) {
        log(`wm-helpers ${args[0]}: ${err.message}`);
        resolve(null);
        return;
      }
      try {
        resolve(JSON.parse(stdout));
      } catch {
        resolve(null);
      }
    });
  });
}

function log(line) {
  const stamp = new Date().toISOString();
  const text = `${stamp} ${line}\n`;
  process.stdout.write(text);
  try {
    try {
      if (statSync(LOG_PATH).size > MAX_LOG_BYTES) truncateSync(LOG_PATH, 0);
    } catch {
      // Log file does not exist yet.
    }
    appendFileSync(LOG_PATH, text);
  } catch {
    // A failing log is not worth killing the process over.
  }
}

/** Is whatever holds this port one of us? */
async function isOurBridge(port) {
  try {
    const res = await fetch(`http://127.0.0.1:${port}/ping`, {
      signal: AbortSignal.timeout(400),
    });
    return (await res.json())?.service === SERVICE;
  } catch {
    return false;
  }
}

/**
 * Tries to own one port. Returns 'listening', 'ours' (a real second instance,
 * so this process should stand down) or 'stranger' (someone else's server).
 */
function listenOn(client, port) {
  return new Promise((resolve) => {
    const server = buildServer(client, port);
    server.once('error', async () => {
      resolve((await isOurBridge(port)) ? 'ours' : 'stranger');
    });
    server.once('listening', () => resolve('listening'));
    server.listen(port, '127.0.0.1');
  });
}

/**
 * Walks the candidate ports. Returns the one we ended up on, or null when this
 * process should exit — with `reason` explaining which of the two cases it was.
 */
async function openBridge(client) {
  for (const port of BRIDGE_PORTS) {
    const outcome = await listenOn(client, port);
    if (outcome === 'listening') return { port };
    if (outcome === 'ours') return { reason: 'another instance is already running' };
    log(`port ${port} is taken by something that is not us, trying the next one`);
  }
  return { reason: `no free port in ${BRIDGE_PORTS.join(', ')}` };
}

/**
 * The bridge itself.
 *
 *   GET /ping              identifies this service, used to resolve the port
 *   GET /state?x=&y=       which window sits at that screen point
 *   GET /windows?process=  windows of a process, with their handles
 *   GET /focused-workspace name of the workspace you are on
 *   GET /place?...         float one window into a fraction of a workspace
 *   GET /cmd?c=            run a GlazeWM command verbatim
 */
function buildServer(client, port) {
  return createServer(async (req, res) => {
    const url = new URL(req.url, 'http://127.0.0.1');
    res.setHeader('Content-Type', 'application/json');

    try {
      if (url.pathname === '/ping') {
        res.end(JSON.stringify({ ok: true, service: SERVICE, port, pid: process.pid }));
        return;
      }
      if (url.pathname === '/state') {
        const x = Number(url.searchParams.get('x'));
        const y = Number(url.searchParams.get('y'));
        res.end(JSON.stringify(await client.windowAt(x, y)));
        return;
      }
      if (url.pathname === '/focused-workspace') {
        res.end(JSON.stringify(await client.focusedWorkspace()));
        return;
      }
      if (url.pathname === '/windows') {
        res.end(JSON.stringify(await client.windowsOf(url.searchParams.get('process'))));
        return;
      }
      if (url.pathname === '/place') {
        const num = (key) => Number(url.searchParams.get(key));
        res.end(
          JSON.stringify(
            await client.placeWindow({
              handle: url.searchParams.get('handle'),
              workspace: url.searchParams.get('ws'),
              fx: num('fx'),
              fy: num('fy'),
              fWidth: num('fw'),
              fHeight: num('fh'),
              fit: url.searchParams.get('fit'),
            }),
          ),
        );
        return;
      }
      if (url.pathname === '/cmd') {
        const command = url.searchParams.get('c') ?? '';
        await client.send(`command ${command}`);
        res.end('{"ok":true}');
        return;
      }
      res.statusCode = 404;
      res.end('{"error":"unknown route"}');
    } catch (err) {
      res.statusCode = 500;
      res.end(JSON.stringify({ error: String(err) }));
    }
  });
}

class GlazeClient {
  #ws = null;
  #pending = []; // FIFO: GlazeWM answers in the order it was asked.
  #onEvent = null;
  #backoff = 1000;
  #failures = 0;

  constructor(onEvent) {
    this.#onEvent = onEvent;
  }

  connect() {
    const ws = new WebSocket(IPC_URL);
    this.#ws = ws;

    ws.onopen = async () => {
      this.#backoff = 1000;
      this.#failures = 0;
      log(`connected to ${IPC_URL}`);
      const res = await this.send(`sub --events ${EVENTS.join(' ')}`);
      log(`subscribed to [${EVENTS.join(', ')}] id=${res?.subscriptionId}`);
      await this.apply('startup');
    };

    ws.onmessage = (ev) => {
      let msg;
      try {
        msg = JSON.parse(ev.data);
      } catch {
        return;
      }

      if (msg.messageType === 'client_response') {
        const resolve = this.#pending.shift();
        if (resolve) resolve(msg.success ? msg.data : null);
        if (!msg.success && msg.error) log(`error response: ${msg.error}`);
        return;
      }

      if (msg.messageType === 'event_subscription') {
        this.#onEvent(msg.data?.eventType);
      }
    };

    ws.onclose = () => {
      // In-flight requests would hang forever otherwise.
      for (const resolve of this.#pending.splice(0)) resolve(null);

      // If GlazeWM is gone for good there is no point retrying forever: exit
      // and let the WM's own startup_commands bring us back next time.
      if (++this.#failures > MAX_RETRIES) {
        log(`no connection after ${MAX_RETRIES} attempts, exiting`);
        process.exit(0);
      }

      log(`connection closed, retrying in ${this.#backoff}ms`);
      setTimeout(() => this.connect(), this.#backoff);
      this.#backoff = Math.min(this.#backoff * 2, 30_000);
    };

    // `onerror` is always followed by `onclose`, which already schedules the
    // retry. Swallowed here so it does not escalate to an uncaught exception.
    ws.onerror = () => {};
  }

  send(message) {
    if (this.#ws?.readyState !== WebSocket.OPEN) return Promise.resolve(null);
    return new Promise((resolve) => {
      this.#pending.push(resolve);
      this.#ws.send(message);
    });
  }

  /**
   * Sets the tiling direction of the focused window's container so the next
   * window splits the space along its longer side. This is the whole BSP trick.
   */
  async apply(reason) {
    const focused = (await this.send('query focused'))?.focused;
    if (focused?.type !== 'window') return;

    // Floating, minimized and fullscreen windows are not part of the tree.
    if (focused.state?.type !== 'tiling') return;

    const wanted = focused.width > focused.height ? 'horizontal' : 'vertical';
    const current = (await this.send('query tiling-direction'))?.tilingDirection;
    if (current === wanted) return;

    await this.send(`command set-tiling-direction ${wanted}`);
    log(
      `${reason}: "${focused.title?.slice(0, 40)}" ${focused.width}x${focused.height}` +
        ` — ${current} -> ${wanted}`,
    );
  }

  /**
   * Stops the taskbar from surfacing over a fullscreen game.
   *
   * Symptom: game running fullscreen, you switch workspace, come back, push the
   * mouse to the bottom edge and the auto-hidden taskbar slides up over it. The
   * manual workaround was killing and restarting explorer.exe.
   *
   * What was measured on a real desktop:
   *   - MarkFullscreenWindow (ITaskbarList2) from another process does NOT fix
   *     it, neither setting it nor clearing and setting it again.
   *   - SetForegroundWindow does not either, nor SetWindowPos with
   *     SWP_FRAMECHANGED over the same rectangle.
   *   - Moving the window 1px and putting it back DOES fix it.
   *   - Growing it by 1px and shrinking it back does NOT: the window never
   *     stops covering the monitor, so the shell sees no edge.
   *
   * So the shell tracks this on an edge, not a level: it learns a window is
   * fullscreen when it sees a position change that ends up covering the whole
   * monitor. The nudge manufactures that edge.
   *
   * See docs/FULLSCREEN-GAMES.md.
   */
  async fixTaskbar() {
    const candidate = await helper('fix-fullscreen', '--dry');
    if (!candidate?.found) return;

    // If GlazeWM has it tiled, the geometry belongs to the WM: moving it behind
    // its back looks like a user drag. That case does not show the bug anyway.
    const windows = (await this.send('query windows'))?.windows ?? [];
    const managed = windows.find((w) => String(w.handle) === String(candidate.hwnd));
    if (managed?.state?.type === 'tiling') return;

    await helper('nudge', String(candidate.hwnd));
    log(
      `taskbar: nudged ${candidate.process || '?'} (hwnd ${candidate.hwnd})` +
        `${managed ? ` state=${managed.state?.type}` : ' unmanaged'}`,
    );
  }

  /** Name of the focused workspace. */
  async focusedWorkspace() {
    const workspaces = (await this.send('query workspaces'))?.workspaces ?? [];
    const active = workspaces.find((w) => w.hasFocus) ?? workspaces.find((w) => w.isDisplayed);
    return { name: active?.name ?? null };
  }

  /** Windows of a process, so a launcher can tell which ones already existed. */
  async windowsOf(process) {
    const windows = (await this.send('query windows'))?.windows ?? [];
    return windows
      .filter((w) => !process || w.processName === process)
      .map((w) => ({ id: w.id, handle: w.handle, title: w.title }));
  }

  /**
   * Floats one window into a fraction of a workspace. Coordinates are given as
   * fractions (0..1) of the workspace, so the same call works on any monitor.
   *
   *   fit=stretch  the window fills its rectangle
   *   fit=center   the window keeps its own size and is centered in it
   *
   * Windows are addressed by their Win32 handle rather than by title on
   * purpose: Windows Terminal does not propagate the tab title to the window
   * title, so several terminals are all called "Terminal" and cannot be told
   * apart by name. Whatever launched them does know which one it just created.
   */
  async placeWindow({ handle, workspace, fx, fy, fWidth, fHeight, fit }) {
    const workspaces = (await this.send('query workspaces'))?.workspaces ?? [];
    const target = workspaces.find((w) => w.name === workspace);
    if (!target) return { ok: false, error: `no such workspace: ${workspace}` };

    const find = async () =>
      ((await this.send('query windows'))?.windows ?? []).find(
        (w) => String(w.handle) === String(handle),
      );

    let window = await find();
    if (!window) return { ok: false, error: `no window with handle ${handle}` };

    // The rectangle assigned to this window, in pixels.
    const rx = Math.round(target.x + fx * target.width) + PLACE_GAP;
    const ry = Math.round(target.y + fy * target.height) + PLACE_GAP;
    const rWidth = Math.round(fWidth * target.width) - PLACE_GAP * 2;
    const rHeight = Math.round(fHeight * target.height) - PLACE_GAP * 2;

    // `--centered=false` is mandatory: state_defaults.floating.centered is true
    // in the config, and that centering overrides --x-pos (the size was honored,
    // the position always ended up in the middle). The `=` is not optional
    // either: `--centered false` makes GlazeWM answer "unexpected argument
    // 'false' found" and run nothing at all.
    if (fit === 'center') {
      // Float it first, then query it again: size changes on the tiling ->
      // floating transition, and centering with the old numbers is off by the
      // difference.
      await this.send(
        `command --id ${window.id} set-floating --centered=false --shown-on-top=true`,
      );
      window = (await find()) ?? window;

      const x = rx + Math.round((rWidth - window.width) / 2);
      const y = ry + Math.round((rHeight - window.height) / 2);
      await this.send(`command --id ${window.id} position --x-pos ${x} --y-pos ${y}`);
      log(`place: handle ${handle} centered ${window.width}x${window.height} @${x},${y}`);
      return { ok: true, x, y, width: window.width, height: window.height };
    }

    // `--shown-on-top=true` because floating.shown_on_top is false in the
    // config: a placed window sharing a workspace with a fullscreen tiled one
    // ends up underneath it on the way back from another workspace, and looks
    // like it vanished.
    await this.send(
      `command --id ${window.id} set-floating --centered=false --shown-on-top=true` +
        ` --x-pos ${rx} --y-pos ${ry} --width ${rWidth} --height ${rHeight}`,
    );
    log(`place: handle ${handle} -> ${rWidth}x${rHeight} @${rx},${ry}`);
    return { ok: true, x: rx, y: ry, width: rWidth, height: rHeight };
  }

  /**
   * Hit test: which window occupies screen point (x, y). The mouse script uses
   * it to tell whether what is under the cursor is tiled — in which case the
   * drag has to go through the tree — or floating, where it can just be moved.
   */
  async windowAt(x, y) {
    const windows = (await this.send('query windows'))?.windows ?? [];
    const hit = windows.find(
      (w) =>
        w.displayState === 'shown' &&
        x >= w.x &&
        x < w.x + w.width &&
        y >= w.y &&
        y < w.y + w.height,
    );
    if (!hit) return { found: false };
    return {
      found: true,
      id: hit.id,
      tiling: hit.state?.type === 'tiling',
      x: hit.x,
      y: hit.y,
      width: hit.width,
      height: hit.height,
      handle: hit.handle,
    };
  }

  /**
   * When a window closes, its sibling absorbs the space and the container can
   * be left with a direction that no longer suits its shape — two windows
   * stacked vertically inside a wide, short gap, say. Walk the tree and turn
   * the mismatched containers, which is what komorebi does when it rebuilds the
   * BSP. No window changes place: only the container direction flips.
   *
   * One change per pass, re-querying in between: changing a container recomputes
   * the geometry of everything below it, so its children have to be judged on
   * the new numbers rather than the stale ones.
   */
  async rebalance() {
    for (let pass = 0; pass < MAX_PASSES; pass++) {
      const workspaces = (await this.send('query workspaces'))?.workspaces;
      if (!workspaces) return;

      let target = null;
      const visit = (node) => {
        if (target) return;
        const isContainer = node.type === 'workspace' || node.type === 'split';
        if (isContainer && (node.children?.length ?? 0) > 1) {
          const wanted = node.width > node.height ? 'horizontal' : 'vertical';
          if (node.tilingDirection !== wanted) {
            target = { id: node.id, type: node.type, wanted, current: node.tilingDirection };
            return;
          }
        }
        for (const child of node.children ?? []) visit(child);
      };
      workspaces.forEach(visit);

      if (!target) return;
      await this.send(`command --id ${target.id} set-tiling-direction ${target.wanted}`);
      log(`rebalance: ${target.type} ${target.current} -> ${target.wanted}`);
    }
  }
}

// Events arrive in bursts: opening a window fires window_managed and
// focus_changed almost together. They are coalesced into a single command, but
// the types seen are ACCUMULATED. Keeping only the last one meant focus_changed
// clobbered the window_managed it came with, and window openings were never
// processed at all.
let timer = null;
const pending = new Set();

const client = new GlazeClient((eventType) => {
  if (!EVENTS.includes(eventType)) return;
  pending.add(eventType);
  clearTimeout(timer);
  timer = setTimeout(async () => {
    const types = new Set(pending);
    pending.clear();

    // Closing a window leaves the tree out of shape; opening one only needs the
    // direction set before it arrives.
    if (types.has('window_unmanaged')) await client.rebalance();
    await client.apply([...types].join('+'));
    await watchWorkspaceChange();
  }, 50);
});

// The taskbar fix triggers on a workspace change. Listening to
// `workspace_activated` is not enough: GlazeWM emits it for the workspace
// lifecycle, not every time you jump to one that is already active. So the name
// is compared instead.
let previousWorkspace = null;
let fixingTaskbar = false;

async function watchWorkspaceChange() {
  const current = (await client.focusedWorkspace())?.name;
  if (!current || current === previousWorkspace) return;

  const firstRead = previousWorkspace === null;
  previousWorkspace = current;
  if (firstRead || fixingTaskbar) return;

  fixingTaskbar = true;
  setTimeout(async () => {
    try {
      await client.fixTaskbar();
    } finally {
      fixingTaskbar = false;
    }
  }, SETTLE_MS);
}

const bridge = await openBridge(client);
if (!bridge.port) {
  log(`${bridge.reason}, exiting`);
  process.exit(0);
}

// Clients read this to find the bridge, since it does not always land on the
// first port. They fall back to probing the candidates if the file is stale.
try {
  writeFileSync(PORT_FILE, String(bridge.port));
  process.on('exit', () => {
    try {
      rmSync(PORT_FILE, { force: true });
    } catch {
      // Best effort: a stale file is survivable, clients re-probe.
    }
  });
} catch {
  log(`could not write ${PORT_FILE}, clients will have to probe for the port`);
}

log('--- autotiling started ---');
log(`HTTP bridge listening on 127.0.0.1:${bridge.port}`);
if (existsSync(HELPER)) {
  log('wm-helpers found: fullscreen-game taskbar fix active');
} else {
  log(`missing ${HELPER}: taskbar fix disabled (build wm-helpers/)`);
}
client.connect();
