import { describe, expect, it } from "vitest"
import { ID_PATTERN, createIdGenerator, isValidId } from "../src/ids.js"

describe("isValidId", () => {
  it.each(["a", "region-1", "A_b.c:d-9", "x".repeat(64)])("accepts %s", (id) => {
    expect(isValidId(id)).toBe(true)
  })

  it.each(["", "x".repeat(65), "has space", "semi;colon", 'quote"', "<script>", "ü", "a/b"])(
    "rejects %j",
    (id) => {
      expect(isValidId(id)).toBe(false)
    },
  )

  it("rejects non-strings", () => {
    expect(isValidId(42 as unknown as string)).toBe(false)
    expect(isValidId(null as unknown as string)).toBe(false)
  })

  it("exposes the pattern used for schema validation", () => {
    expect(ID_PATTERN.test("ok-id")).toBe(true)
  })
})

describe("createIdGenerator (UUIDv7)", () => {
  const fixedRandom = (bytes: Uint8Array) => bytes.fill(0xab)

  it("produces valid, version-7, variant-1 identifiers", () => {
    const next = createIdGenerator({ now: () => 1_700_000_000_000, randomBytes: fixedRandom })
    const id = next()
    expect(isValidId(id)).toBe(true)
    expect(id).toMatch(/^[0-9a-f]{8}-[0-9a-f]{4}-7[0-9a-f]{3}-[89ab][0-9a-f]{3}-[0-9a-f]{12}$/)
  })

  it("encodes the timestamp in the first 48 bits", () => {
    const now = 1_700_000_000_000
    const id = createIdGenerator({ now: () => now, randomBytes: fixedRandom })()
    const hex = id.replaceAll("-", "").slice(0, 12)
    expect(Number.parseInt(hex, 16)).toBe(now)
  })

  it("sorts by creation time", () => {
    let t = 1_700_000_000_000
    const next = createIdGenerator({ now: () => t })
    const a = next()
    t += 5
    const b = next()
    t += 5000
    const c = next()
    expect([c, a, b].sort()).toEqual([a, b, c])
  })

  it("stays unique and monotonic when called many times in the same millisecond", () => {
    const next = createIdGenerator({ now: () => 1_700_000_000_000 })
    const ids = Array.from({ length: 5000 }, () => next())
    expect(new Set(ids).size).toBe(5000)
    expect([...ids].sort()).toEqual(ids)
  })

  it("stays monotonic if the clock steps backwards", () => {
    const times = [1000, 999, 998]
    let i = 0
    const next = createIdGenerator({ now: () => times[i++] ?? 998 })
    const ids = [next(), next(), next()]
    expect([...ids].sort()).toEqual(ids)
  })

  it("throws a clear error when no secure random source exists", () => {
    const original = Object.getOwnPropertyDescriptor(globalThis, "crypto")
    Object.defineProperty(globalThis, "crypto", { value: undefined, configurable: true })
    try {
      expect(() => createIdGenerator()()).toThrow(/secure random/i)
    } finally {
      if (original) Object.defineProperty(globalThis, "crypto", original)
    }
  })
})

describe("createIdGenerator input checks", () => {
  it.each([Number.NaN, -1, 2 ** 48, 1.5, Number.POSITIVE_INFINITY])(
    "rejects clock value %s",
    (t) => {
      expect(() => createIdGenerator({ now: () => t })()).toThrow(/clock/i)
    },
  )

  it("rejects a random source that returns the wrong length", () => {
    expect(() => createIdGenerator({ randomBytes: () => new Uint8Array(3) })()).toThrow(/random/i)
  })
})
