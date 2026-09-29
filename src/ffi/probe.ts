import { readdirSync, readFileSync } from "node:fs"
import { join } from "node:path"
import { fail } from "../errors.ts"

export type SessionInfo = {
  type: string
  desktop: string
  hasKwin: boolean
  bus: string
}

/**
 * The one probe that needs no FFI and no subprocess: environment plus a scan of
 * `/proc` for the compositor. Everything else about the session is discovered
 * from libei itself, which is a better source than any environment guess.
 */
export function inspectSession(): SessionInfo {
  const env = process.env
  const type = (env.XDG_SESSION_TYPE ?? "").toLowerCase()
  const desktop = (env.XDG_CURRENT_DESKTOP ?? env.XDG_SESSION_DESKTOP ?? "").toLowerCase()
  const runtime = env.XDG_RUNTIME_DIR ?? ""
  const bus = env.DBUS_SESSION_BUS_ADDRESS || (runtime ? `unix:path=${join(runtime, "bus")}` : "")
  return { type, desktop, hasKwin: hasKwin(), bus }
}

const hasKwin = (): boolean => {
  try {
    for (const entry of readdirSync("/proc")) {
      if (!/^\d+$/.test(entry)) continue
      try {
        if (readFileSync(join("/proc", entry, "comm"), "utf8").trim() === "kwin_wayland") return true
      } catch {
        /* the process exited while we looked */
      }
    }
  } catch {
    /* /proc is not readable; fall through to the environment-only answer */
  }
  return false
}

/** Throws the environment-shaped errors from the taxonomy. */
export function assertSession(): SessionInfo {
  const info = inspectSession()
  if (info.type && info.type !== "wayland") {
    fail(
      "UNSUPPORTED_SESSION",
      `Computer control needs a Wayland session, but this session reports type "${info.type}".`,
      "Log out and choose the Plasma (Wayland) session, then restart OpenCode.",
    )
  }
  if (info.desktop && !/kde|plasma/.test(info.desktop)) {
    fail(
      "UNSUPPORTED_DESKTOP",
      `This plugin targets KDE Plasma, but this session reports desktop "${info.desktop}".`,
      "The RemoteDesktop portal and libei are compositor-agnostic, but only Plasma is supported here.",
    )
  }
  if (!info.hasKwin) {
    fail(
      "NOT_PLASMA",
      "No KWin compositor process was found, so this does not look like a Plasma session.",
      "Run OpenCode inside a logged-in Plasma Wayland session.",
    )
  }
  if (!info.bus) {
    fail(
      "NO_BUS",
      "No D-Bus session bus address was found in the environment or the runtime directory.",
      "Start OpenCode from inside a desktop session so DBUS_SESSION_BUS_ADDRESS is set.",
    )
  }
  return info
}
