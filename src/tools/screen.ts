import { guard, rememberDesktop, text, toolOptions, type ComputerTool, type Deps } from "./common.ts"

/**
 * Desktop geometry, session state and capabilities. This is also the handshake:
 * the geometry only exists once there is a session, so this is the call that
 * raises the consent dialog and the first one to make in any session.
 */
export const screenTool = (deps: Deps): ComputerTool => ({
  name: "screen",
  options: toolOptions("screen"),
  description:
    "Open the remote-control session if it is not open yet, and report the desktop geometry: the overall size, each monitor's rectangle and scale, which input devices are available, and whether control is authorized. " +
    "Call this first in every session, and again after any change to the monitor layout, because every other tool takes coordinates in this space and there is no other way to learn it. " +
    "The first call shows a system 'Remote Control Requested' dialog that the user must approve; a refusal or a timeout is reported here as an error.",
  input: { type: "object", properties: {}, required: [], additionalProperties: false },
  execute: async () =>
    guard(async () => {
      await deps.session.ready()
      const info = deps.session.screen()
      rememberDesktop(info)
      return text(JSON.stringify(info, null, 2), { state: info.session.state })
    }),
})
