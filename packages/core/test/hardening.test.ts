import { describe, expect, it } from "vitest"
import { isAnnotateError } from "../src/errors.js"
import type { ErrorCode } from "../src/errors.js"
import type { Limits } from "../src/limits.js"
import { parseDocument } from "../src/validate/index.js"
import { parseDocumentJson } from "../src/validate/json.js"
import { type Loose, clone, validDocument } from "./fixtures.js"

function codeOf(doc: unknown, limits?: Partial<Limits>): ErrorCode | "ACCEPTED" {
  try {
    parseDocument(doc, limits ? { limits } : {})
    return "ACCEPTED"
  } catch (error) {
    if (!isAnnotateError(error)) throw error
    return error.code
  }
}

const nest = (depth: number): unknown => {
  let value: unknown = 1
  for (let i = 0; i < depth; i++) value = { k: value }
  return value
}

describe("names that exist on Object.prototype are not references", () => {
  const names = ["toString", "valueOf", "hasOwnProperty", "isPrototypeOf"]

  it.each(names)("rejects classId %s", (name) => {
    const doc: Loose = clone(validDocument())
    doc.regions.r1.classId = name
    expect(codeOf(doc)).toBe("INVALID_DOCUMENT")
  })

  it.each(names)("rejects tagIds [%s]", (name) => {
    const doc: Loose = clone(validDocument())
    doc.regions.r1.tagIds = [name]
    expect(codeOf(doc)).toBe("INVALID_DOCUMENT")
  })

  it.each(names)("rejects skeletonId %s without throwing a raw TypeError", (name) => {
    const doc: Loose = clone(validDocument())
    doc.regions.r4.geometry.skeletonId = name
    expect(codeOf(doc)).toBe("INVALID_DOCUMENT")
  })

  it.each(names)("rejects parentId %s", (name) => {
    const doc: Loose = clone(validDocument())
    doc.regions.r2.parentId = name
    expect(codeOf(doc)).toBe("INVALID_DOCUMENT")
  })

  it.each(names)("rejects an undefined attribute key %s", (name) => {
    const doc: Loose = clone(validDocument())
    doc.regions.r1.attributes[name] = "x"
    expect(codeOf(doc)).toBe("ATTRIBUTE_INVALID")
  })

  it("parsed records have no prototype", () => {
    const parsed = parseDocument(clone(validDocument()))
    expect(Object.getPrototypeOf(parsed.regions)).toBeNull()
    expect(Object.getPrototypeOf(parsed.config.classes)).toBeNull()
  })
})

describe("free-form JSON", () => {
  it("allows any key text inside meta and custom geometry data", () => {
    const doc: Loose = clone(validDocument())
    doc.meta = { "acme:x": { "my key": 1, "a/b": [{ "c d": true }] } }
    doc.regions.r3.geometry = { type: "custom", kind: "acme:x", data: { "a b": { "c/d": 1 } } }
    expect(codeOf(doc)).toBe("ACCEPTED")
  })

  it("still reports forbidden keys nested in meta", () => {
    const doc: Loose = clone(validDocument())
    doc.meta = JSON.parse('{"acme:x":{"__proto__":{"polluted":true}}}')
    expect(codeOf(doc)).toBe("INVALID_DOCUMENT")
    expect(({} as Loose).polluted).toBeUndefined()
  })
})

describe("nesting depth", () => {
  it("limits custom geometry data", () => {
    const doc: Loose = clone(validDocument())
    doc.regions.r3.geometry = { type: "custom", kind: "acme:x", data: nest(100) }
    expect(codeOf(doc)).toBe("LIMIT_EXCEEDED")
  })

  it("limits class and tag meta", () => {
    const classDoc: Loose = clone(validDocument())
    classDoc.config.classes.c1.meta = nest(100)
    expect(codeOf(classDoc)).toBe("LIMIT_EXCEEDED")
    const tagDoc: Loose = clone(validDocument())
    tagDoc.config.tags.t1.meta = nest(100)
    expect(codeOf(tagDoc)).toBe("LIMIT_EXCEEDED")
  })

  it("rejects very deep input as LIMIT_EXCEEDED regardless of stack size", () => {
    for (const depth of [200, 3000, 20_000]) {
      const doc: Loose = clone(validDocument())
      doc.meta = { "acme:x": nest(depth) }
      expect(codeOf(doc)).toBe("LIMIT_EXCEEDED")
    }
  })

  it("terminates on cyclic input", () => {
    const doc: Loose = clone(validDocument())
    doc.meta = { "acme:x": {} }
    doc.meta["acme:x"].self = doc.meta
    expect(codeOf(doc)).toBe("LIMIT_EXCEEDED")
  })
})

describe("limits", () => {
  it("counts vertices per ring, not per shape", () => {
    const ring = (n: number) =>
      Array.from({ length: n * 2 }, (_, i) => (i % 2 ? 100 : 100 + (i % 7)))
    const doc: Loose = clone(validDocument())
    doc.regions.r2.geometry = { type: "polygon", rings: [ring(6), ring(6)] }
    expect(codeOf(doc, { maxVerticesPerShape: 8 })).toBe("ACCEPTED")
    expect(codeOf(doc, { maxVerticesPerShape: 5 })).toBe("LIMIT_EXCEEDED")
  })

  it("applies the string limit to tags, attributes, skeletons and hotkeys", () => {
    const long = "x".repeat(50)
    const limits = { maxStringLength: 20 }
    const cases: ((d: Loose) => void)[] = [
      (d) => (d.config.tags.t1.name = long),
      (d) => (d.config.attributes.score.label = long),
      (d) => (d.config.skeletons.k1.name = long),
      (d) => (d.config.classes.c1.hotkey = long),
      (d) => (d.sources.s1.thumbnailUri = long),
    ]
    for (const mutate of cases) {
      const doc: Loose = clone(validDocument())
      mutate(doc)
      expect(codeOf(doc, limits)).toBe("LIMIT_EXCEEDED")
    }
  })

  it("reports comment limits under regions./tracks. paths", () => {
    const doc: Loose = clone(validDocument())
    doc.regions.r1.comment = "x".repeat(50)
    try {
      parseDocument(doc, { limits: { maxCommentLength: 10 } })
      expect.unreachable()
    } catch (error) {
      expect(isAnnotateError(error) && error.issues?.[0]?.path).toBe("regions.r1.comment")
    }
  })
})

describe("defaults and consistency", () => {
  it("enforces the default statuses when config.statuses is absent", () => {
    const doc: Loose = clone(validDocument())
    doc.regions.r1.status = "weird"
    expect(codeOf(doc)).toBe("INVALID_DOCUMENT")
    doc.regions.r1.status = "accepted"
    expect(codeOf(doc)).toBe("ACCEPTED")
  })

  it("rejects a schema major other than the supported one", () => {
    const doc: Loose = clone(validDocument())
    doc.schemaVersion = "0.9"
    expect(codeOf(doc)).toBe("UNSUPPORTED_VERSION")
  })

  it("rejects duplicate tag references", () => {
    const doc: Loose = clone(validDocument())
    doc.regions.r1.tagIds = ["t1", "t1"]
    expect(codeOf(doc)).toBe("INVALID_DOCUMENT")
  })

  it("rejects incoherent attribute definitions", () => {
    const cases: ((d: Loose) => void)[] = [
      (d) => Object.assign(d.config.attributes.score, { min: 5, max: 1 }),
      (d) => (d.config.attributes.occluded = { key: "occluded", label: "O", type: "enum" }),
      (d) => (d.config.attributes.score.default = 7),
      (d) => (d.config.classes.c1.attributeKeys = ["score", "score"]),
    ]
    for (const mutate of cases) {
      const doc: Loose = clone(validDocument())
      mutate(doc)
      expect(codeOf(doc)).not.toBe("ACCEPTED")
    }
  })
})

describe("resource exhaustion", () => {
  it("caps config list lengths before they are searched per annotation", () => {
    const doc: Loose = clone(validDocument())
    doc.config.statuses = Array.from({ length: 5000 }, (_, i) => `s${i}`)
    expect(codeOf(doc)).toBe("INVALID_DOCUMENT")
    const tools: Loose = clone(validDocument())
    tools.config.tools = Array.from({ length: 5000 }, (_, i) => `t${i}`)
    expect(codeOf(tools)).toBe("INVALID_DOCUMENT")
    const options: Loose = clone(validDocument())
    options.config.attributes.occluded = {
      key: "occluded",
      label: "O",
      type: "enum",
      options: Array.from({ length: 5000 }, (_, i) => `o${i}`),
    }
    expect(codeOf(options)).toBe("INVALID_DOCUMENT")
  })

  it("rejects too many annotations before schema-parsing them", () => {
    const doc: Loose = clone(validDocument())
    for (let i = 0; i < 20; i++) doc.regions[`x${i}`] = { not: "a region" }
    expect(codeOf(doc, { maxAnnotations: 10 })).toBe("LIMIT_EXCEEDED")
  })

  it("caps the number of mask runs", () => {
    const doc: Loose = clone(validDocument())
    doc.regions.r5.geometry.counts = new Array(5_000_000).fill(0).concat([8])
    expect(codeOf(doc)).toBe("INVALID_DOCUMENT")
  })

  it("does not echo long attacker-controlled text in messages", () => {
    const doc: Loose = clone(validDocument())
    doc.regions.r1.status = "x".repeat(100_000)
    try {
      parseDocument(doc)
      expect.unreachable()
    } catch (error) {
      expect(isAnnotateError(error) && error.message.length).toBeLessThan(500)
    }
  })

  it("maps exotic input failures to typed errors", () => {
    const doc: Loose = clone(validDocument())
    Object.defineProperty(doc, "meta", {
      enumerable: true,
      get() {
        throw new Error("boom")
      },
    })
    expect(codeOf(doc)).toBe("INVALID_DOCUMENT")
  })

  it("parseDocumentJson refuses non-string input with a typed error", () => {
    expect(() => parseDocumentJson(undefined as unknown as string)).toThrow(/string/)
    try {
      parseDocumentJson(123 as unknown as string)
    } catch (error) {
      expect(isAnnotateError(error)).toBe(true)
    }
  })
})
