import { describe, expect, it } from "vitest"
import { apply } from "../src/ops/apply.js"
import type { AnnotationDocument } from "../src/types.js"
import { parseDocument } from "../src/validate/index.js"
import { geometryWeight } from "../src/validate/limit-checks.js"
import { type Loose, box, clone, validDocument, validVideoDocument } from "./fixtures.js"
import { AT, batchOf, codeOf, errorOf, nest, opId, reload, run } from "./ops-helpers.js"

const meta = () => ({ id: opId(), type: "setDocumentMeta", patch: { "a:x": 1 } })

describe("the batch envelope", () => {
  const envelope = (extra: Loose): unknown => ({
    id: "b1",
    origin: "local",
    at: AT,
    ops: [meta()],
    ...extra,
  })
  const code = (batch: unknown, limits?: Loose) =>
    codeOf(() => apply(validDocument(), batch as never, limits ? { limits } : {}))

  it.each<[string, unknown]>([
    ["a null batch", null],
    ["a string batch", "batch"],
    ["an array batch", [meta()]],
    ["an invalid id", envelope({ id: "not an id" })],
    ["a missing id", envelope({ id: undefined })],
    ["an unknown origin", envelope({ origin: "elsewhere" })],
    ["non-array ops", envelope({ ops: { 0: meta(), length: 1 } })],
    ["empty ops", envelope({ ops: [] })],
    ["a non-string actor", envelope({ actor: 7 })],
    ["a null label", envelope({ label: null })],
  ])("rejects %s with INVALID_DOCUMENT", (_, batch) => {
    expect(code(batch)).toBe("INVALID_DOCUMENT")
  })

  it("accepts an actor and a label and bounds them by maxStringLength", () => {
    expect(() =>
      apply(validDocument(), envelope({ actor: "ann", label: "Paste 2" }) as never),
    ).not.toThrow()
    expect(() =>
      apply(validDocument(), envelope({ actor: undefined, label: undefined }) as never),
    ).not.toThrow()
    const limits = { maxStringLength: 5 }
    expect(() =>
      apply(validDocument(), envelope({ actor: "abcde", label: "abcde" }) as never, { limits }),
    ).not.toThrow()
    expect(code(envelope({ actor: "abcdef" }), limits)).toBe("LIMIT_EXCEEDED")
    expect(code(envelope({ label: "abcdef" }), limits)).toBe("LIMIT_EXCEEDED")
  })
})

describe("operation-path checks", () => {
  const base = validDocument()

  it("rejects a structurally invalid geometry in setGeometry with INVALID_GEOMETRY", () => {
    const op = { id: opId(), type: "setGeometry", regionId: "r1", geometry: { type: "box", x: 1 } }
    expect(codeOf(() => run(base, [op]))).toBe("INVALID_GEOMETRY")
  })

  it("refuses to move a region between an image and a video source", () => {
    const video = validVideoDocument()
    const toVideo = { id: opId(), type: "moveRegionToSource", regionId: "r1", sourceId: "v1" }
    expect(codeOf(() => run(video, [toVideo]))).toBe("INVALID_DOCUMENT")
    const toImage = { id: opId(), type: "moveRegionToSource", regionId: "vr1", sourceId: "s1" }
    expect(codeOf(() => run(video, [toImage]))).toBe("INVALID_DOCUMENT")
  })

  it("applies the per-shape vertex limit to new regions", () => {
    const polygon = {
      ...box("n1"),
      geometry: { type: "polygon", rings: [[1, 1, 9, 1, 9, 9, 1, 9, 5, 5]] },
    }
    const create = { id: opId(), type: "createRegion", region: polygon }
    expect(() => run(base, [create], { limits: { maxVerticesPerShape: 5 } })).not.toThrow()
    expect(codeOf(() => run(base, [create], { limits: { maxVerticesPerShape: 4 } }))).toBe(
      "LIMIT_EXCEEDED",
    )
  })

  it("applies the depth limit to custom geometry data of new regions", () => {
    const custom = (depth: number) => ({
      ...box("n1"),
      geometry: { type: "custom", kind: "acme:thing", data: nest(depth) },
    })
    const create = (depth: number) => ({ id: opId(), type: "createRegion", region: custom(depth) })
    const limits = { maxMetaDepth: 4 }
    expect(() => run(base, [create(3)], { limits })).not.toThrow()
    expect(codeOf(() => run(base, [create(6)], { limits }))).toBe("LIMIT_EXCEEDED")
  })

  it("checks baseRev on reorderRegion and setDocumentMeta", () => {
    const doc: Loose = clone(base)
    doc.rev = 4
    doc.regions.r1.rev = 2
    const parsed = parseDocument(doc)
    const reorder = (baseRev: number) => ({
      id: opId(),
      type: "reorderRegion",
      regionId: "r1",
      position: "top",
      baseRev,
    })
    expect(codeOf(() => run(parsed, [reorder(1)]))).toBe("REV_CONFLICT")
    expect(() => run(parsed, [reorder(2)])).not.toThrow()
    const setMeta = (baseRev: number) => ({ ...meta(), baseRev })
    expect(codeOf(() => run(parsed, [setMeta(3)]))).toBe("REV_CONFLICT")
    expect(() => run(parsed, [setMeta(4)])).not.toThrow()
  })

  it("restores regions at deletedRev + 1 when deleteRegions empties a source", () => {
    const doc: Loose = clone(base)
    doc.regions.r1.rev = 6
    const all = Object.keys(doc.regions)
    const result = run(reload(doc), [
      { id: opId(), type: "deleteRegions", regionIds: all, children: "delete" },
    ])
    expect(result.doc.sources["s1"]?.regionOrder).toEqual([])
    const undone = run(result.doc, result.inverse)
    expect(undone.doc.regions["r1"]?.rev).toBe(7)
    expect(undone.doc.regions["r2"]?.rev).toBe(1)
  })
})

// Boundaries that surviving mutants showed were untested.
describe("validation boundaries", () => {
  const parse = (doc: Loose, limits?: Loose) =>
    codeOf(() => parseDocument(doc, limits ? { limits } : {}))
  const accepted = (doc: Loose, limits?: Loose) =>
    expect(() => parseDocument(doc, limits ? { limits } : {})).not.toThrow()
  const withBox = (x: number, y: number, w: number, h: number): Loose => {
    const doc: Loose = clone(validDocument())
    doc.regions.r1.geometry = { type: "box", x, y, w, h }
    return doc
  }

  it("tolerates 0.5 px outside the image, not 0.6 px", () => {
    accepted(withBox(900, 700, 100.5, 100))
    expect(parse(withBox(900, 700, 100.6, 100))).toBe("OUT_OF_BOUNDS")
  })

  it("rejects a box that overflows only the bottom edge", () => {
    accepted(withBox(10, 700, 10, 100))
    expect(parse(withBox(10, 700, 10, 101))).toBe("OUT_OF_BOUNDS")
  })

  it("rejects keypoints with more points than the skeleton", () => {
    const doc: Loose = clone(validDocument())
    doc.regions.r4.geometry.points.push(40, 40, 2)
    expect(parse(doc)).toBe("INVALID_GEOMETRY")
  })

  it("accepts a mask of exactly maxMaskPixels and rejects one more", () => {
    accepted(validDocument(), { maxMaskPixels: 8 })
    expect(parse(validDocument(), { maxMaskPixels: 7 })).toBe("LIMIT_EXCEEDED")
  })

  it("accepts attribute numbers at min and max, and min == max", () => {
    const withScore = (score: number, min = 0, max = 1): Loose => {
      const doc: Loose = clone(validDocument())
      doc.config.attributes.score.min = min
      doc.config.attributes.score.max = max
      doc.regions.r1.attributes.score = score
      return doc
    }
    accepted(withScore(0))
    accepted(withScore(1))
    expect(parse(withScore(-0.001))).toBe("ATTRIBUTE_INVALID")
    expect(parse(withScore(1.001))).toBe("ATTRIBUTE_INVALID")
    accepted(withScore(0.5, 0.5, 0.5))
  })

  it("accepts exactly maxTotalVertices and rejects one fewer", () => {
    const doc = validDocument()
    const total = Object.values(doc.regions).reduce((n, r) => n + geometryWeight(r.geometry), 0)
    accepted(doc, { maxTotalVertices: total })
    expect(parse(doc, { maxTotalVertices: total - 1 })).toBe("LIMIT_EXCEEDED")
  })

  it("bounds an annotation status by maxStringLength", () => {
    const doc: Loose = clone(validDocument())
    const status = "s".repeat(100)
    doc.config.statuses = ["draft", status]
    doc.regions.r1.status = status
    accepted(doc, { maxStringLength: 100 })
    const error = errorOf(() => parseDocument(doc, { limits: { maxStringLength: 99 } }))
    expect(error.code).toBe("LIMIT_EXCEEDED")
    expect(error.issues?.map((i) => i.path)).toContain("regions.r1.status")
  })
})

describe("apply on documents it did not produce", () => {
  it("works on a parsed document end to end", () => {
    const doc: AnnotationDocument = parseDocument(clone(validDocument()))
    const result = apply(doc, batchOf([meta()]))
    expect(result.doc.meta["a:x"]).toBe(1)
  })
})
