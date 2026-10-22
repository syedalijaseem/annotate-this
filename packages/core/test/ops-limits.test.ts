import { describe, expect, it } from "vitest"
import type { Limits } from "../src/limits.js"
import { apply } from "../src/ops/apply.js"
import type { Operation } from "../src/ops/types.js"
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
} from "./ops-helpers.js"

const base = validDocument()
const op = (body: Loose): Operation => ({ id: opId(), ...body }) as Operation

// A meta record of `keys` entries: 2 values each (the key and `true`).
const wideMeta = (keys: number, prefix = "k"): Record<string, boolean> =>
  Object.fromEntries(Array.from({ length: keys }, (_, i) => [`${prefix}${i}`, true]))

const addTag = (id: string, meta: Loose = {}) =>
  op({ type: "addTag", def: { id, name: "x", meta } })

// manyRegions() with m0 classified as c1, which allows boxes and points.
function labelled(n: number, parentOf?: (i: number) => number | undefined): AnnotationDocument {
  const doc: Loose = manyRegions(n, parentOf)
  doc.config.classes.c1.allowedGeometry = ["box", "point"]
  doc.regions.m0.classId = "c1"
  return doc
}

describe("the document node limit holds across operations and batches", () => {
  const limits: Partial<Limits> = { maxDocumentNodes: 20_000 }

  it("rejects ops that together push the document past maxDocumentNodes", () => {
    // Each tag adds about 1,800 values; 20 of them pass 20,000.
    const ops = Array.from({ length: 20 }, (_, i) => addTag(`tg${i}`, wideMeta(900)))
    const error = errorOf(() => run(base, ops, { limits }))
    expect(error.code).toBe("LIMIT_EXCEEDED")
    expect(error.opIndex).toBeGreaterThan(5)
    const fits = run(base, ops.slice(0, 10), { limits })
    expect(() => parseDocument(fits.doc, { limits })).not.toThrow()
  })

  it("counts what earlier batches added", () => {
    let doc = base
    const sizes: number[] = []
    for (let b = 0; b < 4; b++) {
      doc = run(doc, [addTag(`tb${b}`, wideMeta(2200, `b${b}k`))], { limits }).doc
      expect(() => parseDocument(doc, { limits })).not.toThrow()
      sizes.push(Object.keys(doc.config.tags).length)
    }
    expect(sizes).toEqual([2, 3, 4, 5])
    expect(codeOf(() => run(doc, [addTag("tb9", wideMeta(2200))], { limits }))).toBe(
      "LIMIT_EXCEEDED",
    )
  })

  it("covers every way of adding values", { timeout: 30_000 }, () => {
    // Each op adds about 6,000 values: one fits under 10,000, two do not.
    const small = { maxDocumentNodes: 10_000 }
    const meta = (p: string) => ({ [`a:${p}`]: wideMeta(3000, p) })
    const adders: ((p: string) => Loose)[] = [
      (p) => ({ type: "setDocumentMeta", patch: meta(p) }),
      (p) => ({ type: "createRegion", region: { ...box(`n${p}`), meta: meta(p) } }),
      (p) => ({ type: "patchRegion", regionId: p === "a" ? "r1" : "r2", patch: { meta: meta(p) } }),
      (p) => ({ type: "updateSource", sourceId: "s1", patch: { meta: meta(p) } }),
      (p) => ({ type: "addClass", def: { id: `c${p}`, name: "x", meta: meta(p) } }),
      (p) => ({ type: "updateTag", tagId: "t1", patch: { meta: meta(p) } }),
    ]
    for (const adder of adders) {
      expect(() => run(base, [op(adder("a"))], { limits: small })).not.toThrow()
      expect(codeOf(() => run(base, [op(adder("a")), op(adder("b"))], { limits: small }))).toBe(
        "LIMIT_EXCEEDED",
      )
    }
    const tools = op({
      type: "setConfig",
      patch: { tools: Array.from({ length: 1000 }, () => "t") },
    })
    expect(codeOf(() => run(base, [tools], { limits: { maxDocumentNodes: 1100 } }))).toBe(
      "LIMIT_EXCEEDED",
    )
  })

  it("lets a batch reuse the room it frees", () => {
    // One 8,000-value tag fits under 15,000; two do not.
    const limits = { maxDocumentNodes: 15_000 }
    const doc = run(base, [addTag("tg1", wideMeta(4000))], { limits }).doc
    const ops = [
      op({ type: "removeTag", tagId: "tg1", onInUse: "reject" }),
      addTag("tg2", wideMeta(4000, "z")),
    ]
    expect(() => run(doc, ops, { limits })).not.toThrow()
    expect(codeOf(() => run(doc, [addTag("tg2", wideMeta(4000, "z"))], { limits }))).toBe(
      "LIMIT_EXCEEDED",
    )
  })
})

describe("the document size limit covers string content", () => {
  it("rejects a 70 MiB string even in an otherwise small document", () => {
    const huge = "x".repeat(70 * 1024 * 1024)
    expect(codeOf(() => run(base, [addTag("tb", { "a:b": huge })]))).toBe("LIMIT_EXCEEDED")
  })

  it("counts strings across operations and batches against maxDocumentBytes", () => {
    const limits = { maxDocumentBytes: 60_000 }
    const text = (n: number) => "y".repeat(n)
    const meta = (key: string, n: number) =>
      op({ type: "setDocumentMeta", patch: { [`a:${key}`]: text(n) } })
    expect(codeOf(() => run(base, [meta("x", 70_000)], { limits }))).toBe("LIMIT_EXCEEDED")
    const first = run(base, [meta("x", 25_000)], { limits }).doc
    expect(JSON.stringify(first).length).toBeLessThan(60_000)
    expect(codeOf(() => run(first, [meta("y", 25_000), meta("z", 25_000)], { limits }))).toBe(
      "LIMIT_EXCEEDED",
    )
    // Replacing a value frees what it held.
    expect(() => run(first, [meta("x", 30_000)], { limits })).not.toThrow()
  })
})

describe("payload records are charged by their parse cost", () => {
  it("charges each record entry many work units", () => {
    // 20,000 meta keys: about 40,000 units when charged per value, far more at the parse cost.
    const limits = { maxBatchWork: 200_000 }
    expect(codeOf(() => run(base, [addTag("tg", wideMeta(20_000))], { limits }))).toBe(
      "LIMIT_EXCEEDED",
    )
    // Plain arrays of numbers stay cheap.
    const numbers = { "a:n": Array.from({ length: 20_000 }, (_, i) => i) }
    expect(() => run(base, [addTag("tg", numbers)], { limits })).not.toThrow()
  })

  it("stops a run of huge-meta config ops early", { timeout: 30_000 }, () => {
    // 60,000 values per op: the third passes 150,000.
    const meta = wideMeta(30_000)
    const ops = Array.from({ length: 10 }, (_, i) => addTag(`tg${i}`, meta))
    const error = errorOf(() =>
      apply(base, batchOf(ops), { limits: { maxDocumentNodes: 150_000 } }),
    )
    expect(error.code).toBe("LIMIT_EXCEEDED")
    expect(error.opIndex).toBeLessThanOrEqual(2)
  })
})

describe("whole-document scans are charged by their real cost", () => {
  const doc10k = labelled(10_000)

  it.each<[string, Loose]>([
    ["setConfig statuses", { type: "setConfig", patch: { statuses: ["draft", "x"] } }],
    [
      "updateClass allowedGeometry",
      { type: "updateClass", classId: "c1", patch: { allowedGeometry: ["box"] } },
    ],
    [
      "setAttributeDef",
      {
        type: "setAttributeDef",
        def: { key: "score", label: "S", type: "number", min: 0, max: 2 },
      },
    ],
    [
      "setConfig allowedArea",
      { type: "setConfig", patch: { allowedArea: { type: "box", x: 0, y: 0, w: 999, h: 800 } } },
    ],
    ["removeTag", { type: "removeTag", tagId: "t1", onInUse: "detach" }],
    ["removeClass", { type: "removeClass", classId: "c1", onInUse: "detach" }],
    ["removeAttributeDef", { type: "removeAttributeDef", key: "occluded", onInUse: "detach" }],
    ["removeSkeleton", { type: "removeSkeleton", skeletonId: "k1" }],
  ])("charges %s at least 16 units per scanned annotation", (_, body) => {
    expect(() => apply(doc10k, batchOf([op(body)]))).not.toThrow()
    expect(
      codeOf(() => apply(doc10k, batchOf([op(body)]), { limits: { maxBatchWork: 160_000 } })),
    ).toBe("LIMIT_EXCEEDED")
  })

  // Each toggle scans all 50,000 regions, so the default budget must stop the
  // batch after a few dozen of the 5,000 toggles.
  it("stops a batch of config toggles on a 50,000-region document early", () => {
    const doc = labelled(50_000)
    const toggles = Array.from({ length: 5000 }, (_, k) =>
      op({ type: "setConfig", patch: { statuses: ["draft", k % 2 ? "a" : "b"] } }),
    )
    const error = errorOf(() => apply(doc, batchOf(toggles)))
    expect(error.code).toBe("LIMIT_EXCEEDED")
    expect(error.opIndex).toBeLessThan(100)
  }, 60_000)
})

describe("parent chains of any valid depth", () => {
  const classChain = (n: number): AnnotationDocument => {
    const doc: Loose = clone(richDocument())
    for (let i = 0; i < n; i++) {
      const parent = i > 0 ? { parentId: `d${i - 1}` } : {}
      doc.config.classes[`d${i}`] = { id: `d${i}`, name: "x", meta: {}, ...parent }
      doc.config.classOrder.push(`d${i}`)
    }
    return doc
  }

  it(
    "re-parents under and removes from a class chain deeper than 10,000",
    { timeout: 30_000 },
    () => {
      const doc = classChain(10_050)
      const reparent = op({ type: "updateClass", classId: "c2", patch: { parentId: "d10049" } })
      expect(roundTrip(doc, [reparent]).doc.config.classes["c2"]?.parentId).toBe("d10049")
      const remove = op({ type: "removeClass", classId: "d10020", onInUse: "reject" })
      const removed = roundTrip(doc, [remove])
      expect(removed.doc.config.classes["d10021"]?.parentId).toBe("d10019")
      expect(codeOf(() => run(doc, [reparent], { limits: { maxBatchWork: 15_000 } }))).toBe(
        "LIMIT_EXCEEDED",
      )
    },
  )

  it("still finds class cycles through a long chain", () => {
    const doc = classChain(10_050)
    const loop = op({ type: "updateClass", classId: "d0", patch: { parentId: "d10049" } })
    expect(codeOf(() => run(doc, [loop]))).toBe("CYCLE")
  })

  it("re-parents a region under a chain deeper than 10,000", () => {
    const doc = manyRegions(10_050, (i) => (i > 0 && i < 10_049 ? i - 1 : undefined))
    const patch = op({ type: "patchRegion", regionId: "m10049", patch: { parentId: "m10048" } })
    const result = apply(doc, batchOf([patch]))
    expect(result.doc.regions["m10049"]?.parentId).toBe("m10048")
    const loop = op({ type: "patchRegion", regionId: "m0", patch: { parentId: "m10048" } })
    expect(codeOf(() => apply(doc, batchOf([loop])))).toBe("CYCLE")
    expect(codeOf(() => apply(doc, batchOf([patch]), { limits: { maxBatchWork: 15_000 } }))).toBe(
      "LIMIT_EXCEEDED",
    )
  })
})
