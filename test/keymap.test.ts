import { describe, expect, test } from "bun:test"
import { parseKeymap, placementFor } from "../src/keymap.ts"
import { codepointFor, keysymFor } from "../src/keys.ts"
import { readFileSync } from "node:fs"
import { join } from "node:path"

const us = parseKeymap(readFileSync(join(import.meta.dir, "fixtures", "us.xkb"), "utf8"))

describe("keysym conversion", () => {
  test("Latin-1 codepoints are their own keysym", () => {
    expect(keysymFor(0x41)).toBe(0x41)
    expect(keysymFor(0xe9)).toBe(0xe9)
  })

  test("above Latin-1 the keysym moves to the Unicode block", () => {
    expect(keysymFor(0x3a9)).toBe(0x010003a9)
    expect(codepointFor(keysymFor(0x3a9))).toBe(0x3a9)
  })
})

describe("keymap parser", () => {
  test("finds the keycodes section", () => {
    expect(us.keycodes).toBeGreaterThan(200)
  })

  test("resolves a plain letter to its evdev code at level 0", () => {
    // AE01 in XKB is evdev KEY_1, keycode 10, so code 2.
    expect(placementFor(us, "1".codePointAt(0)!)).toEqual({ code: 2, level: 0 })
    // AD01 is KEY_Q, keycode 24, so code 16.
    expect(placementFor(us, "q".codePointAt(0)!)).toEqual({ code: 16, level: 0 })
  })

  test("resolves a shifted character to level 1", () => {
    expect(placementFor(us, "!".codePointAt(0)!)).toEqual({ code: 2, level: 1 })
    expect(placementFor(us, "Q".codePointAt(0)!)).toEqual({ code: 16, level: 1 })
  })

  test("maps every printable ASCII character the layout claims", () => {
    const printable = Array.from({ length: 95 }, (_, i) => String.fromCharCode(0x20 + i))
    const missing = printable.filter((character) => !placementFor(us, character.codePointAt(0)!))
    expect(missing).toEqual([])
  })

  test("reports characters the layout cannot produce", () => {
    expect(placementFor(us, "é".codePointAt(0)!)).toBeUndefined()
    expect(placementFor(us, 0x1f30d)).toBeUndefined()
  })

  test("the cheapest placement wins when a keysym appears on several levels", () => {
    // The US layout repeats BackSpace on levels 0 and 1; level 0 needs no
    // modifier, so it is the one to send.
    const backspace = us.index.get(0xff08)
    expect(backspace?.[0]?.level).toBe(0)
    expect(backspace).toHaveLength(2)
  })
  test("every keysym sits on a level the modifier table can reach", () => {
    for (const [keysym, placements] of us.index) {
      for (const placement of placements) {
        expect(placement.level).toBeGreaterThanOrEqual(0)
        expect(placement.level).toBeLessThanOrEqual(3)
      }
      expect(codepointFor(keysym)).toBeGreaterThan(0)
    }
  })
})

describe("keymap parser edge cases", () => {
  // The fixtures below use numeric keysyms because that is what the
  // XKB_KEYMAP_FORMAT_TEXT_V1 serialisation actually contains.
  test("an empty keymap yields nothing rather than throwing", () => {
    const empty = parseKeymap("")
    expect(empty.keycodes).toBe(0)
    expect(empty.index.size).toBe(0)
  })

  test("comments are ignored", () => {
    const map = parseKeymap(`
      xkb_keycodes "t" { <A> = 38; };   // trailing comment
      xkb_symbols "t" { key <A> { [ 0x61, 0x41 ] }; };
    `)
    expect(placementFor(map, 0x61)).toEqual({ code: 30, level: 0 })
  })

  test("NoSymbol keeps its level so later symbols are not shifted down", () => {
    const map = parseKeymap(`
      xkb_keycodes "t" { <A> = 38; };
      xkb_symbols "t" { key <A> { [ NoSymbol, 0x62 ] }; };
    `)
    expect(placementFor(map, 0x61)).toBeUndefined()
    expect(placementFor(map, 0x62)).toEqual({ code: 30, level: 1 })
  })

  test("an override replaces an earlier definition of the same key", () => {
    const map = parseKeymap(`
      xkb_keycodes "t" { <A> = 38; };
      xkb_symbols "t" {
        key <A> { [ 0x61 ] };
        override key <A> { [ 0x62 ] };
      };
    `)
    expect(placementFor(map, 0x61)).toBeUndefined()
    expect(placementFor(map, 0x62)).toEqual({ code: 30, level: 0 })
  })

  test("a key with no keycode entry is skipped", () => {
    const map = parseKeymap(`xkb_symbols "t" { key <MISSING> { [ 0x61 ] }; };`)
    expect(map.index.size).toBe(0)
  })

  test("levels past AltGr are left out rather than typed wrongly", () => {
    const map = parseKeymap(`
      xkb_keycodes "t" { <A> = 38; };
      xkb_symbols "t" { key <A> { [ 0x61, 0x41, 0x78, 0x58, 0x79 ] }; };
    `)
    expect(placementFor(map, 0x78)).toEqual({ code: 30, level: 2 })
    expect(placementFor(map, 0x79)).toBeUndefined()
  })

  test("a group assignment is read instead of the group number", () => {
    const map = parseKeymap(`
      xkb_keycodes "t" { <BKSP> = 22; };
      xkb_symbols "t" {
        key <BKSP> {
          type= "CTRL+ALT",
          symbols[1]= [ 0xff08, 0xff08, NoSymbol, NoSymbol, 0xfed5 ]
        };
      };
    `)
    // 0xff08 is backspace, and it sits on levels 0 and 1.
    expect(map.index.get(0xff08)?.map((entry) => entry.level)).toEqual([0, 1])
    // The level-4 keysym needs a modifier this plugin cannot name.
    expect(map.index.get(0xfed5)).toBeUndefined()
    // The group index itself must never be mistaken for a keysym.
    expect(map.index.get(1)).toBeUndefined()
  })

  test("a group-conditional key still yields its first group", () => {
    const map = parseKeymap(`
      xkb_keycodes "t" { <A> = 38; };
      xkb_symbols "t" { key <A> { symbols[Group1] = [ 0x61 ], symbols[Group2] = [ 0x62 ] }; };
    `)
    expect(placementFor(map, 0x61)).toEqual({ code: 30, level: 0 })
    expect(placementFor(map, 0x62)).toBeUndefined()
  })
})
