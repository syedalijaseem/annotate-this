import { describe, expect, it } from "vitest"
import * as core from "../src/index.js"

describe("annotate-this-core public API", () => {
  it("exposes the document schema version as major.minor", () => {
    expect(core.SCHEMA_VERSION).toMatch(/^\d+\.\d+$/)
  })

  it("exports the document-model entry points", () => {
    for (const name of [
      "parseDocument",
      "parseDocumentJson",
      "createDocument",
      "createIdGenerator",
      "isValidId",
      "AnnotateError",
      "isAnnotateError",
      "DEFAULT_LIMITS",
      "resolveLimits",
      "geometryBounds",
      "apply",
      "ID_PATTERN_SOURCE",
    ]) {
      expect(core, name).toHaveProperty(name)
    }
  })

  it("supports the documented flow end to end through the public entry only", () => {
    let n = 0
    const doc = core.createDocument({
      images: [{ src: "https://example.com/a.png", width: 100, height: 80 }],
      classes: ["cat"],
      idGenerator: () => `id${++n}`,
    })
    const sourceId = doc.sourceOrder[0] as string
    const region = {
      id: "r1",
      sourceId,
      tagIds: [],
      attributes: {},
      status: "draft",
      provenance: { source: "manual" as const },
      meta: {},
      geometry: { type: "box" as const, x: 1, y: 1, w: 10, h: 10 },
    }
    const batch: core.Batch = {
      id: "b1",
      origin: "local",
      at: "2026-10-21T12:00:00Z",
      ops: [{ id: "o1", type: "createRegion", region }],
    }
    const options: core.ApplyBatchOptions = {}
    const result = core.apply(doc, batch, options)
    expect(result.changes.created).toEqual(["r1"])
    const reloaded = core.parseDocumentJson(JSON.stringify(result.doc))
    const undone = core.apply(reloaded, { ...batch, id: "b2", ops: result.inverse })
    expect(undone.doc.regions).toEqual({})
    try {
      core.apply(doc, { ...batch, ops: [] })
      expect.unreachable()
    } catch (error) {
      expect(core.isAnnotateError(error) && error.code).toBe("INVALID_DOCUMENT")
    }
  })

  it("can be imported in a DOM-free environment", () => {
    expect(typeof (globalThis as { document?: unknown }).document).toBe("undefined")
    expect(typeof (globalThis as { window?: unknown }).window).toBe("undefined")
  })
})
