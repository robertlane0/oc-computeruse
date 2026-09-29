import { fail } from "../errors.ts"
import { isButton, isModifier, type Button, type Modifier } from "../keys.ts"
import { type Direction, run, type Action } from "./actions.ts"
import { guard, knownDesktop, text, toolOptions, type ComputerTool, type Deps, type Json } from "./common.ts"

const DIRECTIONS = ["up", "down", "left", "right"]
const BUTTONS = ["left", "right", "middle", "back", "forward"]

const point = {
  type: "object",
  properties: {
    x: { type: "number", description: "Desktop pixel column." },
    y: { type: "number", description: "Desktop pixel row." },
    relative: {
      type: "object",
      description: "A fraction of the desktop, 0,0 top-left to 1,1 bottom-right.",
      properties: { x: { type: "number", minimum: 0, maximum: 1 }, y: { type: "number", minimum: 0, maximum: 1 } },
      required: ["x", "y"],
      additionalProperties: false,
    },
  },
  additionalProperties: false,
} as const

const button = { type: "string", enum: [...BUTTONS], description: "Which mouse button." } as const
const buttonProp = { button, ...point.properties } as Json

const action = (kind: string, description: string, properties: Json = {}, required: string[] = []) => ({
  type: "object",
  description,
  properties: { action: { type: "string", const: kind, description: `This is a ${kind} action.` }, ...properties },
  required: ["action", ...required],
  additionalProperties: false,
})

/** One entry of a batch. The `action` field is the discriminator. */
const ACTION: Json = {
  oneOf: [
    action("move", "Move the pointer to x,y, or by dx,dy, or to a relative fraction.", {
      ...point.properties,
      dx: { type: "number", description: "Pixels to move right; negative is left." },
      dy: { type: "number", description: "Pixels to move down; negative is up." },
    }),
    action("click", "Move to a point and click there.", { ...buttonProp, count: { type: "integer", minimum: 1, maximum: 3, description: "Clicks to send." }, modifiers: { $ref: "#/$defs/modifiers" } }),
    action("mouse_down", "Press a mouse button and hold it, starting a drag.", buttonProp),
    action("mouse_up", "Release a mouse button held by mouse_down.", { button }),
    action("scroll", "Scroll by wheel notches.", { direction: { type: "string", enum: [...DIRECTIONS], description: "The way content should move." }, notches: { type: "number", minimum: 1, description: "Whole notches; default 3." } }, ["direction"]),
    action("type", "Type a string of text.", { text: { type: "string", description: "The text to type." } }, ["text"]),
    action("key", "Press a key or chord, e.g. enter or ctrl+c.", { key: { type: "string", description: "Key name or plus-signed chord." }, modifiers: { $ref: "#/$defs/modifiers" } }, ["key"]),
    action("key_down", "Hold a key down.", { key: { type: "string", description: "Key name." } }, ["key"]),
    action("key_up", "Release a held key.", { key: { type: "string", description: "Key name." } }, ["key"]),
    action("wait", "Pause before the next action.", { ms: { type: "integer", minimum: 0, maximum: 10_000, description: "Milliseconds." } }, ["ms"]),
  ],
}

const SCHEMA: Json = {
  type: "object",
  properties: {
    actions: {
      type: "array",
      description: "The actions to run, in order.",
      minItems: 1,
      maxItems: 200,
      items: ACTION,
    },
  },
  required: ["actions"],
  additionalProperties: false,
  $defs: { modifiers: { type: "array", items: { type: "string", enum: ["ctrl", "alt", "shift", "super"] }, description: "Modifiers to hold for this action." } },
}

const pointOf = (entry: Record<string, unknown>): { x: number; y: number } | undefined => {
  const box = knownDesktop()
  const relative = entry.relative as { x?: unknown; y?: unknown } | undefined
  if (relative && typeof relative.x === "number" && typeof relative.y === "number") {
    if (!box.width || !box.height) {
      return fail(
        "INVALID_ARGUMENT",
        "A relative target was used but the desktop size is not known yet.",
        "Call computer_screen first, then use x and y.",
      )
    }
    return { x: box.x + relative.x * box.width, y: box.y + relative.y * box.height }
  }
  if (typeof entry.x === "number" && typeof entry.y === "number") return { x: entry.x, y: entry.y }
  return undefined
}

const mods = (value: unknown, at: string): Modifier[] => {
  if (value === undefined) return []
  if (!Array.isArray(value)) return fail("INVALID_ARGUMENT", `${at}: modifiers must be an array.`)
  const out: Modifier[] = []
  for (const entry of value) {
    if (typeof entry !== "string" || !isModifier(entry)) {
      return fail("INVALID_ARGUMENT", `${at}: ${JSON.stringify(entry)} is not a modifier.`, "Use ctrl, alt, shift or super.")
    }
    if (!out.includes(entry)) out.push(entry)
  }
  return out
}

const buttonOf = (value: unknown, at: string, fallback: Button): Button => {
  if (value === undefined) return fallback
  if (typeof value !== "string" || !isButton(value)) {
    return fail("INVALID_ARGUMENT", `${at}: ${JSON.stringify(value)} is not a button.`, `Use ${BUTTONS.join(", ")}.`)
  }
  return value
}

const decode = (raw: unknown, index: number, deps: Deps): Action => {
  const at = `Action ${index}`
  if (!raw || typeof raw !== "object") return fail("INVALID_ARGUMENT", `${at} is not an object.`)
  const entry = raw as Record<string, unknown>
  const kind = String(entry.action ?? "")
  const defaultButton = deps.options.requestButton

  switch (kind) {
    case "move": {
      if (typeof entry.dx === "number" || typeof entry.dy === "number") {
        return { kind: "move", delta: { x: (entry.dx as number) ?? 0, y: (entry.dy as number) ?? 0 } }
      }
      const target = pointOf(entry)
      if (!target) {
        return fail("INVALID_ARGUMENT", `${at}: a move needs x and y, dx and dy, or relative.`)
      }
      return { kind: "move", point: target }
    }
    case "click":
      return {
        kind: "click",
        button: buttonOf(entry.button, at, defaultButton),
        count: typeof entry.count === "number" ? Math.min(3, Math.max(1, entry.count)) : 1,
        modifiers: mods(entry.modifiers, at),
        point: pointOf(entry),
      }
    case "mouse_down":
      return { kind: "mouse_down", button: buttonOf(entry.button, at, defaultButton), point: pointOf(entry) }
    case "mouse_up":
      return { kind: "mouse_up", button: buttonOf(entry.button, at, defaultButton) }
    case "scroll": {
      if (typeof entry.direction !== "string" || !(DIRECTIONS as string[]).includes(entry.direction)) {
        return fail("INVALID_ARGUMENT", `${at}: direction must be one of ${DIRECTIONS.join(", ")}.`)
      }
      return {
        kind: "scroll",
        direction: entry.direction as Direction,
        notches: typeof entry.notches === "number" ? Math.min(100, Math.max(1, entry.notches)) : 3,
      }
    }
    case "type":
      if (typeof entry.text !== "string") return fail("INVALID_ARGUMENT", `${at}: type needs a text field.`)
      return { kind: "type", text: entry.text }
    case "key": {
      if (typeof entry.key !== "string" || !entry.key) return fail("INVALID_ARGUMENT", `${at}: key needs a key name.`)
      return { kind: "key", key: entry.key, modifiers: mods(entry.modifiers, at) }
    }
    case "key_down":
    case "key_up": {
      if (typeof entry.key !== "string" || !entry.key) return fail("INVALID_ARGUMENT", `${at}: ${kind} needs a key name.`)
      return { kind, key: entry.key }
    }
    case "wait": {
      const ms = typeof entry.ms === "number" ? entry.ms : 0
      return { kind: "wait", ms: Math.min(10_000, Math.max(0, ms)) }
    }
    default:
      return fail(
        "INVALID_ARGUMENT",
        `${at}: "${kind}" is not an action.`,
        "Use move, click, mouse_down, mouse_up, scroll, type, key, key_down, key_up or wait.",
      )
  }
}

export const batchTool = (deps: Deps): ComputerTool => ({
  name: "batch",
  options: toolOptions("batch"),
  description:
    "Run several actions in order in a single call, stopping at the first failure. Prefer this over a chain of separate calls whenever the steps are known up front: " +
    "it costs one round trip instead of one per action, the ordering is guaranteed, and a wait between steps can be expressed as an action. " +
    "Each entry names its action: move, click, mouse_down, mouse_up, scroll, type, key, key_down, key_up or wait. " +
    "The report lists what each action did, or names the index that failed and how many had already completed.",
  input: SCHEMA,
  execute: async (input) =>
    guard(async () => {
      const raw = Array.isArray(input.actions) ? (input.actions as unknown[]) : []
      if (raw.length === 0) return text("No actions were given.")
      if (raw.length > deps.options.maxBatchActions) {
        return text(`A batch may hold at most ${deps.options.maxBatchActions} actions; ${raw.length} were given.`)
      }
      const done: string[] = []
      const started = Date.now()
      for (const [index, item] of raw.entries()) {
        if (Date.now() - started > deps.options.maxBatchMs) {
          return text(
            `Stopped after ${done.length} of ${raw.length} actions: the batch exceeded its ${Math.round(deps.options.maxBatchMs / 1000)}s budget. Send smaller batches.`,
          )
        }
        try {
          done.push(await run(deps, decode(item, index, deps)))
        } catch (error) {
          const message = error instanceof Error ? error.message : String(error)
          const head = done.length
            ? `${done.length} action(s) completed first:\n${done.map((line) => `  ${line}`).join("\n")}\n`
            : ""
          return text(`${head}Action ${index} (${kindOf(item)}) failed, and the remaining ${raw.length - index - 1} action(s) were skipped: ${message}`)
        }
      }
      return text(`Completed ${done.length} action(s):\n${done.map((line) => `  ${line}`).join("\n")}`)
    }),
})

const kindOf = (item: unknown): string =>
  item && typeof item === "object" && typeof (item as Record<string, unknown>).action === "string"
    ? String((item as Record<string, unknown>).action)
    : "?"
