import { describe, expect, it } from "vitest"
import { createDocument } from "../src/create-document.js"
import { isAnnotateError } from "../src/errors.js"
import { isValidId } from "../src/ids.js"
import { parseDocument } from "../src/validate/index.js"

/** Deterministic ids, so the output is stable. */
function sequence() {
  let n = 0
  return { idGenerator: () => `id${++n}` }
}

const image = { src: "https://example.com/a/photo one.jpg?size=big#top", width: 640, height: 480 }

describe("createDocument", () => {
  it("builds a valid document from images alone", () => {
    const doc = createDocument({ images: [image] })
    expect(() => parseDocument(doc)).not.toThrow()
    expect(doc.sourceOrder).toHaveLength(1)
    const source = doc.sources[doc.sourceOrder[0] as string]
    expect(source).toMatchObject({
      kind: "image",
      width: 640,
      height: 480,
      uri: image.src,
      regionOrder: [],
      rev: 0,
    })
  })

  it("derives a display name from the url when none is given", () => {
    const doc = createDocument({ images: [image] })
    expect(doc.sources[doc.sourceOrder[0] as string]?.name).toBe("photo one.jpg")
  })

  it("keeps an explicit name and thumbnail", () => {
    const doc = createDocument({
      images: [{ ...image, name: "Kitten", thumbnailSrc: "https://example.com/t.jpg" }],
    })
    const source = doc.sources[doc.sourceOrder[0] as string]
    expect(source?.name).toBe("Kitten")
    expect(source?.thumbnailUri).toBe("https://example.com/t.jpg")
  })

  it("keeps image order", () => {
    const doc = createDocument({
      images: [
        { ...image, name: "one" },
        { ...image, name: "two" },
        { ...image, name: "three" },
      ],
    })
    expect(doc.sourceOrder.map((id) => doc.sources[id]?.name)).toEqual(["one", "two", "three"])
  })

  it("creates classes and tags from plain strings, in order", () => {
    const doc = createDocument({ images: [image], classes: ["Alpha", "Beta"], tags: ["blurry"] })
    expect(doc.config.classOrder.map((id) => doc.config.classes[id]?.name)).toEqual([
      "Alpha",
      "Beta",
    ])
    expect(doc.config.tagOrder.map((id) => doc.config.tags[id]?.name)).toEqual(["blurry"])
  })

  it("accepts class objects with an explicit id and color", () => {
    const doc = createDocument({
      images: [image],
      classes: [{ id: "cat", name: "Cat", color: "#ff8800" }],
    })
    expect(doc.config.classes["cat"]).toMatchObject({ id: "cat", name: "Cat", color: "#ff8800" })
  })

  it("passes through task description, tools and allowed area", () => {
    const doc = createDocument({
      images: [image],
      taskDescription: "Draw boxes",
      tools: ["select", "box"],
      allowedArea: { x: 10, y: 10, w: 100, h: 100 },
    })
    expect(doc.config.taskDescription).toBe("Draw boxes")
    expect(doc.config.tools).toEqual(["select", "box"])
    expect(doc.config.allowedArea).toEqual({ type: "box", x: 10, y: 10, w: 100, h: 100 })
  })

  it("allows an empty document (no images yet)", () => {
    const doc = createDocument({})
    expect(doc.sourceOrder).toEqual([])
    expect(() => parseDocument(doc)).not.toThrow()
  })

  it("uses the injected id generator for a reproducible result", () => {
    const a = createDocument({ images: [image], classes: ["x"], ...sequence() })
    const b = createDocument({ images: [image], classes: ["x"], ...sequence() })
    expect(a).toEqual(b)
    expect(a.id).toBe("id1")
  })

  it("generates valid default ids", () => {
    const doc = createDocument({ images: [image, image], classes: ["a"] })
    for (const id of [doc.id, ...doc.sourceOrder, ...doc.config.classOrder])
      expect(isValidId(id)).toBe(true)
    expect(new Set([doc.id, ...doc.sourceOrder, ...doc.config.classOrder]).size).toBe(4)
  })

  it("starts every entity at rev 0 and the current schema version", () => {
    const doc = createDocument({ images: [image] })
    expect(doc.rev).toBe(0)
    expect(doc.config.rev).toBe(0)
    expect(doc.schemaVersion).toBe("1.0")
  })

  it.each([
    ["zero width", { ...image, width: 0 }],
    ["fractional height", { ...image, height: 480.5 }],
    ["negative width", { ...image, width: -1 }],
  ])("rejects %s", (_name, bad) => {
    try {
      createDocument({ images: [bad] })
    } catch (error) {
      expect(isAnnotateError(error) && error.code).toBe("INVALID_DOCUMENT")
      return
    }
    throw new Error("expected createDocument to throw")
  })

  it("rejects duplicate explicit class ids", () => {
    try {
      createDocument({
        classes: [
          { id: "x", name: "A" },
          { id: "x", name: "B" },
        ],
      })
    } catch (error) {
      expect(isAnnotateError(error) && error.code).toBe("DUPLICATE_ID")
      return
    }
    throw new Error("expected createDocument to throw")
  })

  it("does not mutate its input", () => {
    const input = { images: [{ ...image }], classes: ["A"], tools: ["select"] }
    const snapshot = JSON.parse(JSON.stringify(input))
    createDocument(input)
    expect(input).toEqual(snapshot)
  })
})
