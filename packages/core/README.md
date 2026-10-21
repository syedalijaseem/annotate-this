# annotate-this-core

DOM-free core of [annotate-this](https://github.com/syedalijaseem/annotate-this):
document model, operations, store, undo and tools. Work in progress.

## Validating untrusted documents

`parseDocument` and `parseDocumentJson` are synchronous and run on the calling
thread. They are bounded by configurable limits (document bytes, annotation
count, vertices, nesting depth, list lengths), and the defaults keep a maximum
size document to well under a second. On a server, or for very large documents
in a browser, call them from a worker or a request queue so validation cannot
block your event loop. Tighten `limits` for input you do not trust.
