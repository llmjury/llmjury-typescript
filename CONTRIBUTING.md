# Contributing to the LLMJury TypeScript SDK

Thanks for your interest in improving the SDK! This guide covers local setup, the quality bar,
and the one rule that is different from most projects: the frozen bucketing contract.

## Development setup

```bash
git clone https://github.com/llmjury/llmjury-typescript.git
cd llmjury-typescript
npm ci
```

## Running checks

```bash
npm run lint          # eslint
npm run format:check  # prettier
npm run typecheck     # tsc, no emit
npm test              # vitest
npm run build         # dual ESM + CJS build
```

All must pass; CI runs them on Node 18, 20, and 22.

## The frozen bucketing contract

`src/bucketing.ts` implements the frozen, cross-language assignment algorithm described in
[`spec/bucketing.md`](spec/bucketing.md). The Python, TypeScript, and Java SDKs must return the
**same variant for the same input, bit for bit** — that determinism is a core product guarantee.

- Do **not** change anything in `bucketing.ts` or `spec/` in a regular PR. Any behavioral change
  there is a breaking contract change and is coordinated across all SDKs and the backend by the
  maintainers.
- `test/determinism.test.ts` asserts every case in `spec/fixtures/bucketing-cases.json`. If your
  change breaks it, the change is wrong — not the fixture.

## SDK design rules

These invariants hold everywhere in the SDK; PRs that violate them will be asked to change:

1. **Never block the host app.** `assign` is pure local compute; `track` only appends to a buffer.
2. **Never throw into the host app.** Network and I/O failures are logged and swallowed; the
   in-code `default` on `getPrompt` must always work.
3. **Zero runtime dependencies.** The default transport is the runtime `fetch`; the SDK stays
   browser-safe (no hard `process` / `node:` assumptions outside the Node-only offline store).
4. **No real network in tests.** Use the in-process transports in `test/doubles.ts`.

## Submitting changes

1. Fork and create a topic branch.
2. Add or update tests for anything you change.
3. Keep the public API backwards-compatible; deprecate before removing.
4. Update `CHANGELOG.md` under an `Unreleased` heading.
5. Open a PR with a clear description of the motivation and behavior change.

For anything non-trivial, open an issue first so we can agree on the approach before you invest
time in the code.

## Reporting issues

- Bugs and feature requests: [GitHub issues](https://github.com/llmjury/llmjury-typescript/issues)
- Security vulnerabilities: see [SECURITY.md](SECURITY.md) — please do not open public issues.
