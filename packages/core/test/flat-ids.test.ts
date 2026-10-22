import { describe, expect, it } from "vitest"
import { createDocument } from "../src/create-document.js"
import { parseDocument } from "../src/validate/index.js"
import { type Loose, box, clone, validDocument } from "./fixtures.js"
import { errorOf, opId, run } from "./ops-helpers.js"

// Spec 0001, invariant 1: one flat id space, the document id included.
describe("the document id is part of the flat id space", () => {
  it.each<[string, (doc: Loose) => void, string]>([
    [
      "a region",
      (doc) => {
        doc.regions.doc1 = { ...box("doc1") }
        doc.sources.s1.regionOrder.push("doc1")
      },
      "regions.doc1",
    ],
    [
      "a source",
      (doc) => {
        doc.sources.doc1 = { ...clone(doc.sources.s1), id: "doc1", regionOrder: [] }
        doc.sourceOrder.push("doc1")
      },
      "sources.doc1",
    ],
    [
      "a class",
      (doc) => {
        doc.config.classes.doc1 = { id: "doc1", name: "x", meta: {} }
        doc.config.classOrder.push("doc1")
      },
      "config.classes.doc1",
    ],
  ])("rejects %s whose id is the document id", (_, corrupt, path) => {
    const doc: Loose = clone(validDocument())
    expect(doc.id).toBe("doc1")
    corrupt(doc)
    const error = errorOf(() => parseDocument(doc))
    expect(error.code).toBe("DUPLICATE_ID")
    expect(error.issues?.[0]?.path).toBe(path)
    expect(error.issues?.[0]?.message).toMatch(/document id/)
  })

  it("agrees with apply, which already refuses the document id", () => {
    const create = { id: opId(), type: "createRegion", region: box("doc1") }
    expect(errorOf(() => run(validDocument(), [create])).code).toBe("DUPLICATE_ID")
  })
})

describe("createDocument keeps generated ids unique", () => {
  const image = { src: "a.png", width: 10, height: 10 }

  it("fails with DUPLICATE_ID when the generator repeats the document id", () => {
    const error = errorOf(() => createDocument({ images: [image], idGenerator: () => "same" }))
    expect(error.code).toBe("DUPLICATE_ID")
    expect(error.message).toMatch(/"same"/)
  })

  it("fails with DUPLICATE_ID when two images get the same id", () => {
    let n = 0
    const ids = ["d", "s", "s"]
    const error = errorOf(() =>
      createDocument({ images: [image, image], idGenerator: () => ids[n++] ?? "z" }),
    )
    expect(error.code).toBe("DUPLICATE_ID")
  })

  it("fails with DUPLICATE_ID when a label reuses an image id", () => {
    let n = 0
    const ids = ["d", "s"]
    const error = errorOf(() =>
      createDocument({
        images: [image],
        classes: [{ id: "s", name: "x" }],
        idGenerator: () => ids[n++] ?? "z",
      }),
    )
    expect(error.code).toBe("DUPLICATE_ID")
  })
})
