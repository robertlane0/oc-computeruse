import { describe, expect, test } from "bun:test"
import { ComputerUseError, describe as render, fail, toError } from "../src/errors.ts"
import { BUTTON_CODE, KEY_NAMES, MODIFIER_CODE, canonicalName, keyCode, parseChord } from "../src/keys.ts"
import { ALL_DEVICES, DEVICE_MASK, deviceMask, parseOptions } from "../src/options.ts"

const chord = (input: string) => parseChord(input)

describe("options", () => {
  test("defaults cover every device and a patient consent timeout", () => {
    const options = parseOptions(undefined)
    expect(options.devices).toEqual(ALL_DEVICES)
    expect(options.authorizeTimeoutMs).toBe(30_000)
    expect(options.requestButton).toBe("left")
    expect(options.trace).toBe(false)
  })

  test("numbers arrive as strings from JSON config and are still clamped", () => {
    const options = parseOptions({ authorizeTimeoutMs: "5000", defaultTypeDelayMs: 9999, maxBatchActions: 0 })
    expect(options.authorizeTimeoutMs).toBe(5_000)
    expect(options.defaultTypeDelayMs).toBe(500)
    expect(options.maxBatchActions).toBe(1)
  })

  test("a nonsense value falls back instead of disabling the plugin", () => {
    const options = parseOptions({ authorizeTimeoutMs: "soon", trace: "yes", requestButton: "heel" })
    expect(options.authorizeTimeoutMs).toBe(30_000)
    expect(options.trace).toBe(false)
    expect(options.requestButton).toBe("left")
  })

  test("devices accept the pipe-separated and array forms", () => {
    expect(parseOptions({ devices: "pointer|keyboard" }).devices).toEqual(["keyboard", "pointer"])
    expect(parseOptions({ devices: ["pointer"] }).devices).toEqual(["pointer"])
    expect(parseOptions({ devices: "touch" }).devices).toEqual(["touchscreen"])
  })

  test("an empty or unknown device list does not request nothing", () => {
    expect(parseOptions({ devices: "" }).devices).toEqual(ALL_DEVICES)
    expect(parseOptions({ devices: "telepathy" }).devices).toEqual(ALL_DEVICES)
  })

  test("the portal bitmask is the union of the requested devices", () => {
    expect(deviceMask(["keyboard"])).toBe(DEVICE_MASK.keyboard)
    expect(deviceMask(["keyboard", "pointer"])).toBe(3)
    expect(deviceMask(ALL_DEVICES)).toBe(7)
  })
})

describe("named keys", () => {
  test("canonical names resolve to evdev codes", () => {
    expect(keyCode("enter")).toBe(28)
    expect(keyCode("escape")).toBe(1)
    expect(keyCode("f1")).toBe(59)
    expect(keyCode("f24")).toBe(82)
    expect(keyCode("space")).toBe(57)
  })

  test("aliases are accepted and normalised", () => {
    expect(keyCode("return")).toBe(keyCode("enter"))
    expect(keyCode("esc")).toBe(keyCode("escape"))
    expect(keyCode("CMD")).toBe(keyCode("super"))
    expect(canonicalName("cmd")).toBe("super")
  })

  test("modifiers are the left-hand keys", () => {
    expect(MODIFIER_CODE).toEqual({ ctrl: 29, alt: 56, shift: 42, super: 125 })
  })

  test("buttons are the standard evdev codes", () => {
    expect(BUTTON_CODE).toEqual({ left: 0x110, right: 0x111, middle: 0x112, back: 0x113, forward: 0x114 })
  })

  test("an unknown key names the real ones and suggests a near miss", () => {
    let thrown: unknown
    try {
      keyCode("enterr")
    } catch (error) {
      thrown = error
    }
    const error = toError(thrown)
    expect(error.code).toBe("UNSUPPORTED_KEY")
    expect(error.remedy).toContain("enter")
    expect(error.remedy).toContain("escape")
  })
})

describe("chords", () => {
  test("a bare name has no modifiers", () => {
    expect(chord("enter")).toEqual({ modifiers: [], key: "enter" })
  })

  test("a plus-signed chord is split", () => {
    expect(chord("ctrl+c")).toEqual({ modifiers: ["ctrl"], key: "c" })
    expect(chord("ctrl+shift+t")).toEqual({ modifiers: ["ctrl", "shift"], key: "t" })
  })

  test("modifiers always come down in a fixed order", () => {
    expect(chord("shift+ctrl+alt+super+k").modifiers).toEqual(["ctrl", "alt", "shift", "super"])
    expect(chord("super+alt+shift+ctrl+k").modifiers).toEqual(["ctrl", "alt", "shift", "super"])
  })

  test("a repeat is collapsed", () => {
    expect(chord("ctrl+ctrl+c").modifiers).toEqual(["ctrl"])
  })

  test("spaces and underscores both separate a chord", () => {
    expect(chord("ctrl + shift + k").modifiers).toEqual(["ctrl", "shift"])
    expect(chord("ctrl_shift_t").modifiers).toEqual(["ctrl", "shift"])
  })

  test("modifiers only is a hold on the last one named", () => {
    expect(chord("shift")).toEqual({ modifiers: [], key: "shift" })
    expect(chord("ctrl+shift")).toEqual({ modifiers: ["ctrl"], key: "shift" })
  })

  test("two keys in one string is refused rather than half done", () => {
    expect(toError(caught(() => chord("a+b"))).code).toBe("UNSUPPORTED_KEY")
  })

  test("an empty key is refused", () => {
    expect(toError(caught(() => chord("   "))).code).toBe("UNSUPPORTED_KEY")
  })
})

describe("error rendering", () => {
  test("every failure reads as code, message and remedy", () => {
    const rendered = render(new ComputerUseError("OUT_OF_BOUNDS", "(9000, 5) is not on any monitor.", "Pick a smaller x."))
    expect(rendered).toContain("OUT_OF_BOUNDS")
    expect(rendered).toContain("(9000, 5) is not on any monitor.")
    expect(rendered).toContain("Try: Pick a smaller x.")
  })

  test("a plain throw is still rendered rather than escaping", () => {
    expect(render(new Error("boom"))).toContain("boom")
    expect(render("a string")).toContain("a string")
  })

  test("rendering never throws", () => {
    expect(() => render(undefined)).not.toThrow()
  })
})

function caught(fn: () => unknown): unknown {
  try {
    fn()
  } catch (error) {
    return error
  }
  return new ComputerUseError("INVALID_ARGUMENT", "expected a throw")
}

test("the published key list is sorted and non-empty", () => {
  expect(KEY_NAMES.length).toBeGreaterThan(80)
  expect([...KEY_NAMES].sort()).toEqual([...KEY_NAMES])
})

test("fail always throws a ComputerUseError", () => {
  expect(caught(() => fail("BUSY", "later"))).toBeInstanceOf(ComputerUseError)
})
