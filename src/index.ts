import { batchTool } from "./tools/batch.ts"
import { NAMESPACE, NAMESPACE_DESCRIPTION } from "./tools/common.ts"
import { keyboardTools } from "./tools/keyboard.ts"
import { pointerTools } from "./tools/pointer.ts"
import { screenTool } from "./tools/screen.ts"
import { parseOptions } from "./options.ts"
import { EiSession } from "./session.ts"
import type { Plugin } from "@opencode/plugin"

export const ID = "computeruse"

/**
 * OpenCode v2 plugin shape: a stable `id` and a `setup(ctx)` that registers its
 * tools through a synchronous transform. The returned cleanup runs on unload,
 * which is where the RemoteDesktop session is torn down.
 */
export const ComputerUsePlugin = {
  id: ID,
  setup(ctx: Plugin.Context) {
    const options = parseOptions(ctx.options)
    const session = new EiSession(options)
    const deps = { options, session }
    return ctx.tool
      .transform((editor) => {
        editor.namespace({ name: NAMESPACE, description: NAMESPACE_DESCRIPTION })
        editor.add(screenTool(deps))
        for (const tool of pointerTools(deps)) editor.add(tool)
        for (const tool of keyboardTools(deps)) editor.add(tool)
        editor.add(batchTool(deps))
      })
      .then(() => () => session.close())
  },
} satisfies Plugin.Plugin

export default ComputerUsePlugin
