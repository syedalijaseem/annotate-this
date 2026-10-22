import { describe, expect, it } from "vitest"
import { apply } from "../src/ops/apply.js"
import type { Operation, Position } from "../src/ops/types.js"
import type { AnnotationDocument } from "../src/types.js"
import { type Loose, box, clone, validDocument } from "./fixtures.js"
import {
  batchOf,
  codeOf,
  manyRegions,
  opId,
  random,
  reload,
  richDocument,
  roundTrip,
  run,
  stable,
  videoDocument,
} from "./ops-helpers.js"

const base = richDocument()
const op = (body: Loose): Operation => ({ id: opId(), ...body }) as Operation
const order = (doc: AnnotationDocument, sourceId = "s1") => doc.sources[sourceId]?.regionOrder

const createRegions = (regions: Loose[], positions?: Position[]) =>
  op({ type: "createRegions", regions, ...(positions ? { positions } : {}) })

const deleteRegions = (regionIds: string[], children: "delete" | "detach" = "detach") =>
  op({ type: "deleteRegions", regionIds, children })

const timed = <T>(fn: () => T): { value: T; ms: number } => {
  const started = Date.now()
  const value = fn()
  return { value, ms: Date.now() - started }
}

// Undo and redo as an integrator would run them: one batch each, default limits.
function undoRedo(doc: AnnotationDocument, ops: Operation[]) {
  const result = apply(doc, batchOf(ops))
  const undo = timed(() => apply(result.doc, batchOf(result.inverse)))
  const redo = timed(() => apply(undo.value.doc, batchOf(undo.value.inverse)))
  return { result, undone: undo.value, undoMs: undo.ms, redone: redo.value, redoMs: redo.ms }
}

describe("undoing a removeSource is one bounded batch", () => {
  const layouts: [string, number, (i: number, n: number) => number | undefined][] = [
    ["flat", 50_000, () => undefined],
    ["a chain with parents below", 10_000, (i) => (i > 0 ? i - 1 : undefined)],
    ["a chain with parents above", 10_000, (i, n) => (i < n - 1 ? i + 1 : undefined)],
    ["children below their parents", 24_000, (i, n) => (i < n / 2 ? i + n / 2 : undefined)],
  ]

  it.each(layouts)(
    "restores %s within the default limits",
    (_, n, parentOf) => {
      const doc = manyRegions(n, (i) => parentOf(i, n))
      const remove = op({ type: "removeSource", sourceId: "s1" })
      const { result, undone, undoMs, redone, redoMs } = undoRedo(doc, [remove])
      expect(result.inverse).toHaveLength(2)
      expect(result.inverse.map((o) => o.type)).toEqual(["addSource", "createRegions"])
      expect(undoMs).toBeLessThan(2000)
      expect(order(undone.doc)).toEqual(order(doc))
      expect(stable(undone.doc)).toEqual(stable(doc))
      expect(redoMs).toBeLessThan(2000)
      expect(stable(redone.doc)).toEqual(stable(result.doc))
    },
    60_000,
  )

  it("restores the source at deletedRev + 1 and each region at deletedRev + 1", () => {
    const doc: Loose = clone(base)
    doc.sources.s1.rev = 7
    doc.regions.r1.rev = 3
    const result = run(reload(doc), [op({ type: "removeSource", sourceId: "s1" })])
    const undone = run(result.doc, result.inverse)
    expect(undone.doc.sources["s1"]?.rev).toBe(8)
    expect(undone.doc.regions["r1"]?.rev).toBe(4)
    expect(undone.doc.regions["r2"]?.rev).toBe(1)
  })

  it("does not bump a source created earlier in the same batch", () => {
    const source = { ...clone(base.sources["s2"]), id: "s9", regionOrder: [] }
    const result = run(base, [
      op({ type: "addSource", source }),
      op({ type: "createRegion", region: box("n1", "s9") }),
      op({ type: "createRegion", region: box("n2", "s9") }),
    ])
    expect(result.doc.sources["s9"]?.rev).toBe(0)
    expect(result.doc.sources["s9"]?.regionOrder).toEqual(["n1", "n2"])
  })
})

describe("undoing a large subtree delete is one bounded batch", () => {
  it("restores a 20,000-deep chain with one createRegions", () => {
    const doc = manyRegions(20_000, (i) => (i > 0 ? i - 1 : undefined))
    const remove = op({ type: "deleteRegion", regionId: "m0", children: "delete" })
    const { result, undone, undoMs, redone } = undoRedo(doc, [remove])
    expect(result.inverse.map((o) => o.type)).toEqual(["createRegions"])
    expect(undoMs).toBeLessThan(2000)
    expect(stable(undone.doc)).toEqual(stable(doc))
    expect(stable(redone.doc)).toEqual(stable(result.doc))
  }, 60_000)

  it("restores a subtree interleaved with 10,000 survivors in place", () => {
    // Every other region belongs to the subtree under m0.
    const doc = manyRegions(20_000, (i) => (i % 2 === 0 && i > 0 ? i - 2 : undefined))
    const remove = op({ type: "deleteRegion", regionId: "m0", children: "delete" })
    const { result, undone, undoMs } = undoRedo(doc, [remove])
    expect(result.doc.sources["s1"]?.regionOrder).toHaveLength(10_000)
    expect(undoMs).toBeLessThan(2000)
    expect(order(undone.doc)).toEqual(order(doc))
  }, 60_000)

  it("keeps a single-region delete inverted by createRegion", () => {
    const result = roundTrip(base, [
      op({ type: "deleteRegion", regionId: "r3", children: "delete" }),
    ])
    expect(result.inverse.map((o) => o.type)).toEqual(["createRegion"])
  })
})

describe("createRegions", () => {
  it("creates regions on top in list order and is undone by one deleteRegions", () => {
    const result = roundTrip(base, [createRegions([box("n1"), box("n2"), box("n3", "s2")])])
    expect(order(result.doc)).toEqual(["r1", "r2", "r3", "r4", "r5", "n1", "n2"])
    expect(order(result.doc, "s2")).toEqual(["n3"])
    expect(result.doc.regions["n1"]?.rev).toBe(0)
    expect(result.doc.sources["s1"]?.rev).toBe((base.sources["s1"]?.rev ?? 0) + 1)
    expect(result.inverse).toHaveLength(1)
    expect(result.inverse[0]).toMatchObject({ type: "deleteRegions", children: "detach" })
    expect(new Set(result.changes.created)).toEqual(new Set(["n1", "n2", "n3"]))
  })

  it("places regions exactly as one createRegion per entry would", () => {
    const rand = random(17)
    const survivors = order(base) ?? []
    for (let trial = 0; trial < 40; trial++) {
      const regions = Array.from({ length: 6 }, (_, i) => box(`n${i}`))
      const positions = regions.map((_, i): Position => {
        const roll = rand()
        if (roll < 0.2) return "top"
        if (roll < 0.4) return "bottom"
        const earlier = regions.slice(0, i).map((r) => r.id)
        const anchors = roll < 0.7 && earlier.length > 0 ? earlier : survivors
        return { after: anchors[Math.floor(rand() * anchors.length)] as string }
      })
      const one = regions.map((region, i) =>
        op({ type: "createRegion", region, position: positions[i] }),
      )
      const expected = order(run(base, one).doc)
      expect(order(roundTrip(base, [createRegions(regions, positions)]).doc)).toEqual(expected)
    }
  })

  it("accepts parents anywhere in the list, but not loops", () => {
    const child = { ...box("n1"), parentId: "n2" }
    const result = roundTrip(base, [
      createRegions([child, box("n2"), { ...box("n3"), parentId: "r1" }]),
    ])
    expect(result.doc.regions["n1"]?.parentId).toBe("n2")
    const loop = [
      { ...box("n1"), parentId: "n2" },
      { ...box("n2"), parentId: "n1" },
    ]
    expect(codeOf(() => run(base, [createRegions(loop)]))).toBe("CYCLE")
    const self = [{ ...box("n1"), parentId: "n1" }]
    expect(codeOf(() => run(base, [createRegions(self)]))).toBe("CYCLE")
  })

  it("validates parents, ids, sources and positions", () => {
    const check = (regions: Loose[], positions?: Loose[]) =>
      codeOf(() => run(base, [createRegions(regions, positions)]))
    expect(check([{ ...box("n1"), parentId: "nope" }])).toBe("INVALID_DOCUMENT")
    expect(check([box("n1", "s2"), { ...box("n2"), parentId: "n1" }])).toBe("INVALID_DOCUMENT")
    expect(check([box("n1"), box("n1")])).toBe("DUPLICATE_ID")
    expect(check([box("r1")])).toBe("DUPLICATE_ID")
    expect(check([box("config")])).toBe("INVALID_DOCUMENT")
    expect(check([box("n1", "nope")])).toBe("NOT_FOUND")
    expect(check([])).toBe("INVALID_DOCUMENT")
    expect(check([box("n1"), box("n2")], ["top"])).toBe("INVALID_DOCUMENT")
    expect(check([box("n1")], [{ after: "nope" }])).toBe("NOT_FOUND")
    expect(check([box("n1"), box("n2")], [{ after: "n2" }, "top"])).toBe("NOT_FOUND")
    expect(check([box("n1")], [{ after: "n1" }])).toBe("INVALID_DOCUMENT")
    expect(check([box("n1", "s2")], [{ after: "r1" }])).toBe("NOT_FOUND")
    expect(check([box("n1"), box("n2", "s1", 950, 20, 100, 50)])).toBe("OUT_OF_BOUNDS")
    expect(check([{ ...box("n1"), classId: "nope" }])).toBe("INVALID_DOCUMENT")
  })

  it("enforces the annotation, vertex and work limits", () => {
    const three = [box("n1"), box("n2"), box("n3")]
    const count = Object.keys(base.regions).length
    const limits = (extra: Loose) => ({ limits: extra })
    expect(
      codeOf(() => run(base, [createRegions(three)], limits({ maxAnnotations: count + 2 }))),
    ).toBe("LIMIT_EXCEEDED")
    expect(() =>
      run(base, [createRegions(three)], limits({ maxAnnotations: count + 3 })),
    ).not.toThrow()
    expect(codeOf(() => run(base, [createRegions(three)], limits({ maxBatchWork: 50 })))).toBe(
      "LIMIT_EXCEEDED",
    )
  })

  it("does not alias the caller's payload", () => {
    const region: Loose = { ...box("n1"), meta: { "a:x": { y: [1] } } }
    const result = run(base, [createRegions([region])])
    region.meta["a:x"].y.push(2)
    expect((result.doc.regions["n1"]?.meta as Loose)["a:x"].y).toEqual([1])
  })
})

describe("deleteRegions", () => {
  const nested = (): AnnotationDocument => {
    const doc: Loose = clone(base)
    doc.regions.r2.parentId = "r1"
    doc.regions.r3.parentId = "r2"
    doc.regions.r4.parentId = "r1"
    return reload(doc)
  }

  it("deletes the listed regions and detaches their other children", () => {
    const result = roundTrip(nested(), [deleteRegions(["r2", "r5"])])
    expect(order(result.doc)).toEqual(["r1", "r3", "r4"])
    expect(result.doc.regions["r3"]?.parentId).toBeUndefined()
  })

  it("deletes whole subtrees, sharing overlapping ones", () => {
    const result = roundTrip(nested(), [deleteRegions(["r2", "r1", "r3"], "delete")])
    expect(order(result.doc)).toEqual(["r5"])
    expect(result.inverse.map((o) => o.type)).toEqual(["createRegions"])
  })

  it("deletes across sources", () => {
    const doc = run(base, [op({ type: "createRegion", region: box("n1", "s2") })]).doc
    const result = roundTrip(doc, [deleteRegions(["n1", "r1"])])
    expect(order(result.doc, "s2")).toEqual([])
    expect(order(result.doc)).toEqual(["r2", "r3", "r4", "r5"])
  })

  it("validates its ids and refuses track children", () => {
    expect(codeOf(() => run(base, [deleteRegions(["r1", "r1"])]))).toBe("INVALID_DOCUMENT")
    expect(codeOf(() => run(base, [deleteRegions(["nope"])]))).toBe("NOT_FOUND")
    expect(codeOf(() => run(base, [deleteRegions([])]))).toBe("INVALID_DOCUMENT")
    const video: Loose = clone(videoDocument())
    video.tracks.tr1.parentId = "vr1"
    expect(codeOf(() => run(reload(video), [deleteRegions(["vr1"])]))).toBe("IN_USE")
    expect(codeOf(() => run(reload(video), [deleteRegions(["vr1"], "delete")]))).toBe("IN_USE")
  })

  it("is the redo of createRegions", () => {
    const created = run(validDocument(), [
      createRegions([box("n1"), box("n2")], ["bottom", "bottom"]),
    ])
    expect(order(created.doc)?.slice(0, 2)).toEqual(["n2", "n1"])
    const undone = run(created.doc, created.inverse)
    const redone = run(undone.doc, undone.inverse)
    expect(order(redone.doc)).toEqual(order(created.doc))
  })
})
