# annotate-this-core

DOM-free core of [annotate-this](https://github.com/syedalijaseem/annotate-this):
the document model (validation, creation, limits) and the pure operations
engine `apply`. The store, undo stack and tools are not written yet. Work in
progress.

## Validating untrusted documents

`parseDocument` and `parseDocumentJson` are synchronous and run on the calling
thread. They are bounded by configurable limits (document bytes, annotation
count, vertices, nesting depth, list lengths). A maximum-size document is not
instant: `parseDocumentJson` on 50,000 boxes (about 12 MB of JSON) took about
1 s on a current laptop. On a server, or for large documents in a browser, call
them from a worker or a request queue so validation cannot block your event
loop. Tighten `limits` for input you do not trust.

## Applying operations

`apply(doc, batch, options)` is pure: it never mutates its input and returns a
new document, the change set and the inverse operations (undo).

- `doc` must come from `parseDocument`, `parseDocumentJson`, `createDocument`
  or an earlier `apply`. `apply` does not re-validate the whole document it is
  given; it validates the batch and what the batch changes.
- Returned documents and inverse operations must not be mutated. They share
  structure with earlier documents (inverses may hold the very objects of the
  previous document), and `apply` caches document sizes by identity. Copy a
  document (for example with `structuredClone`) before editing it by hand.
