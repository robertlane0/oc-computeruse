import { guard, rememberDesktop, text, toolOptions, type ComputerTool, type Deps } from "./common.ts"

/** Desktop geometry, session state and capabilities. The coordinate anchor. */
export const screenTool = (deps: Deps): ComputerTool => ({
  name: "screen",
  options: toolOptions("screen"),
  description:
    "Report the desktop geometry: the overall size, each monitor's rectangle and scale, which input devices the session has, and whether remote control is authorized. " +
    "Call this first in a session, and again after any change to the monitor layout, because every other tool takes coordinates in this space. " +
    "It is the only call that works before consent is granted and it never raises the system dialog itself.",
  input: { type: "object", properties: {}, required: [], additionalProperties: false },
  execute: async () =>
    guard(async () => {
      const info = deps.session.screen()
      rememberDesktop(info)
      return text(JSON.stringify(info, null, 2), { state: info.session.state })
    }),
})
