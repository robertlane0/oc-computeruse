import { fail } from "./errors.ts"

/** Modifier names the model may use, in the order they are pressed. */
export const MODIFIERS = ["ctrl", "alt", "shift", "super"] as const
export type Modifier = (typeof MODIFIERS)[number]

export const BUTTONS = ["left", "right", "middle", "back", "forward"] as const
export type Button = (typeof BUTTONS)[number]

/** evdev codes from `linux/input-event-codes.h`; layout-independent by design. */
export const BUTTON_CODE: Record<Button, number> = {
  left: 0x110,
  right: 0x111,
  middle: 0x112,
  back: 0x113,
  forward: 0x114,
}

export const MODIFIER_CODE: Record<Modifier, number> = {
  ctrl: 29, // KEY_LEFTCTRL
  alt: 56, // KEY_LEFTALT
  shift: 42, // KEY_LEFTSHIFT
  super: 125, // KEY_LEFTMETA
}

/**
 * Letters and digits, so a single character can be sent as a key. This is what
 * makes `ctrl+c`, the most common chord there is, work.
 */
const ALPHANUMERIC: Record<string, number> = {
  a: 30, b: 48, c: 46, d: 32, e: 18, f: 33, g: 34, h: 35, i: 23, j: 36, k: 37, l: 38,
  m: 50, n: 49, o: 24, p: 25, q: 16, r: 19, s: 31, t: 20, u: 22, v: 47, w: 17, x: 45, y: 21, z: 44,
  "0": 11, "1": 2, "2": 3, "3": 4, "4": 5, "5": 6, "6": 7, "7": 8, "8": 9, "9": 10,
}

const NAMED: Record<string, number> = {
  // editing / whitespace
  enter: 28,
  return: 28,
  tab: 15,
  space: 57,
  spacebar: 57,
  backspace: 14,
  delete: 111,
  del: 111,
  insert: 110,
  escape: 1,
  esc: 1,
  // navigation
  up: 103,
  down: 108,
  left: 105,
  right: 106,
  home: 102,
  end: 107,
  pageup: 104,
  pagedown: 109,
  // locks and system
  capslock: 58,
  numlock: 69,
  scrolllock: 70,
  printscreen: 99,
  print: 99,
  pause: 119,
  menu: 139,
  compose: 127,
  // modifiers (both spellings, plus the raw left-hand names)
  control: 29,
  ctrl: 29,
  alt: 56,
  shift: 42,
  super: 125,
  meta: 125,
  win: 125,
  cmd: 125,
  command: 125,
  windows: 125,
  rightctrl: 97,
  rightalt: 100,
  rightshift: 54,
  // media
  playpause: 164,
  mute: 113,
  volumeup: 115,
  volumedown: 114,
  // keypad
  "kp0": 82,
  "kp1": 79,
  "kp2": 80,
  "kp3": 81,
  "kp4": 75,
  "kp5": 76,
  "kp6": 77,
  "kp7": 71,
  "kp8": 72,
  "kp9": 73,
  "kpenter": 96,
  "kpplus": 78,
  "kpminus": 74,
  "kpasterisk": 55,
  "kpslash": 98,
  "kpdot": 83,
  "kpequal": 117,
}

// f1..f24 are the only table worth generating.
for (let n = 1; n <= 24; n++) NAMED[`f${n}`] = 58 + n
Object.assign(NAMED, ALPHANUMERIC)

/** Every accepted name, for the `UNSUPPORTED_KEY` remedy. */
export const KEY_NAMES: readonly string[] = Object.keys(NAMED).sort()

/** An ordered chord: optional modifiers followed by exactly one key. */
export type Chord = { modifiers: Modifier[]; key: string }

export const isButton = (value: string): value is Button => (BUTTONS as readonly string[]).includes(value)

export const isModifier = (value: string): value is Modifier => (MODIFIERS as readonly string[]).includes(value)

/** Canonical spelling for each name, so the error text can suggest one. */
const CANONICAL: Record<string, string> = {
  return: "enter",
  esc: "escape",
  del: "delete",
  spacebar: "space",
  print: "printscreen",
  control: "ctrl",
  meta: "super",
  win: "super",
  cmd: "super",
  command: "super",
  windows: "super",
  rightctrl: "rightctrl",
}

export const canonicalName = (name: string): string => CANONICAL[name] ?? name

/** Nearest known key by edit distance, for "did you mean" without a dictionary. */
function suggest(name: string): string | undefined {
  let best: { name: string; score: number } | undefined
  for (const candidate of KEY_NAMES) {
    const score = distance(name, candidate)
    if (!best || score < best.score) best = { name: candidate, score }
  }
  const limit = Math.max(1, Math.floor(name.length / 3))
  return best && best.score <= limit ? best.name : undefined
}

function distance(a: string, b: string): number {
  const rows = a.length + 1
  let prev = Array.from({ length: b.length + 1 }, (_, i) => i)
  for (let i = 1; i < rows; i++) {
    const next = [i]
    for (let j = 1; j <= b.length; j++) {
      next[j] = Math.min(prev[j]! + 1, next[j - 1]! + 1, prev[j - 1]! + (a[i - 1] === b[j - 1] ? 0 : 1))
    }
    prev = next
  }
  return prev[b.length]!
}

/**
 * Parses one key argument. Accepts a bare name (`"enter"`, `"f5"`, `"super"`) or
 * a `+`-joined chord (`"ctrl+c"`, `"ctrl+shift+t"`). An unknown name is a
 * reported error listing the real ones, never a silent no-op.
 */
export function parseChord(input: string): Chord {
  const text = input.trim().toLowerCase()
  if (!text) fail("UNSUPPORTED_KEY", "No key given. Pass a key name such as \"enter\", \"f5\" or a chord such as \"ctrl+c\".")

  // Plus, whitespace and underscore all separate a chord, because a model will
  // reach for all three: "ctrl+c", "ctrl + shift + t", "ctrl_shift_t".
  const parts = text.split(/\s*\+\s*|\s+|_/).filter(Boolean)
  if (parts.length === 0) fail("UNSUPPORTED_KEY", `Could not read the key ${JSON.stringify(input)}.`)

  const modifiers: Modifier[] = []
  let key: string | undefined
  for (const part of parts) {
    if (key !== undefined) {
      fail("UNSUPPORTED_KEY", `"${input}" has more than one key. Send one key per call, or use computer_batch.`)
    }
    if (isModifier(part)) {
      if (!modifiers.includes(part)) modifiers.push(part)
      continue
    }
    if (NAMED[part] === undefined && isModifier(part.replace(/^right/, ""))) {
      // "rightctrl" is a real named key rather than a modifier.
      key = part
      continue
    }
    if (NAMED[part] === undefined) {
      const hint = suggest(part)
      fail(
        "UNSUPPORTED_KEY",
        `Unknown key "${part}".`,
        `Use one of: ${KEY_NAMES.join(", ")}.${hint ? ` Did you mean "${hint}"?` : ""} To type a literal "+" use computer_type.`,
      )
    }
    key = part
  }

  if (key === undefined) {
    // Chords made only of modifiers are a legitimate "press shift" request.
    key = modifiers[modifiers.length - 1]!
    modifiers.pop()
  }
  // Fixed order so a chord is always well-formed on the way down and back up.
  return { modifiers: MODIFIERS.filter((modifier) => modifiers.includes(modifier)), key }
}

export const keyCode = (name: string): number => {
  const code = NAMED[name.toLowerCase()]
  if (code === undefined) {
    const hint = suggest(name)
    fail(
      "UNSUPPORTED_KEY",
      `"${name}" is not a key this plugin knows.`,
      `Use one of: ${KEY_NAMES.join(", ")}.${hint ? ` Did you mean "${hint}"?` : ""} To send a literal character, use computer_type.`,
    )
  }
  return code
}

/** Unicode codepoint to X11 keysym; above Latin-1 the keysyms live at +0x01000000. */
export function keysymFor(codepoint: number): number {
  return codepoint >= 0x100 && codepoint <= 0x10ffff ? codepoint + 0x01000000 : codepoint
}

export const codepointFor = (keysym: number): number =>
  keysym >= 0x01000000 && keysym <= 0x0110ffff ? keysym - 0x01000000 : keysym
