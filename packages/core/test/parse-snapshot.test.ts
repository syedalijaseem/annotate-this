import { describe, expect, it } from "vitest"
import { DEFAULT_LIMITS } from "../src/limits.js"
import { apply } from "../src/ops/apply.js"
import type { AnnotationDocument } from "../src/types.js"
import { parseDocument } from "../src/validate/index.js"
import { parseDocumentJson, utf8ByteLength } from "../src/validate/json.js"
import { type Loose, clone, validDocument } from "./fixtures.js"
import { batchOf, codeOf, errorOf, opId } from "./ops-helpers.js"

// parseDocument copies its input once, own properties only, before any check
// runs: what it validates is exactly what it returns.
describe("parseDocument reads a private snapshot of its input", () => {
  it("ignores inherited known keys", () => {
    const own: Loose = clone(validDocument())
    const { config } = own
    delete own.config
    // A parent with a null prototype passes the plain-container check, so the
    // key would be found through the chain by a plain `in` or property read.
    const parent = Object.assign(Object.create(null) as Loose, { config })
    const inherited = Object.assign(Object.create(parent) as Loose, own) as unknown
    expect(codeOf(() => parseDocument(inherited))).toBe("INVALID_DOCUMENT")
    expect(errorOf(() => parseDocument(inherited)).message).toMatch(/^config/)
  })

  it("never sees non-JSON values that hide on the prototype chain", () => {
    const own: Loose = clone(validDocument())
    const hidden = Object.assign(Object.create(null) as Loose, { hook: () => 1, big: 10n })
    const config = Object.create(hidden) as Loose
    Object.assign(config, own.config)
    own.config = config
    const parsed = parseDocument(own)
    expect(Object.hasOwn(parsed.config, "hook")).toBe(false)
    expect(JSON.parse(JSON.stringify(parsed))).toEqual(validDocument())
  })

  it("reads a getter once, so it cannot change its answer after the checks", () => {
    const doc: Loose = clone(validDocument())
    let reads = 0
    const good = doc.regions.r1.status
    Object.defineProperty(doc.regions.r1, "status", {
      enumerable: true,
      get() {
        reads += 1
        return reads === 1 ? good : 42
      },
    })
    const parsed = parseDocument(doc)
    expect(reads).toBe(1)
    expect(parsed.regions["r1"]?.status).toBe(good)
  })

  it("accepts a proxy that answers getPrototypeOf with null, reading each key once", () => {
    const doc: Loose = clone(validDocument())
    const reads = new Map<PropertyKey, number>()
    const meta = new Proxy(
      { note: "x" },
      {
        getPrototypeOf: () => null,
        get(target, key, receiver) {
          reads.set(key, (reads.get(key) ?? 0) + 1)
          return (reads.get(key) ?? 0) > 1 ? 10n : (Reflect.get(target, key, receiver) as unknown)
        },
      },
    )
    doc.meta = meta
    const parsed = parseDocument(doc)
    expect(parsed.meta).toEqual({ note: "x" })
    expect(reads.get("note")).toBe(1)
  })

  it("returns unknown fields that share nothing with the input", () => {
    const doc: Loose = clone(validDocument())
    doc.extra = { deep: { list: [1, { x: "y" }] } }
    doc.regions.r1.future = { a: [1, 2] }
    doc.config.later = { b: { c: true } }
    const parsed = parseDocument(doc) as Loose
    expect(parsed.extra).toEqual(doc.extra)
    expect(parsed.extra).not.toBe(doc.extra)
    expect(parsed.extra.deep).not.toBe(doc.extra.deep)
    expect(parsed.extra.deep.list).not.toBe(doc.extra.deep.list)
    expect(parsed.extra.deep.list[1]).not.toBe(doc.extra.deep.list[1])
    expect(parsed.regions.r1.future).not.toBe(doc.regions.r1.future)
    expect(parsed.config.later.b).not.toBe(doc.config.later.b)
    doc.extra.deep.list.push(3)
    doc.regions.r1.future.a.push(10n)
    expect(parsed.extra.deep.list).toEqual([1, { x: "y" }])
    expect(parsed.regions.r1.future.a).toEqual([1, 2])
  })

  it("keeps apply's size accounting right when the caller mutates its input", () => {
    const doc: Loose = clone(validDocument())
    doc.extra = { blob: "" }
    const parsed = parseDocument(doc, { limits: { maxDocumentBytes: 10_000 } })
    doc.extra.blob = "x".repeat(20_000)
    const op = { id: opId(), type: "setDocumentMeta", patch: { "a:x": 1 } }
    const result = apply(parsed, batchOf([op]), { limits: { maxDocumentBytes: 10_000 } })
    expect(JSON.stringify(result.doc).length).toBeLessThan(10_000)
  })

  it("keeps a __proto__ key visible to the schema and leaves Object.prototype alone", () => {
    const doc = JSON.parse(
      JSON.stringify(validDocument()).replace('"meta":{}', '"meta":{"__proto__":{"polluted":1}}'),
    ) as unknown
    expect(codeOf(() => parseDocument(doc))).toBe("INVALID_DOCUMENT")
    const extra = JSON.parse(`{"__proto__":{"polluted":1}}`) as Loose
    const withExtra: Loose = { ...clone(validDocument()) }
    Object.defineProperty(withExtra, "x", { value: extra, enumerable: true })
    parseDocument(withExtra)
    expect(({} as Loose).polluted).toBeUndefined()
    expect(Object.prototype).not.toHaveProperty("polluted")
  })

  it("still maps throwing getters and hostile proxies to typed errors", () => {
    const doc: Loose = clone(validDocument())
    doc.regions = new Proxy(doc.regions as object, {
      ownKeys() {
        throw new Error("boom")
      },
    })
    expect(codeOf(() => parseDocument(doc))).toBe("INVALID_DOCUMENT")
  })
})

describe("parseDocument enforces maxDocumentBytes on object input", () => {
  const sized = (filler: number): Loose => {
    const doc: Loose = clone(validDocument())
    doc.meta = { pad: "x".repeat(filler) }
    return doc
  }

  it("accepts exactly the limit and rejects one byte more", () => {
    const doc = sized(1000)
    const bytes = utf8ByteLength(JSON.stringify(doc))
    expect(() => parseDocument(doc, { limits: { maxDocumentBytes: bytes } })).not.toThrow()
    const error = errorOf(() => parseDocument(doc, { limits: { maxDocumentBytes: bytes - 1 } }))
    expect(error.code).toBe("LIMIT_EXCEEDED")
    expect(error.message).toMatch(/larger than/)
  })

  it("counts numbers, escapes and multi-byte text exactly", () => {
    const doc: Loose = clone(validDocument())
    doc.meta = { n: [1.5, -2e-7, 123_456_789, 0.1], t: 'é"\n\u0001😀', [`ké`]: true }
    doc.regions.r2.geometry.rings = [[0.123456789, 1, 2.5, 3, 4.75, 5, 6, 7.125]]
    const bytes = utf8ByteLength(JSON.stringify(doc))
    expect(() => parseDocument(doc, { limits: { maxDocumentBytes: bytes } })).not.toThrow()
    expect(codeOf(() => parseDocument(doc, { limits: { maxDocumentBytes: bytes - 1 } }))).toBe(
      "LIMIT_EXCEEDED",
    )
  })

  it("agrees with apply, which refuses to grow such a document", () => {
    const doc = sized(5000)
    const bytes = utf8ByteLength(JSON.stringify(doc))
    const limits = { maxDocumentBytes: bytes - 10 }
    expect(codeOf(() => parseDocument(doc, { limits }))).toBe("LIMIT_EXCEEDED")
    expect(codeOf(() => parseDocumentJson(JSON.stringify(doc), { limits }))).toBe("LIMIT_EXCEEDED")
  })

  it("uses the default limit when none is given", () => {
    const doc = sized(DEFAULT_LIMITS.maxDocumentBytes)
    expect(codeOf(() => parseDocument(doc))).toBe("LIMIT_EXCEEDED")
  })

  it("leaves a document that fits unchanged", () => {
    const doc = sized(10)
    const parsed: AnnotationDocument = parseDocument(doc)
    expect(JSON.parse(JSON.stringify(parsed))).toEqual(doc)
  })
})
