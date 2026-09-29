/**
 * Live harness. Runs the real backend against the real compositor, so it needs
 * a Plasma Wayland session and a human to approve the consent dialog once.
 *
 *   OC_COMPUTERUSE_LIVE=1 bun run test/live.ts
 *
 * Environment:
 *   OC_COMPUTERUSE_LIVE_AT   "x,y" to point at and click before acting, so the
 *                            keyboard and drag steps land somewhere harmless.
 *                            Defaults to the middle of the primary monitor.
 *   OC_COMPUTERUSE_LIVE_WRITE=1
 *                            Also run the steps that change things: clicks,
 *                            drags, typing, keys and chords. Without it the
 *                            harness only reports geometry and bounds handling.
 *
 * Every step is named and printed as it runs. Never run this in CI.
 */
import { MODIFIER_CODE, keyCode } from "../src/keys.ts"
import { parseOptions } from "../src/options.ts"
import { EiSession } from "../src/session.ts"

if (process.env.OC_COMPUTERUSE_LIVE !== "1") {
  console.log("Set OC_COMPUTERUSE_LIVE=1 to run the live harness.")
  process.exit(0)
}

const session = new EiSession(parseOptions({ trace: true, defaultTypeDelayMs: 0 }))
const step = (name: string) => console.log(`\n=== ${name}`)
const pause = (ms: number) => new Promise((resolve) => setTimeout(resolve, ms))
const write = process.env.OC_COMPUTERUSE_LIVE_WRITE === "1"

/** A press and release with a gap, the way a real wheel click behaves. */
const click = async () => {
  session.button("left", true)
  await pause(60)
  session.button("left", false)
  await pause(60)
}

const chord = (modifier: keyof typeof MODIFIER_CODE, name: string, extra?: keyof typeof MODIFIER_CODE) => {
  for (const held of [modifier, extra]) {
    if (held) session.key(MODIFIER_CODE[held], true, held)
  }
  session.key(keyCode(name), true, name)
  session.key(keyCode(name), false, name)
  for (const held of [extra, modifier]) {
    if (held) session.key(MODIFIER_CODE[held], false, held)
  }
}

try {
  step("connect; approve the Remote Control dialog when it appears")
  await session.ready()
  const info = session.screen()
  console.log(JSON.stringify(info, null, 2))

  const box = info.desktop
  const at = (x: number, y: number) => ({ x: box.x + Math.round(box.width * x), y: box.y + Math.round(box.height * y) })

  step("absolute move to the middle, then a relative move back and forth")
  session.moveTo(at(0.5, 0.5).x, at(0.5, 0.5).y)
  session.moveBy(0, -200)
  session.moveBy(0, 200)

  step("a point outside every monitor is refused, and the message names them")
  try {
    session.moveTo(box.x + box.width + 10_000, box.y + box.height + 10_000)
  } catch (error) {
    console.log((error as Error).message)
  }

  step("scroll down five notches, then up five; the target should return to where it was")
  session.scroll("down", 5)
  await pause(800)
  session.scroll("up", 5)
  await pause(800)
  if (write) {
    session.scroll("right", 2)
    await pause(600)
    session.scroll("left", 2)
    await pause(600)
  }

  if (!write) {
    step("done; set OC_COMPUTERUSE_LIVE_WRITE=1 to run the steps that change things")
  } else {
    const target = process.env.OC_COMPUTERUSE_LIVE_AT?.split(",").map(Number)
    const at2 = target?.length === 2 ? { x: target[0]!, y: target[1]! } : at(0.5, 0.5)
    step(`click the target at ${at2.x},${at2.y} to give it the focus, then double click`)
    session.moveTo(at2.x, at2.y)
    await pause(300)
    await click()
    await click()
    await click()
    await pause(400)

    step("drag: press, eight moves to the right, release")
    session.button("left", true)
    for (let i = 0; i < 8; i++) {
      session.moveBy(12, 0)
      await pause(40)
    }
    session.button("left", false)
    await pause(300)

    step("type through the active layout")
    console.log(await session.type("Hello, world! 123"))

    step("type characters the layout cannot produce, and check they are reported")
    console.log(await session.type("héllo ø Ωmega 🌍"))

    step("named keys")
    for (const name of ["enter", "tab", "escape", "backspace", "f5", "up", "down", "left", "right"]) {
      session.key(keyCode(name), true, name)
      session.key(keyCode(name), false, name)
      await pause(150)
    }

    step("chords")
    chord("ctrl", "c")
    chord("ctrl", "t", "shift")
    chord("super", "e")

    step("a key held across a click")
    session.key(MODIFIER_CODE.shift, true, "shift")
    await click()
    session.key(MODIFIER_CODE.shift, false, "shift")

    step("done")
  }
} catch (error) {
  console.error(`\nlive harness failed: ${(error as Error).message}`)
  process.exitCode = 1
} finally {
  session.close()
}
