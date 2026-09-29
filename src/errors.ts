/**
 * Every failure the plugin can produce is a `ComputerUseError` with a stable
 * code and a message written for the model to act on. Nothing is swallowed and
 * nothing throws out of a tool.
 */
export type ErrorCode =
  | "UNSUPPORTED_SESSION"
  | "UNSUPPORTED_DESKTOP"
  | "NOT_PLASMA"
  | "MISSING_LIBRARY"
  | "NO_BUS"
  | "NOT_AUTHORIZED"
  | "AUTH_TIMEOUT"
  | "AUTH_CANCELLED"
  | "SESSION_LOST"
  | "NO_ABSOLUTE_POINTER"
  | "NO_KEYBOARD"
  | "OUT_OF_BOUNDS"
  | "INVALID_ARGUMENT"
  | "UNSUPPORTED_KEY"
  | "LAYOUT_GAP"
  | "CAPABILITY"
  | "BUSY"

/** Per-distro install hints, keyed by the library `dlopen` could not find. */
const INSTALL: Record<string, string> = {
  "libei.so.1": "sudo pacman -S libei  (Fedora: sudo dnf install libei   Debian/Ubuntu: sudo apt install libei1)",
  "liboeffis.so.1": "sudo pacman -S libei  (ships liboeffis.so.1)",
  "libc.so.6": "glibc is missing from this system",
}

export class ComputerUseError extends Error {
  constructor(
    readonly code: ErrorCode,
    message: string,
    readonly remedy?: string,
  ) {
    super(message)
    this.name = "ComputerUseError"
  }
}

/** Throws a coded failure. A `never` function, so callers need no `throw`. */
export function fail(code: ErrorCode, message: string, remedy?: string): never {
  throw new ComputerUseError(code, message, remedy)
}

export function missingLibrary(soname: string, cause?: unknown): never {
  const hint = INSTALL[soname] ?? ""
  throw new ComputerUseError(
    "MISSING_LIBRARY",
    `Could not load ${soname}${causeText(cause)}. These libraries ship with libei, which the KWin compositor already depends on, so a Plasma 6 Wayland session normally has them.`,
    hint ? `Install it with: ${hint}` : undefined,
  )
}

export function toError(value: unknown): ComputerUseError {
  if (value instanceof ComputerUseError) return value
  const text = value instanceof Error ? value.message : String(value)
  return new ComputerUseError("INVALID_ARGUMENT", text)
}

/** Renders a failure as the prose the model reads. Never throws. */
export function describe(value: unknown): string {
  const error = toError(value)
  const lines = [`Computer control failed: ${error.code}.`, error.message]
  if (error.remedy) lines.push(`Try: ${error.remedy}`)
  return lines.join("\n")
}

function causeText(cause: unknown): string {
  if (cause === undefined) return ""
  const message = cause instanceof Error ? cause.message : String(cause)
  return ` (${message.split("\n")[0]})`
}
