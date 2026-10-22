import { describe, expect, it } from "vitest"
import type { Operation } from "../src/ops/types.js"
import type { AnnotationDocument } from "../src/types.js"
import { type Loose, box, clone, must, validDocument } from "./fixtures.js"
import {
  codeOf,
  nest,
  opId,
  reload,
  richDocument,
  roundTrip,
  run,
  videoDocument,
} from "./ops-helpers.js"

const base = richDocument()
const video = videoDocument()
const op = (body: Loose): Operation => ({ id: opId(), ...body }) as Operation
const classOrder = (doc: AnnotationDocument) => doc.config.classOrder
const tagOrder = (doc: AnnotationDocument) => doc.config.tagOrder

describe("setConfig", () => {
  const set = (patch: Loose, extra: Loose = {}) => op({ type: "setConfig", patch, ...extra })

  it("sets and clears fields, bumps config.rev once and reports 'config'", () => {
    const patch = {
      taskDescription: "Label cars",
      tools: ["box", "polygon"],
      allowedArea: { type: "box", x: 0, y: 0, w: 1000, h: 800 },
      minRegionSize: 2,
      statuses: ["draft", "done"],
    }
    const result = roundTrip(base, [set(patch)])
    expect(result.doc.config).toMatchObject(patch)
    expect(result.doc.config.rev).toBe(base.config.rev + 1)
    expect(result.doc.rev).toBe(base.rev + 1)
    expect(result.changes.updated).toEqual(expect.arrayContaining(["config", base.id]))
    const cleared = roundTrip(result.doc, [
      set({
        taskDescription: null,
        tools: null,
        allowedArea: null,
        minRegionSize: null,
        statuses: null,
      }),
    ])
    for (const key of ["taskDescription", "tools", "allowedArea", "minRegionSize", "statuses"]) {
      expect(key in cleared.doc.config).toBe(false)
    }
  })

  it("bumps config.rev once per op, not once per field", () => {
    const result = run(base, [
      set({ taskDescription: "a", tools: ["box"] }),
      set({ taskDescription: "b" }),
    ])
    expect(result.doc.config.rev).toBe(base.config.rev + 2)
  })

  it("is a no-op when nothing changes", () => {
    const result = run(base, [set({ taskDescription: null, statuses: null })])
    expect(result.doc.rev).toBe(base.rev)
    expect(result.inverse).toEqual([])
    expect(result.changes).toEqual({ created: [], updated: [], deleted: [] })
  })

  it("checks baseRev against config.rev", () => {
    expect(codeOf(() => run(base, [set({ minRegionSize: 1 }, { baseRev: 3 })]))).toBe(
      "REV_CONFLICT",
    )
    expect(run(base, [set({ minRegionSize: 1 }, { baseRev: 0 })]).doc.config.minRegionSize).toBe(1)
    expect(() =>
      run(base, [set({ minRegionSize: 1 }, { baseRev: 9 })], { ignoreRev: true }),
    ).not.toThrow()
  })

  it("refuses statuses that existing regions or tracks still use", () => {
    expect(codeOf(() => run(base, [set({ statuses: ["submitted"] })]))).toBe("IN_USE")
    const custom: Loose = clone(base)
    custom.config.statuses = ["draft", "odd"]
    custom.regions.r1.status = "odd"
    // Clearing falls back to the default statuses, which do not include "odd".
    expect(codeOf(() => run(custom, [set({ statuses: null })]))).toBe("IN_USE")
    const track: Loose = clone(video)
    track.config.statuses = ["draft", "odd"]
    track.tracks.tr1.status = "odd"
    expect(codeOf(() => run(track, [set({ statuses: ["draft"] })]))).toBe("IN_USE")
  })

  it("refuses an allowed area that existing geometry would violate", () => {
    const small = { type: "box", x: 0, y: 0, w: 50, h: 50 }
    expect(codeOf(() => run(base, [set({ allowedArea: small })]))).toBe("IN_USE")
    // Track keyframes count too (tr1 has a keyframe at 100,100).
    const onlyTrack: Loose = clone(video)
    onlyTrack.sources.s1.allowedArea = { type: "box", x: 0, y: 0, w: 1000, h: 800 }
    onlyTrack.sources.v1.regionOrder = []
    delete onlyTrack.regions.vr1
    const area = { type: "box", x: 0, y: 0, w: 120, h: 120 }
    expect(codeOf(() => run(onlyTrack, [set({ allowedArea: area })]))).toBe("IN_USE")
  })

  it("does not check the config area against sources that have their own", () => {
    const doc: Loose = clone(base)
    doc.sources.s1.allowedArea = { type: "box", x: 0, y: 0, w: 1000, h: 800 }
    const small = { type: "box", x: 0, y: 0, w: 5, h: 5 }
    expect(roundTrip(doc, [set({ allowedArea: small })]).doc.config.allowedArea).toEqual(small)
  })

  it("enforces text limits", () => {
    const limits = { maxCommentLength: 5, maxStringLength: 5 }
    expect(codeOf(() => run(base, [set({ taskDescription: "too long" })], { limits }))).toBe(
      "LIMIT_EXCEEDED",
    )
    expect(codeOf(() => run(base, [set({ tools: ["far too long"] })], { limits }))).toBe(
      "LIMIT_EXCEEDED",
    )
  })

  it.each([
    ["an unknown field", { classes: {} }],
    ["empty statuses", { statuses: [] }],
    ["a non-box area", { allowedArea: { type: "point", x: 1, y: 1 } }],
    ["a negative minRegionSize", { minRegionSize: -1 }],
    ["an array patch", []],
    ["a null patch", null],
  ])("rejects %s", (_name, patch) => {
    expect(codeOf(() => run(base, [set(patch)]))).toBe("INVALID_DOCUMENT")
  })

  it("rejects an allowed area with unknown fields nested too deep", () => {
    const allowedArea = { type: "box", x: 0, y: 0, w: 10, h: 10, x_ext: nest(63) }
    expect(codeOf(() => run(base, [set({ allowedArea })]))).toBe("LIMIT_EXCEEDED")
  })
})

describe("addClass", () => {
  const def = (id: string, extra: Loose = {}) => ({ id, name: `Class ${id}`, meta: {}, ...extra })
  const add = (d: Loose, extra: Loose = {}) => op({ type: "addClass", def: d, ...extra })

  it("adds on top of the order by default, or at bottom / after another class", () => {
    const top = roundTrip(base, [add(def("c9"))])
    expect(classOrder(top.doc)).toEqual(["c1", "c2", "c9"])
    expect(top.doc.config.rev).toBe(base.config.rev + 1)
    expect(top.changes.updated).toContain("config")
    expect(classOrder(roundTrip(base, [add(def("c9"), { position: "bottom" })]).doc)).toEqual([
      "c9",
      "c1",
      "c2",
    ])
    const after = roundTrip(base, [add(def("c9"), { position: { after: "c1" } })])
    expect(classOrder(after.doc)).toEqual(["c1", "c9", "c2"])
  })

  it("accepts a parent and attribute keys that exist", () => {
    const result = roundTrip(base, [
      add(def("c9", { parentId: "c2", attributeKeys: ["occluded"], allowedGeometry: ["box"] })),
    ])
    expect(result.doc.config.classes["c9"]?.parentId).toBe("c2")
  })

  it("requires a new, usable id", () => {
    for (const id of ["c1", "t1", "k1", "s1", "r1", base.id]) {
      expect(codeOf(() => run(base, [add(def(id))]))).toBe("DUPLICATE_ID")
    }
    for (const id of ["config", "__proto__", "constructor", "prototype"]) {
      expect(codeOf(() => run(base, [add(def(id))]))).toBe("INVALID_DOCUMENT")
    }
  })

  it("rejects unknown parents, attribute keys and anchors", () => {
    expect(codeOf(() => run(base, [add(def("c9", { parentId: "nope" }))]))).toBe("INVALID_DOCUMENT")
    expect(codeOf(() => run(clone(base), [add(def("c9", { parentId: "toString" }))]))).toBe(
      "INVALID_DOCUMENT",
    )
    expect(codeOf(() => run(base, [add(def("c9", { attributeKeys: ["nope"] }))]))).toBe(
      "INVALID_DOCUMENT",
    )
    expect(codeOf(() => run(base, [add(def("c9", { attributeKeys: ["score", "score"] }))]))).toBe(
      "INVALID_DOCUMENT",
    )
    expect(codeOf(() => run(base, [add(def("c9"), { position: { after: "nope" } })]))).toBe(
      "NOT_FOUND",
    )
  })

  it("rejects malformed definitions", () => {
    for (const bad of [
      { id: "c9", meta: {} },
      def("c9", { color: "red" }),
      def("c9", { allowedGeometry: ["blob"] }),
      def("c9", { meta: JSON.parse('{"__proto__": 1}') }),
      null,
      [],
    ]) {
      expect(codeOf(() => run(base, [add(bad)]))).toBe("INVALID_DOCUMENT")
    }
  })

  it("enforces text, meta-depth, unknown-field depth and record-size limits", () => {
    expect(
      codeOf(() =>
        run(base, [add(def("c9", { name: "x".repeat(20) }))], {
          limits: { maxStringLength: 10 },
        }),
      ),
    ).toBe("LIMIT_EXCEEDED")
    expect(codeOf(() => run(base, [add(def("c9", { meta: { "a:b": nest(40) } }))]))).toBe(
      "LIMIT_EXCEEDED",
    )
    expect(codeOf(() => run(base, [add(def("c9", { x_ext: nest(62) }))]))).toBe("LIMIT_EXCEEDED")
    // The classes record is one object, so it is bound by maxEntries too.
    const full: Loose = clone(validDocument())
    full.regions = {}
    full.sources.s1.regionOrder = []
    full.config.classes = { c1: def("c1"), c2: def("c2"), c3: def("c3"), c4: def("c4") }
    full.config.classOrder = ["c1", "c2", "c3", "c4"]
    expect(codeOf(() => run(full, [add(def("c9"))], { limits: { maxEntries: 4 } }))).toBe(
      "LIMIT_EXCEEDED",
    )
    expect(() => run(full, [add(def("c9"))], { limits: { maxEntries: 5 } })).not.toThrow()
  })

  it("stores a copy, never the caller's object", () => {
    const d = def("c9", { meta: { "a:b": [1] } })
    const result = run(base, [add(d)])
    d.meta["a:b"].push(2)
    expect(result.doc.config.classes["c9"]?.meta).toEqual({ "a:b": [1] })
  })

  it("can re-add a class removed earlier in the batch", () => {
    const d = clone(must(base.config.classes["c2"]))
    const result = run(base, [
      op({ type: "removeClass", classId: "c2", onInUse: "detach" }),
      add(d, { position: "bottom" }),
    ])
    expect(classOrder(result.doc)).toEqual(["c2", "c1"])
    reload(result.doc)
  })
})

describe("updateClass", () => {
  const update = (patch: Loose, classId = "c2", extra: Loose = {}) =>
    op({ type: "updateClass", classId, patch, ...extra })

  it("patches fields, clears optional ones with null and merges meta", () => {
    const result = roundTrip(base, [
      update({ name: "Gamma", color: "#ff0000", hotkey: "g", meta: { "a:b": 1 } }),
    ])
    expect(result.doc.config.classes["c2"]).toMatchObject({
      name: "Gamma",
      color: "#ff0000",
      hotkey: "g",
      meta: { "a:b": 1 },
    })
    expect(result.doc.config.rev).toBe(base.config.rev + 1)
    const cleared = roundTrip(result.doc, [
      update({
        color: null,
        hotkey: null,
        parentId: null,
        attributeKeys: null,
        meta: { "a:b": null },
      }),
    ])
    const c2 = must(cleared.doc.config.classes["c2"]) as Loose
    for (const key of ["color", "hotkey", "parentId", "attributeKeys"])
      expect(key in c2).toBe(false)
    expect(c2.meta).toEqual({})
  })

  it("is a no-op when nothing changes", () => {
    const result = run(base, [update({ name: "Beta", color: null })])
    expect(result.doc.rev).toBe(base.rev)
    expect(result.inverse).toEqual([])
  })

  it("re-parents within the hierarchy but refuses cycles", () => {
    expect(roundTrip(base, [update({ parentId: null })]).doc.config.classes["c2"]?.parentId).toBe(
      undefined,
    )
    expect(codeOf(() => run(base, [update({ parentId: "c2" }, "c1")]))).toBe("CYCLE")
    expect(codeOf(() => run(base, [update({ parentId: "c2" })]))).toBe("CYCLE")
    expect(codeOf(() => run(base, [update({ parentId: "nope" })]))).toBe("INVALID_DOCUMENT")
  })

  it("checks a long class chain against the work budget", () => {
    const doc: Loose = clone(base)
    for (let i = 0; i < 10_050; i++) {
      doc.config.classes[`d${i}`] = {
        id: `d${i}`,
        name: "x",
        meta: {},
        ...(i > 0 ? { parentId: `d${i - 1}` } : {}),
      }
      doc.config.classOrder.push(`d${i}`)
    }
    expect(run(doc, [update({ parentId: "d10049" })]).doc.config.classes["c2"]?.parentId).toBe(
      "d10049",
    )
    const limits = { maxBatchWork: 15_000 }
    expect(codeOf(() => run(doc, [update({ parentId: "d10049" })], { limits }))).toBe(
      "LIMIT_EXCEEDED",
    )
  })

  it("refuses an allowedGeometry that existing regions or tracks would violate", () => {
    // r2 (class c2) is a polygon.
    expect(codeOf(() => run(base, [update({ allowedGeometry: ["box"] })]))).toBe("IN_USE")
    const ok = roundTrip(base, [update({ allowedGeometry: ["polygon", "box"] })])
    expect(ok.doc.config.classes["c2"]?.allowedGeometry).toEqual(["polygon", "box"])
    // tr1 (class c1) is a box track; vr1 and r1 are boxes too.
    expect(codeOf(() => run(video, [update({ allowedGeometry: ["point"] }, "c1")]))).toBe("IN_USE")
    const trackOnly: Loose = clone(video)
    delete trackOnly.regions.r1.classId
    expect(codeOf(() => run(trackOnly, [update({ allowedGeometry: ["point"] }, "c1")]))).toBe(
      "IN_USE",
    )
  })

  it("validates attribute keys, names and unknown classes", () => {
    expect(codeOf(() => run(base, [update({ attributeKeys: ["nope"] })]))).toBe("INVALID_DOCUMENT")
    expect(codeOf(() => run(base, [update({ name: "x" }, "nope")]))).toBe("NOT_FOUND")
    expect(codeOf(() => run(clone(base), [update({ name: "x" }, "toString")]))).toBe("NOT_FOUND")
    expect(codeOf(() => run(base, [update({ id: "c7" })]))).toBe("INVALID_DOCUMENT")
    expect(codeOf(() => run(base, [update({ name: null })]))).toBe("INVALID_DOCUMENT")
    expect(
      codeOf(() =>
        run(base, [update({ hotkey: "x".repeat(20) })], {
          limits: { maxStringLength: 10 },
        }),
      ),
    ).toBe("LIMIT_EXCEEDED")
  })

  it("checks baseRev against config.rev", () => {
    expect(codeOf(() => run(base, [update({ name: "x" }, "c2", { baseRev: 4 })]))).toBe(
      "REV_CONFLICT",
    )
  })
})

describe("removeClass", () => {
  const remove = (classId: string, onInUse: "reject" | "detach") =>
    op({ type: "removeClass", classId, onInUse })

  it("rejects a class that regions or sources use", () => {
    expect(codeOf(() => run(base, [remove("c2", "reject")]))).toBe("IN_USE")
    const sourceOnly: Loose = clone(base)
    delete sourceOnly.regions.r1.classId
    delete sourceOnly.config.classes.c2.parentId
    expect(codeOf(() => run(sourceOnly, [remove("c1", "reject")]))).toBe("IN_USE")
  })

  it("removes an unused class and re-parents its children (reject policy)", () => {
    const doc: Loose = clone(base)
    delete doc.regions.r1.classId
    delete doc.sources.s1.classId
    const result = roundTrip(doc, [remove("c1", "reject")])
    expect(result.doc.config.classes["c1"]).toBeUndefined()
    expect(classOrder(result.doc)).toEqual(["c2"])
    expect(result.doc.config.classes["c2"]?.parentId).toBeUndefined()
  })

  it("detaches regions and sources, and re-parents children to the grandparent", () => {
    const doc: Loose = clone(base)
    doc.config.classes.c0 = { id: "c0", name: "Root", meta: {} }
    doc.config.classOrder.push("c0")
    doc.config.classes.c1.parentId = "c0"
    const result = roundTrip(doc, [remove("c1", "detach")])
    expect(result.doc.config.classes["c2"]?.parentId).toBe("c0")
    expect("classId" in must(result.doc.regions["r1"])).toBe(false)
    expect("classId" in must(result.doc.sources["s1"])).toBe(false)
    expect(result.doc.regions["r1"]?.rev).toBe(doc.regions.r1.rev + 1)
    expect(result.doc.sources["s1"]?.rev).toBe(doc.sources.s1.rev + 1)
    expect(result.doc.config.rev).toBe(doc.config.rev + 1)
    expect(result.changes.updated).toEqual(expect.arrayContaining(["config", "r1", "s1"]))
  })

  it("refuses to change tracks (not operation targets yet)", () => {
    expect(codeOf(() => run(video, [remove("c1", "detach")]))).toBe("IN_USE")
    expect(codeOf(() => run(video, [remove("c1", "reject")]))).toBe("IN_USE")
  })

  it("restores the order position on undo", () => {
    const doc: Loose = clone(base)
    doc.config.classes.c3 = { id: "c3", name: "Gamma", meta: {} }
    doc.config.classOrder = ["c1", "c3", "c2"]
    const result = roundTrip(doc, [remove("c3", "reject")])
    expect(classOrder(result.doc)).toEqual(["c1", "c2"])
  })

  it("fails for unknown classes", () => {
    expect(codeOf(() => run(base, [remove("nope", "detach")]))).toBe("NOT_FOUND")
    expect(codeOf(() => run(clone(base), [remove("toString", "detach")]))).toBe("NOT_FOUND")
  })
})

describe("reorderClass and reorderTag", () => {
  const reorderC = (classId: string, position: Loose) =>
    op({ type: "reorderClass", classId, position })
  const reorderT = (tagId: string, position: Loose) => op({ type: "reorderTag", tagId, position })

  it("moves entries and bumps config.rev", () => {
    const result = roundTrip(base, [reorderC("c1", "top")])
    expect(classOrder(result.doc)).toEqual(["c2", "c1"])
    expect(result.doc.config.rev).toBe(base.config.rev + 1)
    expect(tagOrder(roundTrip(base, [reorderT("t2", "bottom")]).doc)).toEqual(["t2", "t1"])
    expect(tagOrder(roundTrip(base, [reorderT("t1", { after: "t2" })]).doc)).toEqual(["t2", "t1"])
  })

  it("is a no-op when already in place", () => {
    expect(run(base, [reorderC("c2", "top")]).doc).toEqual(base)
    expect(run(base, [reorderT("t2", { after: "t1" })]).doc.rev).toBe(base.rev)
  })

  it("rejects unknown targets, unknown anchors and self anchors", () => {
    expect(codeOf(() => run(base, [reorderC("nope", "top")]))).toBe("NOT_FOUND")
    expect(codeOf(() => run(base, [reorderC("c1", { after: "nope" })]))).toBe("NOT_FOUND")
    expect(codeOf(() => run(base, [reorderC("c1", { after: "c1" })]))).toBe("INVALID_DOCUMENT")
    expect(codeOf(() => run(base, [reorderT("toString", "top")]))).toBe("NOT_FOUND")
  })
})

describe("tags", () => {
  const def = (id: string, extra: Loose = {}) => ({ id, name: `Tag ${id}`, meta: {}, ...extra })

  it("addTag adds at a position and requires a new id", () => {
    const result = roundTrip(base, [op({ type: "addTag", def: def("t9"), position: "bottom" })])
    expect(tagOrder(result.doc)).toEqual(["t9", "t1", "t2"])
    expect(codeOf(() => run(base, [op({ type: "addTag", def: def("c1") })]))).toBe("DUPLICATE_ID")
    expect(codeOf(() => run(base, [op({ type: "addTag", def: def("t9", { color: "x" }) })]))).toBe(
      "INVALID_DOCUMENT",
    )
  })

  it("updateTag patches name, color and meta", () => {
    const result = roundTrip(base, [
      op({ type: "updateTag", tagId: "t1", patch: { name: "sharp", color: "#00ff00" } }),
    ])
    expect(result.doc.config.tags["t1"]).toMatchObject({ name: "sharp", color: "#00ff00" })
    expect(
      codeOf(() => run(base, [op({ type: "updateTag", tagId: "t1", patch: { parentId: "t2" } })])),
    ).toBe("INVALID_DOCUMENT")
    expect(
      codeOf(() => run(base, [op({ type: "updateTag", tagId: "nope", patch: { name: "x" } })])),
    ).toBe("NOT_FOUND")
  })

  it("removeTag rejects or detaches uses on regions and sources", () => {
    const remove = (tagId: string, onInUse: string) => op({ type: "removeTag", tagId, onInUse })
    expect(codeOf(() => run(base, [remove("t1", "reject")]))).toBe("IN_USE")
    const result = roundTrip(base, [remove("t1", "detach")])
    expect(result.doc.regions["r1"]?.tagIds).toEqual([])
    expect(result.doc.sources["s1"]?.tagIds).toEqual([])
    expect(tagOrder(result.doc)).toEqual(["t2"])
    expect(roundTrip(base, [remove("t2", "reject")]).doc.config.tags["t2"]).toBeUndefined()
    expect(codeOf(() => run(video, [remove("t1", "detach")]))).toBe("IN_USE")
    expect(codeOf(() => run(base, [remove("t1", "maybe")]))).toBe("INVALID_DOCUMENT")
  })
})

describe("setAttributeDef", () => {
  const set = (def: Loose, extra: Loose = {}) => op({ type: "setAttributeDef", def, ...extra })

  it("adds a definition and is undone by removing it", () => {
    const def = { key: "color", label: "Color", type: "enum", options: ["red", "blue"] }
    const result = roundTrip(base, [set(def)])
    expect(result.doc.config.attributes["color"]).toEqual(def)
    expect(result.doc.config.rev).toBe(base.config.rev + 1)
  })

  it("replaces a definition when existing values stay valid", () => {
    const def = { key: "score", label: "Score", type: "number", min: 0, max: 2 }
    expect(roundTrip(base, [set(def)]).doc.config.attributes["score"]).toEqual(def)
  })

  it("refuses a replacement that existing values would violate", () => {
    // r1 has score 0.5, s1 has score 0.2.
    const tighter = { key: "score", label: "Score", type: "number", min: 0, max: 0.3 }
    expect(codeOf(() => run(base, [set(tighter)]))).toBe("IN_USE")
    const regionless: Loose = clone(base)
    delete regionless.regions.r1.attributes.score
    const tightest = { key: "score", label: "Score", type: "number", min: 0.3, max: 1 }
    expect(codeOf(() => run(regionless, [set(tightest)]))).toBe("IN_USE")
    expect(codeOf(() => run(base, [set({ key: "occluded", label: "O", type: "string" })]))).toBe(
      "IN_USE",
    )
    // tr1 has score 0.7.
    const trackOnly: Loose = clone(video)
    delete trackOnly.regions.r1.attributes.score
    const track = { key: "score", label: "Score", type: "number", max: 0.6 }
    expect(codeOf(() => run(trackOnly, [set(track)]))).toBe("IN_USE")
  })

  it("is a no-op for an identical definition", () => {
    const same = clone(must(base.config.attributes["score"]))
    expect(run(base, [set(same)]).doc).toEqual(base)
  })

  it("validates the definition itself", () => {
    expect(
      codeOf(() => run(base, [set({ key: "k", label: "K", type: "number", default: "x" })])),
    ).toBe("ATTRIBUTE_INVALID")
    expect(
      codeOf(() => run(base, [set({ key: "k", label: "K", type: "number", min: 2, max: 1 })])),
    ).toBe("INVALID_DOCUMENT")
    expect(codeOf(() => run(base, [set({ key: "k", label: "K", type: "enum" })]))).toBe(
      "INVALID_DOCUMENT",
    )
    for (const key of ["__proto__", "constructor", "bad key"]) {
      expect(codeOf(() => run(base, [set({ key, label: "K", type: "string" })]))).toBe(
        "INVALID_DOCUMENT",
      )
    }
    expect(
      codeOf(() =>
        run(base, [set({ key: "k", label: "x".repeat(20), type: "string" })], {
          limits: { maxStringLength: 10 },
        }),
      ),
    ).toBe("LIMIT_EXCEEDED")
  })

  it("checks baseRev against config.rev", () => {
    const def = { key: "k", label: "K", type: "string" }
    expect(codeOf(() => run(base, [set(def, { baseRev: 2 })]))).toBe("REV_CONFLICT")
  })
})

describe("removeAttributeDef", () => {
  const remove = (key: string, onInUse: string) => op({ type: "removeAttributeDef", key, onInUse })

  it("rejects a key that annotations, sources or classes use", () => {
    expect(codeOf(() => run(base, [remove("score", "reject")]))).toBe("IN_USE")
    expect(codeOf(() => run(base, [remove("occluded", "reject")]))).toBe("IN_USE")
    const classOnly: Loose = clone(base)
    delete classOnly.regions.r1.attributes.score
    classOnly.sources.s1.attributes = {}
    expect(codeOf(() => run(classOnly, [remove("score", "reject")]))).toBe("IN_USE")
  })

  it("removes an unused key", () => {
    const doc: Loose = clone(base)
    delete doc.regions.r1.attributes.occluded
    const result = roundTrip(doc, [remove("occluded", "reject")])
    expect(result.doc.config.attributes["occluded"]).toBeUndefined()
  })

  it("detaches the key from regions, sources and class attribute lists", () => {
    const result = roundTrip(base, [remove("score", "detach")])
    expect(result.doc.regions["r1"]?.attributes).toEqual({ occluded: false })
    expect(result.doc.sources["s1"]?.attributes).toEqual({})
    expect(result.doc.config.classes["c2"]?.attributeKeys).toEqual([])
    expect(result.doc.config.rev).toBe(base.config.rev + 1)
  })

  it("refuses to change tracks (not operation targets yet)", () => {
    expect(codeOf(() => run(video, [remove("score", "detach")]))).toBe("IN_USE")
  })

  it("fails for unknown keys", () => {
    expect(codeOf(() => run(base, [remove("nope", "detach")]))).toBe("NOT_FOUND")
    expect(codeOf(() => run(clone(base), [remove("toString", "detach")]))).toBe("NOT_FOUND")
  })
})

describe("skeletons", () => {
  const skeleton = (id: string, points = 2) => ({
    id,
    name: "Line",
    points: Array.from({ length: points }, (_, i) => ({ name: `p${i}` })),
    edges: [[0, points - 1]],
  })
  const update = (patch: Loose, skeletonId = "k1") =>
    op({ type: "updateSkeleton", skeletonId, patch })

  it("addSkeleton adds and is undone by removeSkeleton", () => {
    const result = roundTrip(base, [op({ type: "addSkeleton", def: skeleton("k9") })])
    expect(result.doc.config.skeletons["k9"]?.points).toHaveLength(2)
    expect(result.inverse[0]).toMatchObject({ type: "removeSkeleton", skeletonId: "k9" })
  })

  it("addSkeleton validates ids, points and edges", () => {
    expect(codeOf(() => run(base, [op({ type: "addSkeleton", def: skeleton("r1") })]))).toBe(
      "DUPLICATE_ID",
    )
    const badEdge = { ...skeleton("k9"), edges: [[0, 5]] }
    expect(codeOf(() => run(base, [op({ type: "addSkeleton", def: badEdge })]))).toBe(
      "INVALID_DOCUMENT",
    )
    expect(codeOf(() => run(base, [op({ type: "addSkeleton", def: skeleton("k9", 0) })]))).toBe(
      "INVALID_DOCUMENT",
    )
    const longName = { ...skeleton("k9"), points: [{ name: "x".repeat(20) }], edges: [] }
    expect(
      codeOf(() =>
        run(base, [op({ type: "addSkeleton", def: longName })], {
          limits: { maxStringLength: 10 },
        }),
      ),
    ).toBe("LIMIT_EXCEEDED")
  })

  it("updateSkeleton renames and edits edges", () => {
    const result = roundTrip(base, [update({ name: "Tri", edges: [[0, 2]] })])
    expect(result.doc.config.skeletons["k1"]).toMatchObject({ name: "Tri", edges: [[0, 2]] })
    expect(codeOf(() => run(base, [update({ edges: [[0, 3]] })]))).toBe("INVALID_DOCUMENT")
    expect(run(base, [update({ name: "Triangle" })]).doc).toEqual(base)
  })

  it("updateSkeleton keeps the point count while keypoints use it", () => {
    const points = [{ name: "a" }, { name: "b" }]
    expect(codeOf(() => run(base, [update({ points, edges: [[0, 1]] })]))).toBe("IN_USE")
    const renamed = [{ name: "x" }, { name: "y" }, { name: "z" }]
    expect(
      roundTrip(base, [update({ points: renamed })]).doc.config.skeletons["k1"]?.points,
    ).toEqual(renamed)
    const unused: Loose = clone(base)
    unused.sources.s1.regionOrder = ["r1", "r2", "r3", "r5"]
    delete unused.regions.r4
    expect(roundTrip(unused, [update({ points, edges: [[0, 1]] })]).doc).toBeDefined()
    expect(codeOf(() => run(base, [update({ edges: [[0, 1]] }, "nope")]))).toBe("NOT_FOUND")
    expect(codeOf(() => run(base, [update({ id: "k2" })]))).toBe("INVALID_DOCUMENT")
  })

  it("updateSkeleton checks keypoint tracks too", () => {
    const doc: Loose = clone(video)
    doc.sources.s1.regionOrder = ["r1", "r2", "r3", "r5"]
    delete doc.regions.r4
    doc.tracks.tr1.geometryType = "keypoints"
    for (const keyframe of doc.tracks.tr1.keyframes) {
      keyframe.geometry = {
        type: "keypoints",
        skeletonId: "k1",
        points: [1, 1, 2, 2, 2, 2, 3, 3, 2],
      }
    }
    const points = [{ name: "a" }, { name: "b" }]
    expect(codeOf(() => run(reload(doc), [update({ points, edges: [] })]))).toBe("IN_USE")
    expect(codeOf(() => run(reload(doc), [op({ type: "removeSkeleton", skeletonId: "k1" })]))).toBe(
      "IN_USE",
    )
  })

  it("removeSkeleton refuses a skeleton in use and removes an unused one", () => {
    expect(codeOf(() => run(base, [op({ type: "removeSkeleton", skeletonId: "k1" })]))).toBe(
      "IN_USE",
    )
    const doc = run(base, [op({ type: "addSkeleton", def: skeleton("k9") })]).doc
    const result = roundTrip(doc, [op({ type: "removeSkeleton", skeletonId: "k9" })])
    expect(result.doc.config.skeletons["k9"]).toBeUndefined()
    expect(codeOf(() => run(base, [op({ type: "removeSkeleton", skeletonId: "nope" })]))).toBe(
      "NOT_FOUND",
    )
  })
})

describe("config operations across a batch", () => {
  it("undoes a mixed batch of config and region operations", () => {
    roundTrip(base, [
      op({ type: "addClass", def: { id: "c9", name: "New", meta: {} } }),
      op({ type: "createRegion", region: { ...box("r9"), classId: "c9" } }),
      op({ type: "updateClass", classId: "c9", patch: { allowedGeometry: ["box"] } }),
      op({ type: "setAttributeDef", def: { key: "n", label: "N", type: "number" } }),
      op({ type: "patchRegion", regionId: "r9", patch: { attributes: { n: 3 } } }),
      op({ type: "removeTag", tagId: "t1", onInUse: "detach" }),
      op({ type: "reorderClass", classId: "c9", position: "bottom" }),
      op({ type: "removeClass", classId: "c1", onInUse: "detach" }),
    ])
  })

  it("leaves the input untouched and bumps config.rev once per op", () => {
    const input = validDocument()
    const result = run(input, [
      op({ type: "addTag", def: { id: "t5", name: "a", meta: {} } }),
      op({ type: "addTag", def: { id: "t6", name: "b", meta: {} } }),
    ])
    expect(result.doc.config.rev).toBe(input.config.rev + 2)
    expect(input.config.tags["t5"]).toBeUndefined()
  })
})
