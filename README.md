# oc-computeruse

An [OpenCode](https://opencode.ai) plugin that lets the model **send keyboard and mouse
input to a KDE Plasma Wayland desktop**: move the pointer, click, drag, scroll, type, and
press keys and chords.

It injects input. It does **not** look at the screen. For that, pair it with
[`oc-takeascreenshot`](https://github.com/robertlane0/oc-takeascreenshot), which captures
the screen and hands the image to the model. Together:

1. `screenshot_display` (or `screenshot_capture_window`) — see the screen.
2. `computer_screen` — learn the desktop geometry.
3. `computer_*` — act on the coordinates you read off the image.

Supported: **KDE Plasma 6 on Wayland**, on a machine with `libei` and `liboeffis`
installed. Both ship with `libei`, which KWin already depends on, so a normal Plasma
install already has them.

---

## Install

Point `opencode.json` at this directory. There is no build step and no `npm install`.

```jsonc
{
  "$schema": "https://opencode.ai/config.json",
  "plugin": ["/home/you/code/oc-computeruse"]
}
```

Options, if you want them:

```jsonc
{
  "plugin": [
    {
      "package": "/home/you/code/oc-computeruse",
      "options": {
        "devices": "keyboard|pointer",
        "authorizeTimeoutMs": 30000,
        "defaultTypeDelayMs": 8,
        "defaultClickDelayMs": 40,
        "requestButton": "left",
        "trace": false
      }
    }
  ]
}
```

| option | default | what it does |
|---|---|---|
| `devices` | `keyboard\|pointer\|touchscreen` | which device classes to ask the portal for |
| `authorizeTimeoutMs` | `30000` | how long to wait for the consent dialog |
| `defaultTypeDelayMs` | `8` | pause between typed characters |
| `defaultClickDelayMs` | `40` | pause between a button press and its release |
| `requestButton` | `left` | the button used when a click names none |
| `maxBatchActions` | `200` | cap on one `computer_batch` call |
| `trace` | `false` | log every injected event to stderr |

The first action of a session raises a KDE **"Remote Control Requested"** dialog, which a
person has to approve. It appears once per OpenCode process, not once per machine. KDE
also shows a **Remote Control** tray item for as long as the session lasts; that is the
user's way to revoke it.

---

## The tools

All eleven live in the `computer` namespace.

| tool | what it does |
|---|---|
| `computer_screen` | desktop size, each monitor's rectangle and scale, session state. **Call this first.** |
| `computer_move` | move the pointer to a point, or by a delta |
| `computer_click` | move and click. `count` 2 or 3 for a double or triple click; `modifiers` for chords |
| `computer_mouse_down` / `computer_mouse_up` | press and release a button, so `move` between them becomes a drag |
| `computer_scroll` | scroll by whole wheel notches |
| `computer_type` | type a string |
| `computer_key` | press a key or chord: `enter`, `f5`, `ctrl+c`, `ctrl+shift+t` |
| `computer_key_down` / `computer_key_up` | hold a key across other actions |
| `computer_batch` | run an ordered list of the above in one call |

`computer_batch` is the one to reach for whenever the steps are known up front: it costs
one round trip instead of one per action, and it makes ordering and pauses explicit.

---

## Coordinates

Coordinates are **logical desktop pixels**, with the origin at the top-left of the whole
desktop, across every monitor — including any to the left of or above the first.

`computer_screen` is the only way to learn that space:

```json
{
  "desktop": { "x": 0, "y": 0, "width": 2560, "height": 1600 },
  "regions": [{ "x": 0, "y": 0, "width": 2560, "height": 1600, "scale": 1 }]
}
```

A screenshot the model sees is usually scaled down to fit its input budget, so **a
coordinate read off an image is not a desktop coordinate**. Multiply by
`desktop_width / screenshot_width` first. Every tool that takes a target also accepts

```jsonc
{ "relative": { "x": 0.5, "y": 0.25 } }
```

which is a fraction of the desktop. Fractional reasoning is far more reliable for a model
than pixel arithmetic, and it is immune to image scaling entirely.

A point outside every monitor is refused with an error that names the rectangles, so the
model can correct itself in one step.

---

## What a click can and cannot do

- Keystrokes go to whichever window has keyboard focus. A `click` moves the pointer and
  focuses what is under it, so clicking before typing is almost always right.
- There is no way to target a window by name through the portal. Click a window to reach
  it.
- EIS is send-only: the plugin cannot read back where the pointer is. Every click needs an
  explicit target.

---

## Permissions and risk

**Enabling this plugin hands the model keyboard and mouse control of your desktop.** There
is no way to scope it to one application.

OpenCode 2 has no permission prompt for plugin tools, so configuration is the gate. Every
tool declares `permission: "computer_<name>"`, so a rule in `opencode.json` can remove it
from the model's catalog:

```jsonc
{
  "permissions": [
    { "action": "computer_type", "resource": "*", "effect": "deny" },
    { "action": "computer_key*", "resource": "*", "effect": "deny" },
    { "action": "computer_*", "resource": "*", "effect": "deny" }
  ]
}
```

Deny-by-default, then delete the lines you want back:

```jsonc
{
  "permissions": [{ "action": "computer_*", "resource": "*", "effect": "deny" }]
}
```

Setting `devices` to `"pointer"` narrows what is requested, and so narrows what the
consent dialog says.

---

## Typing and your keyboard layout

The plugin asks the compositor for its own text-injection capability first, and falls back
to sending real key events resolved against your **active keyboard layout** when the
compositor does not offer it — which is the case on current Plasma.

The consequence is that a character your layout has no key for cannot be typed. Those are
reported rather than silently dropped:

```
Typed 11 of 15 characters. 4 could not be typed because the active
keyboard layout has no key for them: é ø Ω 🌍
```

`computer_key` is unaffected: named keys and chords are sent as raw evdev codes and are
exact whatever the layout is.

---

## Troubleshooting

| what you see | what it means |
|---|---|
| `MISSING_LIBRARY` | `libei.so.1` or `liboeffis.so.1` is not installed. Arch: `sudo pacman -S libei`. Both ship with the `libei` package. |
| `UNSUPPORTED_SESSION` | the session is X11. Log out and pick the Plasma (Wayland) session. |
| `NOT_PLASMA` | no KWin process. Run OpenCode from inside a logged-in Plasma session. |
| `AUTH_TIMEOUT` | nobody answered the dialog. Approve it and call again. |
| `NOT_AUTHORIZED` | the dialog was declined, or the portal refused the request. |
| `AUTH_CANCELLED` | the session was ended from the tray. Start a new OpenCode session. |
| `OUT_OF_BOUNDS` | the point is not on any monitor; the message lists the rectangles. |
| `LAYOUT_GAP` | the active layout has no key for some characters. |

---

## How it works

Short version: the XDG **RemoteDesktop portal** for consent and access control, then
**EIS** (libei) to carry the events, both reached over `bun:ffi` with no build step and no
npm dependencies.

The portal's own `Notify*` D-Bus methods are deliberately *not* used: on
`xdg-desktop-portal` 1.19.1 and later, absolute pointer motion is rejected unless the
session also has a screen-cast stream, so a click cannot be placed on a coordinate at all.
`PLAN.md` records the investigation.

`liboeffis` performs the whole portal handshake and hands back the EIS socket, which is
the only practical way to receive that file descriptor from a JavaScript runtime. The
EIS socket is then driven directly with `libei`.

## Licence

MIT.
