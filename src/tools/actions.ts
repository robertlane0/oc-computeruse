import { fail } from "../errors.ts"
import { type Button, type Modifier, MODIFIER_CODE, keyCode, parseChord } from "../keys.ts"
import type { Deps, Point } from "./common.ts"

export type Direction = "up" | "down" | "left" | "right"

/**
 * One thing to do. The individual tools decode their own input into this, and
 * `computer_batch` decodes a list of them, so both paths run identical code and
 * cannot drift apart.
 */
export type Action =
  | { kind: "move"; point?: Point; delta?: Point }
  | { kind: "click"; button: Button; count: number; modifiers: Modifier[]; point?: Point }
  | { kind: "mouse_down"; button: Button; point?: Point }
  | { kind: "mouse_up"; button: Button; point?: Point }
  | { kind: "scroll"; direction: Direction; notches: number }
  | { kind: "type"; text: string }
  | { kind: "key"; key: string; modifiers: Modifier[] }
  | { kind: "key_down"; key: string }
  | { kind: "key_up"; key: string }
  | { kind: "wait"; ms: number }

const at = (point: Point | undefined): string =>
  point ? `(${Math.round(point.x)}, ${Math.round(point.y)})` : "the current pointer position"

/** Runs one action and returns the one-line report the model reads back. */
export async function run(deps: Deps, action: Action): Promise<string> {
  const { session, options } = deps
  await session.ready()

  switch (action.kind) {
    case "move": {
      if (action.point) session.moveTo(action.point.x, action.point.y)
      if (action.delta) session.moveBy(action.delta.x, action.delta.y)
      return `Pointer moved to ${at(action.point ?? action.delta)}.`
    }
    case "click": {
      if (action.point) session.moveTo(action.point.x, action.point.y)
      hold(deps, action.modifiers)
      for (let index = 0; index < action.count; index++) {
        session.button(action.button, true)
        if (options.defaultClickDelayMs > 0) await new Promise((r) => setTimeout(r, options.defaultClickDelayMs))
        session.button(action.button, false)
        if (index + 1 < action.count && options.defaultClickDelayMs > 0) {
          await new Promise((r) => setTimeout(r, options.defaultClickDelayMs))
        }
      }
      release(deps, action.modifiers)
      return `${action.count > 1 ? `${action.count}x ` : ""}${action.button} click at ${at(action.point)}.`
    }
    case "mouse_down": {
      if (action.point) session.moveTo(action.point.x, action.point.y)
      session.button(action.button, true)
      return `${action.button} button down at ${at(action.point)}. A move now drags; finish with computer_mouse_up.`
    }
    case "mouse_up": {
      session.button(action.button, false)
      return `${action.button} button up at ${at(action.point)}.`
    }
    case "scroll": {
      session.scroll(action.direction, action.notches)
      return `Scrolled ${action.direction} ${action.notches} notch${action.notches === 1 ? "" : "es"}.`
    }
    case "type": {
      const result = await session.type(action.text)
      const lines = [`Typed ${result.typed} of ${result.total} characters.`]
      if (result.missing.length) {
        lines.push(
          `${result.missing.length} could not be typed because the active keyboard layout has no key for them: ${result.missing.join(" ")}`,
        )
      }
      return lines.join(" ")
    }
    case "key": {
      const chord = parseChord(action.key)
      const modifiers = [...chord.modifiers, ...action.modifiers].filter(
        (modifier, index, all) => all.indexOf(modifier) === index,
      )
      hold(deps, modifiers)
      const code = keyCode(chord.key)
      session.key(code, true, chord.key)
      session.key(code, false, chord.key)
      release(deps, modifiers)
      return `Pressed ${[...modifiers, chord.key].join("+")}.`
    }
    case "key_down": {
      const code = keyCode(action.key)
      session.key(code, true, action.key)
      return `Holding ${action.key} down. Release it with computer_key_up.`
    }
    case "key_up": {
      const code = keyCode(action.key)
      session.key(code, false, action.key)
      return `Released ${action.key}.`
    }
    case "wait": {
      await new Promise((resolve) => setTimeout(resolve, action.ms))
      return `Waited ${action.ms}ms.`
    }
  }
}

/** Modifiers go down in a fixed order so a chord is always well-formed. */
const ORDER: readonly Modifier[] = ["ctrl", "alt", "shift", "super"]

const hold = (deps: Deps, modifiers: readonly Modifier[]): void => {
  for (const modifier of ORDER) {
    if (modifiers.includes(modifier)) deps.session.key(MODIFIER_CODE[modifier], true, modifier)
  }
}

const release = (deps: Deps, modifiers: readonly Modifier[]): void => {
  for (const modifier of [...ORDER].reverse()) {
    if (modifiers.includes(modifier)) deps.session.key(MODIFIER_CODE[modifier], false, modifier)
  }
}

export const DIRECTIONS: readonly Direction[] = ["up", "down", "left", "right"]

export const asDirection = (value: unknown): Direction => {
  if (typeof value === "string" && (DIRECTIONS as readonly string[]).includes(value)) return value as Direction
  return fail("INVALID_ARGUMENT", `direction must be one of ${DIRECTIONS.join(", ")}.`)
}
