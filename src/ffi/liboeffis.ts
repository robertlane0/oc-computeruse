import { dlopen, FFIType, type Pointer } from "bun:ffi"
import { missingLibrary } from "../errors.ts"

export const SONAME = "liboeffis.so.1"

/** `enum oeffis_event_type`. */
export const OE_EVENT = {
  NONE: 0,
  CONNECTED_TO_EIS: 1,
  CLOSED: 2,
  DISCONNECTED: 3,
} as const

export type Liboeffis = {
  oeffis_new: (user_data: null) => Pointer
  oeffis_unref: (oeffis: Pointer) => Pointer
  oeffis_get_fd: (oeffis: Pointer) => number
  oeffis_get_eis_fd: (oeffis: Pointer) => number
  oeffis_create_session: (oeffis: Pointer, devices: number) => void
  oeffis_dispatch: (oeffis: Pointer) => void
  oeffis_get_event: (oeffis: Pointer) => number
  oeffis_get_error_message: (oeffis: Pointer) => string | null
}

let lib: Liboeffis | undefined

export function liboeffis(): Liboeffis {
  if (lib) return lib
  const handle = (() => {
    try {
      return dlopen(SONAME, {
        oeffis_new: { args: [FFIType.ptr], returns: FFIType.ptr },
        oeffis_unref: { args: [FFIType.ptr], returns: FFIType.ptr },
        oeffis_get_fd: { args: [FFIType.ptr], returns: FFIType.int },
        oeffis_get_eis_fd: { args: [FFIType.ptr], returns: FFIType.int },
        oeffis_create_session: { args: [FFIType.ptr, FFIType.uint32_t], returns: FFIType.void },
        oeffis_dispatch: { args: [FFIType.ptr], returns: FFIType.void },
        oeffis_get_event: { args: [FFIType.ptr], returns: FFIType.int },
        oeffis_get_error_message: { args: [FFIType.ptr], returns: FFIType.cstring },
      })
    } catch (error) {
      return missingLibrary(SONAME, error)
    }
  })()
  lib = handle.symbols as unknown as Liboeffis
  return lib
}
