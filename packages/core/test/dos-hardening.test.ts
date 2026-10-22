import { describe, expect, it } from "vitest"
import { isAnnotateError } from "../src/errors.js"
import type { ErrorCode } from "../src/errors.js"
import { createIdGenerator } from "../src/ids.js"
import { parseDocument } from "../src/validate/index.js"
import { type Loose, clone, validDocument } from "./fixtures.js"

/** Parses and returns the error code, failing loudly on anything that is not an AnnotateError. */
function codeOf(doc: unknown): ErrorCode | "ACCEPTED" {
  try {
    parseDocument(doc)
    return "ACCEPTED"
  } catch (error) {
    if (!isAnnotateError(error)) throw error
    return error.code
  }
}

function errorOf(doc: unknown) {
  try {
    parseDocument(doc)
  } catch (error) {
    if (!isAnnotateError(error)) throw error
    return error
  }
  throw new Error("expected parseDocument to throw")
}

const nestedArrays = (depth: number, leaf: unknown): unknown => {
  let value = leaf
  for (let i = 0; i < depth; i++) value = [value]
  return value
}

describe("hostile input stays linear in time and memory", () => {
  it("rejects deeply nested arrays with an invalid leaf quickly (no union blow-up)", () => {
    const doc: Loose = clone(validDocument())
    // Linear validation takes milliseconds; a union blow-up (2^24 paths or
    // more) would not finish within the test timeout.
    doc.meta = { a: nestedArrays(24, Number.POSITIVE_INFINITY) }
    expect(codeOf(doc)).toBe("INVALID_DOCUMENT")
  })

  it("does the same for custom geometry data", () => {
    const doc: Loose = clone(validDocument())
    doc.regions.r3.geometry = {
      type: "custom",
      kind: "acme:thing",
      data: nestedArrays(24, Number.POSITIVE_INFINITY),
    }
    expect(codeOf(doc)).toBe("INVALID_DOCUMENT")
  })

  it("still accepts valid nested JSON in meta", () => {
    const doc: Loose = clone(validDocument())
    doc.meta = { a: nestedArrays(20, { b: [1, "x", null, true] }) }
    expect(codeOf(doc)).toBe("ACCEPTED")
  })

  it("caps schema issue work for a huge invalid array", () => {
    const doc: Loose = clone(validDocument())
    doc.sourceOrder = new Array(1_000_000).fill(1)
    const error = errorOf(doc)
    expect(error.code).toBe("INVALID_DOCUMENT")
    // The schema stops at the first bad element instead of collecting a million issues.
    expect(error.issues).toHaveLength(1)
    expect(error.issues?.[0]?.path).toBe("sourceOrder.0")
  })

  it(
    "rejects a huge ring by the vertex limit without exhausting memory in the depth guard",
    {
      timeout: 30_000,
    },
    () => {
      const doc: Loose = clone(validDocument())
      doc.regions.r2.geometry.rings = [new Array(3_000_000).fill(0)]
      expect(codeOf(doc)).toBe("LIMIT_EXCEEDED")
    },
  )

  it.each([
    ["source tagIds", (d: Loose) => (d.sources.s1.tagIds = new Array(200_000).fill("nope"))],
    ["sourceOrder", (d: Loose) => (d.sourceOrder = new Array(300_000).fill("s1"))],
    [
      "source attributes",
      (d: Loose) => {
        const attributes: Record<string, number> = {}
        for (let i = 0; i < 300_000; i++) attributes[`k${i}`] = 1
        d.sources.s1.attributes = attributes
      },
    ],
  ])(
    "never throws a raw error for huge issue lists (%s)",
    { timeout: 30_000 },
    (_name, corrupt) => {
      const doc: Loose = clone(validDocument())
      corrupt(doc)
      const error = errorOf(doc)
      expect(error.issues?.length ?? 0).toBeLessThanOrEqual(25)
    },
  )
})

describe("error output cannot be inflated by the input", () => {
  it("clips attacker text in messages", () => {
    const doc: Loose = clone(validDocument())
    doc.schemaVersion = `<img src=x onerror=alert(1)>${"A".repeat(2_000_000)}`
    const error = errorOf(doc)
    expect(error.message.length).toBeLessThan(2000)
    for (const issue of error.issues ?? []) {
      expect(issue.message.length).toBeLessThan(500)
      expect(issue.path.length).toBeLessThan(500)
    }
  })

  it("clips attacker text in paths", () => {
    const doc: Loose = clone(validDocument())
    doc.meta = { [`${"k".repeat(100_000)}`]: nestedArrays(2, Number.POSITIVE_INFINITY) }
    const error = errorOf(doc)
    for (const issue of error.issues ?? []) expect(issue.path.length).toBeLessThan(500)
  })
})

describe("string limits cover every free-text field", () => {
  const long = "x".repeat(20_000)

  it.each([
    [
      "string attribute value",
      (d: Loose) => (d.regions.r1.attributes.note = long),
      "LIMIT_EXCEEDED",
    ],
    [
      "source attribute value",
      (d: Loose) => (d.sources.s1.attributes.note = long),
      "LIMIT_EXCEEDED",
    ],
    [
      "attribute default",
      (d: Loose) => (d.config.attributes.note.default = long),
      "LIMIT_EXCEEDED",
    ],
    [
      "provenance.createdBy",
      (d: Loose) => (d.regions.r1.provenance.createdBy = long),
      "LIMIT_EXCEEDED",
    ],
    [
      "provenance model",
      (d: Loose) => (d.regions.r1.provenance.source = { model: long, version: "1" }),
      "LIMIT_EXCEEDED",
    ],
    [
      "provenance version",
      (d: Loose) => (d.regions.r1.provenance.source = { model: "m", version: long }),
      "LIMIT_EXCEEDED",
    ],
    [
      "skeleton point name",
      (d: Loose) => (d.config.skeletons.k1.points[0].name = long),
      "LIMIT_EXCEEDED",
    ],
    [
      "scale unit",
      (d: Loose) => (d.sources.s1.scale = { realSize: { w: 1, h: 1, unit: long } }),
      "LIMIT_EXCEEDED",
    ],
    [
      "custom kind",
      (d: Loose) => (d.regions.r3.geometry = { type: "custom", kind: `a:${long}`, data: {} }),
      "INVALID_DOCUMENT",
    ],
  ])("rejects an oversized %s", (_name, corrupt, expected) => {
    const doc: Loose = clone(validDocument())
    doc.config.attributes.note = { key: "note", label: "Note", type: "string" }
    doc.regions.r1.attributes.note = "ok"
    doc.sources.s1.attributes.note = "ok"
    corrupt(doc)
    expect(codeOf(doc)).toBe(expected)
  })

  it("accepts the same fields within the limit", () => {
    const doc: Loose = clone(validDocument())
    doc.config.attributes.note = { key: "note", label: "Note", type: "string", default: "d" }
    doc.regions.r1.attributes.note = "x".repeat(10_000)
    expect(codeOf(doc)).toBe("ACCEPTED")
  })
})

describe("unknown fields must be JSON", () => {
  it.each([
    ["bigint", () => 10n],
    ["function", () => () => 1],
    ["NaN", () => Number.NaN],
    ["Date", () => new Date()],
    ["symbol", () => Symbol("s")],
  ])("rejects a %s in an unknown field", (_name, make) => {
    const doc: Loose = clone(validDocument())
    doc.regions.r1.extra = make()
    expect(codeOf(doc)).toBe("INVALID_DOCUMENT")
  })

  it("keeps plain JSON unknown fields", () => {
    const doc: Loose = clone(validDocument())
    doc.regions.r1.extra = { a: [1, "two", null, { b: true }] }
    const parsed = parseDocument(doc) as Loose
    expect(parsed.regions.r1.extra).toEqual({ a: [1, "two", null, { b: true }] })
  })
})

describe("exotic inputs", () => {
  it("turns a throwing schemaVersion getter into an AnnotateError", () => {
    const doc: Loose = clone(validDocument())
    Object.defineProperty(doc, "schemaVersion", {
      get() {
        throw new Error("boom")
      },
      enumerable: true,
    })
    expect(codeOf(doc)).toBe("INVALID_DOCUMENT")
  })

  it("turns a Proxy that throws into an AnnotateError", () => {
    const proxy = new Proxy(
      {},
      {
        get() {
          throw new Error("trap")
        },
        ownKeys() {
          throw new Error("trap")
        },
      },
    )
    expect(codeOf(proxy)).toBe("INVALID_DOCUMENT")
  })
})

describe("integers are bounded to safe values", () => {
  it.each([
    ["rev above 2^53", (d: Loose) => (d.rev = 2 ** 53 + 2)],
    ["rev 1e300", (d: Loose) => (d.rev = 1e300)],
    ["source width 1e300", (d: Loose) => (d.sources.s1.width = 1e300)],
  ])("rejects %s", (_name, corrupt) => {
    const doc: Loose = clone(validDocument())
    corrupt(doc)
    expect(codeOf(doc)).not.toBe("ACCEPTED")
  })

  it("accepts the largest safe integer rev", () => {
    const doc: Loose = clone(validDocument())
    doc.rev = Number.MAX_SAFE_INTEGER
    expect(codeOf(doc)).toBe("ACCEPTED")
  })
})

describe("UUIDv7 generator at the end of the 48-bit range", () => {
  it("throws instead of wrapping the timestamp to zero", () => {
    const next = createIdGenerator({
      now: () => 2 ** 48 - 1,
      randomBytes: (buffer) => buffer.fill(0xff),
    })
    const seen: string[] = []
    const run = () => {
      for (let i = 0; i < 5000; i++) seen.push(next())
    }
    expect(run).toThrow()
    for (const id of seen) expect(id.startsWith("00000000-")).toBe(false)
    expect([...seen].sort()).toEqual(seen)
  })
})
