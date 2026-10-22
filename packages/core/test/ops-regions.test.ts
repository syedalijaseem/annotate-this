import { describe, expect, it } from "vitest"
import { isAnnotateError } from "../src/errors.js"
import type { ErrorCode } from "../src/errors.js"
import type { Limits } from "../src/limits.js"
import { apply } from "../src/ops/apply.js"
import { without } from "../src/ops/util.js"
import type { ApplyBatchOptions, Batch, BatchOrigin, Operation } from "../src/ops/types.js"
import type { AnnotationDocument } from "../src/types.js"
import { parseDocument } from "../src/validate/index.js"
import { type Loose, box, clone, validDocument } from "./fixtures.js"

const AT = "2026-10-21T12:00:00Z"

let counter = 0
const opId = () => `op${++counter}`

const batchOf = (ops: Operation[], origin: BatchOrigin = "local"): Batch => ({
  id: `b${++counter}`,
  origin,
  at: AT,
  ops,
})

/** Applies ops as one batch to a deep-frozen copy, which also proves the input is never mutated. */
function run(doc: AnnotationDocument, ops: Operation[], options?: ApplyBatchOptions) {
  return apply(deepFreeze(clone(doc)), batchOf(ops), options)
}

function deepFreeze<T>(value: T): T {
  if (typeof value === "object" && value !== null && !Object.isFrozen(value)) {
    Object.freeze(value)
    for (const child of Object.values(value)) deepFreeze(child)
  }
  return value
}

function errorOf(run: () => unknown) {
  try {
    run()
  } catch (error) {
    if (!isAnnotateError(error)) throw error
    return error
  }
  throw new Error("expected an AnnotateError")
}

const codeOf = (run: () => unknown): ErrorCode => errorOf(run).code

/** Drops fields an undo is allowed to change: every rev, and provenance.updatedAt. */
function stable(doc: AnnotationDocument): unknown {
  return JSON.parse(
    JSON.stringify(doc, (key, value) => (key === "rev" || key === "updatedAt" ? undefined : value)),
  )
}

const second = (): AnnotationDocument => {
  const doc: Loose = clone(validDocument())
  doc.sources.s2 = { ...clone(doc.sources.s1), id: "s2", name: "other.jpg", regionOrder: [] }
  doc.sourceOrder = ["s1", "s2"]
  return doc
}

const base = validDocument()

describe("apply: envelope and revs", () => {
  it("bumps the document rev once per batch and the entity rev once per op", () => {
    const result = run(base, [
      { id: opId(), type: "patchRegion", regionId: "r1", patch: { comment: "a" } },
      { id: opId(), type: "patchRegion", regionId: "r1", patch: { comment: "b" } },
    ])
    expect(result.doc.rev).toBe(base.rev + 1)
    expect(result.doc.regions["r1"]?.rev).toBe((base.regions["r1"]?.rev ?? 0) + 2)
  })

  it("rejects empty batches, oversized batches and bad timestamps", () => {
    const op: Operation = { id: "o1", type: "setDocumentMeta", patch: { "a:b": 1 } }
    expect(codeOf(() => apply(base, { id: "b", origin: "local", at: AT, ops: [] }))).toBe(
      "INVALID_DOCUMENT",
    )
    const limits: Partial<Limits> = { maxBatchOps: 1 }
    const two: Operation[] = [op, { ...op, id: "o2" }]
    expect(codeOf(() => apply(base, batchOf(two), { limits }))).toBe("LIMIT_EXCEEDED")
    expect(
      codeOf(() => apply(base, { id: "b", origin: "local", at: "yesterday", ops: [op] })),
    ).toBe("INVALID_DOCUMENT")
  })

  it("returns the same document when every op is a no-op", () => {
    const result = run(base, [
      { id: opId(), type: "patchRegion", regionId: "r1", patch: { status: "draft" } },
    ])
    expect(result.changes).toEqual({ created: [], updated: [], deleted: [] })
    expect(result.inverse).toEqual([])
    expect(result.doc.rev).toBe(base.rev)
  })

  it("lets later ops depend on earlier ones in the same batch", () => {
    const result = run(base, [
      { id: opId(), type: "createRegion", region: box("r9") },
      { id: opId(), type: "patchRegion", regionId: "r9", patch: { comment: "made here" } },
    ])
    expect(result.doc.regions["r9"]?.comment).toBe("made here")
  })

  it("is atomic: a failing op reports its index and id and nothing is applied", () => {
    const bad = opId()
    const error = errorOf(() =>
      run(base, [
        { id: opId(), type: "patchRegion", regionId: "r1", patch: { comment: "x" } },
        { id: bad, type: "patchRegion", regionId: "missing", patch: { comment: "y" } },
      ]),
    )
    expect(error.code).toBe("NOT_FOUND")
    expect(error.opIndex).toBe(1)
    expect(error.opId).toBe(bad)
  })

  it("rejects a stale baseRev unless ignoreRev is set", () => {
    const op: Operation = {
      id: opId(),
      type: "patchRegion",
      regionId: "r1",
      baseRev: 5,
      patch: { comment: "x" },
    }
    expect(codeOf(() => run(base, [op]))).toBe("REV_CONFLICT")
    expect(run(base, [op], { ignoreRev: true }).doc.regions["r1"]?.comment).toBe("x")
  })

  it("accepts a matching baseRev", () => {
    const rev = base.regions["r1"]?.rev ?? 0
    const op: Operation = {
      id: opId(),
      type: "patchRegion",
      regionId: "r1",
      baseRev: rev,
      patch: { comment: "x" },
    }
    expect(run(base, [op]).doc.regions["r1"]?.comment).toBe("x")
  })

  it("stamps provenance.updatedAt from the batch", () => {
    const result = run(base, [
      { id: opId(), type: "patchRegion", regionId: "r1", patch: { comment: "x" } },
    ])
    expect(result.doc.regions["r1"]?.provenance.updatedAt).toBe(AT)
  })

  it("always produces a document that passes full validation", () => {
    const result = run(base, [
      { id: opId(), type: "createRegion", region: box("r9") },
      { id: opId(), type: "patchRegion", regionId: "r9", patch: { classId: "c1", tagIds: ["t1"] } },
      { id: opId(), type: "reorderRegion", regionId: "r9", position: "bottom" },
    ])
    expect(() => parseDocument(JSON.parse(JSON.stringify(result.doc)))).not.toThrow()
  })
})

describe("setDocumentMeta", () => {
  it("sets and deletes keys", () => {
    const set = run(base, [
      { id: opId(), type: "setDocumentMeta", patch: { "a:b": 1, "a:c": "x" } },
    ])
    expect(set.doc.meta).toEqual({ "a:b": 1, "a:c": "x" })
    const removed = run(set.doc, [{ id: opId(), type: "setDocumentMeta", patch: { "a:b": null } }])
    expect(removed.doc.meta).toEqual({ "a:c": "x" })
  })

  it("is a no-op when nothing changes", () => {
    const result = run(base, [
      { id: opId(), type: "setDocumentMeta", patch: { "a:missing": null } },
    ])
    expect(result.doc.rev).toBe(base.rev)
  })

  it("reports the document id as updated", () => {
    const result = run(base, [{ id: opId(), type: "setDocumentMeta", patch: { "a:b": 1 } }])
    expect(result.changes.updated).toContain(base.id)
  })
})

describe("createRegion", () => {
  const create = (id: string, extra: Partial<Operation> = {}): Operation =>
    ({ id: opId(), type: "createRegion", region: box(id), ...extra }) as Operation

  it("puts the region on top by default and defaults rev to 0", () => {
    const region = without(box("r9"), "rev")
    const result = run(base, [{ id: opId(), type: "createRegion", region }])
    expect(result.doc.sources["s1"]?.regionOrder.at(-1)).toBe("r9")
    expect(result.doc.regions["r9"]?.rev).toBe(0)
    expect(result.changes.created).toContain("r9")
    expect(result.changes.updated).toContain("s1")
  })

  it("supports bottom and after positions", () => {
    const bottom = run(base, [create("r9", { position: "bottom" })])
    expect(bottom.doc.sources["s1"]?.regionOrder[0]).toBe("r9")
    const after = run(base, [create("r9", { position: { after: "r2" } })])
    expect(after.doc.sources["s1"]?.regionOrder).toEqual(["r1", "r2", "r9", "r3", "r4", "r5"])
  })

  it("fails with NOT_FOUND for an unknown anchor or source", () => {
    expect(codeOf(() => run(base, [create("r9", { position: { after: "nope" } })]))).toBe(
      "NOT_FOUND",
    )
    const op: Operation = { id: opId(), type: "createRegion", region: box("r9", "nope") }
    expect(codeOf(() => run(base, [op]))).toBe("NOT_FOUND")
  })

  it("fails with DUPLICATE_ID when the id is used by any entity", () => {
    expect(codeOf(() => run(base, [create("r1")]))).toBe("DUPLICATE_ID")
    expect(codeOf(() => run(base, [create("s1")]))).toBe("DUPLICATE_ID")
    expect(codeOf(() => run(base, [create("c1")]))).toBe("DUPLICATE_ID")
  })

  it("checks geometry bounds and shape rules", () => {
    const outside: Operation = {
      id: opId(),
      type: "createRegion",
      region: box("r9", "s1", 950, 20, 100, 50),
    }
    expect(codeOf(() => run(base, [outside]))).toBe("OUT_OF_BOUNDS")
    const skeleton: Loose = {
      ...box("r9"),
      geometry: { type: "keypoints", skeletonId: "k1", points: [1, 1, 2] },
    }
    expect(codeOf(() => run(base, [{ id: opId(), type: "createRegion", region: skeleton }]))).toBe(
      "INVALID_GEOMETRY",
    )
  })

  it("checks references, attributes and frame placement", () => {
    const badClass: Loose = { ...box("r9"), classId: "nope" }
    expect(codeOf(() => run(base, [{ id: opId(), type: "createRegion", region: badClass }]))).toBe(
      "INVALID_DOCUMENT",
    )
    const badAttr: Loose = { ...box("r9"), attributes: { score: 5 } }
    expect(codeOf(() => run(base, [{ id: opId(), type: "createRegion", region: badAttr }]))).toBe(
      "ATTRIBUTE_INVALID",
    )
    const framed: Loose = { ...box("r9"), frame: 3 }
    expect(codeOf(() => run(base, [{ id: opId(), type: "createRegion", region: framed }]))).toBe(
      "INVALID_DOCUMENT",
    )
  })

  it("rejects a malformed region payload with INVALID_DOCUMENT", () => {
    const broken = without(box("r9"), "geometry")
    const op = { id: opId(), type: "createRegion", region: broken } as unknown as Operation
    expect(codeOf(() => run(base, [op]))).toBe("INVALID_DOCUMENT")
  })

  it("enforces the annotation count limit", () => {
    expect(codeOf(() => run(base, [create("r9")], { limits: { maxAnnotations: 5 } }))).toBe(
      "LIMIT_EXCEEDED",
    )
  })

  it("stamps provenance.updatedAt but leaves createdAt to the caller", () => {
    const created = run(base, [create("r9")]).doc.regions["r9"]
    expect(created?.provenance.createdAt).toBeUndefined()
    expect(created?.provenance.updatedAt).toBe(AT)
  })

  it("is undone by its inverse", () => {
    const result = run(base, [create("r9")])
    expect(stable(run(result.doc, result.inverse).doc)).toEqual(stable(base))
  })
})

describe("setGeometry", () => {
  it("replaces the geometry and bumps the rev", () => {
    const geometry = { type: "box", x: 1, y: 2, w: 3, h: 4 } as const
    const result = run(base, [{ id: opId(), type: "setGeometry", regionId: "r1", geometry }])
    expect(result.doc.regions["r1"]?.geometry).toEqual(geometry)
    expect(result.doc.regions["r1"]?.rev).toBe(1)
    expect(result.changes.updated).toEqual(["r1", base.id])
  })

  it("is a no-op for identical geometry", () => {
    const geometry = clone((base.regions["r1"] as Loose).geometry)
    const result = run(base, [{ id: opId(), type: "setGeometry", regionId: "r1", geometry }])
    expect(result.doc.rev).toBe(base.rev)
  })

  it("checks bounds, skeleton size and unknown regions", () => {
    const outside = { type: "box", x: 999, y: 0, w: 50, h: 50 } as const
    expect(
      codeOf(() =>
        run(base, [{ id: opId(), type: "setGeometry", regionId: "r1", geometry: outside }]),
      ),
    ).toBe("OUT_OF_BOUNDS")
    const op: Operation = { id: opId(), type: "setGeometry", regionId: "nope", geometry: outside }
    expect(codeOf(() => run(base, [op]))).toBe("NOT_FOUND")
  })

  it("refuses a geometry type the class does not allow", () => {
    const doc: Loose = clone(base)
    doc.config.classes.c1.allowedGeometry = ["box"]
    const point = { type: "point", x: 5, y: 5 } as const
    expect(
      codeOf(() =>
        run(doc, [{ id: opId(), type: "setGeometry", regionId: "r1", geometry: point }]),
      ),
    ).toBe("INVALID_GEOMETRY")
  })

  it("is undone by its inverse", () => {
    const geometry = { type: "box", x: 1, y: 2, w: 3, h: 4 } as const
    const result = run(base, [{ id: opId(), type: "setGeometry", regionId: "r1", geometry }])
    expect(stable(run(result.doc, result.inverse).doc)).toEqual(stable(base))
  })
})

describe("patchRegion", () => {
  const patch = (p: Loose, id = "r1"): Operation => ({
    id: opId(),
    type: "patchRegion",
    regionId: id,
    patch: p,
  })

  it("merges simple fields and clears with null", () => {
    const set = run(base, [patch({ classId: "c1", comment: "hi", locked: true })])
    expect(set.doc.regions["r1"]).toMatchObject({ classId: "c1", comment: "hi", locked: true })
    const cleared = run(set.doc, [patch({ classId: null, comment: null, locked: null })])
    const region = cleared.doc.regions["r1"] as Loose
    expect(region.comment).toBeUndefined()
    expect("classId" in region).toBe(false)
    expect("locked" in region).toBe(false)
  })

  it("merges attributes and meta, deleting keys set to null", () => {
    const result = run(base, [
      patch({ attributes: { occluded: null, score: 0.9 }, meta: { "a:b": 1 } }),
    ])
    const region = result.doc.regions["r1"] as Loose
    expect(region.attributes).toEqual({ score: 0.9 })
    expect(region.meta).toEqual({ "a:b": 1 })
  })

  it("replaces tagIds wholesale", () => {
    const result = run(base, [patch({ tagIds: [] })])
    expect(result.doc.regions["r1"]?.tagIds).toEqual([])
  })

  it("rejects unknown classes, tags and statuses", () => {
    expect(codeOf(() => run(base, [patch({ classId: "nope" })]))).toBe("INVALID_DOCUMENT")
    expect(codeOf(() => run(base, [patch({ tagIds: ["nope"] })]))).toBe("INVALID_DOCUMENT")
    expect(codeOf(() => run(base, [patch({ status: "weird" })]))).toBe("INVALID_DOCUMENT")
  })

  it("validates attribute values", () => {
    expect(codeOf(() => run(base, [patch({ attributes: { score: 9 } })]))).toBe("ATTRIBUTE_INVALID")
  })

  it("sets a parent in the same source and refuses cycles", () => {
    const child = run(base, [patch({ parentId: "r2" }, "r1")])
    expect(child.doc.regions["r1"]?.parentId).toBe("r2")
    expect(codeOf(() => run(child.doc, [patch({ parentId: "r1" }, "r2")]))).toBe("CYCLE")
    expect(codeOf(() => run(base, [patch({ parentId: "r1" })]))).toBe("CYCLE")
  })

  it("refuses a parent from another source or a missing parent", () => {
    const doc = second()
    const moved = run(doc, [
      { id: opId(), type: "moveRegionToSource", regionId: "r2", sourceId: "s2" },
    ])
    expect(codeOf(() => run(moved.doc, [patch({ parentId: "r2" }, "r1")]))).toBe("INVALID_DOCUMENT")
    expect(codeOf(() => run(base, [patch({ parentId: "nope" })]))).toBe("INVALID_DOCUMENT")
  })

  it("refuses frame on an image source and unknown regions", () => {
    expect(codeOf(() => run(base, [patch({ frame: 1 })]))).toBe("INVALID_DOCUMENT")
    expect(codeOf(() => run(base, [patch({ comment: "x" }, "nope")]))).toBe("NOT_FOUND")
  })

  it("is undone by its inverse", () => {
    const result = run(base, [
      patch({
        classId: "c1",
        comment: "hi",
        attributes: { occluded: null, score: 0.9 },
        meta: { "a:b": 1 },
      }),
    ])
    expect(stable(run(result.doc, result.inverse).doc)).toEqual(stable(base))
  })
})

describe("deleteRegion", () => {
  const del = (id: string, children: "delete" | "detach" = "detach"): Operation => ({
    id: opId(),
    type: "deleteRegion",
    regionId: id,
    children,
  })
  const withChild = (): AnnotationDocument => {
    const doc: Loose = clone(base)
    doc.regions.r2.parentId = "r1"
    doc.regions.r3.parentId = "r2"
    return doc
  }

  it("removes the region and its place in the order", () => {
    const result = run(base, [del("r3")])
    expect(result.doc.regions["r3"]).toBeUndefined()
    expect(result.doc.sources["s1"]?.regionOrder).not.toContain("r3")
    expect(result.changes.deleted).toEqual(["r3"])
  })

  it("detaches children by default policy", () => {
    const result = run(withChild(), [del("r1", "detach")])
    expect("parentId" in (result.doc.regions["r2"] as object)).toBe(false)
    expect(result.doc.regions["r3"]?.parentId).toBe("r2")
    expect(result.changes.updated).toContain("r2")
  })

  it("deletes the whole subtree with the delete policy", () => {
    const result = run(withChild(), [del("r1", "delete")])
    for (const id of ["r1", "r2", "r3"]) expect(result.doc.regions[id]).toBeUndefined()
    expect(result.changes.deleted.sort()).toEqual(["r1", "r2", "r3"])
  })

  it("fails for unknown regions", () => {
    expect(codeOf(() => run(base, [del("nope")]))).toBe("NOT_FOUND")
  })

  it.each(["detach", "delete"] as const)("is undone by its inverse (%s)", (policy) => {
    const doc = withChild()
    const result = run(doc, [del("r1", policy)])
    expect(stable(run(result.doc, result.inverse).doc)).toEqual(stable(doc))
  })

  it("restores a deleted region with rev = deletedRev + 1", () => {
    const result = run(base, [del("r3")])
    const restored = run(result.doc, result.inverse).doc.regions["r3"]
    expect(restored?.rev).toBe((base.regions["r3"]?.rev ?? 0) + 1)
  })
})

describe("reorderRegion", () => {
  const order = (doc: AnnotationDocument) => doc.sources["s1"]?.regionOrder
  const reorder = (id: string, position: Loose): Operation => ({
    id: opId(),
    type: "reorderRegion",
    regionId: id,
    position,
  })

  it("moves to top, bottom and after another region", () => {
    expect(order(run(base, [reorder("r1", "top")]).doc)).toEqual(["r2", "r3", "r4", "r5", "r1"])
    expect(order(run(base, [reorder("r5", "bottom")]).doc)).toEqual(["r5", "r1", "r2", "r3", "r4"])
    expect(order(run(base, [reorder("r1", { after: "r3" })]).doc)).toEqual([
      "r2",
      "r3",
      "r1",
      "r4",
      "r5",
    ])
  })

  it("is a no-op when already in place", () => {
    expect(run(base, [reorder("r5", "top")]).doc.rev).toBe(base.rev)
    expect(run(base, [reorder("r2", { after: "r1" })]).doc.rev).toBe(base.rev)
  })

  it("rejects anchors that are missing, in another source, or the region itself", () => {
    expect(codeOf(() => run(base, [reorder("r1", { after: "nope" })]))).toBe("NOT_FOUND")
    expect(codeOf(() => run(base, [reorder("r1", { after: "r1" })]))).toBe("INVALID_DOCUMENT")
    expect(codeOf(() => run(base, [reorder("nope", "top")]))).toBe("NOT_FOUND")
  })

  it("is undone by its inverse", () => {
    const result = run(base, [reorder("r1", { after: "r4" })])
    expect(order(run(result.doc, result.inverse).doc)).toEqual(order(base))
  })
})

describe("moveRegionToSource", () => {
  const move = (id: string, sourceId: string, position?: Loose): Operation =>
    ({
      id: opId(),
      type: "moveRegionToSource",
      regionId: id,
      sourceId,
      ...(position ? { position } : {}),
    }) as Operation

  it("moves the region between sources and updates both orders", () => {
    const result = run(second(), [move("r1", "s2")])
    expect(result.doc.regions["r1"]?.sourceId).toBe("s2")
    expect(result.doc.sources["s1"]?.regionOrder).not.toContain("r1")
    expect(result.doc.sources["s2"]?.regionOrder).toEqual(["r1"])
    expect(result.changes.updated).toEqual(expect.arrayContaining(["r1", "s1", "s2"]))
  })

  it("clears the parent", () => {
    const doc: Loose = second()
    doc.regions.r1.parentId = "r2"
    const result = run(doc, [move("r1", "s2")])
    expect("parentId" in (result.doc.regions["r1"] as object)).toBe(false)
  })

  it("refuses to move a region that has children (they would span sources)", () => {
    const doc: Loose = second()
    doc.regions.r2.parentId = "r1"
    expect(codeOf(() => run(doc, [move("r1", "s2")]))).toBe("IN_USE")
  })

  it("re-checks bounds against the target source", () => {
    const doc: Loose = second()
    doc.sources.s2.width = 50
    doc.sources.s2.height = 50
    expect(codeOf(() => run(doc, [move("r1", "s2")]))).toBe("OUT_OF_BOUNDS")
  })

  it("fails for unknown regions and sources, and acts as a reorder within the same source", () => {
    expect(codeOf(() => run(second(), [move("nope", "s2")]))).toBe("NOT_FOUND")
    expect(codeOf(() => run(second(), [move("r1", "nope")]))).toBe("NOT_FOUND")
    expect(run(second(), [move("r1", "s1", "top")]).doc.sources["s1"]?.regionOrder.at(-1)).toBe(
      "r1",
    )
  })

  it("is undone by its inverse", () => {
    const doc: Loose = second()
    doc.regions.r1.parentId = "r2"
    const result = run(doc, [move("r1", "s2")])
    expect(stable(run(result.doc, result.inverse).doc)).toEqual(stable(doc))
  })
})

describe("change sets, inverses and purity across a batch", () => {
  const create = (id: string): Operation => ({ id: opId(), type: "createRegion", region: box(id) })

  it("a region created and deleted in one batch leaves no trace in the change set", () => {
    const result = run(base, [
      create("r9"),
      { id: opId(), type: "deleteRegion", regionId: "r9", children: "detach" },
    ])
    expect(result.changes.created).toEqual([])
    expect(result.changes.deleted).toEqual([])
    expect(result.changes.updated).not.toContain("r9")
  })

  it("a region deleted and recreated in one batch counts as updated", () => {
    const original = base.regions["r3"] as Loose
    const result = run(base, [
      { id: opId(), type: "deleteRegion", regionId: "r3", children: "detach" },
      { id: opId(), type: "createRegion", region: original },
    ])
    expect(result.changes.deleted).toEqual([])
    expect(result.changes.updated).toContain("r3")
  })

  it("undoes a multi-op batch by reversing it", () => {
    const result = run(base, [
      create("r9"),
      { id: opId(), type: "patchRegion", regionId: "r9", patch: { comment: "x", classId: "c1" } },
      { id: opId(), type: "reorderRegion", regionId: "r9", position: "bottom" },
      { id: opId(), type: "deleteRegion", regionId: "r2", children: "detach" },
      { id: opId(), type: "setDocumentMeta", patch: { "a:b": 1 } },
    ])
    expect(stable(run(result.doc, result.inverse).doc)).toEqual(stable(base))
  })

  it("redo works: inverting the inverse restores the edit", () => {
    const first = run(base, [create("r9")])
    const undone = run(first.doc, first.inverse)
    const redone = run(undone.doc, undone.inverse)
    expect(stable(redone.doc)).toEqual(stable(first.doc))
  })

  it("gives inverse operations valid, distinct, deterministic ids", () => {
    const ops: Operation[] = [
      create("r9"),
      { id: "fixed-op", type: "patchRegion", regionId: "r9", patch: { comment: "x" } },
    ]
    const a = apply(base, { id: "fixed-batch", origin: "local", at: AT, ops })
    const b = apply(base, { id: "fixed-batch", origin: "local", at: AT, ops })
    expect(a.inverse.map((op) => op.id)).toEqual(b.inverse.map((op) => op.id))
    expect(new Set(a.inverse.map((op) => op.id)).size).toBe(a.inverse.length)
    for (const op of a.inverse) expect(op.id).toMatch(/^[A-Za-z0-9_.:-]{1,64}$/)
  })

  it("is a pure function of (doc, batch)", () => {
    const batch = batchOf([
      create("r9"),
      { id: opId(), type: "reorderRegion", regionId: "r1", position: "top" },
    ])
    const a = apply(clone(base), batch)
    const b = apply(clone(base), batch)
    expect(a).toEqual(b)
  })

  it("never lets a rejected batch change the input document", () => {
    const input = deepFreeze(clone(base))
    expect(() =>
      apply(
        input,
        batchOf([
          create("r9"),
          { id: opId(), type: "deleteRegion", regionId: "nope", children: "detach" },
        ]),
      ),
    ).toThrow()
    expect(input.regions["r9"]).toBeUndefined()
  })

  it("rejects non-JSON payloads, unknown operation types and reused operation ids", () => {
    const bad = (op: unknown): ErrorCode => codeOf(() => apply(base, batchOf([op as Operation])))
    expect(bad({ id: opId(), type: "patchRegion", regionId: "r1", patch: { comment: 1n } })).toBe(
      "INVALID_DOCUMENT",
    )
    expect(bad({ id: opId(), type: "explode" })).toBe("INVALID_DOCUMENT")
    const dup: Operation = { id: "same", type: "setDocumentMeta", patch: { "a:b": 1 } }
    expect(codeOf(() => apply(base, batchOf([dup, { ...dup, patch: { "a:c": 2 } }])))).toBe(
      "INVALID_DOCUMENT",
    )
  })

  it("refuses forbidden keys in attribute and meta patches", () => {
    const op = (patch: Loose): Operation => ({
      id: opId(),
      type: "patchRegion",
      regionId: "r1",
      patch,
    })
    const hostile = JSON.parse('{"__proto__": 1}') as Loose
    expect(codeOf(() => run(base, [op({ meta: hostile })]))).toBe("INVALID_DOCUMENT")
    expect(codeOf(() => run(base, [op({ attributes: hostile })]))).toBe("INVALID_DOCUMENT")
  })
})
