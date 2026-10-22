import { describe, expect, it, vi } from "vitest"
import { isAnnotateError } from "../src/errors.js"
import type { ErrorCode } from "../src/errors.js"
import type { Limits } from "../src/limits.js"
import { permutationIssues } from "../src/validate/identity.js"
import { MAX_ISSUES_PER_CHECK } from "../src/validate/issues.js"
import { parseDocument } from "../src/validate/index.js"
import { parseDocumentJson } from "../src/validate/json.js"
import { type Loose, clone, validDocument } from "./fixtures.js"

function errorOf(run: () => unknown) {
  try {
    run()
  } catch (error) {
    if (!isAnnotateError(error)) throw error
    return error
  }
  return null
}

const codeOf = (doc: unknown, limits: Partial<Limits> = {}): ErrorCode | "ACCEPTED" =>
  errorOf(() => parseDocument(doc, { limits }))?.code ?? "ACCEPTED"

describe("document-wide budgets", () => {
  it("rejects more nodes than maxDocumentNodes before building anything", () => {
    const doc: Loose = clone(validDocument())
    doc.meta = { a: Array.from({ length: 2000 }, () => ({})) }
    expect(codeOf(doc, { maxDocumentNodes: 1000 })).toBe("LIMIT_EXCEEDED")
    expect(codeOf(doc)).toBe("ACCEPTED")
  })

  it("does not count plain numbers toward the node budget", () => {
    const doc: Loose = clone(validDocument())
    doc.regions.r2.geometry.rings = [new Array(5000).fill(1)]
    expect(codeOf(doc, { maxDocumentNodes: 1000 })).toBe("ACCEPTED")
  })

  it("rejects an object with more than maxEntries keys", () => {
    const doc: Loose = clone(validDocument())
    doc.meta = Object.fromEntries(Array.from({ length: 200 }, (_, i) => [`k${i}`, 1]))
    expect(codeOf(doc, { maxEntries: 100 })).toBe("LIMIT_EXCEEDED")
    expect(codeOf(doc)).toBe("ACCEPTED")
  })

  it(
    "rejects a coordinate array beyond the hard cap with a typed error",
    { timeout: 60_000 },
    () => {
      const doc: Loose = clone(validDocument())
      doc.regions.r2.geometry.rings = [new Array(9_000_000).fill(0)]
      expect(codeOf(doc)).toBe("INVALID_DOCUMENT")
    },
  )
})

describe("JSON text depth is checked before parsing", () => {
  it("rejects absurd bracket nesting without building it", () => {
    const depth = 3_000_000
    const text = "[".repeat(depth) + "]".repeat(depth)
    const parse = vi.spyOn(JSON, "parse")
    try {
      const error = errorOf(() => parseDocumentJson(text))
      expect(error?.code).toBe("LIMIT_EXCEEDED")
      expect(parse).not.toHaveBeenCalled()
    } finally {
      parse.mockRestore()
    }
  })

  it("ignores brackets inside strings and accepts normal documents", () => {
    const doc: Loose = clone(validDocument())
    doc.meta = {
      note: '[[[[[[[[[[[[[[[[[[[[[[[[[[[[[[[[[[[[[[[[[[[[[[[[[[[[[[[[[[[[[[[[[[[\\"[[[[',
    }
    expect(parseDocumentJson(JSON.stringify(doc)).meta).toEqual(doc.meta)
  })
})

describe("issue lists are capped per check", () => {
  it("permutationIssues stops collecting after the cap", () => {
    const order = new Array(100_000).fill("x")
    const issues = permutationIssues("sourceOrder", order, new Set(["s1"]))
    expect(issues.length).toBeLessThanOrEqual(MAX_ISSUES_PER_CHECK + 1)
    expect(issues.length).toBeGreaterThan(0)
  })

  it("keeps the first-reported problem for a huge unknown tagIds list", () => {
    const doc: Loose = clone(validDocument())
    doc.sources.s1.tagIds = new Array(50_000).fill("nope")
    const error = errorOf(() => parseDocument(doc))
    expect(error?.code).toBe("INVALID_DOCUMENT")
    expect(error?.issues?.[0]?.path).toBe("sources.s1.tagIds")
  })
})

describe("schema error quality and strictness", () => {
  it("reports the failing provenance field, not a generic union error", () => {
    const doc: Loose = clone(validDocument())
    doc.regions.r1.provenance.source = { model: "m", confidence: 2 }
    const error = errorOf(() => parseDocument(doc))
    expect(error?.issues?.[0]?.path).toContain("confidence")
  })

  it.each([
    ["meta", (d: Loose) => (d.meta = ["a", "b"])],
    ["regions", (d: Loose) => (d.regions = [])],
    ["config.classes", (d: Loose) => (d.config.classes = [])],
    ["attributes", (d: Loose) => (d.regions.r1.attributes = [])],
  ])("rejects an array where a record is required (%s)", (_name, corrupt) => {
    const doc: Loose = clone(validDocument())
    corrupt(doc)
    expect(codeOf(doc)).toBe("INVALID_DOCUMENT")
  })

  it("rejects a skeleton edge with extra items", () => {
    const doc: Loose = clone(validDocument())
    doc.config.skeletons.k1.edges = [[0, 1, 2]]
    expect(codeOf(doc)).toBe("INVALID_DOCUMENT")
  })
})

describe("documents from another realm", () => {
  it("accepts plain JSON built in a different VM context", async () => {
    // A variable specifier keeps this test free of @types/node, which the package does not use.
    const specifier: string = "node:vm"
    const { runInNewContext } = (await import(specifier)) as {
      runInNewContext: (code: string) => unknown
    }
    const foreign = runInNewContext(`(${JSON.stringify(validDocument())})`)
    expect(codeOf(foreign)).toBe("ACCEPTED")
  })
})
