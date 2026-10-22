import { describe, expect, it } from "vitest"
import { apply } from "../src/ops/apply.js"
import { measure } from "../src/ops/doc-size.js"
import type { ApplyOptions, Operation } from "../src/ops/types.js"
import type { AnnotationDocument } from "../src/types.js"
import { parseDocument } from "../src/validate/index.js"
import { type Loose, box, clone, validDocument } from "./fixtures.js"
import {
  batchOf,
  codeOf,
  errorOf,
  manyRegions,
  opId,
  richDocument,
  roundTrip,
  run,
  stable,
} from "./ops-helpers.js"

const op = (body: Loose): Operation => ({ id: opId(), ...body }) as Operation

const timed = <T>(fn: () => T): { value: T; ms: number } => {
  const started = Date.now()
  const value = fn()
  return { value, ms: Date.now() - started }
}

// manyRegions(n) as a chain m0 <- m1 <- ... plus a free region X on top.
function chainWithFree(n: number): AnnotationDocument {
  const doc: Loose = manyRegions(n, (i) => (i > 0 ? i - 1 : undefined))
  doc.regions.X = box("X", "s1", 1, 1, 2, 2)
  doc.sources.s1.regionOrder.push("X")
  return doc
}

function classChain(n: number): AnnotationDocument {
  const doc: Loose = clone(validDocument())
  for (let i = 0; i < n; i++) {
    const parent = i > 0 ? { parentId: `d${i - 1}` } : {}
    doc.config.classes[`d${i}`] = { id: `d${i}`, name: "x", meta: {}, ...parent }
    doc.config.classOrder.push(`d${i}`)
  }
  return doc
}

describe("parent-chain walks are charged by their real cost", () => {
  it("charges at least 10 units per step", () => {
    const doc = chainWithFree(10_001)
    const patch = op({ type: "patchRegion", regionId: "X", patch: { parentId: "m10000" } })
    expect(() => apply(doc, batchOf([patch]))).not.toThrow()
    const limits = { maxBatchWork: 100_000 }
    expect(codeOf(() => apply(doc, batchOf([patch]), { limits }))).toBe("LIMIT_EXCEEDED")
    const classes = classChain(10_001)
    const update = op({ type: "updateClass", classId: "c1", patch: { parentId: "d10000" } })
    expect(() => apply(classes, batchOf([update]))).not.toThrow()
    expect(codeOf(() => apply(classes, batchOf([update]), { limits }))).toBe("LIMIT_EXCEEDED")
  })

  // About 0.8 s standalone; the bound leaves room for parallel test workers.
  it("stops 2,000 re-parentings under a 50,000-deep chain within seconds", () => {
    const doc = chainWithFree(49_999)
    const ops = Array.from({ length: 2000 }, (_, k) =>
      op({ type: "patchRegion", regionId: "X", patch: { parentId: `m${49_998 - (k % 2)}` } }),
    )
    const { value: code, ms } = timed(() => codeOf(() => apply(doc, batchOf(ops))))
    expect(code).toBe("LIMIT_EXCEEDED")
    expect(ms).toBeLessThan(4000)
  }, 60_000)
})

describe("free-form payload records are charged while they are copied", () => {
  const base = richDocument()

  it("charges record keys by their parse cost", () => {
    const meta = Object.fromEntries(Array.from({ length: 10_000 }, (_, i) => [`k${i}`, true]))
    const patch = op({ type: "setDocumentMeta", patch: { "a:m": meta } })
    expect(() => run(base, [patch])).not.toThrow()
    expect(codeOf(() => run(base, [patch], { limits: { maxBatchWork: 240_000 } }))).toBe(
      "LIMIT_EXCEEDED",
    )
  })

  it("charges array elements inside records", () => {
    const values = Array.from({ length: 200_000 }, (_, i) => i % 7)
    const patch = op({ type: "setDocumentMeta", patch: { "a:n": values } })
    expect(() => run(base, [patch])).not.toThrow()
    expect(codeOf(() => run(base, [patch], { limits: { maxBatchWork: 300_000 } }))).toBe(
      "LIMIT_EXCEEDED",
    )
  })

  it("stops copying a payload as soon as the budget runs out", () => {
    let reads = 0
    const values = new Proxy(new Array<number>(1_000_000).fill(1), {
      get(target, key, receiver) {
        if (typeof key === "string" && /^\d+$/.test(key)) reads += 1
        return Reflect.get(target, key, receiver) as unknown
      },
    })
    const patch = op({ type: "setDocumentMeta", patch: { "a:n": values } })
    expect(codeOf(() => apply(base, batchOf([patch]), { limits: { maxBatchWork: 10_000 } }))).toBe(
      "LIMIT_EXCEEDED",
    )
    expect(reads).toBeLessThan(20_000)
  })
})

describe("an inverse never needs more than maxBatchOps operations", () => {
  const labelled = (n: number): AnnotationDocument => {
    const doc: Loose = manyRegions(n)
    for (const region of Object.values<Loose>(doc.regions)) {
      region.tagIds = ["t1"]
      region.classId = "c1"
      region.attributes = { occluded: true }
    }
    return parseDocument(doc)
  }

  it.each<[string, Loose]>([
    ["removeTag", { type: "removeTag", tagId: "t1", onInUse: "detach" }],
    ["removeClass", { type: "removeClass", classId: "c1", onInUse: "detach" }],
    ["removeAttributeDef", { type: "removeAttributeDef", key: "occluded", onInUse: "detach" }],
  ])("refuses a %s detach whose undo would not fit", (_, body) => {
    const doc = labelled(20)
    const error = errorOf(() =>
      run(doc, [op({ type: "patchRegion", regionId: "m0", patch: { comment: "x" } }), op(body)], {
        limits: { maxBatchOps: 10 },
      }),
    )
    expect(error.code).toBe("LIMIT_EXCEEDED")
    expect(error.opIndex).toBe(1)
    expect(error.message).toMatch(/undo would need more than 10 operations/)
    const options: ApplyOptions = { limits: { maxBatchOps: 21 } }
    const result = run(doc, [op(body)], options)
    expect(result.inverse.length).toBeLessThanOrEqual(21)
    expect(stable(run(result.doc, result.inverse, options).doc)).toEqual(stable(doc))
  })

  it("counts the inverse across the whole batch", () => {
    const doc: Loose = manyRegions(6, (i) => (i > 0 ? 0 : undefined))
    doc.sources.s2 = { ...clone(doc.sources.s1), id: "s2", regionOrder: [] }
    doc.sourceOrder = ["s1", "s2"]
    const move = (id: string) => op({ type: "moveRegionToSource", regionId: id, sourceId: "s2" })
    expect(() => run(doc, [move("m1")], { limits: { maxBatchOps: 3 } })).not.toThrow()
    const error = errorOf(() => run(doc, [move("m1"), move("m2")], { limits: { maxBatchOps: 3 } }))
    expect(error.code).toBe("LIMIT_EXCEEDED")
    expect(error.opIndex).toBe(1)
  })

  it("lets bulk inverses through with any batch size", () => {
    const doc = manyRegions(500, (i) => (i % 2 === 1 ? i - 1 : undefined))
    const tight: ApplyOptions = { limits: { maxBatchOps: 2 } }
    const removed = apply(doc, batchOf([op({ type: "removeSource", sourceId: "s1" })]), tight)
    const undone = apply(removed.doc, batchOf(removed.inverse), tight)
    expect(stable(undone.doc)).toEqual(stable(doc))
    const one: ApplyOptions = { limits: { maxBatchOps: 1 } }
    const subtree = apply(
      doc,
      batchOf([op({ type: "deleteRegion", regionId: "m0", children: "delete" })]),
      one,
    )
    expect(subtree.inverse).toHaveLength(1)
    const pasted = apply(
      doc,
      batchOf([op({ type: "createRegions", regions: [box("n1"), box("n2")] })]),
      one,
    )
    expect(pasted.inverse).toHaveLength(1)
  })
})

describe("createRegions uses provenance exactly as given", () => {
  const base = validDocument()

  it("does not stamp updatedAt (createRegion still does)", () => {
    const given = {
      ...box("n1"),
      provenance: { source: "manual", updatedAt: "2020-01-01T00:00:00Z" },
    }
    const result = run(base, [op({ type: "createRegions", regions: [box("n0"), given] })])
    expect(result.doc.regions["n0"]?.provenance).toEqual({ source: "manual" })
    expect(result.doc.regions["n1"]?.provenance.updatedAt).toBe("2020-01-01T00:00:00Z")
    const single = run(base, [op({ type: "createRegion", region: box("n2") })])
    expect(single.doc.regions["n2"]?.provenance.updatedAt).toBeDefined()
  })

  it("restores a large delete exactly, even at the node limit", () => {
    const doc: Loose = manyRegions(300)
    for (const region of Object.values<Loose>(doc.regions)) {
      region.meta = Object.fromEntries(Array.from({ length: 20 }, (_, k) => [`k${k}`, k]))
    }
    const parsed = parseDocument(doc)
    const options: ApplyOptions = { limits: { maxDocumentNodes: measure(parsed).nodes } }
    for (const body of [
      { type: "removeSource", sourceId: "s1" },
      { type: "deleteRegions", regionIds: Object.keys(parsed.regions), children: "delete" },
    ]) {
      const removed = run(parsed, [op(body)], options)
      const undone = run(removed.doc, removed.inverse, options)
      const withoutRev = (d: AnnotationDocument) =>
        JSON.parse(JSON.stringify(d, (k, v: unknown) => (k === "rev" ? undefined : v))) as unknown
      expect(withoutRev(undone.doc)).toEqual(withoutRev(parsed))
    }
  })
})

describe("legitimate large batches stay quick", () => {
  it("pastes 20,000 regions with createRegions and undoes it", () => {
    const doc = manyRegions(0)
    const regions = Array.from({ length: 20_000 }, (_, k) => ({
      ...box(`p${k}`, "s1", 1, 1, 5, 5),
      ...(k % 3 ? { parentId: `p${k - (k % 3)}` } : {}),
    }))
    const { value: result, ms } = timed(() =>
      roundTrip(doc, [op({ type: "createRegions", regions })]),
    )
    expect(Object.keys(result.doc.regions)).toHaveLength(20_000)
    expect(ms).toBeLessThan(5000)
  }, 30_000)

  it("pastes 50,000 labelled regions with meta in one batch", () => {
    const doc = manyRegions(0)
    const regions = Array.from({ length: 50_000 }, (_, k) => ({
      ...box(`p${k}`, "s1", 1, 1, 5, 5),
      classId: "c1",
      tagIds: ["t1"],
      attributes: { score: 0.5, occluded: false },
      meta: { "a:model": "yolo", "a:conf": 0.93, "a:extra": { a: 1, b: 2, c: 3 } },
    }))
    const { value: result, ms } = timed(() =>
      apply(doc, batchOf([op({ type: "createRegions", regions })])),
    )
    expect(Object.keys(result.doc.regions)).toHaveLength(50_000)
    expect(ms).toBeLessThan(3000)
    const undo = timed(() => apply(result.doc, batchOf(result.inverse)))
    expect(Object.keys(undo.value.doc.regions)).toHaveLength(0)
    expect(undo.ms).toBeLessThan(3000)
  }, 30_000)

  it("edits the tags of 20,000 regions in one batch", () => {
    const doc = manyRegions(20_000)
    const ops = Object.keys(doc.regions).map((regionId) =>
      op({ type: "patchRegion", regionId, patch: { tagIds: ["t1"] } }),
    )
    const { value: result, ms } = timed(() => apply(doc, batchOf(ops)))
    expect(result.doc.regions["m5"]?.tagIds).toEqual(["t1"])
    expect(ms).toBeLessThan(3000)
  }, 30_000)

  it("renames 20,000 tags in one batch", () => {
    const doc: Loose = clone(validDocument())
    for (let k = 0; k < 20_000; k++) {
      doc.config.tags[`u${k}`] = { id: `u${k}`, name: "n", meta: {} }
      doc.config.tagOrder.push(`u${k}`)
    }
    const ops = Array.from({ length: 20_000 }, (_, k) =>
      op({ type: "updateTag", tagId: `u${k}`, patch: { name: `q${k}` } }),
    )
    const { value: result, ms } = timed(() => apply(doc, batchOf(ops)))
    expect(result.doc.config.tags["u7"]?.name).toBe("q7")
    expect(ms).toBeLessThan(3000)
  }, 30_000)
})
