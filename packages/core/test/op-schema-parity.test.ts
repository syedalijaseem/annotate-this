import { describe, expect, it } from "vitest"
import { OPERATION_TYPES, parseOperation } from "../src/ops/op-schema.js"
import type { OperationType } from "../src/ops/types.js"
import { box, clone, validDocument } from "./fixtures.js"

const source = { ...clone(validDocument().sources["s1"]), id: "s9", regionOrder: [] }

// One valid example of every operation (Spec 0002 catalog). The Record type
// makes this list exhaustive over OperationType at compile time.
const EXAMPLES: Record<OperationType, Record<string, unknown>> = {
  setDocumentMeta: { patch: { "a:x": 1 } },
  createRegion: { region: box("n1"), position: "top" },
  createRegions: { regions: [box("n1")], positions: [{ after: "r1" }] },
  setGeometry: { regionId: "r1", geometry: { type: "point", x: 1, y: 1 } },
  patchRegion: { regionId: "r1", patch: { comment: null, tagIds: ["t1"], frame: 2 } },
  deleteRegion: { regionId: "r1", children: "delete" },
  deleteRegions: { regionIds: ["r1"], children: "detach" },
  reorderRegion: { regionId: "r1", position: "bottom" },
  moveRegionToSource: { regionId: "r1", sourceId: "s2" },
  setConfig: { patch: { statuses: ["draft"], minRegionSize: null } },
  addClass: { def: { id: "c9", name: "x", meta: {} } },
  updateClass: { classId: "c1", patch: { hotkey: "k", allowedGeometry: ["box"] } },
  removeClass: { classId: "c1", onInUse: "reject" },
  reorderClass: { classId: "c1", position: "top" },
  addTag: { def: { id: "t9", name: "x", meta: {} } },
  updateTag: { tagId: "t1", patch: { color: "#000000" } },
  removeTag: { tagId: "t1", onInUse: "detach" },
  reorderTag: { tagId: "t1", position: "top" },
  setAttributeDef: { def: { key: "k", label: "K", type: "boolean" } },
  removeAttributeDef: { key: "k", onInUse: "reject" },
  addSkeleton: { def: { id: "k9", name: "x", points: [{ name: "a" }], edges: [] } },
  updateSkeleton: { skeletonId: "k1", patch: { name: "y" } },
  removeSkeleton: { skeletonId: "k1" },
  addSource: { source },
  updateSource: { sourceId: "s1", patch: { thumbnailUri: null, comment: "c" } },
  removeSource: { sourceId: "s1" },
  reorderSource: { sourceId: "s1", position: { after: "s2" } },
}

const withType = (type: string, body: Record<string, unknown>) => ({ id: "o1", type, ...body })

describe("operation schemas match the operation catalog", () => {
  it("has a schema for exactly the operation types", () => {
    expect([...OPERATION_TYPES].sort()).toEqual(Object.keys(EXAMPLES).sort())
  })

  it.each(Object.entries(EXAMPLES))("parses a valid %s", (type, body) => {
    const parsed = parseOperation(withType(type, body))
    expect(parsed.type).toBe(type)
    expect(parsed.id).toBe("o1")
  })

  it.each(Object.entries(EXAMPLES))("rejects an unknown top-level key on %s", (type, body) => {
    expect(() => parseOperation({ ...withType(type, body), extra: 1 })).toThrow(
      expect.objectContaining({ code: "INVALID_DOCUMENT" }) as Error,
    )
  })

  it.each([
    "patchRegion",
    "setConfig",
    "updateClass",
    "updateTag",
    "updateSkeleton",
    "updateSource",
  ])("rejects an unknown patch field on %s", (type) => {
    const body = EXAMPLES[type as OperationType]
    const patch = { ...(body["patch"] as object), nope: 1 }
    expect(() => parseOperation(withType(type, { ...body, patch }))).toThrow(/nope|Invalid/)
  })

  it("rejects unknown operation types", () => {
    expect(() => parseOperation(withType("explode", {}))).toThrow(/unknown type/)
  })
})
