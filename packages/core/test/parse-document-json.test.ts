import { describe, expect, it } from "vitest"
import { isAnnotateError } from "../src/errors.js"
import { parseDocumentJson, utf8ByteLength } from "../src/validate/json.js"
import { validDocument } from "./fixtures.js"

function failure(text: string, limits?: { maxDocumentBytes: number }) {
  try {
    parseDocumentJson(text, limits ? { limits } : {})
  } catch (error) {
    if (isAnnotateError(error)) return error
    throw error
  }
  throw new Error("expected parseDocumentJson to throw")
}

describe("utf8ByteLength", () => {
  it.each([
    ["", 0],
    ["abc", 3],
    ["é", 2],
    ["€", 3],
    ["😀", 4],
    ["a€😀é", 1 + 3 + 4 + 2],
  ])("%j is %i bytes", (text, bytes) => {
    expect(utf8ByteLength(text)).toBe(bytes)
  })

  it("treats a lone surrogate as the 3 bytes of its replacement character", () => {
    expect(utf8ByteLength("\ud800")).toBe(3)
  })
})

describe("parseDocumentJson", () => {
  it("parses valid JSON text", () => {
    expect(parseDocumentJson(JSON.stringify(validDocument()))).toEqual(validDocument())
  })

  it("ignores a leading byte-order mark", () => {
    expect(parseDocumentJson("﻿" + JSON.stringify(validDocument())).id).toBe("doc1")
  })

  it("reports a syntax error as INVALID_DOCUMENT without leaking the raw parser message", () => {
    const err = failure("{ not json")
    expect(err.code).toBe("INVALID_DOCUMENT")
    expect(err.message).toMatch(/not valid JSON/i)
  })

  it("rejects text over the byte limit before parsing it", () => {
    const text = JSON.stringify(validDocument())
    const err = failure(text, { maxDocumentBytes: 100 })
    expect(err.code).toBe("LIMIT_EXCEEDED")
  })

  it("counts bytes, not characters, against the limit", () => {
    const text = JSON.stringify({ ...validDocument(), meta: { "acme:note": "€".repeat(100) } })
    const characters = text.length
    expect(failure(text, { maxDocumentBytes: characters + 50 }).code).toBe("LIMIT_EXCEEDED")
  })

  it("turns absurd nesting inside a valid document into LIMIT_EXCEEDED, not a crash", () => {
    // JSON.parse copes with this depth; the recursive schema validation would overflow the stack.
    const depth = 200_000
    const text = JSON.stringify({ ...validDocument(), meta: { "acme:x": 0 } }).replace(
      '"acme:x":0',
      `"acme:x":${"[".repeat(depth)}${"]".repeat(depth)}`,
    )
    expect(failure(text).code).toBe("LIMIT_EXCEEDED")
  })

  it("rejects a deeply nested value as too deep, before checking its shape", () => {
    const deep = "[".repeat(100_000) + "]".repeat(100_000)
    expect(failure(deep).code).toBe("LIMIT_EXCEEDED")
  })

  it("still validates the parsed value", () => {
    const err = failure(JSON.stringify({ ...validDocument(), schemaVersion: "9.0" }))
    expect(err.code).toBe("UNSUPPORTED_VERSION")
  })
})
