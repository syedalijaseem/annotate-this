import { describe, expect, it } from "vitest"
import { DEFAULT_LIMITS } from "../src/limits.js"
import { apply, applyMetered } from "../src/ops/apply.js"
import type { Operation } from "../src/ops/types.js"
import type { AnnotationDocument, Region } from "../src/types.js"
import { geometryWeight } from "../src/validate/limit-checks.js"
import { type Loose, box, clone, must, validDocument } from "./fixtures.js"
import {
  AT,
  batchOf,
  codeOf,
  nest,
  opId,
  reload,
  richDocument,
  roundTrip,
  run,
  stable,
  videoDocument,
} from "./ops-helpers.js"

const base = richDocument()
const video = videoDocument()
const op = (body: Loose): Operation => ({ id: opId(), ...body }) as Operation
const sourceOrder = (doc: AnnotationDocument) => doc.sourceOrder

const image = (id: string, extra: Loose = {}): Loose => ({
  kind: "image",
  id,
  name: `${id}.jpg`,
  uri: `https://example.com/${id}.jpg`,
  width: 640,
  height: 480,
  regionOrder: [],
  tagIds: [],
  attributes: {},
  meta: {},
  ...extra,
})

const videoSource = (id: string, extra: Loose = {}): Loose => ({
  ...image(id),
  kind: "video",
  frameCount: 3,
  fps: 30,
  trackOrder: [],
  ...extra,
})

describe("addSource", () => {
  const add = (source: Loose, extra: Loose = {}) => op({ type: "addSource", source, ...extra })

  it("adds on top (end of sourceOrder) by default, with rev 0", () => {
    const result = roundTrip(base, [add(image("s9"))])
    expect(sourceOrder(result.doc)).toEqual(["s1", "s2", "s9"])
    expect(result.doc.sources["s9"]?.rev).toBe(0)
    expect(result.changes.created).toEqual(["s9"])
    expect(result.changes.updated).toEqual([base.id])
    expect(result.inverse[0]).toMatchObject({ type: "removeSource", sourceId: "s9" })
  })

  it("supports bottom and after positions", () => {
    expect(sourceOrder(roundTrip(base, [add(image("s9"), { position: "bottom" })]).doc)).toEqual([
      "s9",
      "s1",
      "s2",
    ])
    const after = roundTrip(base, [add(image("s9"), { position: { after: "s1" } })])
    expect(sourceOrder(after.doc)).toEqual(["s1", "s9", "s2"])
    expect(codeOf(() => run(base, [add(image("s9"), { position: { after: "r1" } })]))).toBe(
      "NOT_FOUND",
    )
    expect(codeOf(() => run(base, [add(image("s9"), { position: { after: "s9" } })]))).toBe(
      "INVALID_DOCUMENT",
    )
  })

  it("adds labelled sources whose references exist", () => {
    const labelled = image("s9", { classId: "c1", tagIds: ["t2"], attributes: { score: 1 } })
    expect(roundTrip(base, [add(labelled)]).doc.sources["s9"]?.classId).toBe("c1")
    expect(codeOf(() => run(base, [add(image("s9", { classId: "nope" }))]))).toBe(
      "INVALID_DOCUMENT",
    )
    expect(codeOf(() => run(base, [add(image("s9", { tagIds: ["t1", "t1"] }))]))).toBe(
      "INVALID_DOCUMENT",
    )
    expect(codeOf(() => run(base, [add(image("s9", { attributes: { score: 4 } }))]))).toBe(
      "ATTRIBUTE_INVALID",
    )
    expect(codeOf(() => run(base, [add(image("s9", { attributes: { nope: 1 } }))]))).toBe(
      "ATTRIBUTE_INVALID",
    )
  })

  it("adds video sources with exactly one of fps or timestamps", () => {
    roundTrip(base, [add(videoSource("v9"))])
    const timed = videoSource("v9", { timestamps: [0, 0.5, 1] })
    delete timed.fps
    roundTrip(base, [add(timed)])
    const both = videoSource("v9", { timestamps: [0, 0.5, 1] })
    const neither = videoSource("v9")
    delete neither.fps
    const short = { ...timed, timestamps: [0, 1] }
    const unordered = { ...timed, timestamps: [0, 1, 1] }
    for (const bad of [both, neither, short, unordered]) {
      expect(codeOf(() => run(base, [add(bad)]))).toBe("INVALID_DOCUMENT")
    }
  })

  it("requires empty region and track orders", () => {
    expect(codeOf(() => run(base, [add(image("s9", { regionOrder: ["r1"] }))]))).toBe(
      "INVALID_DOCUMENT",
    )
    expect(codeOf(() => run(base, [add(videoSource("v9", { trackOrder: ["tr1"] }))]))).toBe(
      "INVALID_DOCUMENT",
    )
  })

  it("validates dimensions and shape", () => {
    for (const bad of [
      image("s9", { width: 0 }),
      image("s9", { height: 1.5 }),
      image("s9", { kind: "audio" }),
      videoSource("v9", { frameCount: 0 }),
      { ...image("s9"), name: undefined },
      null,
      [],
    ]) {
      expect(codeOf(() => run(base, [add(bad)]))).toBe("INVALID_DOCUMENT")
    }
  })

  it("requires a new, usable id", () => {
    for (const id of ["s1", "r1", "c1", "t1", "k1", base.id]) {
      expect(codeOf(() => run(base, [add(image(id))]))).toBe("DUPLICATE_ID")
    }
    for (const id of ["config", "__proto__", "constructor"]) {
      expect(codeOf(() => run(base, [add(image(id))]))).toBe("INVALID_DOCUMENT")
    }
  })

  it("enforces text, meta-depth, unknown-field depth and record-size limits", () => {
    const limits = { maxStringLength: 10 }
    expect(codeOf(() => run(base, [add(image("s9", { name: "x".repeat(20) }))], { limits }))).toBe(
      "LIMIT_EXCEEDED",
    )
    expect(codeOf(() => run(base, [add(image("s9", { meta: { "a:b": nest(40) } }))]))).toBe(
      "LIMIT_EXCEEDED",
    )
    expect(codeOf(() => run(base, [add(image("s9", { x_ext: nest(63) }))]))).toBe("LIMIT_EXCEEDED")
    // The sources record is one object, so it is bound by maxEntries too.
    const full: Loose = clone(validDocument())
    full.regions = {}
    full.sources = {}
    full.sourceOrder = []
    for (let i = 0; i < 12; i++) {
      full.sources[`q${i}`] = image(`q${i}`, { rev: 0 })
      full.sourceOrder.push(`q${i}`)
    }
    expect(codeOf(() => run(full, [add(image("s9"))], { limits: { maxEntries: 12 } }))).toBe(
      "LIMIT_EXCEEDED",
    )
    expect(() => run(full, [add(image("s9"))], { limits: { maxEntries: 13 } })).not.toThrow()
  })

  it("stores a copy, never the caller's object", () => {
    const source = image("s9", { meta: { "a:b": [1] } })
    const result = run(base, [add(source)])
    source.meta["a:b"].push(2)
    expect(result.doc.sources["s9"]?.meta).toEqual({ "a:b": [1] })
  })
})

describe("updateSource", () => {
  const update = (patch: Loose, sourceId = "s1", extra: Loose = {}) =>
    op({ type: "updateSource", sourceId, patch, ...extra })

  it("patches every patchable field and clears optional ones with null", () => {
    const patch = {
      name: "renamed.jpg",
      uri: "https://example.com/renamed.jpg",
      thumbnailUri: "https://example.com/t.jpg",
      classId: "c2",
      tagIds: ["t2"],
      attributes: { score: 0.4 },
      comment: "note",
      allowedArea: { type: "box", x: 0, y: 0, w: 1000, h: 800 },
      scale: { pixelSize: { w: 0.1, h: 0.1 } },
      meta: { "a:b": 1 },
    }
    const result = roundTrip(base, [update(patch)])
    expect(result.doc.sources["s1"]).toMatchObject(patch)
    expect(result.doc.sources["s1"]?.rev).toBe(must(base.sources["s1"]).rev + 1)
    expect(result.changes.updated).toEqual(expect.arrayContaining(["s1", base.id]))
    const cleared = roundTrip(result.doc, [
      update({
        thumbnailUri: null,
        classId: null,
        comment: null,
        allowedArea: null,
        scale: null,
        attributes: { score: null },
        meta: { "a:b": null },
      }),
    ])
    const s1 = must(cleared.doc.sources["s1"]) as Loose
    for (const key of ["thumbnailUri", "classId", "comment", "allowedArea", "scale"]) {
      expect(key in s1).toBe(false)
    }
    expect(s1.attributes).toEqual({})
  })

  it("bumps the source rev once per op and not for a no-op", () => {
    const result = run(base, [update({ name: "a", comment: "b", tagIds: [] })])
    expect(result.doc.sources["s1"]?.rev).toBe(must(base.sources["s1"]).rev + 1)
    const same = run(base, [update({ name: "photo.jpg", comment: null })])
    expect(same.doc).toEqual(base)
    expect(same.inverse).toEqual([])
  })

  it.each([["kind"], ["width"], ["height"], ["frameCount"], ["regionOrder"], ["id"], ["rev"]])(
    "never patches %s",
    (field) => {
      expect(codeOf(() => run(base, [update({ [field]: 1 })]))).toBe("INVALID_DOCUMENT")
    },
  )

  it("validates references, attributes and text", () => {
    expect(codeOf(() => run(base, [update({ classId: "nope" })]))).toBe("INVALID_DOCUMENT")
    expect(codeOf(() => run(clone(base), [update({ classId: "toString" })]))).toBe(
      "INVALID_DOCUMENT",
    )
    expect(codeOf(() => run(base, [update({ tagIds: ["nope"] })]))).toBe("INVALID_DOCUMENT")
    expect(codeOf(() => run(base, [update({ attributes: { score: 9 } })]))).toBe(
      "ATTRIBUTE_INVALID",
    )
    expect(codeOf(() => run(base, [update({ name: null })]))).toBe("INVALID_DOCUMENT")
    expect(
      codeOf(() =>
        run(base, [update({ scale: { realSize: { w: 1, h: 1, unit: "x".repeat(20) } } })], {
          limits: { maxStringLength: 10 },
        }),
      ),
    ).toBe("LIMIT_EXCEEDED")
    expect(codeOf(() => run(base, [update({ meta: { "a:b": nest(40) } })]))).toBe("LIMIT_EXCEEDED")
  })

  it("refuses an allowed area that the source's geometry would violate", () => {
    const small = { type: "box", x: 0, y: 0, w: 50, h: 50 }
    expect(codeOf(() => run(base, [update({ allowedArea: small })]))).toBe("IN_USE")
    // Clearing falls back to the config area, which may be stricter.
    const doc: Loose = clone(base)
    doc.sources.s1.allowedArea = { type: "box", x: 0, y: 0, w: 1000, h: 800 }
    doc.config.allowedArea = { type: "box", x: 0, y: 0, w: 5, h: 5 }
    doc.sources.s2.allowedArea = { type: "box", x: 0, y: 0, w: 1000, h: 800 }
    expect(codeOf(() => run(reload(doc), [update({ allowedArea: null })]))).toBe("IN_USE")
    // The other source's area is not involved.
    expect(roundTrip(reload(doc), [update({ allowedArea: null }, "s2")]).doc).toBeDefined()
    // Track keyframes count.
    const tracks: Loose = clone(video)
    tracks.sources.v1.regionOrder = []
    delete tracks.regions.vr1
    const area = { type: "box", x: 0, y: 0, w: 120, h: 120 }
    expect(codeOf(() => run(tracks, [update({ allowedArea: area }, "v1")]))).toBe("IN_USE")
  })

  it("checks baseRev against the source rev and fails for unknown sources", () => {
    expect(codeOf(() => run(base, [update({ name: "x" }, "s1", { baseRev: 7 })]))).toBe(
      "REV_CONFLICT",
    )
    expect(codeOf(() => run(base, [update({ name: "x" }, "nope")]))).toBe("NOT_FOUND")
    expect(codeOf(() => run(clone(base), [update({ name: "x" }, "toString")]))).toBe("NOT_FOUND")
    expect(codeOf(() => run(base, [update({ name: "x" }, "r1")]))).toBe("NOT_FOUND")
  })
})

describe("removeSource", () => {
  const remove = (sourceId: string, extra: Loose = {}) =>
    op({ type: "removeSource", sourceId, ...extra })

  it("removes the source and cascades to its regions", () => {
    const result = roundTrip(base, [remove("s1")])
    expect(result.doc.sources["s1"]).toBeUndefined()
    expect(sourceOrder(result.doc)).toEqual(["s2"])
    expect(Object.keys(result.doc.regions)).toEqual([])
    expect(result.changes.deleted.sort()).toEqual(["r1", "r2", "r3", "r4", "r5", "s1"])
  })

  it("restores interleaved parent/child z-order exactly on undo", () => {
    const doc: Loose = clone(base)
    doc.sources.s1.regionOrder = ["r3", "r1", "r5", "r2", "r4"]
    doc.regions.r2.parentId = "r1"
    doc.regions.r4.parentId = "r2"
    doc.regions.r3.parentId = "r4"
    doc.sourceOrder = ["s2", "s1"]
    const result = roundTrip(reload(doc), [remove("s1")])
    const undone = run(result.doc, result.inverse)
    expect(undone.doc.sources["s1"]?.regionOrder).toEqual(["r3", "r1", "r5", "r2", "r4"])
    expect(sourceOrder(undone.doc)).toEqual(["s2", "s1"])
  })

  it("restores entities with rev = deletedRev + 1", () => {
    const doc: Loose = clone(base)
    doc.sources.s1.rev = 4
    doc.regions.r1.rev = 9
    const result = run(reload(doc), [remove("s1")])
    const undone = run(result.doc, result.inverse)
    expect(undone.doc.regions["r1"]?.rev).toBe(10)
    expect(must(undone.doc.sources["s1"]).rev).toBeGreaterThan(4)
  })

  it("re-adding a removed source in the same batch continues its rev", () => {
    const doc: Loose = clone(base)
    doc.sources.s2.rev = 6
    const s2 = clone(doc.sources.s2)
    s2.rev = 0
    const result = run(reload(doc), [remove("s2"), op({ type: "addSource", source: s2 })])
    expect(result.doc.sources["s2"]?.rev).toBe(7)
    expect(result.changes.updated).toContain("s2")
    expect(result.changes.deleted).toEqual([])
  })

  it("keeps the vertex and annotation totals right after a cascade", () => {
    const polygon = (id: string): Operation =>
      op({
        type: "createRegion",
        region: {
          ...box(id, "s2"),
          geometry: { type: "polygon", rings: [[1, 1, 9, 1, 9, 9, 1, 9]] },
        },
      })
    const existing = Object.values(base.regions).reduce((n, r) => n + geometryWeight(r.geometry), 0)
    expect(existing).toBeGreaterThanOrEqual(8)
    const limits = { maxTotalVertices: existing + 4, maxAnnotations: 6 }
    expect(codeOf(() => run(base, [polygon("n0"), polygon("n1")], { limits }))).toBe(
      "LIMIT_EXCEEDED",
    )
    // n0 makes the engine count the totals before the cascade runs.
    const ops = [polygon("n0"), remove("s1"), polygon("n1"), polygon("n2")]
    expect(Object.keys(run(base, ops, { limits }).doc.regions)).toEqual(["n0", "n1", "n2"])
  })

  it("removes a video source without tracks but refuses one with tracks", () => {
    const doc: Loose = clone(video)
    expect(codeOf(() => run(doc, [remove("v1")]))).toBe("IN_USE")
    doc.sources.v1.trackOrder = []
    doc.tracks = {}
    const result = roundTrip(reload(doc), [remove("v1")])
    expect(result.doc.regions["vr1"]).toBeUndefined()
  })

  it("checks baseRev and fails for unknown sources", () => {
    expect(codeOf(() => run(base, [remove("s1", { baseRev: 3 })]))).toBe("REV_CONFLICT")
    expect(codeOf(() => run(base, [remove("nope")]))).toBe("NOT_FOUND")
    expect(codeOf(() => run(clone(base), [remove("toString")]))).toBe("NOT_FOUND")
  })

  it("cascades 50,000 regions quickly and the undo restores them", () => {
    const doc: Loose = clone(validDocument())
    doc.regions = {}
    doc.sources.s1.regionOrder = []
    for (let i = 0; i < 50_000; i++) {
      const region: Region = box(`m${i}`, "s1", 10, 10, 20, 20)
      if (i % 3 === 1) region.parentId = `m${i - 1}`
      doc.regions[`m${i}`] = region
      doc.sources.s1.regionOrder.push(`m${i}`)
    }
    // Work units are calibrated to engine time: a fifth of the default budget is quick.
    const { result, work } = applyMetered(doc, batchOf([remove("s1")]))
    expect(work).toBeLessThan(DEFAULT_LIMITS.maxBatchWork / 5)
    expect(Object.keys(result.doc.regions)).toHaveLength(0)
    expect(result.inverse).toHaveLength(2)
    const undone = apply(result.doc, { id: "undo", origin: "local", at: AT, ops: result.inverse })
    expect(undone.doc.sources["s1"]?.regionOrder).toEqual(doc.sources.s1.regionOrder)
    expect(stable(undone.doc)).toEqual(stable(doc))
  }, 30_000)

  it("is stopped by the work budget", () => {
    expect(codeOf(() => run(base, [remove("s1")], { limits: { maxBatchWork: 5 } }))).toBe(
      "LIMIT_EXCEEDED",
    )
  })
})

describe("reorderSource", () => {
  const reorder = (sourceId: string, position: Loose, extra: Loose = {}) =>
    op({ type: "reorderSource", sourceId, position, ...extra })
  const three = (): AnnotationDocument =>
    run(base, [op({ type: "addSource", source: image("s3") })]).doc

  it("moves to top, bottom and after another source", () => {
    const doc = three()
    expect(sourceOrder(roundTrip(doc, [reorder("s1", "top")]).doc)).toEqual(["s2", "s3", "s1"])
    expect(sourceOrder(roundTrip(doc, [reorder("s3", "bottom")]).doc)).toEqual(["s3", "s1", "s2"])
    expect(sourceOrder(roundTrip(doc, [reorder("s1", { after: "s2" })]).doc)).toEqual([
      "s2",
      "s1",
      "s3",
    ])
  })

  it("changes the document but not the source rev (the document owns sourceOrder)", () => {
    const doc = three()
    const result = run(doc, [reorder("s1", "top")])
    expect(result.doc.sources["s1"]?.rev).toBe(doc.sources["s1"]?.rev)
    expect(result.doc.rev).toBe(doc.rev + 1)
    expect(result.changes).toEqual({ created: [], updated: [doc.id], deleted: [] })
  })

  it("is a no-op when already in place", () => {
    expect(run(base, [reorder("s2", "top")]).doc).toEqual(base)
    expect(run(base, [reorder("s2", { after: "s1" })]).inverse).toEqual([])
  })

  it("rejects unknown sources and anchors, self anchors and a stale baseRev", () => {
    expect(codeOf(() => run(base, [reorder("nope", "top")]))).toBe("NOT_FOUND")
    expect(codeOf(() => run(base, [reorder("s1", { after: "nope" })]))).toBe("NOT_FOUND")
    expect(codeOf(() => run(base, [reorder("s1", { after: "s1" })]))).toBe("INVALID_DOCUMENT")
    expect(codeOf(() => run(base, [reorder("s1", "top", { baseRev: 5 })]))).toBe("REV_CONFLICT")
  })
})

describe("malformed config and source operations give typed errors", () => {
  const cases: [string, Loose][] = [
    ["setConfig without patch", { type: "setConfig" }],
    ["addClass without def", { type: "addClass" }],
    ["addClass extra key", { type: "addClass", def: { id: "c9", name: "x", meta: {} }, x: 1 }],
    [
      "addClass bad position",
      { type: "addClass", def: { id: "c9", name: "x", meta: {} }, position: 3 },
    ],
    ["updateClass without patch", { type: "updateClass", classId: "c1" }],
    ["updateClass numeric id", { type: "updateClass", classId: 1, patch: {} }],
    ["removeClass without policy", { type: "removeClass", classId: "c1" }],
    ["removeClass bad policy", { type: "removeClass", classId: "c1", onInUse: "delete" }],
    ["reorderClass without position", { type: "reorderClass", classId: "c1" }],
    ["addTag array def", { type: "addTag", def: [] }],
    ["updateTag null patch", { type: "updateTag", tagId: "t1", patch: null }],
    ["removeTag without id", { type: "removeTag", onInUse: "reject" }],
    ["reorderTag position object", { type: "reorderTag", tagId: "t1", position: { before: "t2" } }],
    [
      "setAttributeDef bad type",
      { type: "setAttributeDef", def: { key: "k", label: "K", type: "x" } },
    ],
    ["removeAttributeDef bad key", { type: "removeAttributeDef", key: "a b", onInUse: "reject" }],
    [
      "addSkeleton bad edges",
      { type: "addSkeleton", def: { id: "k9", name: "n", points: [{ name: "a" }], edges: [[0]] } },
    ],
    [
      "updateSkeleton empty points",
      { type: "updateSkeleton", skeletonId: "k1", patch: { points: [] } },
    ],
    ["removeSkeleton numeric", { type: "removeSkeleton", skeletonId: 7 }],
    ["addSource without source", { type: "addSource" }],
    ["updateSource array patch", { type: "updateSource", sourceId: "s1", patch: [] }],
    [
      "updateSource tagIds string",
      { type: "updateSource", sourceId: "s1", patch: { tagIds: "t1" } },
    ],
    ["removeSource extra key", { type: "removeSource", sourceId: "s1", cascade: true }],
    ["reorderSource bad position", { type: "reorderSource", sourceId: "s1", position: "middle" }],
  ]

  it.each(cases)("%s", (_name, body) => {
    expect(codeOf(() => run(base, [{ id: opId(), ...body }]))).toBe("INVALID_DOCUMENT")
  })

  it("rejects forbidden keys in every new map patch", () => {
    const hostile = JSON.parse('{"__proto__": 1}') as Loose
    const ops = [
      { type: "updateClass", classId: "c1", patch: { meta: hostile } },
      { type: "updateTag", tagId: "t1", patch: { meta: hostile } },
      { type: "updateSource", sourceId: "s1", patch: { meta: hostile } },
      { type: "updateSource", sourceId: "s1", patch: { attributes: hostile } },
    ]
    for (const body of ops) expect(codeOf(() => run(base, [op(body)]))).toBe("INVALID_DOCUMENT")
  })

  it("terminates on cyclic and very deep payloads", () => {
    const cyclic: Loose = { id: "c9", name: "x", meta: {} }
    cyclic.self = cyclic
    expect(codeOf(() => run(base, [op({ type: "addClass", def: cyclic })]))).toBe("LIMIT_EXCEEDED")
    const deep = image("s9", { x_ext: nest(100_000) })
    expect(codeOf(() => run(base, [op({ type: "addSource", source: deep })]))).toBe(
      "LIMIT_EXCEEDED",
    )
  })

  it("treats explicit undefined optional fields as absent", () => {
    const result = run(base, [
      op({
        type: "addClass",
        def: { id: "c9", name: "x", meta: {}, color: undefined },
        position: undefined,
      }),
      op({ type: "updateSource", sourceId: "s1", patch: { name: "y", comment: undefined } }),
    ])
    expect("color" in must(result.doc.config.classes["c9"])).toBe(false)
    expect(result.doc.sources["s1"]?.name).toBe("y")
  })

  it("survives a throwing getter inside a definition", () => {
    const def = { id: "c9", meta: {} }
    Object.defineProperty(def, "name", {
      enumerable: true,
      get() {
        throw new Error("boom")
      },
    })
    expect(codeOf(() => run(base, [op({ type: "addClass", def })]))).toBe("INVALID_DOCUMENT")
  })
})
