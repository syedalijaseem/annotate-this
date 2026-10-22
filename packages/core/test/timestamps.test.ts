import { describe, expect, it } from "vitest"
import { parseDocument } from "../src/validate/index.js"
import { type Loose, clone, validDocument } from "./fixtures.js"
import { batchOf, codeOf, opId, run } from "./ops-helpers.js"
import { apply } from "../src/ops/apply.js"

// Spec 0001: timestamps are ISO-8601 UTC strings. Accepted form:
// YYYY-MM-DDTHH:MM:SS with an optional fraction of 1 to 9 digits, then "Z",
// naming a real calendar instant (no rollover, no year 0000).
const ACCEPTED = [
  "2026-10-21T12:00:00Z",
  "2024-02-29T23:59:59Z",
  "2026-01-01T00:00:00.5Z",
  "2026-01-01T00:00:00.123456789Z",
  "0001-01-01T00:00:00Z",
  "9999-12-31T23:59:59.999Z",
]

const REJECTED = [
  "2026-02-31T00:00:00Z",
  "2026-04-31T00:00:00Z",
  "2025-02-29T00:00:00Z",
  "2026-13-01T00:00:00Z",
  "2026-00-10T00:00:00Z",
  "2026-01-00T00:00:00Z",
  "2026-01-01T24:00:00Z",
  "2026-01-01T23:60:00Z",
  "2026-01-01T23:59:60Z",
  "2026-01-01T00:00:00 +23",
  "2026-01-01T00:00:00+02:00",
  "2026-01-01T00:00:00",
  "2026-01-01T00:00Z",
  "2026-01-01 00:00:00Z",
  "2026-01-01t00:00:00z",
  "0000-01-01T00:00:00Z",
  "2026-01-01T00:00:00.Z",
  "2026-01-01T00:00:00.1234567890Z",
  "+002026-01-01T00:00:00Z",
  "2026-1-01T00:00:00Z",
  "",
]

const withUpdatedAt = (at: string): Loose => {
  const doc: Loose = clone(validDocument())
  doc.regions.r1.provenance = { source: "manual", updatedAt: at }
  return doc
}

describe("document timestamps", () => {
  it.each(ACCEPTED)("accepts %s", (at) => {
    expect(() => parseDocument(withUpdatedAt(at))).not.toThrow()
  })

  it.each(REJECTED)("rejects %j", (at) => {
    expect(codeOf(() => parseDocument(withUpdatedAt(at)))).toBe("INVALID_DOCUMENT")
  })
})

describe("batch.at", () => {
  const op = () => ({ id: opId(), type: "setDocumentMeta", patch: { "a:x": 1 } })

  it.each(ACCEPTED)("accepts %s", (at) => {
    expect(() => apply(validDocument(), { ...batchOf([op()]), at })).not.toThrow()
  })

  it.each(REJECTED)("rejects %j", (at) => {
    expect(codeOf(() => apply(validDocument(), { ...batchOf([op()]), at }))).toBe(
      "INVALID_DOCUMENT",
    )
  })

  it("stamps createRegion with the batch time", () => {
    const create = { id: opId(), type: "createRegion", region: withUpdatedAt("x").regions.r1 }
    create.region.id = "n1"
    delete create.region.provenance.updatedAt
    expect(run(validDocument(), [create]).doc.regions["n1"]?.provenance.updatedAt).toBe(
      "2026-10-21T12:00:00Z",
    )
  })
})
