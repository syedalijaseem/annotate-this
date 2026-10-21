# Contributing

## Setup

Requires Node 22+ and pnpm (`corepack enable` picks the pinned version).

```sh
pnpm install
pnpm check   # lint, format, typecheck, tests, build, package and size checks, licenses
```

## Workflow

- Work on a branch per change; open a pull request; do not push to `main`.
- Use conventional commits: `feat:`, `fix:`, `refactor:`, `docs:`, `test:`,
  `chore:`, `perf:`, `ci:`.
- Write the test first. New code needs tests; the minimum coverage is 80%.
- Add a changeset (`pnpm changeset`) for any change that affects a published
  package.
- Never commit secrets, tokens or credentials.

## Code standards

- TypeScript strict mode; prefer immutable updates over mutation.
- The core package must not use DOM APIs (it has no DOM types on purpose).
- No `console` calls in shipped code; report failures as typed errors.
- Keep files focused (under about 800 lines) and functions small.
