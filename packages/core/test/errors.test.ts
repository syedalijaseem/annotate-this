import { describe, expect, it } from "vitest"
import { AnnotateError, ERROR_CODES, isAnnotateError } from "../src/errors.js"

describe("AnnotateError", () => {
  it("carries a stable code, a message and optional detail", () => {
    const err = new AnnotateError("NOT_FOUND", "Region r1 does not exist", {
      opIndex: 2,
      opId: "op1",
    })
    expect(err).toBeInstanceOf(Error)
    expect(err.name).toBe("AnnotateError")
    expect(err.code).toBe("NOT_FOUND")
    expect(err.message).toBe("Region r1 does not exist")
    expect(err.opIndex).toBe(2)
    expect(err.opId).toBe("op1")
  })

  it("omits optional detail when not given", () => {
    const err = new AnnotateError("READ_ONLY", "Editor is read-only")
    expect(err.opIndex).toBeUndefined()
    expect(err.opId).toBeUndefined()
    expect(err.issues).toBeUndefined()
  })

  it("keeps validation issues as plain data", () => {
    const err = new AnnotateError("INVALID_DOCUMENT", "bad", {
      issues: [{ path: "regions.r1", message: "x" }],
    })
    expect(err.issues).toEqual([{ path: "regions.r1", message: "x" }])
  })

  it("lists every code from Spec 0002", () => {
    expect([...ERROR_CODES].sort()).toEqual(
      [
        "ATTRIBUTE_INVALID",
        "CYCLE",
        "DUPLICATE_BATCH",
        "DUPLICATE_ID",
        "INVALID_DOCUMENT",
        "INVALID_GEOMETRY",
        "IN_USE",
        "LIMIT_EXCEEDED",
        "NOT_FOUND",
        "OUT_OF_BOUNDS",
        "READ_ONLY",
        "REV_CONFLICT",
        "SIZE_MISMATCH",
        "UNSUPPORTED_VERSION",
      ].sort(),
    )
  })

  it("is recognised by isAnnotateError, including across realms by shape", () => {
    expect(isAnnotateError(new AnnotateError("CYCLE", "x"))).toBe(true)
    expect(isAnnotateError(new Error("x"))).toBe(false)
    expect(isAnnotateError({ name: "AnnotateError", code: "CYCLE", message: "x" })).toBe(true)
    expect(isAnnotateError(null)).toBe(false)
  })
})
