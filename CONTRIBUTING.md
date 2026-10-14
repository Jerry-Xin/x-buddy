# Contributing

Use a contributor fork and a focused branch. Run `npm ci` and `npm run check` before opening a draft pull request against `Jerry-Xin/x-buddy:main`. Include the tracking issue, exact head SHA, scope, validation and remaining gaps. Never commit credentials or environment files.

Each runtime feature needs its own approved requirements and tests. Preserve source licenses and record every selected external asset in `docs/import-manifest.json` with its exact commit and SHA-256. Do not copy repository history or bulk-import the prototype.

Use Conventional Commits (`feat`, `fix`, `docs`, `test`, `build`, `ci`, `chore`). Maintain `CHANGELOG.md` with an Unreleased section and Keep a Changelog categories. Use semantic versioning after explicit release approval. Version changes, tags, publication and deployment require a separate release decision; no automated release workflow is configured.

Maintainers require an independent review and validation at the same head before merging. Repository settings such as branch protection and required checks are owner-managed; these files do not claim those settings have been configured.
