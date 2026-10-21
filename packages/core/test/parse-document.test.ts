import { describe, expect, it } from "vitest"
import { isAnnotateError } from "../src/errors.js"
import { parseDocument } from "../src/validate/index.js"
import { type Loose, clone, validDocument, validVideoDocument } from "./fixtures.js"

function failure(input: unknown) {
  try {
    parseDocument(input)
  } catch (error) {
    if (isAnnotateError(error)) return error
    throw error
  }
  throw new Error("expected parseDocument to throw")
}

describe("parseDocument: accepting valid documents", () => {
  it("accepts a valid image document unchanged", () => {
    const doc = validDocument()
    expect(parseDocument(clone(doc))).toEqual(doc)
  })

  it("accepts a valid video document with a track", () => {
    const doc = validVideoDocument()
    expect(parseDocument(clone(doc))).toEqual(doc)
  })

  it("does not mutate its input", () => {
    const input = clone(validDocument())
    const snapshot = clone(input)
    parseDocument(input)
    expect(input).toEqual(snapshot)
  })

  it("preserves unknown fields at every level (forward compatibility)", () => {
    const input = clone(validDocument()) as Loose
    input["futureRoot"] = { a: 1 }
    input["regions"]["r1"]["futureRegion"] = "keep"
    input["regions"]["r1"]["geometry"]["futureGeo"] = 7
    input["config"]["futureConfig"] = true
    input["sources"]["s1"]["futureSource"] = [1, 2]
    const out = parseDocument(input) as Loose
    expect(out["futureRoot"]).toEqual({ a: 1 })
    expect(out["regions"]["r1"]["futureRegion"]).toBe("keep")
    expect(out["regions"]["r1"]["geometry"]["futureGeo"]).toBe(7)
    expect(out["config"]["futureConfig"]).toBe(true)
    expect(out["sources"]["s1"]["futureSource"]).toEqual([1, 2])
  })
})

describe("parseDocument: schema version", () => {
  it("loads a newer minor version", () => {
    const input = clone(validDocument())
    input.schemaVersion = "1.7"
    expect(parseDocument(input).schemaVersion).toBe("1.7")
  })

  it("refuses a newer major version with UNSUPPORTED_VERSION", () => {
    const input = clone(validDocument())
    input.schemaVersion = "2.0"
    expect(failure(input).code).toBe("UNSUPPORTED_VERSION")
  })

  it.each(["", "1", "1.0.0", "v1.0", "one.zero", "1.-1"])(
    "rejects malformed version %j",
    (version) => {
      const input = clone(validDocument())
      input.schemaVersion = version
      expect(failure(input).code).toBe("INVALID_DOCUMENT")
    },
  )
})

describe("parseDocument: shape errors", () => {
  it.each([null, undefined, 42, "text", [], true])("rejects non-object input %j", (input) => {
    const err = failure(input)
    expect(err.code).toBe("INVALID_DOCUMENT")
  })

  it("reports the path of the first problem", () => {
    const input = clone(validDocument()) as Loose
    delete input.regions.r1.geometry
    const err = failure(input)
    expect(err.code).toBe("INVALID_DOCUMENT")
    expect(err.issues?.some((issue) => issue.path.startsWith("regions.r1"))).toBe(true)
  })

  it("rejects invalid identifiers", () => {
    const input = clone(validDocument()) as Loose
    input.regions.r1.id = "bad id <script>"
    expect(failure(input).code).toBe("INVALID_DOCUMENT")
  })

  it.each([
    ["negative box width", (d: Loose) => (d.regions.r1.geometry.w = -1)],
    ["NaN coordinate", (d: Loose) => (d.regions.r3.geometry.x = Number.NaN)],
    ["Infinity coordinate", (d: Loose) => (d.regions.r3.geometry.y = Number.POSITIVE_INFINITY)],
    ["non-integer rev", (d: Loose) => (d.regions.r1.rev = 1.5)],
    ["negative rev", (d: Loose) => (d.rev = -1)],
    ["unknown geometry type", (d: Loose) => (d.regions.r1.geometry = { type: "blob" })],
    ["string where number expected", (d: Loose) => (d.regions.r3.geometry.x = "5")],
    ["bad keypoint visibility", (d: Loose) => (d.regions.r4.geometry.points[2] = 3)],
    ["bad color", (d: Loose) => (d.config.classes.c1.color = "red")],
    ["bad attribute value type", (d: Loose) => (d.regions.r1.attributes.score = { nested: true })],
  ])("rejects %s", (_name, mutate) => {
    const input = clone(validDocument())
    mutate(input)
    expect(failure(input).code).toBe("INVALID_DOCUMENT")
  })
})

describe("parseDocument: prototype-pollution keys", () => {
  const evil = (json: string) => JSON.parse(json) as Record<string, unknown>

  it("rejects an own __proto__ key in region meta", () => {
    const input = clone(validDocument()) as Loose
    input.regions.r1.meta = evil('{"__proto__": {"polluted": true}}')
    const err = failure(input)
    expect(err.code).toBe("INVALID_DOCUMENT")
    expect(({} as Record<string, unknown>)["polluted"]).toBeUndefined()
  })

  it.each(["constructor", "prototype"])("rejects %s as a key in attributes", (key) => {
    const input = clone(validDocument()) as Loose
    input.regions.r1.attributes = { [key]: "x" }
    expect(failure(input).code).toBe("INVALID_DOCUMENT")
  })

  it("rejects __proto__ as an ID-keyed record key", () => {
    const input = clone(validDocument()) as Loose
    input.regions = evil('{"__proto__": {"id": "x"}}')
    expect(failure(input).code).toBe("INVALID_DOCUMENT")
  })

  it("accepts harmless keys that merely look similar", () => {
    const input = clone(validDocument()) as Loose
    input.regions.r1.meta = { "acme:toString": 1, proto: 2 }
    expect(parseDocument(input).regions["r1"]?.meta).toEqual({ "acme:toString": 1, proto: 2 })
  })
})
