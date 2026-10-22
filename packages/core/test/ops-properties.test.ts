import { describe, expect, it } from "vitest"
import { isAnnotateError } from "../src/errors.js"
import { apply } from "../src/ops/apply.js"
import type { Operation, Position } from "../src/ops/types.js"
import type { AnnotationDocument } from "../src/types.js"
import { parseDocument } from "../src/validate/index.js"
import { type Loose, box, clone, validDocument } from "./fixtures.js"
import { random } from "./ops-helpers.js"

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
          result = apply(doc, batch)
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
        }
        doc = result.doc
      }
      expect(applied).toBeGreaterThan(0)
    },
  )
})
