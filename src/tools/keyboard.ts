import { run, type Action } from "./actions.ts"
import { decodeModifiers, guard, object, str, text, toolOptions, MODIFIERS, type ComputerTool, type Deps } from "./common.ts"

const KEY = str('A key name such as "enter", "tab", "escape", "backspace", "f5", "up" or "ctrl", or a chord written with plus signs such as "ctrl+c".')

const HELD_KEY = str('Key name, e.g. "ctrl", "shift" or "super".')

const CHORD =
  'Press one key, optionally with modifiers held. The key is a name such as "enter", "tab", "escape", "backspace", "f5", or a direction written as up, down, left or right. A chord can be written with plus signs in one string, as in "ctrl+c" or "ctrl+shift+t", or spelled out with the modifiers field.'

export const keyboardTools = (deps: Deps): ComputerTool[] => [
  {
    name: "type",
    options: toolOptions("type"),
    description:
      "Type a string into the window that has keyboard focus. Newlines press Enter. Uses the compositor's own text input when it offers one, otherwise the active keyboard layout, and reports any character the layout cannot produce rather than dropping it silently. " +
      "Click the target window first, or the text goes wherever focus already is.",
    input: object({ text: str("The text to type.") }, ["text"]),
    execute: async (input) =>
      guard(async () => {
        const body = typeof input.text === "string" ? input.text : ""
        if (!body) return text("Nothing was typed: the text was empty.")
        return text(await run(deps, { kind: "type", text: body }))
      }),
  },
  {
    name: "key",
    options: toolOptions("key"),
    description: CHORD,
    input: object({ key: KEY, modifiers: MODIFIERS }, ["key"]),
    execute: async (input) =>
      guard(async () => {
        const action: Action = {
          kind: "key",
          key: String(input.key ?? ""),
          modifiers: decodeModifiers(input.modifiers),
        }
        return text(await run(deps, action))
      }),
  },
  {
    name: "key_down",
    options: toolOptions("key_down"),
    description:
      "Hold a key down without releasing it, for a chord that needs something in the middle, such as ctrl held while clicking. Release it with computer_key_up.",
    input: object({ key: HELD_KEY }, ["key"]),
    execute: async (input) =>
      guard(async () => text(await run(deps, { kind: "key_down", key: String(input.key ?? "") }))),
  },
  {
    name: "key_up",
    options: toolOptions("key_up"),
    description: "Release a key that computer_key_down is holding down.",
    input: object({ key: HELD_KEY }, ["key"]),
    execute: async (input) =>
      guard(async () => text(await run(deps, { kind: "key_up", key: String(input.key ?? "") }))),
  },
]
