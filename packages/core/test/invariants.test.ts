import { describe, expect, it } from "vitest"
import type { ErrorCode } from "../src/errors.js"
import { isAnnotateError } from "../src/errors.js"
import type { Limits } from "../src/limits.js"
import { parseDocument } from "../src/validate/index.js"
import { type Loose, box, clone, must, validDocument, validVideoDocument } from "./fixtures.js"

type Mutation = (doc: Loose) => void

function expectFailure(doc: unknown, code: ErrorCode, pathPart: string, limits?: Partial<Limits>) {
  try {
    parseDocument(doc, limits ? { limits } : {})
  } catch (error) {
    if (!isAnnotateError(error)) throw error
    expect(error.code).toBe(code)
    expect(
      error.issues?.some((i) => i.path.includes(pathPart)),
      `no issue path contains "${pathPart}": ${JSON.stringify(error.issues)}`,
    ).toBe(true)
    return
  }
  throw new Error(`expected ${code} at ${pathPart} but the document was accepted`)
}

function runCases(
  cases: [string, Mutation, ErrorCode, string][],
  base: () => Loose = validDocument,
) {
  it.each(cases)("%s", (_name, mutate, code, path) => {
    const doc = clone(base())
    mutate(doc)
    expectFailure(doc, code, path)
  })
}

describe("identity and ordering", () => {
  runCases([
    [
      "record key differs from entity id",
      (d) => (d.regions.r1.id = "other"),
      "INVALID_DOCUMENT",
      "regions.r1",
    ],
    [
      "id reused across kinds (class vs region)",
      (d) => {
        d.config.classes.r1 = { ...d.config.classes.c1, id: "r1" }
        delete d.config.classes.c1
        d.config.classOrder = ["r1"]
        d.regions.r1.classId = "r1"
      },
      "DUPLICATE_ID",
      "r1",
    ],
    [
      "sourceOrder missing a source",
      (d) => (d.sourceOrder = []),
      "INVALID_DOCUMENT",
      "sourceOrder",
    ],
    [
      "sourceOrder lists a source twice",
      (d) => (d.sourceOrder = ["s1", "s1"]),
      "INVALID_DOCUMENT",
      "sourceOrder",
    ],
    [
      "regionOrder missing a region",
      (d) => (d.sources.s1.regionOrder = ["r1", "r2"]),
      "INVALID_DOCUMENT",
      "regionOrder",
    ],
    [
      "regionOrder lists an unknown region",
      (d) => d.sources.s1.regionOrder.push("ghost"),
      "INVALID_DOCUMENT",
      "regionOrder",
    ],
    ["classOrder out of sync", (d) => (d.config.classOrder = []), "INVALID_DOCUMENT", "classOrder"],
    [
      "tagOrder out of sync",
      (d) => (d.config.tagOrder = ["t1", "t1"]),
      "INVALID_DOCUMENT",
      "tagOrder",
    ],
    [
      "attribute record key differs from key",
      (d) => (d.config.attributes.score.key = "other"),
      "INVALID_DOCUMENT",
      "config.attributes.score",
    ],
  ])

  it("accepts regionOrder containing exactly the source's regions in any order", () => {
    const doc = clone(validDocument())
    must(doc.sources["s1"]).regionOrder = ["r5", "r4", "r3", "r2", "r1"]
    expect(() => parseDocument(doc)).not.toThrow()
  })
})

describe("references", () => {
  runCases([
    [
      "unknown sourceId",
      (d) => (d.regions.r1.sourceId = "nope"),
      "INVALID_DOCUMENT",
      "regions.r1.sourceId",
    ],
    [
      "unknown classId",
      (d) => (d.regions.r1.classId = "nope"),
      "INVALID_DOCUMENT",
      "regions.r1.classId",
    ],
    [
      "unknown tagId",
      (d) => (d.regions.r1.tagIds = ["nope"]),
      "INVALID_DOCUMENT",
      "regions.r1.tagIds",
    ],
    [
      "unknown parentId",
      (d) => (d.regions.r2.parentId = "nope"),
      "INVALID_DOCUMENT",
      "regions.r2.parentId",
    ],
    [
      "unknown skeleton",
      (d) => (d.regions.r4.geometry.skeletonId = "nope"),
      "INVALID_DOCUMENT",
      "skeletonId",
    ],
    [
      "unknown source classId",
      (d) => (d.sources.s1.classId = "nope"),
      "INVALID_DOCUMENT",
      "sources.s1.classId",
    ],
    [
      "unknown class parent",
      (d) => (d.config.classes.c1.parentId = "nope"),
      "INVALID_DOCUMENT",
      "config.classes.c1.parentId",
    ],
    [
      "unknown class attributeKey",
      (d) => (d.config.classes.c1.attributeKeys = ["nope"]),
      "INVALID_DOCUMENT",
      "attributeKeys",
    ],
    [
      "skeleton edge out of range",
      (d) => (d.config.skeletons.k1.edges = [[0, 9]]),
      "INVALID_DOCUMENT",
      "edges",
    ],
    [
      "status not in config.statuses",
      (d) => (d.config.statuses = ["draft2"]),
      "INVALID_DOCUMENT",
      "status",
    ],
    [
      "region parent in another source",
      (d) => {
        d.sources.s2 = { ...clone(d.sources.s1), id: "s2", regionOrder: ["x1"] }
        d.sourceOrder.push("s2")
        d.regions.x1 = box("x1", "s2")
        d.regions.r2.parentId = "x1"
      },
      "INVALID_DOCUMENT",
      "regions.r2.parentId",
    ],
  ])

  runCases([
    ["region parenting itself", (d) => (d.regions.r1.parentId = "r1"), "CYCLE", "regions.r1"],
    [
      "two regions parenting each other",
      (d) => {
        d.regions.r1.parentId = "r2"
        d.regions.r2.parentId = "r1"
      },
      "CYCLE",
      "parentId",
    ],
    [
      "class hierarchy cycle",
      (d) => {
        d.config.classes.c2 = { ...clone(d.config.classes.c1), id: "c2", parentId: "c1" }
        d.config.classes.c1.parentId = "c2"
        d.config.classOrder.push("c2")
      },
      "CYCLE",
      "config.classes",
    ],
  ])

  it("accepts a valid parent chain across a region and a track", () => {
    const doc = clone(validVideoDocument())
    must(doc.regions["vr1"]).parentId = "tr1"
    expect(() => parseDocument(doc)).not.toThrow()
  })

  it("rejects a track on an image source", () => {
    const doc = clone(validVideoDocument()) as Loose
    doc.tracks.tr1.sourceId = "s1"
    expectFailure(doc, "INVALID_DOCUMENT", "tracks.tr1.sourceId")
  })
})

describe("geometry rules", () => {
  runCases([
    [
      "keypoints with the wrong number of points",
      (d) => (d.regions.r4.geometry.points = [1, 1, 2]),
      "INVALID_GEOMETRY",
      "regions.r4",
    ],
    [
      "mask runs that do not sum to width*height",
      (d) => (d.regions.r5.geometry.counts = [1, 1]),
      "INVALID_GEOMETRY",
      "regions.r5",
    ],
    [
      "box outside the image",
      (d) => (d.regions.r1.geometry = { type: "box", x: 950, y: 10, w: 100, h: 10 }),
      "OUT_OF_BOUNDS",
      "regions.r1",
    ],
    [
      "polygon outside the image",
      (d) => (d.regions.r2.geometry.rings[0][0] = -50),
      "OUT_OF_BOUNDS",
      "regions.r2",
    ],
    [
      "point on negative coordinates",
      (d) => (d.regions.r3.geometry.x = -5),
      "OUT_OF_BOUNDS",
      "regions.r3",
    ],
    [
      "geometry outside a source allowedArea",
      (d) => (d.sources.s1.allowedArea = { type: "box", x: 0, y: 0, w: 50, h: 50 }),
      "OUT_OF_BOUNDS",
      "regions.r1",
    ],
    [
      "geometry outside config.allowedArea",
      (d) => (d.config.allowedArea = { type: "box", x: 0, y: 0, w: 50, h: 50 }),
      "OUT_OF_BOUNDS",
      "regions.r1",
    ],
  ])

  it("tolerates rounding error up to half a pixel", () => {
    const doc = clone(validDocument())
    must(doc.regions["r1"]).geometry = { type: "box", x: -0.4, y: 0, w: 1000.8, h: 800 }
    expect(() => parseDocument(doc)).not.toThrow()
  })

  it("ignores unlabeled keypoints when checking bounds", () => {
    const doc = clone(validDocument())
    must(doc.regions["r4"]).geometry = {
      type: "keypoints",
      skeletonId: "k1",
      points: [10, 10, 2, 9999, 9999, 0, 30, 30, 1],
    }
    expect(() => parseDocument(doc)).not.toThrow()
  })

  it("accepts custom geometry without bounds", () => {
    const doc = clone(validDocument())
    must(doc.regions["r3"]).geometry = {
      type: "custom",
      kind: "acme:lasso",
      data: { anything: [1, 2, 3] },
    }
    expect(() => parseDocument(doc)).not.toThrow()
  })
})

describe("video rules", () => {
  runCases(
    [
      [
        "both fps and timestamps",
        (d) => (d.sources.v1.timestamps = Array.from({ length: 100 }, (_, i) => i / 25)),
        "INVALID_DOCUMENT",
        "sources.v1",
      ],
      [
        "neither fps nor timestamps",
        (d) => delete d.sources.v1.fps,
        "INVALID_DOCUMENT",
        "sources.v1",
      ],
      [
        "timestamps of the wrong length",
        (d) => {
          delete d.sources.v1.fps
          d.sources.v1.timestamps = [0, 1, 2]
        },
        "INVALID_DOCUMENT",
        "timestamps",
      ],
      [
        "timestamps not strictly increasing",
        (d) => {
          delete d.sources.v1.fps
          d.sources.v1.timestamps = Array.from({ length: 100 }, (_, i) => (i === 50 ? 0 : i))
        },
        "INVALID_DOCUMENT",
        "timestamps",
      ],
      [
        "video region without a frame",
        (d) => delete d.regions.vr1.frame,
        "INVALID_DOCUMENT",
        "regions.vr1.frame",
      ],
      [
        "video region frame out of range",
        (d) => (d.regions.vr1.frame = 100),
        "INVALID_DOCUMENT",
        "regions.vr1.frame",
      ],
      [
        "image region with a frame",
        (d) => (d.regions.r1.frame = 3),
        "INVALID_DOCUMENT",
        "regions.r1.frame",
      ],
      [
        "keyframes not strictly increasing",
        (d) => (d.tracks.tr1.keyframes[1].frame = 0),
        "INVALID_DOCUMENT",
        "keyframes.1.frame",
      ],
      [
        "keyframe beyond the last frame",
        (d) => (d.tracks.tr1.keyframes[1].frame = 100),
        "INVALID_DOCUMENT",
        "keyframes.1.frame",
      ],
      [
        "keyframe geometry differs from the track type",
        (d) => (d.tracks.tr1.keyframes[1].geometry = { type: "point", x: 1, y: 1 }),
        "INVALID_GEOMETRY",
        "keyframes.1.geometry",
      ],
      [
        "keyframe geometry out of bounds",
        (d) => (d.tracks.tr1.keyframes[0].geometry.x = 5000),
        "OUT_OF_BOUNDS",
        "keyframes.0",
      ],
      [
        "trackOrder out of sync",
        (d) => (d.sources.v1.trackOrder = []),
        "INVALID_DOCUMENT",
        "trackOrder",
      ],
    ],
    validVideoDocument,
  )

  it("accepts timestamps instead of fps", () => {
    const doc = clone(validVideoDocument()) as Loose
    delete doc.sources.v1.fps
    doc.sources.v1.timestamps = Array.from({ length: 100 }, (_, i) => i / 30)
    expect(() => parseDocument(doc)).not.toThrow()
  })
})

describe("labels and attributes", () => {
  runCases([
    [
      "unknown attribute on a region",
      (d) => (d.regions.r1.attributes.mystery = true),
      "ATTRIBUTE_INVALID",
      "regions.r1.attributes.mystery",
    ],
    [
      "wrong attribute type",
      (d) => (d.regions.r1.attributes.occluded = "yes"),
      "ATTRIBUTE_INVALID",
      "occluded",
    ],
    [
      "number below min",
      (d) => (d.regions.r1.attributes.score = -0.5),
      "ATTRIBUTE_INVALID",
      "score",
    ],
    ["number above max", (d) => (d.regions.r1.attributes.score = 2), "ATTRIBUTE_INVALID", "score"],
    [
      "enum value not in options",
      (d) => {
        d.config.attributes.mood = {
          key: "mood",
          label: "Mood",
          type: "enum",
          options: ["calm", "angry"],
        }
        d.regions.r1.attributes.mood = "sleepy"
      },
      "ATTRIBUTE_INVALID",
      "mood",
    ],
    [
      "unknown attribute on a source",
      (d) => (d.sources.s1.attributes.mystery = 1),
      "ATTRIBUTE_INVALID",
      "sources.s1.attributes",
    ],
    [
      "class disallows the geometry type",
      (d) => (d.config.classes.c1.allowedGeometry = ["polygon"]),
      "INVALID_GEOMETRY",
      "regions.r1.geometry",
    ],
  ])

  it("accepts an enum value from the options", () => {
    const doc = clone(validDocument())
    doc.config.attributes["mood"] = {
      key: "mood",
      label: "Mood",
      type: "enum",
      options: ["calm", "angry"],
    }
    must(doc.regions["r1"]).attributes["mood"] = "calm"
    expect(() => parseDocument(doc)).not.toThrow()
  })

  it("does not require required attributes at load time", () => {
    const doc = clone(validDocument())
    must(doc.config.attributes["occluded"]).required = true
    delete (doc.regions["r1"] as Loose).attributes.occluded
    expect(() => parseDocument(doc)).not.toThrow()
  })
})

describe("resource limits", () => {
  it("rejects too many annotations", () => {
    expectFailure(clone(validDocument()), "LIMIT_EXCEEDED", "regions", { maxAnnotations: 3 })
  })

  it("rejects too many total vertices", () => {
    expectFailure(clone(validDocument()), "LIMIT_EXCEEDED", "regions", { maxTotalVertices: 5 })
  })

  it("rejects a shape with too many vertices", () => {
    expectFailure(clone(validDocument()), "LIMIT_EXCEEDED", "regions.r2", {
      maxVerticesPerShape: 3,
    })
  })

  it("rejects overlong names and comments", () => {
    const doc = clone(validDocument())
    must(doc.sources["s1"]).name = "x".repeat(20)
    expectFailure(doc, "LIMIT_EXCEEDED", "sources.s1.name", { maxStringLength: 10 })
    const doc2 = clone(validDocument())
    must(doc2.regions["r1"]).comment = "y".repeat(50)
    expectFailure(doc2, "LIMIT_EXCEEDED", "comment", { maxCommentLength: 10 })
  })

  it("rejects meta nested too deeply", () => {
    const doc = clone(validDocument()) as Loose
    let nested: Loose = {}
    doc.regions.r1.meta = { "acme:deep": nested }
    for (let i = 0; i < 12; i++) {
      nested["n"] = {}
      nested = nested["n"]
    }
    expectFailure(doc, "LIMIT_EXCEEDED", "regions.r1.meta", { maxMetaDepth: 5 })
  })

  it("rejects a mask larger than the pixel limit", () => {
    expectFailure(clone(validDocument()), "LIMIT_EXCEEDED", "regions.r5", { maxMaskPixels: 4 })
  })

  it("turns a stack-overflowing nest into LIMIT_EXCEEDED instead of crashing", () => {
    const doc = clone(validDocument()) as Loose
    let nested: Loose = {}
    doc.regions.r1.meta = { "acme:deep": nested }
    for (let i = 0; i < 200_000; i++) {
      nested["n"] = {}
      nested = nested["n"]
    }
    expectFailure(doc, "LIMIT_EXCEEDED", "document")
  })
})
