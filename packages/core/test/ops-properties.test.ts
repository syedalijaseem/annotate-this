import { describe, expect, it } from "vitest"
import { isAnnotateError } from "../src/errors.js"
import { apply } from "../src/ops/apply.js"
import type { ChangeSet, Operation, Position } from "../src/ops/types.js"
import type { AnnotationDocument } from "../src/types.js"
import { parseDocument } from "../src/validate/index.js"
import { type Loose, box, clone, validDocument } from "./fixtures.js"
import { deepFreeze, random } from "./ops-helpers.js"

const pick = <T>(rand: () => number, items: readonly T[]): T =>
  items[Math.floor(rand() * items.length)] as T

function twoSources(): AnnotationDocument {
  const doc: Loose = clone(validDocument())
  doc.sources.s2 = { ...clone(doc.sources.s1), id: "s2", regionOrder: [] }
  doc.sourceOrder = ["s1", "s2"]
  return doc
}

function stable(doc: AnnotationDocument): unknown {
  return JSON.parse(
    JSON.stringify(doc, (key, value) => (key === "rev" || key === "updatedAt" ? undefined : value)),
  )
}

type Entities = Record<string, unknown>

// Every entity a change set can name: the document's own fields (under its
// id), the config (under "config"), sources, regions and tracks.
function entities(doc: AnnotationDocument): Entities {
  const { sources, regions, tracks, config, ...own } = doc
  return { [doc.id]: own, config, ...sources, ...regions, ...tracks }
}

// Canonical JSON: key order is not a change.
const canon = (value: unknown): string =>
  JSON.stringify(value, (_key, v: unknown) =>
    v && typeof v === "object" && !Array.isArray(v)
      ? Object.fromEntries(
          Object.keys(v)
            .sort()
            .map((k) => [k, (v as Record<string, unknown>)[k]]),
        )
      : v,
  )

// The entity diff between two documents, which a change set must equal.
function trueDiff(before: AnnotationDocument, after: AnnotationDocument): ChangeSet {
  const a = entities(before)
  const b = entities(after)
  return {
    created: Object.keys(b)
      .filter((id) => !(id in a))
      .sort(),
    updated: Object.keys(a)
      .filter((id) => id in b && canon(a[id]) !== canon(b[id]))
      .sort(),
    deleted: Object.keys(a)
      .filter((id) => !(id in b))
      .sort(),
  }
}

const sortedChanges = (c: ChangeSet): ChangeSet => ({
  created: [...c.created].sort(),
  updated: [...c.updated].sort(),
  deleted: [...c.deleted].sort(),
})

const revOf = (entity: unknown): number | undefined => (entity as { rev?: number }).rev

// Applying the ops one per batch: every entity an op changes gains exactly one
// rev, every other keeps its rev, and each change set is the true diff.
function expectRevSteps(doc: AnnotationDocument, ops: Operation[], tag: string): void {
  let step = doc
  for (const [k, op] of ops.entries()) {
    const at = "2026-10-21T12:00:00Z"
    const next = apply(step, { id: `${tag}-${k}`, origin: "local", at, ops: [op] }).doc
    if (next === step) continue
    const before = entities(step)
    const after = entities(next)
    const diff = trueDiff(step, next)
    for (const id of Object.keys(before)) {
      if (!(id in after) || id === doc.id) continue
      const delta = (revOf(after[id]) ?? 0) - (revOf(before[id]) ?? 0)
      expect(delta, `rev of ${id} after ${op.type}`).toBe(diff.updated.includes(id) ? 1 : 0)
    }
    step = next
  }
}

/** Wire round trip, as an integrator would persist and reload the result. */
const reload = (doc: AnnotationDocument): AnnotationDocument =>
  parseDocument(JSON.parse(JSON.stringify(doc)))

function randomOp(rand: () => number, doc: AnnotationDocument, n: number): Operation {
  const regionIds = Object.keys(doc.regions)
  const any = (): string => (rand() < 0.1 ? "ghost" : pick(rand, regionIds))
  const position = (): Position => pick<Position>(rand, ["top", "bottom", { after: any() }])
  const id = `p${n}`
  switch (Math.floor(rand() * 8)) {
    case 0:
      return {
        id,
        type: "createRegion",
        region: box(
          `n${n}`,
          pick(rand, ["s1", "s2"]),
          rand() * 900,
          rand() * 700,
          20 + rand() * 90,
          20 + rand() * 90,
        ),
        position: position(),
      }
    case 1:
      return {
        id,
        type: "setGeometry",
        regionId: any(),
        geometry: {
          type: "box",
          x: rand() * 950,
          y: rand() * 750,
          w: 10 + rand() * 80,
          h: 10 + rand() * 80,
        },
      }
    case 2:
      return {
        id,
        type: "patchRegion",
        regionId: any(),
        patch: {
          comment: pick(rand, ["a", "b", null]),
          classId: pick(rand, ["c1", null, "nope"]),
          tagIds: pick(rand, [[], ["t1"]]),
          attributes: { score: pick(rand, [0.1, 0.9, null]) },
          parentId: pick(rand, [null, null, any()]),
          locked: pick(rand, [true, null]),
        },
      }
    case 3:
      return {
        id,
        type: "deleteRegion",
        regionId: any(),
        children: pick(rand, ["delete", "detach"]),
      }
    case 4:
      return { id, type: "reorderRegion", regionId: any(), position: position() }
    case 5:
      return {
        id,
        type: "moveRegionToSource",
        regionId: any(),
        sourceId: pick(rand, ["s1", "s2", "ghost"]),
        position: position(),
      }
    case 6:
      return {
        id,
        type: "setDocumentMeta",
        patch: { [`a:k${Math.floor(rand() * 3)}`]: pick(rand, [1, "x", null]) },
      }
    default:
      return {
        id,
        type: "patchRegion",
        regionId: any(),
        patch: { status: pick(rand, ["draft", "submitted", "weird"]) },
      }
  }
}

describe("random batches (Spec 0002 property obligations)", () => {
  const SEEDS = 40
  const BATCHES = 25

  it.each(Array.from({ length: SEEDS }, (_, i) => i + 1))(
    "seed %i: applied docs stay valid and inverses restore the previous state",
    (seed) => {
      const rand = random(seed)
      let doc = twoSources()
      let counter = 0
      let applied = 0
      for (let b = 0; b < BATCHES; b++) {
        const ops = Array.from({ length: 1 + Math.floor(rand() * 4) }, () =>
          randomOp(rand, doc, ++counter),
        )
        const batch = {
          id: `batch${seed}-${b}`,
          origin: "local" as const,
          at: "2026-10-21T12:00:00Z",
          ops,
        }
        let result
        try {
          // Frozen: apply must never write to its input.
          result = apply(deepFreeze(doc), batch)
        } catch (error) {
          // A rejected batch must be a typed error and must not have touched the document.
          expect(isAnnotateError(error)).toBe(true)
          continue
        }
        applied += 1
        expect(() => reload(result.doc)).not.toThrow()
        if (result.doc !== doc) {
          expect(result.doc.rev).toBe(doc.rev + 1)
          const undone = apply(result.doc, {
            ...batch,
            id: `undo${seed}-${b}`,
            ops: result.inverse,
          })
          expect(stable(undone.doc)).toEqual(stable(doc))
          const redone = apply(undone.doc, {
            ...batch,
            id: `redo${seed}-${b}`,
            ops: undone.inverse,
          })
          expect(stable(redone.doc)).toEqual(stable(result.doc))
          expect(sortedChanges(result.changes)).toEqual(trueDiff(doc, result.doc))
          expectRevSteps(doc, ops, `step${seed}-${b}`)
        } else {
          expect(result.changes).toEqual({ created: [], updated: [], deleted: [] })
          expect(result.inverse).toEqual([])
        }
        doc = result.doc
      }
      expect(applied).toBeGreaterThan(0)
    },
  )
})
