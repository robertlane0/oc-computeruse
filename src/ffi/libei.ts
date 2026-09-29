import { dlopen, FFIType, ptr, type Pointer } from "bun:ffi"
import { missingLibrary } from "../errors.ts"

export const SONAME = "libei.so.1"

/** `enum ei_device_capability`. */
export const CAP = {
  POINTER: 1 << 0,
  POINTER_ABSOLUTE: 1 << 1,
  KEYBOARD: 1 << 2,
  TOUCH: 1 << 3,
  SCROLL: 1 << 4,
  BUTTON: 1 << 5,
  TEXT: 1 << 6,
} as const

export type Capability = keyof typeof CAP

/** `enum ei_event_type`. */
export const EVENT = {
  CONNECT: 1,
  DISCONNECT: 2,
  SEAT_ADDED: 3,
  SEAT_REMOVED: 4,
  DEVICE_ADDED: 5,
  DEVICE_REMOVED: 6,
  DEVICE_PAUSED: 7,
  DEVICE_RESUMED: 8,
  PING: 9,
  PONG: 10,
  KEYBOARD_MODIFIER: 11,
} as const

export type Libei = {
  ei_new_sender: (user_data: null) => Pointer
  ei_unref: (ei: Pointer) => Pointer
  ei_configure_name: (ei: Pointer, name: string) => void
  ei_setup_backend_fd: (ei: Pointer, fd: number) => number
  ei_get_fd: (ei: Pointer) => number
  ei_dispatch: (ei: Pointer) => void
  ei_get_event: (ei: Pointer) => Pointer | null
  ei_event_get_type: (event: Pointer) => number
  ei_event_get_device: (event: Pointer) => Pointer | null
  ei_event_get_seat: (event: Pointer) => Pointer | null
  ei_event_unref: (event: Pointer) => Pointer | null
  ei_now: (ei: Pointer) => number
  ei_seat_bind_capabilities: (seat: Pointer, ...caps: number[]) => void
  ei_seat_has_capability: (seat: Pointer, cap: number) => boolean
  ei_device_has_capability: (device: Pointer, cap: number) => boolean
  ei_device_close: (device: Pointer) => void
  ei_device_start_emulating: (device: Pointer, sequence: number) => void
  ei_device_frame: (device: Pointer, time: bigint) => void
  ei_device_get_name: (device: Pointer) => string
  ei_device_get_region: (device: Pointer, index: number) => Pointer | null
  ei_region_get_x: (region: Pointer) => number
  ei_region_get_y: (region: Pointer) => number
  ei_region_get_width: (region: Pointer) => number
  ei_region_get_height: (region: Pointer) => number
  ei_region_get_physical_scale: (region: Pointer) => number
  ei_region_contains: (region: Pointer, x: number, y: number) => boolean
  ei_device_pointer_motion: (device: Pointer, x: number, y: number) => void
  ei_device_pointer_motion_absolute: (device: Pointer, x: number, y: number) => void
  ei_device_button_button: (device: Pointer, button: number, press: boolean) => void
  ei_device_scroll_discrete: (device: Pointer, x: number, y: number) => void
  ei_device_keyboard_key: (device: Pointer, keycode: number, press: boolean) => void
  ei_device_text_utf8: (device: Pointer, text: string) => void
  ei_device_keyboard_get_keymap: (device: Pointer) => Pointer | null
  ei_keymap_get_fd: (keymap: Pointer) => number
  ei_keymap_get_size: (keymap: Pointer) => number
  ei_keymap_get_type: (keymap: Pointer) => number
  pread: (fd: number, buffer: unknown, count: number, offset: number) => bigint
}

/**
 * `ei_seat_bind_capabilities` is C-variadic and `bun:ffi` has no variadic
 * signature, so it is declared with a fixed number of trailing ints. The
 * callee stops at the first zero, so the tail is padding and callers pass the
 * capability *bit values* (not their indices — a leading 0 would terminate the
 * list immediately and silently bind nothing) followed by explicit zeros.
 */
const bindCapArgs = Array.from({ length: 8 }, () => FFIType.int)

let lib: Libei | undefined

export function libei(): Libei {
  if (lib) return lib
  const handle = (() => {
    try {
      return dlopen(SONAME, {
      ei_new_sender: { args: [FFIType.ptr], returns: FFIType.ptr },
      ei_unref: { args: [FFIType.ptr], returns: FFIType.ptr },
      ei_configure_name: { args: [FFIType.ptr, FFIType.cstring], returns: FFIType.void },
      ei_setup_backend_fd: { args: [FFIType.ptr, FFIType.int], returns: FFIType.int },
      ei_get_fd: { args: [FFIType.ptr], returns: FFIType.int },
      ei_dispatch: { args: [FFIType.ptr], returns: FFIType.void },
      ei_get_event: { args: [FFIType.ptr], returns: FFIType.ptr },
      ei_event_get_type: { args: [FFIType.ptr], returns: FFIType.int },
      ei_event_get_device: { args: [FFIType.ptr], returns: FFIType.ptr },
      ei_event_get_seat: { args: [FFIType.ptr], returns: FFIType.ptr },
      ei_event_unref: { args: [FFIType.ptr], returns: FFIType.ptr },
      ei_now: { args: [FFIType.ptr], returns: FFIType.u64_fast },
      ei_seat_bind_capabilities: { args: [FFIType.ptr, ...bindCapArgs], returns: FFIType.void },
      ei_seat_has_capability: { args: [FFIType.ptr, FFIType.int], returns: FFIType.bool },
      ei_device_has_capability: { args: [FFIType.ptr, FFIType.int], returns: FFIType.bool },
      ei_device_close: { args: [FFIType.ptr], returns: FFIType.void },
      ei_device_start_emulating: { args: [FFIType.ptr, FFIType.uint32_t], returns: FFIType.void },
      ei_device_frame: { args: [FFIType.ptr, FFIType.u64_fast], returns: FFIType.void },
      ei_device_get_name: { args: [FFIType.ptr], returns: FFIType.cstring },
      ei_device_get_region: { args: [FFIType.ptr, FFIType.uint64_t], returns: FFIType.ptr },
      ei_region_get_x: { args: [FFIType.ptr], returns: FFIType.uint32_t },
      ei_region_get_y: { args: [FFIType.ptr], returns: FFIType.uint32_t },
      ei_region_get_width: { args: [FFIType.ptr], returns: FFIType.uint32_t },
      ei_region_get_height: { args: [FFIType.ptr], returns: FFIType.uint32_t },
      ei_region_get_physical_scale: { args: [FFIType.ptr], returns: FFIType.double },
      ei_region_contains: { args: [FFIType.ptr, FFIType.double, FFIType.double], returns: FFIType.bool },
      ei_device_pointer_motion: { args: [FFIType.ptr, FFIType.double, FFIType.double], returns: FFIType.void },
      ei_device_pointer_motion_absolute: {
        args: [FFIType.ptr, FFIType.double, FFIType.double],
        returns: FFIType.void,
      },
      ei_device_button_button: { args: [FFIType.ptr, FFIType.uint32_t, FFIType.bool], returns: FFIType.void },
      ei_device_scroll_discrete: { args: [FFIType.ptr, FFIType.int32_t, FFIType.int32_t], returns: FFIType.void },
      ei_device_keyboard_key: { args: [FFIType.ptr, FFIType.uint32_t, FFIType.bool], returns: FFIType.void },
      ei_device_text_utf8: { args: [FFIType.ptr, FFIType.cstring], returns: FFIType.void },
      ei_device_keyboard_get_keymap: { args: [FFIType.ptr], returns: FFIType.ptr },
      ei_keymap_get_fd: { args: [FFIType.ptr], returns: FFIType.int },
      ei_keymap_get_size: { args: [FFIType.ptr], returns: FFIType.uint32_t },
      ei_keymap_get_type: { args: [FFIType.ptr], returns: FFIType.int },
      pread: { args: [FFIType.int, FFIType.ptr, FFIType.uint64_t, FFIType.int], returns: FFIType.uint64_t },
      })
    } catch (error) {
      return missingLibrary(SONAME, error)
    }
  })()
  lib = handle.symbols as unknown as Libei
  return lib
}

/** Round number up to the wire's next multiple of 4ms. */
export const timestamp = (): bigint => BigInt(Math.ceil(Date.now() / 4) * 4)

/** Capabilities as bit values, in bind order, with zeros as the terminator. */
export const bindList = (caps: readonly number[]): number[] => [...caps, 0, 0, 0, 0, 0, 0, 0, 0]

/**
 * Reads the whole keymap. `pread` rather than `read`: libei hands over a
 * memfd whose file position is already at the end, so a plain read returns 0.
 */
export function readKeymap(ei: Libei, keymap: Pointer): string {
  const size = ei.ei_keymap_get_size(keymap)
  const buffer = Buffer.alloc(size)
  // pread returns ssize_t, which the FFI surfaces as a BigInt.
  const got = Number(ei.pread(ei.ei_keymap_get_fd(keymap), ptr(buffer), size, 0))
  return buffer.subarray(0, Math.max(0, Math.min(size, got))).toString("utf8")
}
