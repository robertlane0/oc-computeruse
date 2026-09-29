import type { Info as ToolInfo, Result as ToolResult } from "@opencode/plugin/promise/tool"
import { describe, fail, toError } from "../errors.ts"
import { type Button, isButton, type Modifier, isModifier } from "../keys.ts"
import type { Options } from "../options.ts"
import type { EiSession, ScreenInfo } from "../session.ts"

export type Result = ToolResult<undefined>
export type ComputerTool = ToolInfo<any, undefined>
export type Deps = { options: Options; session: EiSession }
export type Json = Record<string, unknown>

/**
 * All tools share a namespace so the model sees `computer_click` rather than a
 * generic `click` that could collide with a built-in. `codemode: false` keeps
 * each one a direct native call, which is what input injection wants: the
 * shortest possible round trip.
 */
export const NAMESPACE = "computer"

export const NAMESPACE_DESCRIPTION =
  "Control the keyboard and mouse of a KDE Plasma Wayland desktop. Coordinates are LOGICAL desktop pixels with the origin at the top-left of the whole desktop, across every monitor including any to the left of or above the first. Call computer_screen first to learn the desktop size and each monitor's rectangle. If the screenshot you are looking at is a different pixel width than the desktop, multiply coordinates by desktop_width / screenshot_width, or pass a `relative` fraction of the desktop instead. Typed text goes to whichever window has keyboard focus, so click the target window first. The first action in a session raises a system 'Remote Control Requested' dialog that the user must approve."

/**
 * `permission` is the action a `deny` rule has to name to take the tool out of
 * the model's catalog, so it is the effective tool name. V2 gives plugins no
 * permission-prompt API, which makes configuration the supported gate.
 */
export const toolOptions = (name: string) =>
  ({ codemode: false, namespace: NAMESPACE, permission: `${NAMESPACE}_${name}` }) as const

/** Plain text result. These tools report in prose, so they have no output schema. */
export const text = (body: string, metadata?: Record<string, unknown>): Result => ({ content: body, metadata })

/** Never let a tool reject: a rejection is a defect that fails the whole step. */
export async function guard(fn: () => Promise<Result> | Result): Promise<Result> {
  try {
    return await fn()
  } catch (error) {
    const failure = toError(error)
    return text(describe(failure), { error: failure.code })
  }
}

// ------------------------------------------------------------------- schemas

/**
 * V2 takes a tool's `input` as plain JSON Schema and hands it to the model
 * verbatim, so these builders are the whole schema layer. `additionalProperties`
 * is false throughout: the host decodes the schema into a struct, and an unknown
 * key is a model mistake worth reporting rather than dropping.
 */
export const str = (description: string): Json => ({ type: "string", description })

export const number = (description: string): Json => ({ type: "number", description })

export const integer = (description: string, min: number, max: number): Json => ({
  type: "integer",
  minimum: min,
  maximum: max,
  description,
})

export const choice = (values: readonly string[], description: string): Json => ({
  type: "string",
  enum: [...values],
  description,
})

export const object = (properties: Json, required: readonly string[] = []): Json => ({
  type: "object",
  properties,
  required: [...required],
  additionalProperties: false,
})

export const array = (items: Json, description: string, min: number, max: number): Json => ({
  type: "array",
  items,
  minItems: min,
  maxItems: max,
  description,
})

export const RELATIVE: Json = {
  type: "object",
  description:
    "A point as a fraction of the desktop: 0,0 is the top-left corner and 1,1 the bottom-right. Unaffected by how the screenshot was scaled.",
  properties: {
    x: { type: "number", minimum: 0, maximum: 1 },
    y: { type: "number", minimum: 0, maximum: 1 },
  },
  required: ["x", "y"],
  additionalProperties: false,
}

export const MODIFIERS: Json = {
  type: "array",
  items: choice(["ctrl", "alt", "shift", "super"], "A modifier to hold down."),
  description: "Modifiers to hold while the action happens, released afterwards.",
}

export const COORDS: Json = {
  x: number("Desktop pixel column, counted from the left of the whole desktop."),
  y: number("Desktop pixel row, counted from the top of the whole desktop."),
  relative: RELATIVE,
}

export const BUTTON: Json = choice(["left", "right", "middle", "back", "forward"], "Which mouse button to use.")

// ------------------------------------------------------------------- decoding

export type Point = { x: number; y: number }

let desktop: ScreenInfo["desktop"] = { x: 0, y: 0, width: 0, height: 0 }

/** `computer_screen` is the coordinate anchor, so it records the last box it saw. */
export const rememberDesktop = (info: ScreenInfo): void => {
  desktop = info.desktop
}

export const knownDesktop = (): ScreenInfo["desktop"] => desktop

const inRange = (value: unknown, min: number, max: number, what = "value"): number => {
  if (typeof value !== "number" || !Number.isFinite(value)) {
    fail("INVALID_ARGUMENT", `${what} must be a number between ${min} and ${max}, got ${JSON.stringify(value)}.`)
  }
  return Math.min(max, Math.max(min, value))
}

const pair = (input: Json, a: string, b: string, what: string): { a: number; b: number } | undefined => {
  const first = input[a]
  const second = input[b]
  if (first === undefined && second === undefined) return undefined
  if (typeof first !== "number" || typeof second !== "number") {
    fail("INVALID_ARGUMENT", `Both ${a} and ${b} are needed for ${what}.`)
  }
  return { a: first, b: second }
}

/** Turns the two accepted ways of naming a point into desktop pixels. */
export function decodePoint(input: Json): Point | undefined {
  const relative = input.relative as { x?: unknown; y?: unknown } | undefined
  const pixels = pair(input, "x", "y", "a point in desktop pixels")
  if (pixels && relative !== undefined) {
    fail(
      "INVALID_ARGUMENT",
      "A target was given both in pixels and as a fraction.",
      "Give either x and y, or relative {x,y} — not both.",
    )
  }
  if (relative) {
    const box = desktop
    if (!box.width || !box.height) {
      fail(
        "INVALID_ARGUMENT",
        "A relative target was given but the desktop size is not known yet.",
        "Call computer_screen first, then use x and y.",
      )
    }
    return {
      x: box.x + inRange(relative.x, 0, 1, "relative.x") * box.width,
      y: box.y + inRange(relative.y, 0, 1, "relative.y") * box.height,
    }
  }
  return pixels ? { x: pixels.a, y: pixels.b } : undefined
}

export function decodeDelta(input: Json): Point | undefined {
  const delta = pair(input, "dx", "dy", "a movement")
  return delta ? { x: delta.a, y: delta.b } : undefined
}

export function decodeModifiers(value: unknown): Modifier[] {
  if (value === undefined) return []
  if (!Array.isArray(value)) fail("INVALID_ARGUMENT", "modifiers must be an array of modifier names.")
  const out: Modifier[] = []
  for (const entry of value as unknown[]) {
    if (typeof entry !== "string" || !isModifier(entry)) {
      fail("INVALID_ARGUMENT", `${JSON.stringify(entry)} is not a modifier.`, "Use ctrl, alt, shift or super.")
    }
    if (!out.includes(entry)) out.push(entry)
  }
  return out
}

export function decodeButton(value: unknown, fallback: Button): Button {
  if (value === undefined) return fallback
  if (typeof value !== "string" || !isButton(value)) {
    fail("INVALID_ARGUMENT", `${JSON.stringify(value)} is not a button.`, "Use left, right, middle, back or forward.")
  }
  return value
}
