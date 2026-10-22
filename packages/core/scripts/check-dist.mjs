// Smoke test of the built package entry (dist/index.js), as a consumer imports
// it: run after `pnpm build`, as part of check:package. Silent on success.
import assert from "node:assert/strict"
import * as core from "../dist/index.js"

for (const name of ["apply", "parseDocument", "parseDocumentJson", "createDocument"]) {
  assert.equal(typeof core[name], "function", `dist/index.js must export ${name}`)
}
let n = 0
const doc = core.createDocument({
  images: [{ src: "a.png", width: 10, height: 10 }],
  idGenerator: () => `id${++n}`,
})
const region = {
  id: "r1",
  sourceId: doc.sourceOrder[0],
  tagIds: [],
  attributes: {},
  status: "draft",
  provenance: { source: "manual" },
  meta: {},
  geometry: { type: "box", x: 1, y: 1, w: 2, h: 2 },
}
const batch = { id: "b1", origin: "local", at: "2026-01-01T00:00:00Z", ops: [] }
const result = core.apply(doc, { ...batch, ops: [{ id: "o1", type: "createRegion", region }] })
const parsed = core.parseDocumentJson(JSON.stringify(result.doc))
assert.deepEqual(Object.keys(parsed.regions), ["r1"])
const undone = core.apply(parsed, { ...batch, id: "b2", ops: result.inverse })
assert.equal(Object.keys(undone.doc.regions).length, 0)
assert.throws(
  () => core.parseDocument({}),
  (error) => core.isAnnotateError(error),
)
