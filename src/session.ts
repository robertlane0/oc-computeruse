import type { Pointer } from "bun:ffi"
import { fail } from "./errors.ts"
import { CAP, EVENT, bindList, libei, readKeymap, timestamp, type Libei } from "./ffi/libei.ts"
import { OE_EVENT, liboeffis } from "./ffi/liboeffis.ts"
import { assertSession } from "./ffi/probe.ts"
import { poll } from "./ffi/poll.ts"
import { parseKeymap, placementFor, type Keymap, type Placement } from "./keymap.ts"
import { BUTTON_CODE, MODIFIER_CODE, type Button, type Modifier } from "./keys.ts"
import { deviceMask, type Options } from "./options.ts"

export type Region = { x: number; y: number; width: number; height: number; scale: number }

export type ScreenInfo = {
  session: { state: string; authorized: boolean; note: string }
  capabilities: { absolutePointer: boolean; relativePointer: boolean; keyboard: boolean; text: boolean; touch: boolean }
  desktop: { x: number; y: number; width: number; height: number }
  regions: Region[]
  pointer: { known: false; note: string }
}

type State = "absent" | "probing" | "authorizing" | "connecting" | "binding" | "ready"

type Slot = "absolute" | "relative" | "keyboard" | "text" | "touch"

type Entry = { device: Pointer; caps: number[]; emulating: boolean; name: string }

const POLL_MS = 100
const DEVICE_TIMEOUT_MS = 10_000

/**
 * Modifiers each XKB level implies. Level 0 is plain, 1 adds shift, and 2 and 3
 * are the AltGr levels. Anything deeper cannot be reached with named keys, so
 * those characters are reported as untypable rather than typed wrongly.
 */
const LEVEL_MODIFIERS: Record<number, readonly Modifier[]> = {
  0: [],
  1: ["shift"],
  2: ["alt"],
  3: ["alt", "shift"],
}

const MODIFIER_ORDER: readonly Modifier[] = ["ctrl", "alt", "shift", "super"]

const sleep = (ms: number) => new Promise<void>((resolve) => setTimeout(resolve, ms))

/**
 * The one long-lived RemoteDesktop session for the plugin. It owns both the
 * `liboeffis` portal context — which has to outlive the `ei` context, because
 * dropping it invalidates the EIS socket — and the `ei` sender, and it is the
 * only code that talks to the compositor. It is created on the first action
 * rather than at load, so merely loading the plugin never raises a dialog.
 */
export class EiSession {
  #state: State = "absent"
  #pending: Promise<void> | undefined
  #oeffis: Pointer | undefined
  #ei: Pointer | undefined
  #sequence = 0
  #keymap: Keymap | undefined
  #lost = ""
  readonly #devices = new Map<Slot, Entry>()
  readonly #options: Options

  constructor(options: Options) {
    this.#options = options
  }

  get state(): State {
    return this.#state
  }

  get authorized(): boolean {
    return this.#state === "ready"
  }

  /**
   * Brings the session to `ready`. An attempt in flight is shared, so two tool
   * calls racing each other cannot open two portal sessions and two dialogs.
   */
  async ready(): Promise<void> {
    if (this.#state === "ready") return
    if (!this.#pending) {
      this.#pending = this.#connect().finally(() => {
        this.#pending = undefined
      })
    }
    return this.#pending
  }

  async #connect(): Promise<void> {
    this.#release()
    assertSession()
    this.#state = "probing"
    const ei = libei()
    const portal = liboeffis()

    this.#state = "authorizing"
    const context = portal.oeffis_new(null)
    if (!context) fail("NOT_AUTHORIZED", "The RemoteDesktop portal client could not be created.")
    this.#oeffis = context
    portal.oeffis_create_session(context, deviceMask(this.#options.devices))
    const eisFd = await this.#awaitEis(context)
    if (eisFd < 0) return

    this.#state = "connecting"
    const sender = ei.ei_new_sender(null)
    if (!sender) {
      this.#release()
      fail("SESSION_LOST", "libei could not create a sender context.", "Restart OpenCode and try again.")
    }
    this.#ei = sender
    if (ei.ei_setup_backend_fd(sender, eisFd) !== 0) {
      this.#release()
      fail("SESSION_LOST", "The compositor refused the input-injection socket.", "Restart OpenCode and try again.")
    }
    this.#state = "binding"
    await this.#awaitDevices(ei, sender)
  }

  /** Pumps the portal context until the user answers the consent dialog. */
  async #awaitEis(context: Pointer): Promise<number> {
    const portal = liboeffis()
    const deadline = Date.now() + this.#options.authorizeTimeoutMs
    let fd = -1
    while (Date.now() < deadline && fd < 0) {
      const ready = poll(portal.oeffis_get_fd(context), POLL_MS)
      if (ready.dead) {
        this.#release()
        fail("SESSION_LOST", "The connection to the RemoteDesktop portal was lost.", "Call the tool again.")
      }
      if (!ready.readable) continue
      portal.oeffis_dispatch(context)
      for (;;) {
        const event = portal.oeffis_get_event(context)
        if (event === OE_EVENT.NONE) break
        if (event === OE_EVENT.CONNECTED_TO_EIS) {
          fd = portal.oeffis_get_eis_fd(context)
        } else if (event === OE_EVENT.CLOSED) {
          this.#release()
          fail(
            "AUTH_CANCELLED",
            "The remote-control session was ended from the system tray before any input was sent.",
            "Start a new OpenCode session to request control again.",
          )
        } else {
          const message = portal.oeffis_get_error_message(context) || "unknown error"
          this.#release()
          fail(
            "NOT_AUTHORIZED",
            `The RemoteDesktop portal refused the request: ${message}`,
            "Ask the user to approve the 'Remote Control Requested' dialog, then call the tool again.",
          )
        }
      }
    }
    if (fd < 0) {
      this.#release()
      fail(
        "AUTH_TIMEOUT",
        `No answer to the 'Remote Control Requested' dialog after ${Math.round(this.#options.authorizeTimeoutMs / 1000)}s.`,
        "Ask the user to approve the system dialog, then call the tool again.",
      )
    }
    return fd
  }

  /** Pumps the EIS socket until every device the tools need is emulating. */
  async #awaitDevices(ei: Libei, sender: Pointer): Promise<void> {
    const deadline = Date.now() + DEVICE_TIMEOUT_MS
    const pending: { seat: Pointer; caps: number[] }[] = []
    while (Date.now() < deadline) {
      const ready = poll(ei.ei_get_fd(sender), POLL_MS)
      if (ready.dead) {
        this.#release()
        fail("SESSION_LOST", "The compositor closed the input-injection connection.", "Call the tool again.")
      }
      if (!ready.readable) continue
      ei.ei_dispatch(sender)
      if (!this.#drain(ei, sender, pending)) continue
      // Binding has to wait until the queued events have been released: while
      // the seat-added event is outstanding libei treats the seat as new and
      // ignores the request.
      for (const { seat, caps } of pending.splice(0)) {
        this.#trace(`bind ${caps.join("+")}`)
        ei.ei_seat_bind_capabilities(seat, ...bindList(caps))
      }
      if (this.#satisfied()) {
        this.#state = "ready"
        this.#trace("ready")
        return
      }
    }
    this.#release()
    fail(
      "CAPABILITY",
      "The compositor accepted the session but never offered the input devices the tools need.",
      "Check that xdg-desktop-portal is running, then call the tool again.",
    )
  }

  /**
   * Handles one batch of EIS events. Returns false when the transport is gone.
   * Never throws: a dead connection is state, not an exception, so the caller
   * can fall out of its loop and report it.
   */
  #drain(ei: Libei, sender: Pointer, pending: { seat: Pointer; caps: number[] }[]): boolean {
    for (;;) {
      const event = ei.ei_get_event(sender)
      if (!event) return true
      const type = ei.ei_event_get_type(event)
      const seat = ei.ei_event_get_seat(event)
      const device = ei.ei_event_get_device(event)

      if (type === EVENT.DISCONNECT) {
        // A disconnect invalidates the whole context, so nothing may touch the
        // event or the sender afterwards.
        this.#lost = "The compositor ended the input session."
        this.#release()
        return false
      }
      if (type === EVENT.SEAT_ADDED && seat) {
        const caps: number[] = []
        for (const bit of Object.values(CAP)) {
          if (ei.ei_seat_has_capability(seat, bit)) caps.push(bit)
        }
        // Touch is bound when offered, so a touch device arrives; no tool uses
        // it yet, but its presence costs nothing and keeps the option open.
        pending.push({ seat, caps })
      } else if (type === EVENT.DEVICE_ADDED && device) {
        const caps: number[] = []
        for (const bit of Object.values(CAP)) {
          if (ei.ei_device_has_capability(device, bit)) caps.push(bit)
        }
        const slot = classify(caps)
        if (!slot) ei.ei_device_close(device)
        else {
          this.#devices.set(slot, { device, caps, emulating: false, name: deviceName(ei, device) })
          if (caps.includes(CAP.KEYBOARD)) this.#loadKeymap(ei, device)
        }
      } else if (type === EVENT.DEVICE_RESUMED && device) {
        for (const entry of this.#devices.values()) {
          if (entry.device === device && !entry.emulating) {
            entry.emulating = true
            // The sequence has to strictly increase; 0 is not a valid first call.
            ei.ei_device_start_emulating(device, ++this.#sequence)
          }
        }
      } else if (type === EVENT.DEVICE_PAUSED || type === EVENT.DEVICE_REMOVED) {
        for (const [slot, entry] of this.#devices) {
          if (entry.device === device) this.#devices.delete(slot)
        }
      } else if (type === EVENT.SEAT_REMOVED) {
        this.#devices.clear()
      }
      ei.ei_event_unref(event)
    }
  }

  #loadKeymap(ei: Libei, device: Pointer): void {
    const keymap = ei.ei_device_keyboard_get_keymap(device)
    if (!keymap) return
    try {
      this.#keymap = parseKeymap(readKeymap(ei, keymap))
    } catch (error) {
      this.#lost = `The keyboard layout could not be read: ${(error as Error).message}`
    }
  }

  /** True once every device kind the requested tools need is emulating. */
  #satisfied(): boolean {
    const want = this.#options.devices
    if (want.includes("pointer") && !this.#live("absolute") && !this.#live("relative")) return false
    if (want.includes("keyboard") && !this.#live("keyboard")) return false
    return true
  }

  #live = (slot: Slot): boolean => this.#devices.get(slot)?.emulating === true

  /**
   * The device for absolute motion, buttons and scroll. The absolute device
   * carries BUTTON and SCROLL as well, so a click lands on the very pointer a
   * move placed; a relative-only session falls back to the pointer device.
   */
  #pointing(): Entry {
    if (this.#live("absolute")) return this.#need("NO_ABSOLUTE_POINTER")
    const relative = this.#devices.get("relative")
    if (relative?.emulating) return relative
    return this.#need("NO_ABSOLUTE_POINTER")
  }

  /**
   * The device for relative motion. It must be the device that actually has
   * POINTER: libei rejects the call outright on an absolute device, which is a
   * client bug it is right to report.
   */
  #relative(): Entry {
    const relative = this.#devices.get("relative")
    if (relative?.emulating) return relative
    return fail(
      "CAPABILITY",
      "The compositor offered no relative pointing device, so the pointer cannot be moved by a delta.",
      "Move to an absolute position with computer_move x and y instead.",
    )
  }

  #need(code: "NO_ABSOLUTE_POINTER" | "NO_KEYBOARD"): Entry {
    const slot = code === "NO_KEYBOARD" ? "keyboard" : "absolute"
    const entry = this.#devices.get(slot)
    if (entry?.emulating) return entry
    if (entry) {
      fail(
        "CAPABILITY",
        `The compositor paused the ${entry.name}.`,
        "Call the tool again; the session reconnects on the next action.",
      )
    }
    return fail(
      code,
      code === "NO_KEYBOARD"
        ? "No keyboard device was offered by the compositor, so nothing can be typed."
        : "No absolute pointing device was offered, so a click cannot be placed on a coordinate.",
      "Ask the user to restart OpenCode and approve the remote-control dialog again.",
    )
  }

  #trace(message: string): void {
    if (this.#options.trace) process.stderr.write(`[computeruse] ${message}\n`)
  }

  // ----------------------------------------------------------------- reporting

  screen(): ScreenInfo {
    const regions = this.#regions()
    const box = regions.reduce(
      (acc, region) => ({
        x: Math.min(acc.x, region.x),
        y: Math.min(acc.y, region.y),
        right: Math.max(acc.right, region.x + region.width),
        bottom: Math.max(acc.bottom, region.y + region.height),
      }),
      { x: Infinity, y: Infinity, right: -Infinity, bottom: -Infinity },
    )
    const known = Number.isFinite(box.x) && Number.isFinite(box.y)
    return {
      session: { state: this.#state, authorized: this.authorized, note: this.#lost },
      capabilities: {
        absolutePointer: this.#live("absolute"),
        relativePointer: this.#live("relative"),
        keyboard: this.#live("keyboard"),
        text: this.#live("text"),
        touch: this.#live("touch"),
      },
      desktop: {
        x: known ? box.x : 0,
        y: known ? box.y : 0,
        width: known ? box.right - box.x : 0,
        height: known ? box.bottom - box.y : 0,
      },
      regions,
      pointer: {
        known: false,
        note: "EIS is send-only, so the pointer position cannot be read back. Every click needs an explicit target.",
      },
    }
  }

  #regions(): Region[] {
    const ei = libei()
    const out: Region[] = []
    for (const entry of this.#devices.values()) {
      if (!entry.caps.includes(CAP.POINTER_ABSOLUTE)) continue
      // The region count is fixed for a device's lifetime, so iterating until
      // the lookup returns null is both correct and cheap.
      for (let index = 0; ; index++) {
        const region = ei.ei_device_get_region(entry.device, index)
        if (!region) break
        out.push({
          x: ei.ei_region_get_x(region),
          y: ei.ei_region_get_y(region),
          width: ei.ei_region_get_width(region),
          height: ei.ei_region_get_height(region),
          scale: ei.ei_region_get_physical_scale(region),
        })
      }
    }
    return out
  }

  // ----------------------------------------------------------------- injection

  moveTo(x: number, y: number): void {
    const ei = libei()
    const entry = this.#need("NO_ABSOLUTE_POINTER")
    const regions = this.#regions()
    // A point outside every region is discarded by the compositor without a
    // word, so it is checked here and the error names the rectangles.
    if (!regions.some((region) => contains(region, x, y))) {
      fail(
        "OUT_OF_BOUNDS",
        `(${Math.round(x)}, ${Math.round(y)}) is not inside any monitor.`,
        `The desktop is ${regions.map((r) => `${r.width}x${r.height} at (${r.x}, ${r.y})`).join(" and ")}. Choose a point inside one of those.`,
      )
    }
    ei.ei_device_pointer_motion_absolute(entry.device, x, y)
    this.#frame(entry)
    this.#trace(`move ${Math.round(x)},${Math.round(y)}`)
  }

  moveBy(dx: number, dy: number): void {
    const entry = this.#relative()
    libei().ei_device_pointer_motion(entry.device, dx, dy)
    this.#frame(entry)
    this.#trace(`move ${dx >= 0 ? "+" : ""}${dx},${dy >= 0 ? "+" : ""}${dy}`)
  }

  button(button: Button, press: boolean): void {
    const entry = this.#pointing()
    libei().ei_device_button_button(entry.device, BUTTON_CODE[button], press)
    this.#frame(entry)
    this.#trace(`button ${button} ${press ? "down" : "up"}`)
  }

  /**
   * `notches` are wheel clicks. The sign is the one that actually works:
   * verified against a page that logs its wheel events, KWin passes a discrete
   * value straight through, and the browser treats a positive delta as moving
   * the content up, i.e. revealing what is below. The libei header's `wl_pointer`
   * wording reads the other way round, and following it silently scrolls the
   * wrong way — which is invisible at the top of a page and maddening anywhere
   * else.
   */
  scroll(direction: "up" | "down" | "left" | "right", notches: number): void {
    const entry = this.#pointing()
    const steps = Math.round(notches * 120)
    const dx = direction === "right" ? steps : direction === "left" ? -steps : 0
    const dy = direction === "down" ? steps : direction === "up" ? -steps : 0
    libei().ei_device_scroll_discrete(entry.device, dx, dy)
    this.#frame(entry)
    this.#trace(`scroll ${direction} ${notches}`)
  }

  key(code: number, press: boolean, label: string): void {
    const entry = this.#need("NO_KEYBOARD")
    const ei = libei()
    ei.ei_device_keyboard_key(entry.device, code, press)
    this.#frame(entry)
    this.#trace(`key ${label} ${press ? "down" : "up"}`)
  }

  /**
   * Types through `ei_device_text_utf8` when the compositor advertises the text
   * capability, and otherwise resolves every character against the live XKB
   * keymap. Characters the active layout cannot produce are reported back,
   * never dropped: a silently missing character is the most confusing failure
   * an agent can be handed.
   */
  async type(text: string): Promise<{ typed: number; total: number; missing: string[] }> {
    const characters = [...text]
    const missing: string[] = []
    const text0 = this.#devices.get("text")
    let typed = 0

    for (const character of characters) {
      if (character === "\n") {
        this.key(28, true, "enter")
        this.key(28, false, "enter")
        typed++
      } else if (text0?.emulating) {
        libei().ei_device_text_utf8(text0.device, character)
        this.#frame(text0)
        typed++
      } else if (this.#typeOne(character)) {
        typed++
      } else {
        missing.push(character)
      }
      if (this.#options.defaultTypeDelayMs > 0) await sleep(this.#options.defaultTypeDelayMs)
    }
    return { typed, total: characters.length, missing }
  }

  /** One character through evdev, with the modifiers its level requires. */
  #typeOne(character: string): boolean {
    const keymap = this.#keymap
    if (!keymap) return false
    const placement: Placement | undefined = placementFor(keymap, character.codePointAt(0)!)
    if (!placement) return false
    const modifiers = LEVEL_MODIFIERS[placement.level]
    if (!modifiers) return false
    for (const modifier of MODIFIER_ORDER) {
      if (modifiers.includes(modifier)) this.key(MODIFIER_CODE[modifier], true, modifier)
    }
    this.key(placement.code, true, `code ${placement.code}`)
    this.key(placement.code, false, `code ${placement.code}`)
    for (const modifier of [...MODIFIER_ORDER].reverse()) {
      if (modifiers.includes(modifier)) this.key(MODIFIER_CODE[modifier], false, modifier)
    }
    return true
  }

  #frame(entry: Entry): void {
    libei().ei_device_frame(entry.device, timestamp())
  }

  /** Drops both native contexts. The `oeffis` one has to go last. */
  #release(): void {
    const ei = this.#ei
    const portal = this.#oeffis
    this.#ei = undefined
    this.#oeffis = undefined
    this.#devices.clear()
    this.#keymap = undefined
    if (this.#state !== "absent") this.#state = "absent"
    if (ei) {
      try {
        libei().ei_unref(ei)
      } catch {
        /* the process may be going away anyway */
      }
    }
    if (portal) {
      try {
        liboeffis().oeffis_unref(portal)
      } catch {
        /* ignore */
      }
    }
  }

  close(): void {
    this.#release()
  }
}

/** The one slot a device can fill, or undefined when nothing here can use it. */
const classify = (caps: number[]): Slot | undefined => {
  if (caps.includes(CAP.POINTER_ABSOLUTE)) return "absolute"
  if (caps.includes(CAP.KEYBOARD)) return "keyboard"
  if (caps.includes(CAP.TEXT)) return "text"
  if (caps.includes(CAP.POINTER)) return "relative"
  if (caps.includes(CAP.TOUCH)) return "touch"
  return undefined
}

const contains = (region: Region, x: number, y: number): boolean =>
  x >= region.x && x < region.x + region.width && y >= region.y && y < region.y + region.height

const deviceName = (ei: Libei, device: Pointer): string => {
  try {
    return ei.ei_device_get_name(device)
  } catch {
    return "unknown device"
  }
}
