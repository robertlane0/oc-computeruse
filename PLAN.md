# oc-computeruse — plan

An OpenCode plugin that lets the agent **send keyboard and mouse input to a Wayland
desktop**. Scope: **KDE Plasma 6 on Wayland only** for now.

Vision is explicitly *not* part of this plugin. Screenshot capability lives in a
separate plugin — [`oc-takeascreenshot`](https://github.com/robertlane0/oc-takeascreenshot)
— which captures the screen and returns the image to the model. This plugin only
*injects input*, and exposes the screen **geometry** (not pixels) so the model knows
what coordinate space it is clicking in.

---

## 1. TL;DR

| | |
|---|---|
| **Runtime** | OpenCode ≥ 2.0.18 (`@opencode/plugin` v2 promise API), Bun |
| **Backend** | XDG **RemoteDesktop** portal → **EIS** socket → **libei** sender API |
| **Native deps** | None at the npm level. `libei.so.1` / `liboeffis.so.1` loaded at runtime via `bun:ffi`. Both are already present on any Plasma 6 Wayland system because **`kwin` links them**. |
| **Tool surface** | 10 tools in a `computer` namespace, native (`codemode: false`) |
| **Biggest risk** | The obvious approach — the portal's D-Bus `Notify*` methods — **does not work for absolute pointer motion**. Confirmed against a current KDE Plasma Wayland stack. See §4.2. |

---

## 2. Goals / non-goals

### Goals

1. Move the pointer to an absolute logical-pixel coordinate, and by a relative delta.
2. Press/release mouse buttons (left/right/middle/back/forward), including multi-click.
3. Scroll vertically/horizontally by a whole number of wheel notches.
4. Type arbitrary text.
5. Press named keys and modifier chords (`ctrl+c`, `super`), including held-key
   (down/up) and ordered sequences.
6. Report the desktop's coordinate geometry so the model can map screenshot pixels
   to injected coordinates.
7. Degrade gracefully with **model-readable, self-correcting** error strings.

### Non-goals

- Screenshot / pixel capture (→ `oc-takeascreenshot`).
- X11, GNOME, Hyprland, wlroots compositors (the backend is Plasma-specific in
  practice: `libei` + `liboeffis` are compositor-agnostic, but Plasma is the only
  target we will *test and support*; GNOME is listed as a plausible future port).
- Clipboard, screen-casting, multi-machine KVM.
- Touch / gestures / stylus (capability is bound if present, but no tools expose it).

---

## 3. Tool surface

All tools are registered into a `computer` namespace, so the model sees
`computer_click`, not `click` — no collision with the built-in `bash`, `edit`, etc.
Namespace flattening is `effectiveName()` in
`packages/core/src/tool/runtime.ts`; a namespace segment must match
`/^[A-Za-z0-9_-]{1,64}$/` (`packages/core/src/tool.ts:324`).

Every tool sets `options.codemode = false`. **This is mandatory, not stylistic:**
CodeMode is the default, and a tool without it is not sent to the provider as a
native tool at all — it only becomes a one-line entry in a CodeMode sandbox catalog
(`packages/core/src/tool.ts:234`). Input injection wants the shortest possible
round trip.

### 3.1 The tools

| Model-facing name | Purpose |
|---|---|
| `computer_screen` | Desktop geometry (bounding box + per-output regions + scale). The coordinate anchor. Also reports session state and capabilities. |
| `computer_move` | `{x,y}` absolute **or** `{dx,dy}` relative. |
| `computer_click` | `{button?, count?, x?, y?, modifiers?}` — click at a point. The workhorse. |
| `computer_mouse_down` / `computer_mouse_up` | Button press/release at a point. Composable into drags. |
| `computer_scroll` | `{direction, notches}` — wheel notches, direction-qualified. |
| `computer_type` | `{text}` — types a string. |
| `computer_key` | `{key, modifiers?}` — a named key or chord. |
| `computer_key_down` / `computer_key_up` | Held keys. |
| `computer_batch` | An ordered array of the above action objects in **one** tool call. |

That is 10 tools. Rationale for not collapsing them into one `action`-discriminated
tool: a union tool makes the model emit a correct `oneOf` on every call and forces a
large JSON Schema into the prompt; separate tools let each description be one crisp
sentence, and each `codemode: false` tool is a direct native call. This mirrors the
shipped `plugin-browser` package, which does exactly the same thing for browser
operations.

`computer_batch` is the one piece that is *not* strictly necessary, and it is the
highest-leverage one: without it, an agent performing "click, wait, type, press enter"
pays four model round trips; with it, one. It also guarantees ordering and lets
`wait` be expressed without shelling out.

### 3.2 Namespace description (the prompt text the model actually reads)

```
Computer control for a KDE Plasma Wayland desktop. Coordinates are LOGICAL desktop
pixels, origin top-left of the whole virtual desktop (all monitors, including any
to the left of or above the primary). Call computer_screen first to learn the exact
desktop size and the per-output regions. If a screenshot you are looking at has a
different pixel width than the desktop, scale coordinates by
desktop_width / screenshot_width before acting. Prefer computer_batch when you need
more than one action in a row. Text goes to the focused window — click the target
window first. A "Remote Control Requested" system dialog is shown once per OpenCode
session and must be approved before any input works.
```

That block carries three things models reliably get wrong: the origin, the
multi-monitor origin, and the screenshot-scale mismatch. It is the single highest-value
piece of prompt engineering in the whole plugin.

### 3.3 Coordinate-space bridge (the awkward part)

`oc-takeascreenshot` returns a `data:` URI, and OpenCode budgets tool images to
2000×2000 px / 5 MiB, so the model is usually looking at a **downscaled** image while
the desktop is e.g. 3840×2160. The model must scale, and gets it wrong.

Mitigations, in order of preference:

1. `computer_screen` returns the exact desktop size and each region's
   `scale` (`ei_region_get_physical_scale`), so the model has everything needed to
   compute the factor.
2. The namespace description states the formula explicitly.
3. Every coordinate-accepting tool **also** accepts `relative: {x, y}` in `0..1`
   (fraction of the desktop bounding box). Fractional reasoning is much more robust
   for a model than pixel arithmetic, and it is immune to image scaling entirely.
4. Coordinate inputs are validated against the real regions; an out-of-bounds point
   returns an error that **names the regions**, so the model can self-correct in one
   step rather than clicking into the void.

**Open question (§16).** Whether to instead make coordinate inputs accept a
`source: {width, height}` hint so the tool does the rescale server-side.

---

## 4. Backend: research and the key decision

### 4.1 What KDE Connect does

`plugins/mousepad/waylandremoteinput.cpp` in the KDE Connect source is the
reference implementation and the reason this is a solved problem at all:

```
CreateSession{handle_token, session_handle_token}
  → Response signal on /org/freedesktop/portal/desktop/request/<sender>/<token>
SelectDevices{types: 7 (kbd|pointer|touch), persist_mode: 2, restore_token?}
  → Response{session_handle}
Start{parent_window: ""}
  → Response{restore_token}
ConnectToEIS{}
  → returns a Unix fd          ← the EIS socket
ei_new_sender() + ei_setup_backend_fd(ei, fd)
QSocketNotifier on ei_get_fd() → ei_dispatch() → ei_get_event()
ei_seat_bind_capabilities(seat, POINTER, POINTER_ABSOLUTE, KEYBOARD, BUTTON, SCROLL, NULL)
on EI_EVENT_DEVICE_RESUMED:  ei_device_start_emulating(device, 0)
ei_device_frame(device, ei_now(ei))   ← after EVERY event
```

KDE Connect has a **fallback** that uses the portal's `Notify*` D-Bus methods when
libei is unavailable. That fallback is the interesting part, because it is what a
first instinct says to build — and it does not work.

### 4.2 Why the D-Bus `Notify*` path is rejected  ← the pivotal finding

`NotifyPointerMotionAbsolute` is guarded by `check_position()` in the
`xdg-desktop-portal` front-end:

```c
static gboolean
check_position (XdpSession *session, uint32_t stream, double x, double y)
{
  for (l = remote_desktop_session->streams; l; l = l->next)   /* `stream` param is shadowed */
    {
      ScreenCastStream *stream = l->data;
      screen_cast_stream_get_size (stream, &width, &height);
      if (x >= 0.0 && x < width && y >= 0.0 && y < height) return TRUE;
    }
  return FALSE;                                              /* no streams ⇒ always FALSE */
}
```

If the RemoteDesktop session has no `ScreenCast` streams the loop body never runs and
**every** absolute-motion call fails with `org.freedesktop.DBus.Error.Failed:
"Invalid position"`. The `stream` argument you pass is ignored entirely, and
coordinates are validated against *some* stream's size, not the one you named.
Introduced in `xdg-desktop-portal` 1.19.1; present in 1.19.1 and later.

This is not theoretical. `xdg-desktop-portal` **1.19.1** and later all carry it, so
every current KDE Plasma stack is affected, and it is straightforward to confirm
against any Plasma install by inspecting the shipped front-end binary:

```console
$ strings /usr/lib/xdg-desktop-portal | grep -i "invalid position"
Invalid position
$ strings /usr/lib/xdg-desktop-portal | grep -oE "Notify[A-Za-z]+|ConnectToEIS" | sort -u
ConnectToEIS
NotifyKeyboardKeycode
NotifyKeyboardKeysym
NotifyPointerAxis
NotifyPointerAxisDiscrete
NotifyPointerButton
NotifyPointerMotion
NotifyPointerMotionAbsolute
Session is not allowed to call
```

Absolute pointer motion is **the single most important primitive for an agent** — it
is how a click lands on a coordinate the model read off a screenshot. Working around
this by also calling `ScreenCast.SelectSources` would mean a second consent dialog,
an active PipeWire capture, and a much larger privacy surface, in exchange for
re-implementing a mechanism the portal itself calls "recommended" the other way.
Rejected.

### 4.3 The chosen path: liboeffis + libei over `bun:ffi`

```
plugin process (Bun)
  └─ liboeffis.so.1   oeffis_create_session(KEYBOARD|POINTER|TOUCHSCREEN)
                        ↳ D-Bus: CreateSession → SelectDevices → Start → ConnectToEIS
                        ↳ returns the EIS fd  (SCM_RIGHTS, received in C)
  └─ libei.so.1       ei_new_sender() → ei_setup_backend_fd(fd)
  └─ libei.so.1       ei_device_*  →  KWin's libeis  →  InputDevice  →  the desktop
```

Why `liboeffis` rather than hand-rolling the D-Bus handshake:

- It performs the **entire** portal dance — handle tokens, `Request::Response` signal
  subscription, error handling — in ~6 C calls. That is roughly 400 lines of D-Bus
  marshalling and several hundred more of portal protocol we would otherwise own.
- **It is the only practical way to get the EIS fd into this process.** Confirmed
  empirically by sending a Unix socket message with an attached fd
  (`sendmsg` + `SCM_RIGHTS`) to a client on the other end:

  ```console
  connected, has readWithFds: undefined
  data <Buffer 68 65 6c 6c 6f>     # payload arrives, the fd is silently dropped
  ```

  `node:net` (and therefore Bun's `net.Socket`) has no `SCM_RIGHTS` receive path, and
  `dbus-native` — the only maintained pure-JS D-Bus client — explicitly does not
  provide an FD transport (`lib/index.js`: `canSendFds = typeof stream.writeWithFds === 'function'`).
  So a from-scratch D-Bus client could do `Notify*` but **could not** do `ConnectToEIS`.
  liboeffis closes that gap in C.

- The FFI surface itself is verified to work: `dlopen("libei.so.1")` → `ei_new_sender`
  returns a non-null pointer, `ei_is_sender` → 1, `ei_get_fd` returns a real
  descriptor; `dlopen("liboeffis.so.1")` → `oeffis_new` returns a valid context;
  `poll(2)` via `dlopen("libc.so.6")` returns correct `POLLIN` on a readable fd and
  `0` on timeout. No compositor interaction is needed for any of these.

**Availability.** `libei` is a hard dependency of `kwin` (and of `xorg-xwayland`) in
every mainstream Plasma 6 packaging we are aware of, so it — along with
`liboeffis.so.1` and the `libei-1.0` headers — is already present on a Plasma 6
Wayland system. Other distributions must be feature-detected at runtime, with a
per-distro install hint in the error (§10).

**The trade-off we accept.** `liboeffis` has no `persist_mode`/`restore_token`
parameters — the header says "intentionally kept simple". So the KDE consent dialog
appears **once per OpenCode process** rather than once ever. Given that we keep one
long-lived session for the whole OpenCode lifetime, that is N tool calls → 1 dialog,
which is acceptable. It is also *more* private than the alternative: we never write
a long-lived restore token to disk. The alternative (hand-rolled D-Bus to get
`persist_mode: 2`) buys silence at the cost of a token we would be storing — and
would not have worked anyway without FD support for EIS.

**We do not self-grant permission.** KDE's `isAppMegaAuthorized()` consults
`PermissionStore["kde-authorized"]["remote-desktop"]`, which would skip the dialog
entirely. It is technically writable over the bus. We will not do this, ever: it is
bypassing a security prompt. One dialog per session is the correct price.

### 4.4 Rejected alternatives

| Approach | Why not |
|---|---|
| Portal `Notify*` over D-Bus | Absolute motion blocked by `check_position` (§4.2). Also one-way: no delivery feedback. |
| `xdotool` / X11 | XWayland only; cannot reach native Wayland clients; no absolute pointer. |
| `ydotool` (uinput) | Needs root + `/dev/uinput`; bypasses the portal consent model entirely. |
| `wtype` (`zwp_virtual_keyboard_v1`) | Text only, no pointer. KWin support unverified. |
| KWin scripting (`loadScript`) | Only the *first* `loadScript` per KWin session ever runs; `callDBus` from script bodies does not reach the bus. Already burned by the sibling plugin. |
| `org.kde_kwin_fake_input` directly | A Wayland wire protocol, not D-Bus. Requires a hand-rolled `wl_display` client, its own `authenticate()` which is a documented no-op (`// TODO: make secure`), and it bypasses the portal consent dialog. |
| `org.kde.KWin.EIS.RemoteDesktop.connectToEIS` on D-Bus | Skips the portal dialog entirely (a raw injection channel) and still needs FD reception. |
| `wdotool` / Rust `reis` subprocess | Process-per-call latency, an extra runtime dependency, and its README flags the KDE backend as unverified on real Plasma. |
| KWin `outputLayout` D-Bus property for geometry | **Does not exist.** KWin exposes exactly one property on `org.kde.KWin` — `showingDesktop` — and there is no `/ScreenManager` or `/org/kde/KWin/OutputManager` object. We get geometry from EIS regions instead (§7.4) — better anyway, since it is the exact space EIS accepts. |
| `xdp-remote-control` (the old KWin script) | Does not exist. Zero references in the KDE Connect tree, no invent.kde.org project, no distro package. |

---

## 5. Repository layout

```
oc-computeruse/
├── index.ts                    # re-export default plugin (Host.resolve falls back to <dir>/index)
├── package.json
├── tsconfig.json
├── README.md
├── AGENTS.md                   # host constraints w/ source citations, risks, test matrix
├── LICENSE                     # MIT, matching oc-takeascreenshot
├── src/
│   ├── index.ts                # Plugin.define: setup, tool registration, teardown
│   ├── options.ts              # ctx.options parsing (hand-rolled, no zod)
│   ├── errors.ts               # ComputerUseError → model-readable string
│   ├── guard.ts                # execute() wrapper: never let a throw become a defect
│   ├── ffi/
│   │   ├── libei.ts            # bun:ffi signatures for libei.so.1
│   │   ├── liboeffis.ts        # bun:ffi signatures for liboeffis.so.1
│   │   ├── poll.ts             # dlopen("libc.so.6") poll(2)
│   │   └── probe.ts            # feature detection + install hints
│   ├── session.ts              # EiSession: the backend singleton + state machine
│   ├── keymap.ts               # XKB text-keymap parser (keysym → evdev code)
│   ├── keys.ts                 # named key → evdev code; unicode → keysym
│   └── tools/
│       ├── common.ts           # namespace, toolOptions(), guard, action validation
│       ├── screen.ts
│       ├── move.ts             # move / click / down / up
│       ├── scroll.ts
│       ├── type.ts             # type / key / key_down / key_up
│       └── batch.ts
└── test/                       # bun test
```

`package.json` mirrors `oc-takeascreenshot`: `main`/`exports` → `./index.ts`, no build
step, `"@opencode/plugin": ">=2.0.0"` as a **type-only** peer dependency, devDeps
`@opencode/plugin` 2.0.18 + `typescript` + `@types/bun` + `@types/node`. **Zero runtime
npm dependencies**, so a bare `git clone` runs.

---

## 6. Plugin shape

```ts
// index.ts
export { default, ID, ComputerUsePlugin } from "./src/index.ts"
```

```ts
// src/index.ts
import type { Plugin } from "@opencode/plugin"

export const ID = "computeruse"

export const ComputerUsePlugin = {
  id: ID,
  setup(ctx: Plugin.Context) {
    const options = parseOptions(ctx.options)
    const session = new EiSession(options)
    return ctx.tool
      .transform((editor) => {
        editor.namespace({ name: NAMESPACE, description: NAMESPACE_DESCRIPTION })
        for (const tool of tools) editor.add(tool(session, options))
      })
      .then(() => () => session.close())
  },
} satisfies Plugin.Plugin

export default ComputerUsePlugin
```

The plugin API is confirmed: `Plugin.define({ id, setup })`
(`packages/plugin/src/promise/plugin.ts`), `ctx.tool.transform((editor) => …)` where
the editor is **synchronous** (`packages/plugin/src/promise/tool.ts`), and `setup`
returning a cleanup function which OpenCode awaits on unload
(`packages/plugin/src/promise/adapter.ts`: `Effect.acquireRelease(... cleanup)`).

### 6.1 Error handling: never throw out of `execute`

**A thrown error from a promise-plugin tool is a *defect*, not a recoverable
tool error.** The adapter wraps executors in
`Effect.promise((signal) => tool.execute(...))`
(`packages/plugin/src/promise/adapter.ts`), and `Effect.promise` turns a rejection
into a die. `Effect.mapError` in `packages/core/src/tool/runtime.ts:36-44` only maps
the typed error channel, so a rejected promise bypasses the
`catchTag("Tool.Error")` handling downstream and fails the whole model step instead
of returning an error the model can read and self-correct from.

Therefore **every** `execute` is wrapped in `guard()`, which converts any throw into a
`content` string. This matches the sibling plugin's discipline and is not optional.

```ts
export function guard<A extends unknown[]>(
  name: string,
  fn: (...args: A) => Promise<Tool.Result>,
): (...args: A) => Promise<Tool.Result> {
  return async (...args) => {
    try {
      return await fn(...args)
    } catch (error) {
      return { content: describe(name, error) }   // never rethrow
    }
  }
}
```

Two consequences for tool design:

- `execute` returns `{ content: string }` and **no `output` schema**. Declaring
  `output` makes the runtime demand `result.output` and encode it; these tools return
  prose, not structured data (`packages/core/src/tool/runtime.ts:45-59`).
- Inputs are plain **JSON Schema** objects (the `Tool.ValueSchema` union accepts
  `JsonSchema.JsonSchema`, and the value is passed to the model verbatim). Input
  validation failures from the runtime are model-repairable by design
  (`formatInputIssues` ends with "Update the arguments and call the tool again."), so
  the JSON Schema does the cheap structural checks and `guard` does the semantic
  ones with a better message.

---

## 7. Backend design

### 7.1 State machine

`EiSession` is a lazily-created singleton, one per plugin load, torn down by the
cleanup returned from `setup`. States:

```
absent ──ensure()──▶ probing ──libs ok──▶ authorizing ──CONNECTED_TO_EIS──▶ binding
                                                                              │
                                          SEAT_ADDED → bind caps ◀────────────┘
                                                     │
                                    DEVICE_ADDED + DEVICE_RESUMED (both needed)
                                                     │
                                                     ▼
                                                  ready
```

- `probing` — `dlopen` the three libraries. Missing library ⇒ throw a
  `MissingLibrary` error with a per-distro install hint, **do not** retry silently.
- `authorizing` — `oeffis_new` + `oeffis_create_session(devices)`. This is where the
  KDE dialog appears. Pump `oeffis_get_fd()` with `poll()` in a loop until
  `OEFFIS_EVENT_CONNECTED_TO_EIS` (`1`) / `OEFFIS_EVENT_CLOSED` (`2`) /
  `OEFFIS_EVENT_DISCONNECTED` (`3`), or the `authorizeTimeout` elapses
  (default 30 s — the user has to click a dialog).
  - `oeffis_get_error_message()` carries the failure text for `DISCONNECTED`.
  - `CLOSED` means the user ended the session from the tray. Not an error the model
    can fix; report it and reset to `absent`.
- `binding` — `ei_new_sender(NULL)`, then `ei_setup_backend_fd(ei, oeffis_get_eis_fd())`.
  **The `oeffis` context must be kept alive for the lifetime of the `ei` context** —
  this is called out twice in `liboeffis.h`: destroying it closes the D-Bus connection
  and invalidates the EIS fd.
  Then pump `ei_get_fd()`:
  - `EI_EVENT_SEAT_ADDED (3)` → `ei_seat_bind_capabilities(seat, …, NULL)`.
  - `EI_EVENT_DEVICE_ADDED (4)` → classify by `ei_device_has_capability()`; if it is
    the keyboard device, pull the keymap (below).
  - `EI_EVENT_DEVICE_RESUMED (6)` → `ei_device_start_emulating(device, seq++)`.
    **Sending before this is a client bug.** Note KDE Connect passes sequence `0`
    every time; we use a monotonic counter as the API documents ("must go up by at
    least 1 on each call").
  - `EI_EVENT_DEVICE_PAUSED (5)` / `DEVICE_REMOVED (4→removed)` → drop from the map.
  - `EI_EVENT_DISCONNECT (2)` → mark dead, reset to `absent`.
- `ready` — every injector asserts the required device is present **and** resumed
  **and** emulating before doing anything. This is stricter than KDE Connect, which
  branches on `if (m_ei && m_device)` and therefore silently routes to a dead
  transport when a device has not arrived yet.

### 7.2 Pumping the fds

There is no event loop in a tool call. We pump synchronously:

```ts
// libc.so.6 via bun:ffi; struct pollfd { int fd; short events; short revents; }
function pump(fd: number, timeoutMs: number): boolean {
  const pfd = Buffer.alloc(8)
  pfd.writeInt32LE(fd, 0); pfd.writeInt16LE(POLLIN, 4); pfd.writeInt16LE(0, 6)
  return libc.poll(pfd, 1, timeoutMs) > 0
}
```

Confirmed working under Bun: `poll` on a readable descriptor returns `1` with
`POLLIN`, on a non-readable one `0`, on a closed one `POLLHUP`. After `poll` reports
readable:
`ei_dispatch(ei)` then drain `while ((e = ei_get_event(ei))) { … ; ei_event_unref(e) }`.
`poll` also returns `>0` on `POLLHUP`/`POLLERR`, which is how a dead EIS connection
is detected — a readable fd is not guaranteed to be a live fd, and re-checked fds
must be re-polled rather than cached.

### 7.3 Capabilities

Always bind: `POINTER (1<<0)`, `POINTER_ABSOLUTE (1<<1)`, `KEYBOARD (1<<2)`,
`BUTTON (1<<5)`, `SCROLL (1<<4)`.

Bind `TEXT (1<<6)` **only if** `ei_seat_has_capability(seat, EI_DEVICE_CAP_TEXT)` —
that capability is `@since 1.6` and binding a capability the compositor does not
have is at best a no-op and at worst a client bug.

Devices may arrive with a *subset* of the bound capabilities ("Keyboard events sent
through that device will be treated as client bug"), so we hold a map
`{ pointer?, absolute?, keyboard?, text?, touch? }` keyed by capability, each with an
`emulating: boolean`.

### 7.4 Coordinate model

- `ei_device_pointer_motion_absolute(dev, x, y)` takes **desktop-wide logical pixels**,
  origin top-left of the virtual desktop, `+y` down. The same space as
  `ei_region_get_x/y/width/height`. These are logical px, matching what KWin and
  Qt report, so no DPI conversion is needed anywhere.
- "The x/y coordinate must be within the device's regions or the event is **silently
  discarded**." So we must validate first:
  ```ts
  // ei_device_get_region() returns NULL once the index exceeds the region's count,
  // and "the number of regions is constant for the lifetime of the device", so
  // iterating to NULL is both correct and cheap.
  for (const dev of absoluteDevices)
    for (let i = 0; ; i++) {
      const r = ei_device_get_region(dev, i)
      if (r == null) break
      if (ei_region_contains(r, x, y)) return inject(dev, x, y)
    }
  throw new OutOfBounds(x, y, regions)   // names the regions, so the model can fix it
  ```
  `ei_device_get_region_at(dev, x, y)` does this in one call for the single-device
  case; we use the loop because a dual-head setup can present two absolute devices
  with one region each.
- Relative motion: `ei_device_pointer_motion(dev, dx, dy)`, logical px, no validation.
- **Geometry comes from the regions**, not from KWin D-Bus (which has no such API,
  §4.4) and not from `kscreen-doctor` (a subprocess for something we already have).
  `computer_screen` returns:
  ```jsonc
  {
    "session": { "state": "ready", "authorized": true },
    "capabilities": { "absolutePointer": true, "text": false },
    "desktop": { "width": 3840, "height": 2160, "x": 0, "y": 0 },
    "regions": [
      { "x": 0,    "y": 0, "width": 2560, "widthLogical": 2560, "height": 1440, "scale": 1 },
      { "x": 2560, "y": 0, "width": 1920, "height": 1080, "scale": 1 }
    ],
    "pointer": { "known": false, "note": "EIS cannot report the current pointer position." }
  }
  ```
  `pointer.known` is honestly `false` — EIS is send-only, there is no
  `ei_device_get_position()`. The model should not assume where the pointer is
  between actions; every `click` therefore takes an explicit `x`/`y`.

### 7.5 Buttons

evdev codes from `linux/input-event-codes.h`, matching both the portal spec and KDE
Connect's use of `<linux/input.h>`:

| button | code |
|---|---|
| left | `BTN_LEFT` 0x110 (272) |
| right | `BTN_RIGHT` 0x111 (273) |
| middle | `BTN_MIDDLE` 0x112 (274) |
| back | `BTN_SIDE` 0x113 (275) |
| forward | `BTN_EXTRA` 0x114 (276) |

`count: 2` sends press/release twice (real double-click, not a synthetic
multi-click event — some toolkits distinguish). `count: 3` is a triple click.

### 7.6 Scroll

`ei_device_scroll_discrete(dev, x, y)` is the right primitive: "The value for one
scroll unit is 120, a fraction or multiple thereof represents a fraction or multiple
of a wheel click." We send whole notches.

**Sign convention.** libei follows `wl_pointer`: **positive `dy` = scroll up** (content
moves up). The tool-facing API is the opposite of that, because "scroll down 3" is
what a model means when it says scroll down. So:

```
{ direction: "down", notches: 3 }   →   ei_device_scroll_discrete(dev, 0, -360)
{ direction: "up",   notches: 3 }   →   ei_device_scroll_discrete(dev, 0, +360)
```

The D-Bus `NotifyPointerAxis` path has a *different* sign convention again
(`xdg-desktop-portal-kde`'s `waylandintegration.cpp` negates `y`), which is precisely
the kind of thing that makes hand-rolled implementations silently scroll the wrong
way. One code path, one convention, unit-tested.

A bare `computer_scroll` does **not** send `ei_device_scroll_stop` — that is for
touchpad-style gesture ends, and sending it for a discrete wheel click is a client
bug per the libei docs.

### 7.7 Keyboard

Three distinct mechanisms, chosen by capability:

**(a) Named keys → `ei_device_keyboard_key(kbd, evdevCode, isPress)`.**
A static table of ~90 names → evdev codes: `enter return`, `tab`, `escape esc`,
`backspace`, `delete`, `space`, `home`, `end`, `pageup pagedown`, `up down left right`,
`f1`–`f24`, `shift`, `ctrl control`, `alt meta option`, `super meta win cmd`,
`printscreen`, `scrolllock`, `pause`, `menu compose`, `insert`, `capslock`, plus
keypad. evdev codes are layout-independent, so this path is always exact.
Modifiers use `KEY_LEFTSHIFT` / `KEY_LEFTCTRL` / `KEY_LEFTALT` / `KEY_LEFTMETA`.

**(b) Text → `ei_device_text_utf8(dev, utf8)` when `EI_DEVICE_CAP_TEXT` is available.**
This is the one that matters. It is "independent of any keymap and the keysym may not
exist on any active keymap on any device", so it types anything — accents, CJK, emoji
— with no layout games. `@since 1.6`; feature-detected.

**(c) Text fallback → per-character keysym, resolved through the EIS keymap.**
For compositors that do not advertise `TEXT`, we replicate KDE Connect's approach
without xkbcommon:

- `ei_device_keyboard_get_keymap(kbd)` → `ei_keymap_get_fd/size/type`. It is
  `EI_KEYMAP_TYPE_XKB`, delivered as a **mmap-able fd in `XKB_KEYMAP_FORMAT_TEXT_V1`**.
- Write a **minimal XKB text keymap parser** (~200 lines) that extracts, for the
  effective layout group, the symbol list per level for each `key <name>` entry.
- `keycodeFromKeysym(sym)` scans keycodes × levels for the sym, returns `code - 8`
  (XKB keycodes are evdev + 8). If a hit is on level > 0, press the shift modifier for
  that level (`xkb_keymap_key_get_mods_for_level` equivalent) around the key.
- Unicode → keysym is trivial and dependency-free:
  ```ts
  const keysym = cp >= 0x100 && cp <= 0x10ffff ? cp + 0x01000000 : cp
  ```
- Characters with no symbol in the active layout are reported in the result:
  `"typed 41/43 characters; 2 not in the current layout: é ø"`. **Never silently
  dropped** — that is the single most confusing failure mode for an agent, and it is
  what KDE Connect does (`qCWarning("Cannot send character")`).

`(b)` is preferred and `(c)` is the fallback. Both are unit-testable without a
compositor by feeding the parser a checked-in `.xkb` string.

### 7.8 Modifier handling

`modifiers: ["ctrl", "shift"]` expands to: press left modifiers in a fixed order
(`ctrl`, `alt`, `shift`, `super` — so the resulting chord is always well-formed),
then the key, then release in reverse. `computer_key_down` / `computer_key_up` cover
chords the model cannot express as a single call (e.g. `ctrl` down → click → `ctrl`
up).

---

## 8. Tool specifications

All input schemas are plain JSON Schema. All descriptions are written for the model,
not for a human.

### `computer_screen`
```jsonc
{ "type": "object", "properties": {}, "additionalProperties": false }
```
Returns the payload of §7.4 as pretty JSON. Cheap, safe, and the first call of any
session.

### `computer_move`
```jsonc
{
  "type": "object",
  "properties": {
    "x": { "type": "number" }, "y": { "type": "number" },
    "dx": { "type": "number" }, "dy": { "type": "number" },
    "relative": { "type": "object", "properties": { "x": {"type":"number","minimum":0,"maximum":1},
                                                    "y": {"type":"number","minimum":0,"maximum":1} } }
  },
  "additionalProperties": false
}
```
Semantics: give `(x, y)` **or** `(dx, dy)` **or** `relative`. Exactly one; anything else
is a validation error naming the three options. `x`/`y` are desktop logical pixels;
`relative` is a fraction of the desktop bounding box.

### `computer_click`
```jsonc
{
  "type": "object",
  "properties": {
    "button": { "type": "string", "enum": ["left","right","middle","back","forward"] },
    "count":  { "type": "integer", "minimum": 1, "maximum": 3 },
    "x": { "type": "number" }, "y": { "type": "number" },
    "relative": { … },
    "modifiers": { "type": "array", "items": { "type": "string",
                    "enum": ["ctrl","alt","shift","super"] } }
  },
  "additionalProperties": false
}
```
Expansion: `move` (if coordinates given) → modifier down → `count` × (press, release)
→ modifier up. This is the tool the model will call 90% of the time, so it is the one
that has to be forgiving.

### `computer_mouse_down` / `computer_mouse_up`
Same shape as `computer_click` minus `count`.

### `computer_scroll`
```jsonc
{ "type": "object", "required": ["direction"],
  "properties": { "direction": { "type": "string", "enum": ["up","down","left","right"] },
                  "notches":   { "type": "number", "minimum": 1 } },
  "additionalProperties": false }
```

### `computer_type`
```jsonc
{ "type": "object", "required": ["text"],
  "properties": { "text": { "type": "string" } }, "additionalProperties": false }
```
Newlines become Enter. The result reports the number of characters actually typed and
any that the active layout could not produce.

### `computer_key`
```jsonc
{ "type": "object", "required": ["key"],
  "properties": { "key": { "type": "string" },
                  "modifiers": { "type": "array", "items": { "type": "string",
                                     "enum": ["ctrl","alt","shift","super"] } } },
  "additionalProperties": false }
```
`key` accepts both canonical names (`"enter"`) and familiar aliases (`"return"`,
`"esc"`, `"cmd"`, `"ctrl+c"` as a single string). An unknown key returns the list of
supported names rather than failing silently.

### `computer_key_down` / `computer_key_up`
Same as `computer_key` minus `modifiers` — these *are* the modifier hold.

### `computer_batch`
```jsonc
{ "type": "object", "required": ["actions"],
  "properties": { "actions": { "type": "array", "minItems": 1, "maxItems": 200,
                               "items": { "$ref": "#/$defs/action" } } },
  "$defs": { "action": { "oneOf": [ …one schema per action type…,
                                    { "type": "object", "required": ["wait"],
                                      "properties": { "wait": { "type": "integer",
                                                                "minimum": 0, "maximum": 10000 } } } ] } },
  "additionalProperties": false }
```
Actions execute **in order**, in one D-Bus-free in-process run, stopping at the first
failure and reporting the index of the action that failed plus the actions already
completed. A `wait` action is capped at 10 s and the whole batch at 30 s.

---

## 9. Safety and permissions

### 9.1 What the permission system can and cannot do here

In OpenCode 2, `options.permission` on a tool is used **only for whole-tool catalog
filtering** — `whollyDisabled()` in `packages/core/src/tool.ts:292` hides a tool whose
name has a `deny /* * */` rule. It is not an execution-time authorization. A plugin
leaf cannot call `Permission.assert`, because `Permission.Service` is a Core-internal
service not exposed on the plugin `Context`; `ctx.permission` is `list`/`get`/`reply`
only, and `ctx.ask` is gone in v2.

Consequence, and it must be stated loudly in the README: **enabling this plugin hands
the model keyboard and mouse control of the desktop.** The default agent policy is
`{"action":"*","resource":"*","effect":"allow"}`, so the tools are available unless the
user writes a rule.

What we do about it:

1. Every tool declares `permission: "computer_<name>"`, so users can revoke
   individually or with the `computer_*` wildcard:
   ```jsonc
   { "permissions": [
     { "action": "computer_type",    "resource": "*", "effect": "deny" },
     { "action": "computer_key*",    "resource": "*", "effect": "deny" },
     { "action": "computer_*",       "resource": "*", "effect": "deny" }
   ] }
   ```
2. A **safe-by-default recommendation** in the README: ship the deny-by-default block
   above and tell users to remove the specific lines they want. (The plugin itself
   cannot write permission rules.)
3. The consent dialog is per-session and always shown, so a user who has granted
   nothing sees a system dialog and can decline.
4. A plugin option `devices` (default `keyboard|pointer|touch`) lets a user narrow the
   request to pointer-only, which also narrows the consent dialog.

### 9.2 Blast radius notes for the README

- Keystrokes reach whatever window has focus. There is no way to target a window by
  name through the portal.
- A click focuses: injected key events issued before a click land on the previously
  focused window. The tool descriptions say so.
- KDE shows a "Remote Control" tray item for the whole session; that is the user's
  revoke handle.
- No screenshot is taken by this plugin. Combined with `oc-takeascreenshot`, the user
  is granting two distinct capabilities and should be told which is which.

---

## 10. Error taxonomy

Every failure is a `ComputerUseError` with a `code` and a message written for a model
to act on. `describe()` renders `code` + message + remedy. Nothing is swallowed.

| code | when | message shape |
|---|---|---|
| `UNSUPPORTED_SESSION` | `XDG_SESSION_TYPE != wayland` | "Computer control needs a Wayland session; this is X11. Log out and choose the Plasma (Wayland) session." |
| `UNSUPPORTED_DESKTOP` | `XDG_CURRENT_DESKTOP` not Plasma | names the detected DE and what is supported |
| `MISSING_LIBRARY` | `dlopen` fails | distros: Arch `sudo pacman -S libei`, Fedora `sudo dnf install libei`, Debian/Ubuntu `sudo apt install libei1` + `liboeffis1`. Explains that kwin already depends on it. |
| `NO_BUS` | no `$DBUS_SESSION_BUS_ADDRESS` / `$XDG_RUNTIME_DIR/bus` | — |
| `NOT_AUTHORIZED` | user denied the dialog | "The 'Remote Control Requested' dialog was declined. Nothing was sent. Ask the user to approve it and retry." |
| `AUTH_TIMEOUT` | no response in `authorizeTimeout` | "No answer to the 'Remote Control Requested' dialog after Ns. Ask the user to look for it." |
| `AUTH_CANCELLED` | `OEFFIS_EVENT_CLOSED` | "The remote-control session was ended from the system tray. It cannot be re-opened in this turn; tell the user to restart OpenCode." |
| `SESSION_LOST` | `EI_EVENT_DISCONNECT` | auto-reset to `absent`; next tool call re-authorizes |
| `NO_ABSOLUTE_POINTER` | compositor gave no absolute device | "This compositor only exposed a relative pointer; absolute positioning is unavailable." |
| `OUT_OF_BOUNDS` | point outside every region | "Point (x, y) is outside the desktop. Desktop is W×H at (0,0); regions: [...]." — **the model can fix this in one step** |
| `NO_KEYBOARD` | no keyboard device | — |
| `UNSUPPORTED_KEY` | name not in the table | lists the supported names |
| `LAYOUT_GAP` | characters not in the active layout | lists them (from §7.7c) |
| `CAPABILITY` | a requested capability is absent | e.g. "The compositor does not advertise EI_DEVICE_CAP_TEXT; arbitrary Unicode cannot be typed." |
| `NOT_PLASMA` | missing `org_kde.KWin` | ties the failure to a real cause |

---

## 11. Options

From `ctx.options` (the object form in `opencode.json`), hand-parsed with a clamp and
a fallback per field — no zod, matching the sibling plugin:

```jsonc
{
  "package": "oc-computeruse",
  "options": {
    "devices": "keyboard|pointer|touch",   // default; narrows the consent request
    "authorizeTimeoutMs": 30000,           // clamp 1000..120000
    "defaultClickDelayMs": 40,             // between click press/release; clamp 0..500
    "defaultTypeDelayMs": 8,               // between characters; clamp 0..500
    "requestButton": "left",               // default button
    "maxBatchActions": 200,
    "trace": false                         // log every injection to stderr
  }
}
```

Delays exist because some applications drop synthetic events that arrive faster than
their own event loop. Defaults are conservative but not sluggish; both are settable to
0 for trusted local use.

---

## 12. Delivery plan

Each phase is independently shippable and independently testable.

### P0 — skeleton (no backend)
- `package.json`, `tsconfig.json`, `index.ts`, plugin registration, namespace,
  all 10 tools returning a clear "not implemented" string.
- `guard()`, `errors.ts`, `options.ts`, `keys.ts` tables, `common.ts`.
- **Accept:** plugin loads under `opencode`; `computer_screen` lists its tools; a
  `bun test` run covers options parsing, key tables, and schema validation.

### P1 — the EIS backend
- `ffi/` (libei, liboeffis, poll, probe), `session.ts` state machine, the
  connect/authorize/bind pump.
- **Accept:** on a Plasma 6 Wayland box, `computer_screen` after a manual consent click
  returns the correct desktop geometry. A live test moves the pointer to a corner and
  back.

### P2 — pointer
- `move`, `click`, `mouse_down/up`, `scroll`; region validation and the
  `OUT_OF_BOUNDS` remedy; `ei_device_frame` after every event.
- **Accept:** live test clicks a known-position test widget at each of the four
  corners, double-clicks, drags with down/move/up, scrolls a scrollable view in all
  four directions with the sign verified by eye.

### P3 — keyboard
- Named keys + chords + `key_down`/`key_up` (evdev, exact).
- **Accept:** live test types into a text field, presses `ctrl+s`, `super`,
  `f5`, arrow keys, and a modifier-held sequence.

### P4 — text
- `ei_device_text_utf8` path with `EI_DEVICE_CAP_TEXT` detection, then the XKB
  keymap parser + keysym fallback.
- **Accept:** with `TEXT`, types `"héllo 🌍 Ωmega"` verbatim. Without, types the
  ASCII subset and *reports* the 3 characters it could not produce. The parser is
  unit-tested against checked-in keymaps for `us`, `de`, `gb`, and a Dvorak layout.

### P5 — `computer_batch`, docs, packaging
- The batch tool, README, AGENTS.md, live test harness.
- **Accept:** a scripted "open a menu, click an item, type, press enter" flow
  completes in a single `computer_batch` call with no intermediate round trips.

---

## 13. Test plan

| Layer | How |
|---|---|
| Pure unit | `bun test` — options parsing, key tables, unicode↔keysym, XKB parser, scroll sign mapping, coordinate/region validation, every error's rendered message, JSON Schema shapes. No FFI, no compositor. |
| FFI smoke | `dlopen` all three libs, create and destroy an `ei` and an `oeffis` context, assert `ei_is_sender == 1`, and assert `poll()` behaviour. No compositor interaction, so it is safe anywhere `libei` is installed. |
| Live | `test/live.ts`, gated behind `OC_COMPUTERUSE_LIVE=1`. Requires a human to click the consent dialog. Steps are named and printed one at a time so the operator can abort. **Default-off and never run in CI.** |
| Regression | The `check_position` finding is written up in AGENTS.md under "rejected approaches — do not revisit without re-testing", including the `strings` check that confirms it, so nobody re-derives the `Notify*` path in six months. |

---

## 14. Documentation

### `README.md`
- What it does, and explicitly what it does **not** do.
- **Screenshot capability is provided by
  [`oc-takeascreenshot`](https://github.com/robertlane0/oc-takeascreenshot)** — a
  separate OpenCode plugin that captures the screen and hands the image to the model.
  This plugin injects input only. The intended pairing is:
  1. `screenshot_capture_display` (or `_window`) from `oc-takeascreenshot`
  2. `computer_screen` to learn the desktop geometry
  3. `computer_*` to act on the coordinates you read off the image
  Note that `oc-takeascreenshot` scales images down to fit the model's input budget,
  so coordinates read from a screenshot must be scaled to the desktop size — which
  is why `computer_screen` exists and why the tool descriptions say so.
- Install: point `opencode.json` at the directory, no build step, no npm install
  needed.
- **Permissions and risk** (§9.1 verbatim-ish, with copy-paste rules).
- Coordinate system, multi-monitor, and the screenshot-scale bridge.
- Troubleshooting keyed to the §10 error table.
- The "Remote Control" tray item and how to revoke.

### `AGENTS.md`
- OpenCode host constraints with `file:line` citations, the same discipline the
  sibling uses: `codemode: false` is mandatory; a throwing promise tool is a *defect*
  that fails the model step, so `guard()` is mandatory; `Host.resolve` falls back to
  `<dir>/index`; duplicate plugin `id` drops the whole generation.
- The backend decision record, including the `check_position` finding with a
  reproduction someone can re-run on any Plasma install.
- Phase plan, test matrix, risks table, rejected-approaches list.

---

## 15. Risks

| Risk | Likelihood | Mitigation |
|---|---|---|
| KWin's EIS impl does not advertise `EI_DEVICE_CAP_TEXT` | Medium | Feature-detected; XKB fallback; error explains the limit. Test early in P4. |
| Compositor grants a device without `POINTER_ABSOLUTE` | Low | Clear `NO_ABSOLUTE_POINTER` error; relative motion still offered. |
| The portal front-end diverges from upstream and `liboeffis` breaks | Low | Feature-probe `liboeffis.so.1` and its symbols at load; the `MISSING_LIBRARY` path is already written. |
| `libei` not installed on some distributions | Medium | Runtime probe + per-distro install hint in the error. Report it; do not silently degrade. |
| Too many tools bloats the prompt | Low | Descriptions are one to three sentences; `computer_batch` collapses multi-step work. |
| Injected keys land in the wrong window | High, inherent | Documented; `click` moves before clicking so the common case is right. |
| A drag needs intermediate motion frames to register in some apps | Medium | `mouse_down` / `move` / `mouse_up` are exposed separately, and `computer_batch` can interleave many `move` steps in one call. |
| Bun `dlopen` unavailable in a future runtime | Low | Detected at `setup`; tools return an explanatory string instead of crashing the plugin. |

---

## 16. Open questions

1. **Should coordinate inputs accept a source-image size hint** (`{x, y, source:
   {width, height}}`) so the plugin does the rescale instead of the model? Pro:
   removes the single most common agent arithmetic error. Con: couples this plugin to
   an output shape it does not own. **Recommendation:** ship the explicit scaling
   instruction + `relative` first; add the hint only if it proves necessary.
2. **Does `ei_configure_name()` reach KDE's consent dialog?** The dialog names the app
   from the D-Bus peer, and `liboeffis` does not expose a way to set that, so the
   dialog will likely say "OpenCode". That is honest and acceptable, but worth
   confirming rather than assuming.
3. **Multiple absolute devices on multi-monitor.** Assumption: KWin presents one
   absolute device with one region per output. If it instead presents one device per
   output, the region loop in §7.4 handles it, but the `desktop` bounding box in
   `computer_screen` must be computed as the union of all regions, not from region 0.
   Verify in P1.
4. **Should we offer a `computer_touch` tool?** `EI_DEVICE_CAP_TOUCH` is already bound
   if present, and touch-scroll is more faithful on a touchscreen laptop. Deferred —
   it doubles the batch action surface for a minority case.
5. **GNOME.** `libei` + `liboeffis` are compositor-agnostic and
   `xdg-desktop-portal-gnome` implements RemoteDesktop, so the same code plausibly
   works. Out of scope for v1, but the architecture does not preclude it — which is
   the main reason not to reach for the KWin-private D-Bus shortcuts we rejected.
