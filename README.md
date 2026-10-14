# x-buddy

Standalone foundation for the approved x-buddy project. Requires Node.js 22.13+ or 24+ and npm (the tooling excludes the unsupported Node 23 series). This bootstrap provides build, validation and governance only; no messaging adapter, App Server integration, session storage, scheduler or product CLI is implemented.

```sh
npm ci
npm run check
```

Individual gates: `npm run typecheck`, `npm run lint`, `npm test`, `npm run build`, `npm run pack-smoke`, `npm run check:imports`, and `npm run check:security`. Pack smoke installs a local tarball in a temporary directory and imports its public ESM entry. It does not publish anything.

See [requirements](docs/requirements.md), [selective imports](docs/import-manifest.json), [DEV-01 reference](docs/dev01-reference.md), [contributing](CONTRIBUTING.md) and [security](SECURITY.md). Licensed under Apache-2.0.
