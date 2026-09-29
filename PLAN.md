# oc-computeruse — plan and findings

An OpenCode plugin that lets the model **send keyboard and mouse input to a Wayland
desktop**. Scope: **KDE Plasma 6 on Wayland**.

Vision is deliberately not part of it. Screenshot capability lives in
[`oc-takeascreenshot`](https://github.com/robertlane0/oc-takeascreenshot), which captures
the screen and returns the image. This plugin only *injects input*, and exposes the screen
**geometry** — not pixels — so the model knows what coordinate space it is clicking in.

This file is the decision record. What was actually built is described in `README.md` and
the source. What follows is the part worth keeping: the findings that are not obvious from
the code, and would cost somebody a day to rediscover.

---

## 1. Status

Built and working end to end: the model opens a remote-control session, reads the desktop
geometry, selects a window, scrolls a page and clicks a target found on a screenshot.

| | |
|---|---|
| Runtime | OpenCode ≥ 2.0.18 (`@opencode/plugin` v2 promise API), Bun |
| Backend | XDG **RemoteDesktop** portal → **EIS** socket → **libei** over `bun:ffi` |
| Native deps | None at npm level. `libei.so.1` / `liboeffis.so.1` are loaded at runtime, and ship with the `libei` package that KWin already depends on. |
| Tool surface | 11 tools in a `computer` namespace, native (`codemode: false`) |
| Tests | `bun test` — options, key tables, chords, error rendering, XKB keymap parsing against a captured real keymap. Plus `test/live.ts`, an opt-in harness. |

---

## 2. The backend decision

### 2.1 Why not the portal's `Notify*` methods

The obvious approach — call `org.freedesktop.portal.RemoteDesktop.NotifyPointerMotionAbsolute`
over D-Bus — **does not work for absolute pointer motion**. `check_position()` in the
`xdg-desktop-portal` front-end validates the coordinate against a *screen-cast stream's*
size, and a RemoteDesktop-only session has none, so the loop never runs and every call
fails with `"Invalid position"`. Introduced in 1.19.1, and present in every version since,
so every current Plasma install is affected.

Absolute pointer motion is how a click lands on a coordinate read off a screenshot.
Working around it by also requesting a screen-cast stream would mean a second consent
dialog and an active PipeWire capture, to re-implement something the portal blocks on
purpose.

Confirm on any Plasma install, without running anything:

```console
$ strings /usr/lib/xdg-desktop-portal | grep -c "Invalid position"
1
```

### 2.2 The path that works

```
plugin process (Bun)
  └─ liboeffis.so.1   oeffis_create_session(KEYBOARD|POINTER|TOUCHSCREEN)
                        ↳ D-Bus: CreateSession → SelectDevices → Start → ConnectToEIS
                        ↳ returns the EIS fd, received in C
  └─ libei.so.1       ei_new_sender() → ei_setup_backend_fd(fd)
  └─ libei.so.1       ei_device_* → KWin's libeis → the desktop
```

`liboeffis` does the whole portal handshake — handle tokens, the `Request::Response`
signal, error handling — in six C calls, and it is the only practical way to **receive a
file descriptor** from the portal. That is not a convenience: `node:net` has no `SCM_RIGHTS`
receive path, so a from-scratch D-Bus client could call `Notify*` but never
`ConnectToEIS`. Hand-rolling the portal is not on the table.

### 2.3 Rejected alternatives

| Approach | Why not |
|---|---|
| Portal `Notify*` over D-Bus | Absolute motion blocked (§2.1). Also one-way: no delivery feedback. |
| `xdotool` / X11 | XWayland only; cannot reach native Wayland clients. |
| `ydotool` (uinput) | Needs root and `/dev/uinput`; bypasses the portal consent model entirely. |
| `wtype` (`zwp_virtual_keyboard_v1`) | Text only, no pointer. Also unsupported by KWin. |
| KWin scripting | `callDBus` from a script body does not reach the bus. |
| `org.kde_kwin_fake_input` | A Wayland wire protocol, not D-Bus; needs a hand-rolled client whose own `authenticate()` is a documented no-op, and it bypasses consent. |
| KWin `outputLayout` D-Bus property for geometry | Does not exist. KWin exposes one property, `showingDesktop`. Geometry comes from EIS regions instead — which is the exact space EIS accepts. |
| `xdp-remote-control` | Does not exist, in any tree or package index. |

### 2.4 Consent is not self-granted

KDE's `isAppMegaAuthorized()` consults `PermissionStore["kde-authorized"]["remote-desktop"]`,
which would skip the dialog entirely and is writable over the bus. The plugin does not
touch it, ever: bypassing a security prompt is not a trade-off worth making.

---

## 3. Findings from implementing it

These are the things that cost time, and the reason the code looks the way it does.

### 3.1 `ei_seat_bind_capabilities` is variadic, and `bun:ffi` is not

It is declared `void ei_seat_bind_capabilities(struct ei_seat *seat, ...)`. `bun:ffi` has
no variadic signature, so it is declared with a fixed list of trailing `int`s and the
capabilities are passed positionally with explicit zero terminators. Two traps:

- **The values must be the capability *bits*** (`EI_DEVICE_CAP_POINTER_ABSOLUTE` and so
  on), not the indices you get from iterating a capability list. Passing indices means
  the first argument is `0`, which *is* the terminator, so the call binds nothing and
  returns success. This looks exactly like "the compositor gave us no devices".
- **The binding must be deferred until the queued events have been released.** While the
  seat-added event is still outstanding, libei treats the seat as new and drops the
  request. Collect the seat during the drain, unref every event, then bind.

### 3.2 The keymap is delivered as a file descriptor that is already at EOF

`ei_device_keyboard_get_keymap` → `ei_keymap_get_fd` gives a memfd. `read` returns 0
because libei's own bookkeeping has already consumed it; `pread` at offset 0 works.
`pread` returns `ssize_t`, which `bun:ffi` surfaces as a **BigInt** — convert it before
using it as a `Buffer` length.

### 3.3 The serialised keymap uses numeric keysyms, so no name table is needed

`XKB_KEYMAP_FORMAT_TEXT_V1` writes `[ 0x31, 0x21 ]`, not `[ 1, exclam ]`. That removes the
single largest piece of work in the original plan: no X11 keysym-name table is required,
only a `codepoint → keysym → evdev code` lookup. Two forms of the level list appear:

- inline: `key <AE01> { [ 0x31, 0x21 ] };`
- per group: `key <BKSP> { type= "CTRL+ALT", symbols[1]= [ 0xff08, ... ]; }`

A parser that grabs the first `[...]` in the second form reads the **group number** as a
keysym. Match `symbols[1]=` and `symbols[Group1]=` explicitly, and let placeholders like
`NoSymbol` keep their level so later symbols do not slide down.

Levels 0–3 are reachable as plain / shift / altgr / altgr+shift. Level 4 and beyond need a
modifier that cannot be named, so characters living only there are reported, not guessed.

### 3.4 KWin does not advertise `EI_DEVICE_CAP_TEXT`

The seat reports `POINTER, POINTER_ABSOLUTE, KEYBOARD, TOUCH, SCROLL, BUTTON` — and
nothing else. So on current Plasma, `ei_device_text_utf8` is **not available at all** and
the XKB keymap path in §3.3 is the only way to type. The plan treated it as a fallback;
it is the main path. Probe for the capability first, and do not assume it.

### 3.5 Scroll direction is the opposite of the header's wording

libei documents `ei_device_scroll_discrete` in `wl_pointer` terms, which reads as "positive
is up". Measured on Plasma, by logging the page's own wheel events:

```
scroll down 5  →  deltaY = +990  →  scrollY 0 → 307
scroll up   5  →  deltaY = -990  →  scrollY 307 → 0
```

KWin passes the discrete value straight through, and a browser treats a positive delta as
content moving up, i.e. revealing what is below. So **down is positive**.

The failure mode is nasty and worth stating: at the top of a page, scrolling *up* is a
no-op, so an inverted sign looks like "scroll does nothing" rather than "scroll is
backwards". Verify the sign against something that prints its own scroll offset.

### 3.6 Relative motion needs the device that has `POINTER`

`ei_device_pointer_motion` on the absolute device is rejected by libei as a client bug,
outright and with a log line. Relative motion belongs on the relative-pointer device;
absolute motion, buttons and scroll belong on the absolute device, because that is the
pointer a click lands on and the one carrying the regions a coordinate is validated
against.

### 3.7 `Number(ptr(x))` is `NaN`

A `Pointer` is already the numeric address. Round-tripping it through `ptr()` and back
gives `NaN`, and because `Map` and `Set` use SameValueZero, every `NaN` key collapses onto
the same entry. Two devices that were meant to be distinct silently became one. Keep the
raw value the FFI call returned.

### 3.8 The geometry only exists once there is a session

KWin has no D-Bus API for output geometry, so the desktop size comes from EIS regions,
which require an authorized session. That makes `computer_screen` the handshake: it opens
the session, raises the consent dialog, and returns the geometry. A `computer_screen` that
answered before consent would report a 0×0 desktop, and a model told to call it first
would have nothing to scale its coordinates with — the coordinate bridge, which is the
whole reason the tool exists, would be broken at step one.

### 3.9 `bun:ffi` variadic calls work for integer arguments

`snprintf(buf, n, "%d-%d-%d", 11, 22, 33)` produces `11-22-33` through `bun:ffi`, so
integer varargs arrive correctly even though the ABI wants `%al` set. It is worth knowing
this works before considering a C shim.

---

## 4. The tool surface

Eleven tools, all in the `computer` namespace: `screen`, `move`, `click`, `mouse_down`,
`mouse_up`, `scroll`, `type`, `key`, `key_down`, `key_up`, `batch`.

`codemode: false` on all of them is mandatory, not stylistic. CodeMode is the default, and
a tool without it is not sent to the provider as a native tool at all — it becomes one
line in a CodeMode catalog instead.

`computer_batch` is the one piece that is not strictly necessary and the highest leverage:
without it, "click, wait, type, press enter" costs four model round trips; with it, one.

### 4.1 Never let a tool throw

A rejected promise from a promise-plugin tool is a *defect*, not a recoverable tool error.
The host wraps executors in an effect that turns rejection into a die, and only a typed
error channel is mapped back, so a throw fails the whole model step instead of returning
something the model can read and correct itself from. Every `execute` is therefore wrapped
in `guard()`, which converts any throw into a prose `content` string.

### 4.2 The namespace description is the highest-value prompt text in the plugin

It carries the three things models reliably get wrong: the origin, the multi-monitor
origin, and the screenshot-scale mismatch.

---

## 5. Risks

| Risk | Likelihood | Mitigation |
|---|---|---|
| KWin offers no text capability | **Certain** | The keymap path is the real one (§3.4). Characters without a key are reported, never dropped. |
| The portal front-end diverges and `liboeffis` breaks | Low | `dlopen` is probed; a missing library is a `MISSING_LIBRARY` error with a per-distro hint. |
| `libei` absent on some distribution | Medium | Runtime probe plus an install hint. Report it; do not silently degrade. |
| Injected keys land in the wrong window | High, inherent | Documented; `click` moves before clicking so the common case is right. |
| A drag needs intermediate motion to register | Medium | `mouse_down` / `move` / `mouse_up` are separate, and `batch` interleaves them in one call. |
| Ten tools bloats the prompt | Low | Descriptions are one to three sentences; `batch` collapses multi-step work. |

---

## 6. Open questions

1. **Should coordinate inputs accept a source-image size hint** (`{x, y, source:
   {width, height}}`) so the plugin rescales instead of the model? Pro: removes the most
   common agent arithmetic error. Con: couples this plugin to an output shape it does not
   own. *Recommendation:* ship the explicit scaling instruction and `relative`; add the
   hint only if it proves necessary.
2. **Should `computer_screen` report window rectangles?** The model can only get a
   window's *size* from the screenshot plugin, not its position, so a window capture
   cannot be turned into desktop coordinates. Reporting rectangles would need KWin's
   window list, which only KWin scripting can supply.
3. **GNOME.** `libei` and `liboeffis` are compositor-agnostic, so the same code plausibly
   works. Out of scope, but the architecture does not preclude it — which is the main
   reason not to reach for the KWin-private shortcuts rejected in §2.3.
