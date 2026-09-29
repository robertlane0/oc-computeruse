import { type Button, isButton } from "./keys.ts"

/** Device classes as the RemoteDesktop portal names them. */
export type Device = "keyboard" | "pointer" | "touchscreen"

export const ALL_DEVICES: readonly Device[] = ["keyboard", "pointer", "touchscreen"]

/** Portal device bitmask; matches `oeffis_device`. */
export const DEVICE_MASK: Record<Device, number> = {
  keyboard: 1 << 0,
  pointer: 1 << 1,
  touchscreen: 1 << 2,
}

export type Options = {
  devices: readonly Device[]
  authorizeTimeoutMs: number
  defaultClickDelayMs: number
  defaultTypeDelayMs: number
  requestButton: Button
  maxBatchActions: number
  maxBatchMs: number
  trace: boolean
}

const DEFAULTS: Options = {
  devices: ALL_DEVICES,
  authorizeTimeoutMs: 30_000,
  defaultClickDelayMs: 40,
  defaultTypeDelayMs: 8,
  requestButton: "left",
  maxBatchActions: 200,
  maxBatchMs: 30_000,
  trace: false,
}

const clamp = (value: number, min: number, max: number) => Math.min(max, Math.max(min, value))

function num(value: unknown, min: number, max: number, fallback: number): number {
  const parsed = typeof value === "string" ? Number(value) : value
  if (typeof parsed !== "number" || !Number.isFinite(parsed)) return fallback
  return clamp(Math.round(parsed), min, max)
}

function parseDevices(value: unknown): readonly Device[] {
  const raw = Array.isArray(value) ? value : typeof value === "string" ? value.split(/[|,\s]+/) : []
  const wanted = raw.map((entry) => String(entry).trim().toLowerCase()).filter(Boolean)
  const found = ALL_DEVICES.filter((device) =>
    wanted.some((entry) => entry === device || (entry === "touch" && device === "touchscreen")),
  )
  // An empty or unrecognised list must not silently narrow the request to
  // nothing, which would hand back a session with no usable device.
  return found.length ? found : DEFAULTS.devices
}

/** Hand-rolled with a per-field fallback: a typo must not break the plugin. */
export function parseOptions(raw: unknown): Options {
  const options = (raw ?? {}) as Record<string, unknown>
  const button = options.requestButton
  return {
    devices: parseDevices(options.devices),
    authorizeTimeoutMs: num(options.authorizeTimeoutMs, 1_000, 120_000, DEFAULTS.authorizeTimeoutMs),
    defaultClickDelayMs: num(options.defaultClickDelayMs, 0, 500, DEFAULTS.defaultClickDelayMs),
    defaultTypeDelayMs: num(options.defaultTypeDelayMs, 0, 500, DEFAULTS.defaultTypeDelayMs),
    requestButton: typeof button === "string" && isButton(button) ? button : DEFAULTS.requestButton,
    maxBatchActions: num(options.maxBatchActions, 1, 1_000, DEFAULTS.maxBatchActions),
    maxBatchMs: num(options.maxBatchMs, 1_000, 120_000, DEFAULTS.maxBatchMs),
    trace: options.trace === true,
  }
}

export const deviceMask = (devices: readonly Device[]): number =>
  devices.reduce((mask, device) => mask | DEVICE_MASK[device], 0)

