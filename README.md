# annotate-this

A framework-agnostic image and video annotation library: a headless TypeScript
core, a canvas renderer, thin adapters for React, Vue and Angular, and an
optional themeable UI. Collaboration, storage and dataset management are
deliberately out of scope; the library exposes the hooks apps need to build them.

Status: **in development**. `annotate-this-core` (document model, validation and
the pure operations engine `apply`) is being built; the store, renderer, adapters
and UI are not written yet. Design records live in [docs/adr](docs/adr).
