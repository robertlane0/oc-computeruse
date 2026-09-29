import { keysymFor } from "./keys.ts"

/** One place a keysym can be typed from. */
export type Placement = {
  /** evdev code; XKB keycodes are always evdev + 8. */
  code: number
  /** 0 = plain, 1 = shift, 2 = altgr, 3 = altgr+shift. */
  level: number
}

export type Keymap = {
  /** keysym value to every placement that produces it, lowest level first. */
  index: Map<number, Placement[]>
  keycodes: number
}

const XKB_OFFSET = 8

const strip = (text: string): string =>
  text
    .split("\n")
    .map((line) => {
      const at = line.indexOf("//")
      return at === -1 ? line : line.slice(0, at)
    })
    .join("\n")

const block = (text: string, name: string): string => {
  const start = text.indexOf(`xkb_${name}`)
  if (start === -1) return ""
  const open = text.indexOf("{", start)
  let depth = 0
  for (let i = open; i < text.length; i++) {
    if (text[i] === "{") depth++
    else if (text[i] === "}" && --depth === 0) return text.slice(open + 1, i)
  }
  return text.slice(open + 1)
}

/**
 * The keysyms of one key entry, in level order. A key may list its symbols
 * inline or assign them per group, written either `symbols[1] =` or
 * `symbols[Group1] =`; either way the first group is the one the compositor is
 * in. Placeholders such as `NoSymbol` still occupy their level, so later
 * symbols must not slide down.
 */
function levelsOf(body: string): number[] {
  const assigned = [...body.matchAll(/symbols\s*\[\s*(?:Group)?(\d+)\s*\]\s*=\s*\[([^\]]*)\]/g)].sort(
    (a, b) => Number(a[1]) - Number(b[1]),
  )
  // A bare bracket group only counts when the entry has no explicit assignment,
  // otherwise the group number itself would be read as a keysym.
  const list = assigned[0]?.[2] ?? body.replace(/symbols\s*\[[^\]]*\]/g, "").match(/\[([^\]]*)\]/)?.[1] ?? ""
  return list
    .split(",")
    .map((token) => {
      const value = token.trim()
      if (value === "" || /^(NoSymbol|VoidSymbol)$/i.test(value) || value === "0" || value === "0x0") return 0
      return Number(value)
    })
}

/**
 * Reads an `XKB_KEYMAP_FORMAT_TEXT_V1` keymap: the keycode section gives
 * `<name> = <code>` and the symbols section gives the per-level keysyms. The
 * serialised form carries numeric keysyms, so no keysym name table is needed.
 * A later definition of a key wins, which is what `override` means.
 */
export function parseKeymap(source: string): Keymap {
  const text = strip(source)
  const keycodes = new Map<string, number>()
  let count = 0
  for (const match of block(text, "keycodes").matchAll(/<\s*([\w-]+)\s*>\s*=\s*(\d+)\s*;/g)) {
    const code = Number(match[2])
    if (code >= XKB_OFFSET) {
      keycodes.set(match[1]!, code)
      count++
    }
  }

  const symbols = new Map<string, number[]>()
  for (const match of block(text, "symbols").matchAll(/key\s*<\s*([\w-]+)\s*>\s*\{([^}]*)\}/g)) {
    symbols.set(match[1]!, levelsOf(match[2]!))
  }

  const index = new Map<number, Placement[]>()
  for (const [name, levels] of symbols) {
    const keycode = keycodes.get(name)
    if (keycode === undefined) continue
    levels.forEach((keysym, level) => {
      // Level 4 and beyond need a modifier this plugin cannot name, so a
      // character living only there is reported rather than typed wrongly.
      if (!keysym || level > 3) return
      const list = index.get(keysym) ?? []
      if (!list.some((entry) => entry.level === level)) {
        list.push({ code: keycode - XKB_OFFSET, level })
        list.sort((a, b) => a.level - b.level)
        index.set(keysym, list)
      }
    })
  }

  return { index, keycodes: count }
}

/** The evdev code and modifier level for a character, or undefined. */
export function placementFor(keymap: Keymap, codepoint: number): Placement | undefined {
  return keymap.index.get(keysymFor(codepoint))?.[0]
}
