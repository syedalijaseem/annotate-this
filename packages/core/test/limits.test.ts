import { describe, expect, it } from "vitest"
import { DEFAULT_LIMITS, type Limits, resolveLimits } from "../src/limits.js"
import { createDocument } from "../src/create-document.js"
import { parseDocument } from "../src/validate/index.js"
import { parseDocumentJson } from "../src/validate/json.js"
import { type Loose, clone, validDocument } from "./fixtures.js"
import { batchOf, codeOf, errorOf, opId, run } from "./ops-helpers.js"
import { apply } from "../src/ops/apply.js"

const BAD_VALUES: [string, unknown][] = [
  ["NaN", Number.NaN],
  ["Infinity", Number.POSITIVE_INFINITY],
  ["-Infinity", Number.NEGATIVE_INFINITY],
  ["a negative number", -1],
  ["a fraction", 1.5],
  ["null", null],
  ["a numeric string", "100"],
  ["a number beyond 2^53", 2 ** 53],
  ["a boolean", true],
  ["an object", { valueOf: () => 5 }],
]

const SAMPLE_KEYS: (keyof Limits)[] = [
  "maxStringLength",
  "maxDocumentBytes",
  "maxBatchWork",
  "maxEntries",
]

describe("resolveLimits", () => {
  it("returns the defaults, frozen, when nothing is overridden", () => {
    const limits = resolveLimits()
    expect(limits).toEqual(DEFAULT_LIMITS)
    expect(Object.isFrozen(limits)).toBe(true)
    expect(Object.isFrozen(resolveLimits({ maxStringLength: 5 }))).toBe(true)
  })

  it("applies valid overrides, including 0", () => {
    const limits = resolveLimits({ maxStringLength: 0, maxBatchOps: 7 })
    expect(limits.maxStringLength).toBe(0)
    expect(limits.maxBatchOps).toBe(7)
    expect(limits.maxEntries).toBe(DEFAULT_LIMITS.maxEntries)
  })

  it("ignores keys whose value is undefined", () => {
    const limits = resolveLimits({ maxStringLength: undefined } as unknown as Partial<Limits>)
    expect(limits.maxStringLength).toBe(DEFAULT_LIMITS.maxStringLength)
  })

  for (const key of SAMPLE_KEYS) {
    it.each(BAD_VALUES)(`rejects ${key} set to %s with a typed error naming it`, (_, value) => {
      const error = errorOf(() => resolveLimits({ [key]: value } as Partial<Limits>))
      expect(error.code).toBe("INVALID_DOCUMENT")
      expect(error.message).toContain(key)
    })
  }

  it("reads own keys only", () => {
    const inherited = Object.create({ maxStringLength: 1 }) as Partial<Limits>
    expect(resolveLimits(inherited).maxStringLength).toBe(DEFAULT_LIMITS.maxStringLength)
  })

  it("ignores unknown keys", () => {
    const limits = resolveLimits({ maxNothing: -1 } as unknown as Partial<Limits>)
    expect(limits).toEqual(DEFAULT_LIMITS)
  })

  it("turns non-object overrides and throwing getters into typed errors", () => {
    expect(codeOf(() => resolveLimits(null as unknown as Partial<Limits>))).toBe("INVALID_DOCUMENT")
    const hostile = {
      get maxStringLength(): number {
        throw new Error("boom")
      },
    }
    expect(codeOf(() => resolveLimits(hostile))).toBe("INVALID_DOCUMENT")
  })
})

describe("every entry point validates its limits", () => {
  const bad = { limits: { maxStringLength: Number.NaN } }

  it("parseDocument, parseDocumentJson, apply and createDocument refuse bad limits", () => {
    expect(codeOf(() => parseDocument(validDocument(), bad))).toBe("INVALID_DOCUMENT")
    const text = JSON.stringify(validDocument())
    expect(codeOf(() => parseDocumentJson(text, bad))).toBe("INVALID_DOCUMENT")
    const patch = { id: opId(), type: "setDocumentMeta", patch: { "a:x": 1 } }
    expect(codeOf(() => run(validDocument(), [patch], bad))).toBe("INVALID_DOCUMENT")
    expect(codeOf(() => apply(validDocument(), batchOf([patch]), bad))).toBe("INVALID_DOCUMENT")
    expect(() => createDocument()).not.toThrow()
  })

  it("no longer lets an undefined override disable a check", () => {
    const long: Loose = clone(validDocument())
    long.sources.s1.name = "x".repeat(20_000)
    const options = { limits: { maxStringLength: undefined } } as unknown as {
      limits: Partial<Limits>
    }
    expect(codeOf(() => parseDocument(long, options))).toBe("LIMIT_EXCEEDED")
  })
})
