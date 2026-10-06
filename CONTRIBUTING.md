# Contributing to Junior

Small, focused contributions are welcome. Open an issue for substantial behavior or architecture changes before implementing them. Explain the deliverable, acceptance criteria, and how the change preserves existing capabilities.

## Development

Use Node.js 24+ and npm. Clone the repository, run `npm ci`, then `npm test`. Tests build the package first and use mocks; they should not need API keys or paid calls. `npm run build` transpiles TypeScript; it is not a type check. Run `node scripts/smoke-installed.mjs` to verify the packed CLI. Worker process cancellation tests require Linux; use Ubuntu WSL on Windows.

Do not weaken acceptance checks. Tests should have an atomic scenario, a declarative name, and one behavioral assertion against a public outcome. Preserve deadline, cancellation, isolation, and recoverable handback behavior. New provider calls must remain opt-in in tests.

## Pull requests

Describe the problem, resulting behavior, and validation. Update the README or skill when contracts or user-facing commands change. Keep generated dist files, credentials, local artifacts, and provider transcripts out of commits. AI-assisted contributions are welcome; the contributor remains responsible for reviewing the complete change and its evidence. No automatic worker acceptance or merge is implied.

Contributions are provided under the project's MIT license. Be respectful, address technical disagreements with evidence, and avoid personal attacks. Maintainers may close abusive or out-of-scope contributions.
