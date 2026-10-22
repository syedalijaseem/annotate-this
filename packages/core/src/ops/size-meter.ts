import { AnnotateError } from "../errors.js"
import type { Limits } from "../limits.js"
import type { AnnotationDocument } from "../types.js"
import type { Charge } from "./charge.js"
import { type Size, ZERO, knownSize, measure, minus, plus, rememberSize } from "./doc-size.js"

// Tracks how a batch changes the document's size (Limits.maxDocumentNodes and
// maxDocumentBytes) without re-walking the document: the draft reports every
// entity it replaces. The original's size is measured lazily, the first time
// the document grows, unless an earlier batch already left it known.
export class SizeMeter {
  private delta: Size = ZERO
  private base: Size | undefined

  constructor(
    private readonly original: AnnotationDocument,
    private readonly limits: Limits,
    private readonly charge: Charge,
  ) {
    this.base = knownSize(original)
  }

  // `before` was replaced by `after` (ZERO for an addition or removal).
  change(before: Size, after: Size): void {
    // Measuring walks every value and scans every string (about 8 bytes per unit).
    this.charge(before.nodes + after.nodes + ((before.bytes + after.bytes) >>> 3))
    this.delta = plus(this.delta, minus(after, before))
    if (after.nodes > before.nodes || after.bytes > before.bytes) this.assertFits()
  }

  // A number (a rev) changed in place: only its digits can change the size.
  renumber(before: number, after: number): void {
    const bytes = String(after).length - String(before).length
    if (bytes !== 0) this.change(ZERO, { nodes: 0, bytes })
  }

  // Records the committed document's size for the next batch, when it is known.
  commit(doc: AnnotationDocument): void {
    if (this.base) rememberSize(doc, plus(this.base, this.delta))
  }

  private assertFits(): void {
    if (!this.base) {
      this.base = measure(this.original)
      this.charge(this.base.nodes)
      rememberSize(this.original, this.base)
    }
    const { nodes, bytes } = plus(this.base, this.delta)
    const { maxDocumentNodes, maxDocumentBytes } = this.limits
    if (nodes > maxDocumentNodes) {
      throw new AnnotateError(
        "LIMIT_EXCEEDED",
        `More than ${maxDocumentNodes} values in the document`,
      )
    }
    if (bytes > maxDocumentBytes) {
      throw new AnnotateError(
        "LIMIT_EXCEEDED",
        `The document would be larger than ${maxDocumentBytes} bytes`,
      )
    }
  }
}
