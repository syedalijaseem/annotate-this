import { describe, expect, it } from "vitest"
import { SCHEMA_VERSION } from "../src/index.js"

describe("annotate-this-core", () => {
  it("exposes the document schema version as a positive integer", () => {
    expect(Number.isInteger(SCHEMA_VERSION)).toBe(true)
    expect(SCHEMA_VERSION).toBeGreaterThan(0)
  })

  it("can be imported in a DOM-free environment", () => {
    expect(typeof (globalThis as { document?: unknown }).document).toBe("undefined")
  })
})
