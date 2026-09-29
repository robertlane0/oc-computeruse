import { dlopen, FFIType, ptr } from "bun:ffi"
import { missingLibrary } from "../errors.ts"

const POLLIN = 0x001
const POLLERR = 0x008
const POLLHUP = 0x010
const POLLNVAL = 0x020

/** Anything that means the descriptor is dead rather than merely idle. */
const DEAD = POLLERR | POLLHUP | POLLNVAL

type Libc = {
  poll: (fds: unknown, nfds: number, timeout: number) => number
  close: (fd: number) => number
}

let lib: Libc | undefined

function libc(): Libc {
  if (lib) return lib
  const handle = (() => {
    try {
      return dlopen("libc.so.6", {
        poll: { args: [FFIType.ptr, FFIType.uint64_t, FFIType.int], returns: FFIType.int },
        close: { args: [FFIType.int], returns: FFIType.int },
      })
    } catch (error) {
      return missingLibrary("libc.so.6", error)
    }
  })()
  lib = handle.symbols as unknown as Libc
  return lib
}

export type PollResult = { readable: boolean; revents: number; dead: boolean }

/**
 * `poll(2)` over one descriptor. There is no event loop inside a tool call, so
 * readiness is checked synchronously; a hang-up counts as "readable" so the
 * caller drains whatever the transport left behind instead of spinning, and
 * `dead` lets it report a lost connection rather than a quiet timeout.
 */
export function poll(fd: number, timeoutMs: number): PollResult {
  if (fd < 0) return { readable: false, revents: POLLNVAL, dead: true }
  const pfd = Buffer.alloc(8) // struct pollfd { int fd; short events; short revents; }
  pfd.writeInt32LE(fd, 0)
  pfd.writeInt16LE(POLLIN, 4)
  pfd.writeInt16LE(0, 6)
  const ready = libc().poll(ptr(pfd), 1, timeoutMs)
  if (ready < 0) return { readable: false, revents: POLLERR, dead: true }
  const revents = pfd.readInt16LE(6)
  return { readable: ready > 0, revents, dead: (revents & DEAD) !== 0 }
}

export const closeFd = (fd: number): void => {
  if (fd >= 0) libc().close(fd)
}
