import { describe, expect, it } from "vitest"
import { isAnnotateError } from "../src/errors.js"
import type { ErrorCode } from "../src/errors.js"
import { DEFAULT_LIMITS, type Limits } from "../src/limits.js"
import { apply, applyMetered } from "../src/ops/apply.js"
import type { ApplyBatchOptions, Batch, Operation } from "../src/ops/types.js"
import type { AnnotationDocument } from "../src/types.js"
import { parseDocument } from "../src/validate/index.js"
import { type Loose, box, clone, validDocument } from "./fixtures.js"
import { stable } from "./ops-helpers.js"

const AT = "2026-10-21T12:00:00Z"
let counter = 0
const opId = () => `h${++counter}`
const base = validDocument()

const batchOf = (ops: unknown[]): Batch =>
  ({ id: `hb${++counter}`, origin: "local", at: AT, ops }) as Batch

const run = (ops: unknown[], doc: AnnotationDocument = base, options?: ApplyBatchOptions) =>
  apply(doc, batchOf(ops), options)

function errorOf(fn: () => unknown) {
  try {
    fn()
  } catch (error) {
    if (!isAnnotateError(error)) throw error
    return error
  }
  throw new Error("expected an AnnotateError")
}
const codeOf = (fn: () => unknown): ErrorCode => errorOf(fn).code

const nest = (depth: number, leaf: unknown = 1): unknown => {
  let value = leaf
  for (let i = 0; i < depth; i++) value = { k: value }
  return value
}

describe("setDocumentMeta validates and copies its patch", () => {
  const meta = (patch: unknown): Operation =>
    ({ id: opId(), type: "setDocumentMeta", patch }) as Operation

  it("rejects nested forbidden keys", () => {
    const patch = { "a:b": JSON.parse('{"x": {"__proto__": 1}}') as unknown }
    expect(codeOf(() => run([meta(patch)]))).toBe("INVALID_DOCUMENT")
  })

  it("rejects values nested deeper than maxMetaDepth", () => {
    expect(codeOf(() => run([meta({ "a:b": nest(40) })]))).toBe("LIMIT_EXCEEDED")
    expect(codeOf(() => run([meta({ "a:b": nest(70) })]))).toBe("LIMIT_EXCEEDED")
  })

  it("rejects objects with too many keys", () => {
    const wide = Object.fromEntries(Array.from({ length: 11 }, (_, i) => [`k${i}`, 1]))
    expect(codeOf(() => run([meta({ "a:b": wide })], base, { limits: { maxEntries: 10 } }))).toBe(
      "LIMIT_EXCEEDED",
    )
  })

  it("does not alias the caller's objects", () => {
    const value = { b: [1] }
    const result = run([meta({ "a:b": value })])
    value.b.push(2)
    expect((result.doc.meta as Loose)["a:b"].b).toEqual([1])
  })

  it("rejects a missing or null patch with a typed error", () => {
    expect(codeOf(() => run([{ id: opId(), type: "setDocumentMeta" }]))).toBe("INVALID_DOCUMENT")
    expect(codeOf(() => run([meta(null)]))).toBe("INVALID_DOCUMENT")
  })
})

describe("per-operation checks match whole-document rules", () => {
  it("enforces the total vertex limit", () => {
    const polygon = (id: string): Operation => ({
      id: opId(),
      type: "createRegion",
      region: { ...box(id), geometry: { type: "polygon", rings: [[1, 1, 9, 1, 9, 9, 1, 9]] } },
    })
    const limits: Partial<Limits> = { maxTotalVertices: 4 + 4 + 4 + 1 + 1 + 3 }
    // the fixture already uses 4 (r2) + 1 (r3) + 3 (r4) vertices
    expect(() => run([polygon("n1")], base, { limits })).not.toThrow()
    expect(codeOf(() => run([polygon("n1"), polygon("n2")], base, { limits }))).toBe(
      "LIMIT_EXCEEDED",
    )
  })

  it("rejects keypoints that name an unknown skeleton", () => {
    for (const skeletonId of ["nope", "toString"]) {
      const op = {
        id: opId(),
        type: "setGeometry",
        regionId: "r4",
        geometry: { type: "keypoints", skeletonId, points: [1, 1, 2, 2, 2, 2, 3, 3, 2] },
      }
      expect(codeOf(() => run([op]))).toBe("INVALID_DOCUMENT")
    }
  })

  it("limits the size of a region's meta after a patch", () => {
    const wide = Object.fromEntries(Array.from({ length: 12 }, (_, i) => [`a:k${i}`, 1]))
    const op = { id: opId(), type: "patchRegion", regionId: "r1", patch: { meta: wide } }
    expect(codeOf(() => run([op], base, { limits: { maxEntries: 10 } }))).toBe("LIMIT_EXCEEDED")
  })

  it("rejects deeply nested unknown fields on a created region", () => {
    const region = { ...box("r9"), x_ext: nest(70) }
    expect(codeOf(() => run([{ id: opId(), type: "createRegion", region }]))).toBe("LIMIT_EXCEEDED")
  })

  it("keeps the result valid for the whole-document validator", () => {
    const result = run([
      { id: opId(), type: "createRegion", region: { ...box("r9"), x_ext: nest(10) } },
    ])
    expect(() => parseDocument(JSON.parse(JSON.stringify(result.doc)))).not.toThrow()
  })
})

describe("documents that are not null-prototype", () => {
  const plain = () => clone(base)

  it.each([
    ["tagIds", { tagIds: ["toString"] }],
    ["classId", { classId: "toString" }],
    ["parentId", { parentId: "valueOf" }],
    ["attributes", { attributes: { toString: 1 } }],
  ])("does not resolve %s through Object.prototype", (_name, patch) => {
    const op = { id: opId(), type: "patchRegion", regionId: "r1", patch }
    const error = errorOf(() => run([op], plain()))
    expect(["INVALID_DOCUMENT", "ATTRIBUTE_INVALID"]).toContain(error.code)
  })

  it("rejects forbidden and reserved entity ids", () => {
    for (const id of ["__proto__", "constructor", "prototype", "config"]) {
      const region = JSON.parse(JSON.stringify(box("r9"))) as Loose
      region.id = id
      expect(codeOf(() => run([{ id: opId(), type: "createRegion", region }]))).toBe(
        "INVALID_DOCUMENT",
      )
    }
  })
})

describe("malformed operations always give typed errors", () => {
  const cases: [string, unknown][] = [
    ["patchRegion without patch", { type: "patchRegion", regionId: "r1" }],
    ["patchRegion with null patch", { type: "patchRegion", regionId: "r1", patch: null }],
    ["patchRegion with array patch", { type: "patchRegion", regionId: "r1", patch: [] }],
    [
      "patchRegion tagIds as object",
      { type: "patchRegion", regionId: "r1", patch: { tagIds: {} } },
    ],
    ["patchRegion tagIds as number", { type: "patchRegion", regionId: "r1", patch: { tagIds: 5 } }],
    [
      "patchRegion non-patchable key",
      { type: "patchRegion", regionId: "r1", patch: { geometry: {} } },
    ],
    ["createRegion without region", { type: "createRegion" }],
    ["createRegion with null region", { type: "createRegion", region: null }],
    ["reorderRegion without position", { type: "reorderRegion", regionId: "r1" }],
    ["reorderRegion bad position", { type: "reorderRegion", regionId: "r1", position: "middle" }],
    ["reorderRegion empty position", { type: "reorderRegion", regionId: "r1", position: {} }],
    [
      "reorderRegion extra position key",
      { type: "reorderRegion", regionId: "r1", position: { after: "r2", before: "r3" } },
    ],
    ["deleteRegion without children", { type: "deleteRegion", regionId: "r1" }],
    ["deleteRegion bad children", { type: "deleteRegion", regionId: "r1", children: "explode" }],
    ["setGeometry without geometry", { type: "setGeometry", regionId: "r1" }],
    ["non-string regionId", { type: "deleteRegion", regionId: 5, children: "detach" }],
    ["baseRev NaN", { type: "setDocumentMeta", patch: {}, baseRev: Number.NaN }],
    ["array operation", []],
    ["null operation", null],
  ]

  it.each(cases)("%s", (_name, op) => {
    const withId =
      typeof op === "object" && op !== null && !Array.isArray(op) ? { id: opId(), ...op } : op
    expect(codeOf(() => run([withId]))).toBe("INVALID_DOCUMENT")
  })

  it("survives throwing getters and proxies", () => {
    const getter = { id: opId(), type: "setDocumentMeta" }
    Object.defineProperty(getter, "patch", {
      get() {
        throw new Error("boom")
      },
      enumerable: true,
    })
    expect(codeOf(() => run([getter]))).toBe("INVALID_DOCUMENT")
    const proxy = new Proxy(
      {},
      {
        get() {
          throw new Error("trap")
        },
        ownKeys() {
          throw new Error("trap")
        },
      },
    )
    expect(codeOf(() => run([proxy]))).toBe("INVALID_DOCUMENT")
    const batch = { id: "b1", origin: "local", ops: [] } as unknown as Batch
    Object.defineProperty(batch, "at", {
      get() {
        throw new Error("boom")
      },
    })
    expect(codeOf(() => apply(base, batch))).toBe("INVALID_DOCUMENT")
  })

  it("reads a changing type getter once", () => {
    let reads = 0
    const flip = { id: opId(), patch: { "a:b": 1 } }
    Object.defineProperty(flip, "type", {
      get() {
        reads += 1
        return reads === 1 ? "setDocumentMeta" : "explode"
      },
      enumerable: true,
    })
    const result = run([flip])
    expect(reads).toBe(1)
    expect(result.doc.meta["a:b"]).toBe(1)
    expect(result.inverse).toEqual([
      expect.objectContaining({ type: "setDocumentMeta", patch: { "a:b": null } }),
    ])
  })

  it("terminates on a cyclic payload", () => {
    const m: Loose = { a: 1 }
    m.self = m
    expect(codeOf(() => run([{ id: opId(), type: "setDocumentMeta", patch: { "a:m": m } }]))).toBe(
      "LIMIT_EXCEEDED",
    )
  })

  it("treats explicit undefined optional fields as absent", () => {
    const op = {
      id: opId(),
      type: "createRegion",
      region: box("r9"),
      position: undefined,
      baseRev: undefined,
    }
    expect(run([op]).doc.regions["r9"]).toBeDefined()
    const patch = {
      id: opId(),
      type: "patchRegion",
      regionId: "r1",
      patch: { comment: "x", classId: undefined },
    }
    expect(run([patch]).doc.regions["r1"]?.comment).toBe("x")
  })

  it("does not read batch.ops through an overridden iterator", () => {
    class Sneaky extends Array {
      override entries(): ReturnType<Array<unknown>["entries"]> {
        return Array.from(
          { length: 5 },
          (_, i) =>
            [i, { id: `x${i}`, type: "setDocumentMeta", patch: { [`a:k${i}`]: 1 } }] as [
              number,
              unknown,
            ],
        )[Symbol.iterator]() as never
      }
    }
    const ops = new Sneaky()
    ops.push({ id: "only", type: "setDocumentMeta", patch: { "a:one": 1 } })
    const result = apply(base, {
      id: "b",
      origin: "local",
      at: AT,
      ops: ops as unknown as Operation[],
    })
    expect(result.doc.meta).toEqual({ "a:one": 1 })
  })
})

describe("revs and change sets", () => {
  it("re-creating a deleted id in the same batch continues its rev", () => {
    const doc: Loose = clone(base)
    doc.regions.r3.rev = 7
    const recreate = { ...box("r3"), rev: 0 }
    const result = run(
      [
        { id: opId(), type: "deleteRegion", regionId: "r3", children: "detach" },
        { id: opId(), type: "createRegion", region: recreate },
      ],
      doc,
    )
    expect(result.doc.regions["r3"]?.rev).toBe(8)
  })

  it("bumps the source rev once per operation, even for a subtree delete", () => {
    const doc: Loose = clone(base)
    doc.regions.r2.parentId = "r1"
    doc.regions.r3.parentId = "r1"
    doc.regions.r4.parentId = "r2"
    const result = run(
      [{ id: opId(), type: "deleteRegion", regionId: "r1", children: "delete" }],
      doc,
    )
    expect(result.doc.sources["s1"]?.rev).toBe(doc.sources.s1.rev + 1)
  })

  it("uses a store-supplied inverse id function", () => {
    const result = run(
      [{ id: opId(), type: "patchRegion", regionId: "r1", patch: { comment: "x" } }],
      base,
      { inverseId: (opIdValue, index) => `undo-${opIdValue}-${index}` },
    )
    expect(result.inverse[0]?.id).toMatch(/^undo-h\d+-0$/)
  })
})

describe("same-source moves are reorders", () => {
  it("keeps the parent and the region's rev", () => {
    const doc: Loose = clone(base)
    doc.regions.r1.parentId = "r2"
    const result = run(
      [
        {
          id: opId(),
          type: "moveRegionToSource",
          regionId: "r1",
          sourceId: "s1",
          position: "bottom",
        },
      ],
      doc,
    )
    expect(result.doc.regions["r1"]?.parentId).toBe("r2")
    expect(result.doc.regions["r1"]?.rev).toBe(doc.regions.r1.rev)
    expect(result.doc.sources["s1"]?.regionOrder[0]).toBe("r1")
  })
})

describe("large batches stay fast and bounded", () => {
  const manyRegions = (n: number): AnnotationDocument => {
    const doc: Loose = clone(base)
    doc.config.statuses = ["draft"]
    doc.sources.s1.regionOrder = []
    doc.regions = {}
    for (let i = 0; i < n; i++) {
      doc.regions[`m${i}`] = box(`m${i}`, "s1", 10, 10, 20, 20)
      doc.sources.s1.regionOrder.push(`m${i}`)
    }
    return doc
  }

  // Work units are calibrated to engine time: half the default budget is about 1 s.
  const QUICK = DEFAULT_LIMITS.maxBatchWork / 2

  it("creates 20,000 regions in one batch quickly", { timeout: 30_000 }, () => {
    const doc = manyRegions(0)
    const ops = Array.from({ length: 20_000 }, (_, i) => ({
      id: `c${i}`,
      type: "createRegion",
      region: box(`n${i}`),
    }))
    const { result, work } = applyMetered(doc, batchOf(ops), { limits: { maxBatchOps: 20_000 } })
    expect(Object.keys(result.doc.regions)).toHaveLength(20_000)
    expect(work).toBeLessThan(QUICK)
  })

  it("deletes a 10,000-deep parent chain without overflowing the stack", () => {
    const doc: Loose = manyRegions(10_000)
    for (let i = 1; i < 10_000; i++) doc.regions[`m${i}`].parentId = `m${i - 1}`
    const { result, work } = applyMetered(
      doc,
      batchOf([{ id: opId(), type: "deleteRegion", regionId: "m0", children: "delete" }]),
    )
    expect(Object.keys(result.doc.regions)).toHaveLength(0)
    expect(work).toBeLessThan(QUICK)
  })

  it("stops a batch that exceeds the work budget", () => {
    const doc = manyRegions(2000)
    const ops = Array.from({ length: 2000 }, (_, i) => ({
      id: `r${i}`,
      type: "reorderRegion",
      regionId: `m${i}`,
      position: "top",
    }))
    expect(codeOf(() => apply(doc, batchOf(ops), { limits: { maxBatchWork: 10_000 } }))).toBe(
      "LIMIT_EXCEEDED",
    )
  })
})

describe("follow-up guarantees", () => {
  it("undoes a subtree delete whose members are interleaved with survivors", () => {
    const doc: Loose = clone(base)
    doc.sources.s1.regionOrder = ["r3", "r1", "r5", "r2", "r4"]
    doc.regions.r2.parentId = "r1"
    doc.regions.r4.parentId = "r2"
    doc.regions.r3.parentId = "r4"
    const result = run(
      [{ id: opId(), type: "deleteRegion", regionId: "r1", children: "delete" }],
      doc,
    )
    expect(result.doc.sources["s1"]?.regionOrder).toEqual(["r5"])
    const undone = run(result.inverse, result.doc)
    expect(stable(undone.doc)).toEqual(stable(doc))
  })

  it("limits keys of the merged meta, not only of the patch", () => {
    const limits = { maxEntries: 3 }
    const first = run(
      [{ id: opId(), type: "setDocumentMeta", patch: { "a:1": 1, "a:2": 2 } }],
      base,
      { limits },
    )
    expect(
      codeOf(() =>
        run([{ id: opId(), type: "setDocumentMeta", patch: { "a:3": 3, "a:4": 4 } }], first.doc, {
          limits,
        }),
      ),
    ).toBe("LIMIT_EXCEEDED")
  })

  it("stops a very deep but small payload before any schema walks it", () => {
    const patch = { "a:deep": nest(100_000) }
    expect(codeOf(() => run([{ id: opId(), type: "setDocumentMeta", patch }]))).toBe(
      "LIMIT_EXCEEDED",
    )
  })

  it("rejects an inverseId function that returns an invalid id", () => {
    const op = { id: opId(), type: "patchRegion", regionId: "r1", patch: { comment: "x" } }
    expect(codeOf(() => run([op], base, { inverseId: () => "not valid!" }))).toBe(
      "INVALID_DOCUMENT",
    )
  })

  it("inverts a same-source move with a reorder and bumps the source rev once", () => {
    const op = { id: opId(), type: "moveRegionToSource", regionId: "r1", sourceId: "s1" }
    const result = run([op])
    expect(result.inverse).toHaveLength(1)
    expect(result.inverse[0]).toMatchObject({
      type: "reorderRegion",
      regionId: "r1",
      position: "bottom",
    })
    expect(result.doc.sources["s1"]?.rev).toBe((base.sources["s1"]?.rev ?? 0) + 1)
  })

  it("rejects unknown fields that would nest past the document budget once stored", () => {
    // Depth 64 in the operation (op > region > 62 levels) is depth 65 in the document.
    const region = { ...box("r9"), x_ext: nest(62) }
    expect(codeOf(() => run([{ id: opId(), type: "createRegion", region }]))).toBe("LIMIT_EXCEEDED")
    const ok = run([
      { id: opId(), type: "createRegion", region: { ...box("r9"), x_ext: nest(60) } },
    ])
    expect(() => parseDocument(JSON.parse(JSON.stringify(ok.doc)))).not.toThrow()
  })
})
