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

  it("returns false instead of throwing for hostile objects", () => {
    const throwing = new Proxy(
      {},
      {
        get() {
          throw new Error("boom")
        },
        getPrototypeOf() {
          throw new Error("boom")
        },
      },
    )
    expect(isAnnotateError(throwing)).toBe(false)
    const getter = Object.defineProperty({}, "name", {
      get() {
        throw new Error("boom")
      },
    })
    expect(isAnnotateError(getter)).toBe(false)
  })

  it("rejects spoofed shapes with malformed detail", () => {
    const base = { name: "AnnotateError", code: "CYCLE", message: "x" }
    expect(isAnnotateError({ ...base, issues: "not-an-array" })).toBe(false)
    expect(isAnnotateError({ ...base, issues: [{ path: 1, message: "m" }] })).toBe(false)
    expect(isAnnotateError({ ...base, issues: [null] })).toBe(false)
    expect(isAnnotateError({ ...base, opIndex: "2" })).toBe(false)
    expect(isAnnotateError({ ...base, opId: 7 })).toBe(false)
    expect(isAnnotateError({ ...base, code: "NOPE" })).toBe(false)
    expect(
      isAnnotateError({ ...base, issues: [{ path: "a", message: "b" }], opIndex: 0, opId: "o" }),
    ).toBe(true)
    expect(isAnnotateError({ ...base, opIndex: undefined })).toBe(true)
  })
})
