import { AnnotateError } from "../errors.js"
import { type Limits, resolveLimits } from "../limits.js"
import type { AnnotationDocument } from "../types.js"
import { STRUCTURE_DEPTH_ALLOWANCE } from "./depth.js"
import { type ParseOptions, parseInput } from "./index.js"

/** Exact UTF-8 size of a JS string, without allocating the encoded bytes. */
export function utf8ByteLength(text: string): number {
  let bytes = 0
  for (let i = 0; i < text.length; i++) {
    const code = text.charCodeAt(i)
    if (code < 0x80) bytes += 1
    else if (code < 0x800) bytes += 2
    else if (
      code >= 0xd800 &&
      code <= 0xdbff &&
      i + 1 < text.length &&
      isLowSurrogate(text.charCodeAt(i + 1))
    ) {
      bytes += 4
      i += 1
    } else bytes += 3 // BMP character, or a lone surrogate (encoded as U+FFFD)
  }
  return bytes
}

const isLowSurrogate = (code: number) => code >= 0xdc00 && code <= 0xdfff

/**
 * True when brackets nest deeper than `limit`. A linear scan that skips string
 * contents: JSON.parse no longer throws on deep nesting, it just builds all of
 * it, so the depth has to be known before parsing.
 */
export function exceedsBracketDepth(text: string, limit: number): boolean {
  let depth = 0
  let inString = false
  for (let i = 0; i < text.length; i++) {
    const code = text.charCodeAt(i)
    if (inString) {
      if (code === 0x5c)
        i += 1 // backslash: skip the escaped character
      else if (code === 0x22) inString = false
    } else if (code === 0x22) inString = true
    else if (code === 0x5b || code === 0x7b) {
      depth += 1
      if (depth > limit) return true
    } else if (code === 0x5d || code === 0x7d) depth -= 1
  }
  return false
}

const maxBracketDepth = (limits: Limits): number => limits.maxMetaDepth + STRUCTURE_DEPTH_ALLOWANCE

/**
 * Parses and validates a document from JSON text. The byte limit is checked
 * before parsing, so an oversized payload is never turned into objects.
 */
export function parseDocumentJson(text: string, options: ParseOptions = {}): AnnotationDocument {
  if (typeof text !== "string") {
    throw new AnnotateError("INVALID_DOCUMENT", "parseDocumentJson needs a string")
  }
  const limits = resolveLimits(options.limits)
  const { maxDocumentBytes } = limits
  const source = text.charCodeAt(0) === 0xfeff ? text.slice(1) : text
  // UTF-16 code units never exceed UTF-8 bytes, so a longer string is certainly too big.
  if (source.length > maxDocumentBytes || utf8ByteLength(source) > maxDocumentBytes) {
    throw new AnnotateError("LIMIT_EXCEEDED", `Document is larger than ${maxDocumentBytes} bytes`)
  }
  if (exceedsBracketDepth(source, maxBracketDepth(limits))) {
    throw new AnnotateError("LIMIT_EXCEEDED", "Document nesting is too deep")
  }
  let parsed: unknown
  try {
    parsed = JSON.parse(source)
  } catch (error) {
    if (error instanceof RangeError) {
      throw new AnnotateError("LIMIT_EXCEEDED", "Document nesting is too deep")
    }
    // Deliberately not echoing the engine's message: it can quote part of the input.
    throw new AnnotateError("INVALID_DOCUMENT", "Document is not valid JSON")
  }
  // Fresh JSON.parse output is plain and shared with nobody: checked, not copied.
  return parseInput(parsed, options, false)
}
