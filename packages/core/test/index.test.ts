import { describe, expect, it } from "vitest"
import * as core from "../src/index.js"

describe("annotate-this-core public API", () => {
  it("exposes the document schema version as major.minor", () => {
    expect(core.SCHEMA_VERSION).toMatch(/^\d+\.\d+$/)
  })

  it("exports the document-model entry points", () => {
    for (const name of [
      "parseDocument",
      "parseDocumentJson",
      "createDocument",
      "createIdGenerator",
      "isValidId",
      "AnnotateError",
      "isAnnotateError",
      "DEFAULT_LIMITS",
      "geometryBounds",
    ]) {
      expect(core, name).toHaveProperty(name)
    }
  })

  it("can be imported in a DOM-free environment", () => {
    expect(typeof (globalThis as { document?: unknown }).document).toBe("undefined")
    expect(typeof (globalThis as { window?: unknown }).window).toBe("undefined")
  })
})
