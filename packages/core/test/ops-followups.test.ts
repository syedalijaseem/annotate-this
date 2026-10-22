import { describe, expect, it } from "vitest"
import type { Operation } from "../src/ops/types.js"
import { parseDocument } from "../src/validate/index.js"
import { type Loose, clone, validDocument, validVideoDocument } from "./fixtures.js"
import { codeOf, nest, opId, richDocument, roundTrip, run } from "./ops-helpers.js"

const base = richDocument()
const op = (body: Loose): Operation => ({ id: opId(), ...body }) as Operation

describe('the id "config" is reserved everywhere', () => {
  const withId = (place: (doc: Loose) => void) => {
    const doc: Loose = clone(validDocument())
    place(doc)
    return () => parseDocument(doc)
  }

  it.each<[string, (doc: Loose) => void]>([
    [
      "source",
      (doc) => {
        doc.sources.config = { ...doc.sources.s1, id: "config", regionOrder: [] }
        doc.sourceOrder.push("config")
      },
    ],
    [
      "region",
      (doc) => {
        doc.regions.config = { ...doc.regions.r3, id: "config" }
        doc.sources.s1.regionOrder.push("config")
      },
    ],
    [
      "class",
      (doc) => {
        doc.config.classes.config = { id: "config", name: "x", meta: {} }
        doc.config.classOrder.push("config")
      },
    ],
    [
      "tag",
      (doc) => {
        doc.config.tags.config = { id: "config", name: "x", meta: {} }
        doc.config.tagOrder.push("config")
      },
    ],
    [
      "skeleton",
      (doc) => {
        doc.config.skeletons.config = { ...doc.config.skeletons.k1, id: "config" }
      },
    ],
    ["document", (doc) => (doc.id = "config")],
  ])("parseDocument rejects a %s with id config", (_, place) => {
    expect(codeOf(withId(place))).toBe("INVALID_DOCUMENT")
  })

  it("parseDocument rejects a track with id config", () => {
    const doc: Loose = clone(validVideoDocument())
    expect(() => parseDocument(doc)).not.toThrow()
    doc.tracks = { config: { ...doc.tracks.tr1, id: "config" } }
    doc.sources.v1.trackOrder = ["config"]
    expect(codeOf(() => parseDocument(doc))).toBe("INVALID_DOCUMENT")
  })
})

describe("setConfig changes config.meta per key", () => {
  const setMeta = (meta: Loose) => op({ type: "setConfig", patch: { meta } })

  it("sets, replaces and deletes keys, and is undone", () => {
    const first = roundTrip(base, [setMeta({ "a:x": 1, "a:y": { z: [1] } })])
    expect(first.doc.config.meta).toEqual({ "a:x": 1, "a:y": { z: [1] } })
    expect(first.doc.config.rev).toBe(base.config.rev + 1)
    const second = roundTrip(first.doc, [setMeta({ "a:x": null, "a:y": 2 })])
    expect(second.doc.config.meta).toEqual({ "a:y": 2 })
    expect(run(second.doc, [setMeta({ "a:y": 2, "a:q": null })]).inverse).toEqual([])
  })

  it("enforces depth, key and forbidden-key rules", () => {
    expect(codeOf(() => run(base, [setMeta({ "a:x": nest(40) })]))).toBe("LIMIT_EXCEEDED")
    const wide = Object.fromEntries(Array.from({ length: 11 }, (_, i) => [`k${i}`, 1]))
    expect(codeOf(() => run(base, [setMeta(wide)], { limits: { maxEntries: 10 } }))).toBe(
      "LIMIT_EXCEEDED",
    )
    const forbidden = JSON.parse('{"__proto__": 1}') as unknown
    expect(codeOf(() => run(base, [setMeta(forbidden)]))).toBe("INVALID_DOCUMENT")
    expect(codeOf(() => run(base, [setMeta([])]))).toBe("INVALID_DOCUMENT")
  })
})

describe("status strings are length-limited", () => {
  const long = "x".repeat(10_001)

  it("in parseDocument", () => {
    const doc: Loose = clone(validDocument())
    doc.config.statuses = ["draft", long]
    expect(codeOf(() => parseDocument(doc))).toBe("LIMIT_EXCEEDED")
  })

  it("in setConfig", () => {
    const patch = { statuses: ["draft", long] }
    expect(codeOf(() => run(base, [op({ type: "setConfig", patch })]))).toBe("LIMIT_EXCEEDED")
  })
})

describe("apply hardening follow-ups", () => {
  it("turns a throwing inverseId into a typed error", () => {
    const body = { type: "patchRegion", regionId: "r1", patch: { comment: "x" } }
    const inverseId = () => {
      throw new Error("boom")
    }
    expect(codeOf(() => run(base, [op(body)], { inverseId }))).toBe("INVALID_DOCUMENT")
  })

  it("returns the same document for a batch that nets out to nothing", () => {
    const source = { ...clone(base.sources["s2"]), id: "s9", regionOrder: [] }
    const result = run(base, [
      op({ type: "addSource", source }),
      op({ type: "removeSource", sourceId: "s9" }),
    ])
    expect(result.doc.rev).toBe(base.rev)
    expect(result.changes).toEqual({ created: [], updated: [], deleted: [] })
    expect(result.inverse).toEqual([])
    const there = run(base, [
      op({ type: "reorderSource", sourceId: "s1", position: "top" }),
      op({ type: "reorderSource", sourceId: "s1", position: "bottom" }),
    ])
    expect(there.doc.rev).toBe(base.rev)
    expect(there.inverse).toEqual([])
    const meta = run(base, [
      op({ type: "setDocumentMeta", patch: { "a:x": 1 } }),
      op({ type: "setDocumentMeta", patch: { "a:x": null } }),
    ])
    expect(meta.doc.rev).toBe(base.rev)
    expect(meta.inverse).toEqual([])
  })
})
