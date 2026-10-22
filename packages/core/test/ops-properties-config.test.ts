import { afterAll, describe, expect, it } from "vitest"
import { isAnnotateError } from "../src/errors.js"
import { apply } from "../src/ops/apply.js"
import { knownSize, measure } from "../src/ops/doc-size.js"
import type { Operation, Position } from "../src/ops/types.js"
import type { AnnotationDocument } from "../src/types.js"
import { box } from "./fixtures.js"
import { AT, reload, richDocument, stable } from "./ops-helpers.js"

/** Small deterministic PRNG (mulberry32), so a failing seed can be replayed. */
function random(seed: number): () => number {
  let state = seed >>> 0
  return () => {
    state = (state + 0x6d2b79f5) >>> 0
    let t = state
    t = Math.imul(t ^ (t >>> 15), t | 1)
    t ^= t + Math.imul(t ^ (t >>> 7), t | 61)
    return ((t ^ (t >>> 14)) >>> 0) / 4294967296
  }
}

type Rand = () => number
type Body = Record<string, unknown>

const pick = <T>(rand: Rand, items: readonly T[]): T =>
  items[Math.floor(rand() * items.length)] as T

// An existing key of `record` most of the time, otherwise a missing one.
const some = (rand: Rand, record: object): string =>
  rand() < 0.1 ? "ghost" : pick(rand, [...Object.keys(record), "ghost"])

const positionIn = (rand: Rand, order: readonly string[]): Position =>
  pick<Position>(rand, ["top", "bottom", { after: rand() < 0.1 ? "ghost" : pick(rand, order) }])

const area = (rand: Rand) =>
  pick(rand, [
    null,
    { type: "box", x: 0, y: 0, w: 1000, h: 1000 },
    { type: "box", x: 0, y: 0, w: 60, h: 60 },
  ])

const STATUSES = [null, ["draft"], ["draft", "submitted", "accepted", "rejected"], ["draft", "odd"]]

function configOp(rand: Rand, doc: AnnotationDocument, n: number): Body {
  const { config } = doc
  const classId = some(rand, config.classes)
  const tagId = some(rand, config.tags)
  switch (Math.floor(rand() * 13)) {
    case 0:
      return {
        type: "setConfig",
        patch: {
          statuses: pick(rand, STATUSES),
          allowedArea: area(rand),
          taskDescription: pick(rand, ["x", null]),
        },
      }
    case 1: {
      const parentId = rand() < 0.5 ? {} : { parentId: some(rand, config.classes) }
      const def = { id: `nc${n}`, name: "C", meta: {}, ...parentId }
      return { type: "addClass", def, position: positionIn(rand, config.classOrder) }
    }
    case 2:
      return {
        type: "updateClass",
        classId,
        patch: pick<Body>(rand, [
          { name: `C${n}`, color: pick(rand, ["#123456", null]) },
          { parentId: pick(rand, [null, some(rand, config.classes)]) },
          {
            allowedGeometry: pick(rand, [
              null,
              ["box"],
              ["box", "polygon", "point", "keypoints", "mask"],
            ]),
          },
          {
            attributeKeys: pick(rand, [null, ["score"], ["nope"]]),
            meta: { "a:x": pick(rand, [1, null]) },
          },
        ]),
      }
    case 3:
      return { type: "removeClass", classId, onInUse: pick(rand, ["reject", "detach"]) }
    case 4:
      return { type: "reorderClass", classId, position: positionIn(rand, config.classOrder) }
    case 5:
      return {
        type: "addTag",
        def: { id: `nt${n}`, name: "T", meta: {} },
        position: positionIn(rand, config.tagOrder),
      }
    case 6:
      return {
        type: "updateTag",
        tagId,
        patch: { name: `T${n}`, color: pick(rand, ["#abcdef", null]) },
      }
    case 7:
      return { type: "removeTag", tagId, onInUse: pick(rand, ["reject", "detach"]) }
    case 8:
      return { type: "reorderTag", tagId, position: positionIn(rand, config.tagOrder) }
    default:
      return attributeOrSkeletonOp(rand, doc, n)
  }
}

function attributeOrSkeletonOp(rand: Rand, doc: AnnotationDocument, n: number): Body {
  const key = pick(rand, ["score", "occluded", "extra", "ghost"])
  const skeletonId = some(rand, doc.config.skeletons)
  const points = (count: number) => Array.from({ length: count }, (_, i) => ({ name: `p${i}` }))
  switch (Math.floor(rand() * 6)) {
    case 0:
      return {
        type: "setAttributeDef",
        def: pick<Body>(rand, [
          { key, label: "N", type: "number", min: 0, max: pick(rand, [1, 0.3, 10]) },
          { key, label: "B", type: "boolean" },
          { key, label: "S", type: "string", default: "x" },
        ]),
      }
    case 1:
      return { type: "removeAttributeDef", key, onInUse: pick(rand, ["reject", "detach"]) }
    case 2:
      return {
        type: "addSkeleton",
        def: { id: `nk${n}`, name: "K", points: points(3), edges: [[0, 2]] },
      }
    case 3:
      return {
        type: "updateSkeleton",
        skeletonId,
        patch: { points: points(pick(rand, [2, 3])), edges: [] },
      }
    case 4:
      return { type: "updateSkeleton", skeletonId, patch: { name: `K${n}` } }
    default: {
      // Mostly a skeleton added by this run: k1 is in use by r4.
      const added = Object.keys(doc.config.skeletons).filter((id) => id !== "k1")
      return {
        type: "removeSkeleton",
        skeletonId: added.length > 0 ? pick(rand, added) : skeletonId,
      }
    }
  }
}

function sourceOp(rand: Rand, doc: AnnotationDocument, n: number): Body {
  const sourceId = some(rand, doc.sources)
  switch (Math.floor(rand() * 4)) {
    case 0: {
      const source = {
        kind: "image",
        id: `ns${n}`,
        name: "n.jpg",
        uri: "https://example.com/n.jpg",
        width: 640,
        height: 480,
        regionOrder: [],
        tagIds: [],
        attributes: {},
        meta: {},
      }
      return { type: "addSource", source, position: positionIn(rand, doc.sourceOrder) }
    }
    case 1:
      return {
        type: "updateSource",
        sourceId,
        patch: pick<Body>(rand, [
          {
            classId: pick(rand, [null, some(rand, doc.config.classes)]),
            comment: pick(rand, ["c", null]),
          },
          { tagIds: pick(rand, [[], [some(rand, doc.config.tags)]]) },
          { attributes: { score: pick(rand, [0.1, 0.9, null]) } },
          { allowedArea: area(rand), name: `n${n}` },
        ]),
      }
    case 2:
      return { type: "removeSource", sourceId }
    default:
      return { type: "reorderSource", sourceId, position: positionIn(rand, doc.sourceOrder) }
  }
}

// Several new regions in one or two sources, some parented to each other or to existing regions.
function createRegionsOp(rand: Rand, doc: AnnotationDocument, n: number): Body {
  const sourceId = some(rand, doc.sources)
  const regions = Array.from({ length: 1 + Math.floor(rand() * 4) }, (_, k) => {
    const region: Body = { ...box(`n${n}x${k}`, rand() < 0.8 ? sourceId : some(rand, doc.sources)) }
    if (rand() < 0.3) region["parentId"] = rand() < 0.5 ? `n${n}x0` : some(rand, doc.regions)
    return region
  })
  const anchors = [...(doc.sources[sourceId]?.regionOrder ?? []), ...regions.map((r) => r["id"])]
  const positions = regions.map(() => positionIn(rand, anchors as string[]))
  return { type: "createRegions", regions, ...(rand() < 0.5 ? { positions } : {}) }
}

function regionOp(rand: Rand, doc: AnnotationDocument, n: number): Body {
  const regionId = some(rand, doc.regions)
  switch (Math.floor(rand() * 6)) {
    case 4:
      return createRegionsOp(rand, doc, n)
    case 5: {
      const regionIds = [...new Set([regionId, some(rand, doc.regions), some(rand, doc.regions)])]
      return { type: "deleteRegions", regionIds, children: pick(rand, ["delete", "detach"]) }
    }
    case 0: {
      const region = box(
        `n${n}`,
        some(rand, doc.sources),
        rand() * 500,
        rand() * 350,
        5 + rand() * 50,
        5 + rand() * 50,
      )
      return {
        type: "createRegion",
        region: { ...region, classId: pick(rand, [undefined, some(rand, doc.config.classes)]) },
      }
    }
    case 1:
      return {
        type: "patchRegion",
        regionId,
        patch: {
          classId: pick(rand, [null, some(rand, doc.config.classes)]),
          tagIds: pick(rand, [[], [some(rand, doc.config.tags)]]),
          attributes: {
            [pick(rand, ["score", "occluded", "extra"])]: pick(rand, [0.5, true, "x", null]),
          },
          status: pick(rand, ["draft", "odd", "submitted"]),
        },
      }
    case 2:
      return { type: "deleteRegion", regionId, children: pick(rand, ["delete", "detach"]) }
    default:
      return {
        type: "setGeometry",
        regionId,
        geometry: {
          type: "box",
          x: rand() * 500,
          y: rand() * 350,
          w: 5 + rand() * 40,
          h: 5 + rand() * 40,
        },
      }
  }
}

function randomOp(rand: Rand, doc: AnnotationDocument, n: number): Operation {
  const roll = rand()
  const body =
    roll < 0.5
      ? configOp(rand, doc, n)
      : roll < 0.75
        ? sourceOp(rand, doc, n)
        : regionOp(rand, doc, n)
  return { id: `q${n}`, ...body } as Operation
}

const applied = new Map<string, number>()
const NEW_TYPES = [
  "setConfig",
  "addClass",
  "updateClass",
  "removeClass",
  "reorderClass",
  "addTag",
  "updateTag",
  "removeTag",
  "reorderTag",
  "setAttributeDef",
  "removeAttributeDef",
  "addSkeleton",
  "updateSkeleton",
  "removeSkeleton",
  "addSource",
  "updateSource",
  "removeSource",
  "reorderSource",
  "createRegions",
  "deleteRegions",
]

// The size apply carries from batch to batch must match a fresh walk.
function expectKnownSize(doc: AnnotationDocument): void {
  const size = knownSize(doc)
  if (size) expect(size).toEqual(measure(doc))
}

describe("random config, source and region batches (Spec 0002 property obligations)", () => {
  const SEEDS = 60
  const BATCHES = 30

  it.each(Array.from({ length: SEEDS }, (_, i) => i + 1))(
    "seed %i: applied docs stay valid and inverses restore the previous state",
    (seed) => {
      const rand = random(seed * 7919)
      let doc = richDocument()
      let counter = 0
      for (let b = 0; b < BATCHES; b++) {
        const ops = Array.from({ length: 1 + Math.floor(rand() * 3) }, () =>
          randomOp(rand, doc, ++counter),
        )
        const batch = { id: `cb${seed}-${b}`, origin: "local" as const, at: AT, ops }
        let result
        try {
          result = apply(doc, batch)
        } catch (error) {
          expect(isAnnotateError(error)).toBe(true)
          continue
        }
        for (const op of ops) applied.set(op.type, (applied.get(op.type) ?? 0) + 1)
        expect(() => reload(result.doc)).not.toThrow()
        expectKnownSize(result.doc)
        if (result.doc !== doc) {
          expect(result.doc.rev).toBe(doc.rev + 1)
          const undone = apply(result.doc, { ...batch, id: `cu${seed}-${b}`, ops: result.inverse })
          expect(stable(undone.doc)).toEqual(stable(doc))
          expect(() => reload(undone.doc)).not.toThrow()
          const redone = apply(undone.doc, { ...batch, id: `cr${seed}-${b}`, ops: undone.inverse })
          expect(stable(redone.doc)).toEqual(stable(result.doc))
          expectKnownSize(undone.doc)
          expectKnownSize(redone.doc)
        }
        doc = result.doc
      }
    },
  )

  afterAll(() => {
    // Stats probe: every new operation type must succeed at least sometimes,
    // otherwise the property above would only be exercising rejections.
    for (const type of NEW_TYPES) expect(applied.get(type) ?? 0, type).toBeGreaterThan(2)
  })
})
