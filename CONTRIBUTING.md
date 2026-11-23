# Contributing to Leeboard

Thank you for your interest in contributing to Leeboard!

## Development Setup

Leeboard needs Node 26 or later and git.

```bash
# Clone the repo
git clone https://github.com/zsoltborsos/leeboard.git
cd leeboard

npm ci
npm run build
```

`npm run build` compiles to `dist/`; the CLI is `dist/cli.js`. To try it by hand, run it
against a scratch store, never your real one:

```bash
export LEEBOARD_HOME="$(mktemp -d)"
node dist/cli.js init
node dist/cli.js --help
```

## Running Tests

```bash
# All tests
npm test

# A specific file
npx vitest run test/check.test.ts

# Also the opt-in timing tests
LEEBOARD_PERF=1 npm test
```

Tests must never touch a real store. `test/setup.ts` points `HOME` and `LEEBOARD_HOME`
at a temporary directory and neutralises the global git configuration for every test
file; keep that isolation, and in any test that creates a store, set `LEEBOARD_HOME` to a
temporary directory. The suite uses fake runners and does not call real models or need
provider credentials. See [AGENTS.md](AGENTS.md) for the rules that bind every change.

## Code Style

Leeboard is strict TypeScript (ESM) tested with Vitest. Match the style of the
surrounding code; there is no formatter or linter to run. Before opening a pull request:

```bash
npm run build
npm test
npm run typecheck
```

Two constraints to keep in mind when changing code:

- `brief`, `delta` and `check` are on every agent session's hot path: no network, no
  LLM, no subprocess other than `git`, and well under 200 ms.
- Credential-like text must be rejected before anything is persisted, on every field a
  command writes.

## Branch Naming

- `feature/<short-description>` — new features
- `fix/<short-description>` — bug fixes
- `docs/<short-description>` — documentation only
- `chore/<short-description>` — maintenance, dependency bumps

## Pull Request Conventions

1. Keep PRs focused — one concern per PR.
2. Add or update tests for any code you change. For a bug fix, add a test that fails
   without the fix.
3. Make sure build, tests and type-check pass before requesting review.
4. Update [docs/design.md](docs/design.md) or [README.md](README.md) when behaviour
   changes, and add a line to the top section of
   [CHANGELOG.md](CHANGELOG.md).

## Where to Ask Questions

- Open an issue in this repository's issue tracker for questions, bugs or feature requests.
- Report vulnerabilities privately using [SECURITY.md](SECURITY.md).

## License

By contributing, you agree that your contributions will be licensed under the MIT License.
