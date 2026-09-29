import { asDirection, run, type Action } from "./actions.ts"
import {
  BUTTON,
  COORDS,
  MODIFIERS,
  choice,
  decodeButton,
  decodeDelta,
  decodeModifiers,
  decodePoint,
  guard,
  integer,
  number,
  object,
  text,
  toolOptions,
  type ComputerTool,
  type Deps,
} from "./common.ts"

const CLICKS = integer("Clicks to send: 2 for a double-click, 3 for a triple-click. Default 1.", 1, 3)

const MOVE = "Move the pointer. Give exactly one of: x and y in desktop pixels, dx and dy to move from wherever the pointer already is, or relative {x,y} as a fraction of the desktop."

const CLICK =
  "Move to a point and click there, in one step. This is the tool to reach for almost always: it focuses the window it clicks, so anything typed or keyed afterwards goes to the right place. " +
  "count 2 double-clicks and count 3 triple-clicks. Use modifiers for the chords that open a context menu or extend a selection."

export const pointerTools = (deps: Deps): ComputerTool[] => [
  {
    name: "move",
    options: toolOptions("move"),
    description: MOVE,
    input: object(COORDS),
    execute: async (input) =>
      guard(async () => {
        const point = decodePoint(input)
        const delta = decodeDelta(input)
        if (!point && !delta) {
          return text(
            "No movement was given. Pass x and y for a position, dx and dy for a movement from here, or relative {x,y} for a fraction of the desktop.",
          )
        }
        return text(await run(deps, { kind: "move", point, delta }))
      }),
  },
  {
    name: "click",
    options: toolOptions("click"),
    description: CLICK,
    input: object({ ...COORDS, button: BUTTON, count: CLICKS, modifiers: MODIFIERS }),
    execute: async (input) =>
      guard(async () => {
        const action: Action = {
          kind: "click",
          button: decodeButton(input.button, deps.options.requestButton),
          count: typeof input.count === "number" ? input.count : 1,
          modifiers: decodeModifiers(input.modifiers),
          point: decodePoint(input),
        }
        return text(await run(deps, action))
      }),
  },
  {
    name: "mouse_down",
    options: toolOptions("mouse_down"),
    description:
      "Press a mouse button and leave it held, so the next computer_move becomes a drag. Finish with computer_mouse_up, or use computer_batch to interleave the moves in between.",
    input: object({ ...COORDS, button: BUTTON }),
    execute: async (input) =>
      guard(async () => {
        const action: Action = {
          kind: "mouse_down",
          button: decodeButton(input.button, deps.options.requestButton),
          point: decodePoint(input),
        }
        return text(await run(deps, action))
      }),
  },
  {
    name: "mouse_up",
    options: toolOptions("mouse_up"),
    description: "Release a mouse button held by computer_mouse_down, ending a drag.",
    input: object({ ...COORDS, button: BUTTON }),
    execute: async (input) =>
      guard(async () => {
        const action: Action = {
          kind: "mouse_up",
          button: decodeButton(input.button, deps.options.requestButton),
        }
        return text(await run(deps, action))
      }),
  },
  {
    name: "scroll",
    options: toolOptions("scroll"),
    description:
      "Scroll by whole wheel notches over whatever is under the pointer. direction is the way the content should move: down reveals what is below, up goes back. Point the pointer at the scrollable area first.",
    input: object(
      {
        direction: choice(["up", "down", "left", "right"], "The way the content should move."),
        notches: number("Whole wheel notches. Default 3."),
      },
      ["direction"],
    ),
    execute: async (input) =>
      guard(async () =>
        text(
          await run(deps, {
            kind: "scroll",
            direction: asDirection(input.direction),
            notches: typeof input.notches === "number" ? input.notches : 3,
          }),
        ),
      ),
  },
]
