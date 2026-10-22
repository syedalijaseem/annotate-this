import { AnnotateError } from "./errors.js"
import type { ID } from "./types.js"

const idError = (message: string): AnnotateError => new AnnotateError("INVALID_DOCUMENT", message)

/**
 * Allowed identifier shape (Spec 0001), as regular-expression source: safe to
 * embed in URLs, attributes and file names. A string, so no caller can alter
 * the expression validation uses; build a RegExp from it if you need one.
 */
export const ID_PATTERN_SOURCE = "^[A-Za-z0-9_.:-]{1,64}$"

// Private: an exported RegExp could be recompiled or have its lastIndex moved.
const ID_REGEX = /* @__PURE__ */ new RegExp(ID_PATTERN_SOURCE)

export function isValidId(value: unknown): value is ID {
  return typeof value === "string" && ID_REGEX.test(value)
}

export interface IdGeneratorOptions {
  /** Milliseconds since the Unix epoch. Injected for deterministic tests. */
  now?: () => number
  /** Fills the given buffer with cryptographically secure random bytes. */
  randomBytes?: (bytes: Uint8Array) => Uint8Array
}

interface CryptoLike {
  getRandomValues<T extends ArrayBufferView>(array: T): T
}

function secureRandomBytes(bytes: Uint8Array): Uint8Array {
  // Read the global lazily: nothing may touch the environment at import time (SSR-safe).
  const crypto = (globalThis as { crypto?: CryptoLike }).crypto
  if (!crypto || typeof crypto.getRandomValues !== "function") {
    throw idError(
      "A secure random source (globalThis.crypto.getRandomValues) is required to generate IDs",
    )
  }
  return crypto.getRandomValues(bytes)
}

const MAX_TIMESTAMP = 281_474_976_710_656 // 2 ** 48, as a literal so bundlers can drop it
const COUNTER_MAX = 0xfff
const COUNTER_START_MAX = 0x3ff

function toHex(bytes: Uint8Array): string {
  let out = ""
  for (const byte of bytes) out += byte.toString(16).padStart(2, "0")
  return `${out.slice(0, 8)}-${out.slice(8, 12)}-${out.slice(12, 16)}-${out.slice(16, 20)}-${out.slice(20)}`
}

/**
 * Creates a UUIDv7 generator (RFC 9562, with the 12-bit counter in `rand_a`).
 * IDs sort by creation time and stay strictly increasing even within one
 * millisecond or if the clock steps backwards.
 */
export function createIdGenerator(options: IdGeneratorOptions = {}): () => ID {
  const now = options.now ?? (() => Date.now())
  const randomBytes = options.randomBytes ?? secureRandomBytes
  let lastTimestamp = -1
  let counter = 0

  return () => {
    const random = randomBytes(new Uint8Array(10))
    if (random.length !== 10) throw idError("The random source returned the wrong number of bytes")
    const current = now()
    if (!Number.isSafeInteger(current) || current < 0 || current >= MAX_TIMESTAMP) {
      throw idError("The clock must return whole milliseconds that fit in 48 bits")
    }
    if (current > lastTimestamp) {
      lastTimestamp = current
      counter = (((random[0] ?? 0) << 8) | (random[1] ?? 0)) & COUNTER_START_MAX
    } else {
      counter += 1
      if (counter > COUNTER_MAX) {
        if (lastTimestamp + 1 >= MAX_TIMESTAMP) {
          throw idError("The ID generator ran out of timestamps in the 48-bit range")
        }
        lastTimestamp += 1
        counter = 0
      }
    }

    const bytes = new Uint8Array(16)
    // 48-bit big-endian timestamp without relying on 32-bit bitwise operators.
    let t = lastTimestamp
    for (let i = 5; i >= 0; i--) {
      bytes[i] = t % 256
      t = Math.floor(t / 256)
    }
    bytes[6] = 0x70 | ((counter >> 8) & 0x0f)
    bytes[7] = counter & 0xff
    for (let i = 0; i < 8; i++) bytes[8 + i] = random[2 + i] ?? 0
    bytes[8] = ((bytes[8] ?? 0) & 0x3f) | 0x80
    return toHex(bytes)
  }
}
