import { describe, expect, it } from "vitest"
import * as core from "../src/index.js"
import { DEFAULT_STATUSES } from "../src/schema/config.js"
import { parseDocument } from "../src/validate/index.js"
import { validDocument } from "./fixtures.js"

// Nothing a consumer can reach may change how the library validates.
describe("shared internals cannot be tampered with", () => {
  it("freezes the exported error codes and the default statuses", () => {
    expect(Object.isFrozen(core.ERROR_CODES)).toBe(true)
    expect(Object.isFrozen(DEFAULT_STATUSES)).toBe(true)
  })

  it("exports the id pattern as a string, not the regex validation uses", () => {
    expect(core).not.toHaveProperty("ID_PATTERN")
    expect(typeof core.ID_PATTERN_SOURCE).toBe("string")
    expect(new RegExp(core.ID_PATTERN_SOURCE).test("ok-id")).toBe(true)
    expect(core.isValidId("ok-id")).toBe(true)
    expect(() => parseDocument(validDocument())).not.toThrow()
  })

  it("does not expose the valibot document schema", () => {
    expect(core).not.toHaveProperty("DocumentSchema")
  })
})
