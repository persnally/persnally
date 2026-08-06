# Contributing to Persnally

Thanks for your interest! Persnally is source-available and contributions are welcome.

## Getting started

### Prerequisites

- Node.js >= 20
- (Optional) [Ollama](https://ollama.com) or an Anthropic API key — only if you're working on extraction/synthesis (imports run fully local with Ollama, or via your own key).

### Local development

```bash
git clone https://github.com/persnally/persnally.git
cd persnally/persnallyd
npm install
npm run build
npm run lint       # ESLint (typescript-eslint + eslint-plugin-security)
npm test           # node:test unit suite + protocol e2e
```

Run the daemon locally:

```bash
node build/src/cli.js setup
```

The marketing site lives in `web/` (Next.js):

```bash
cd web && npm install && npm run dev
```

## Project structure

```
persnallyd/   # the product + the published npm package (`persnally`):
              #   SQLite event store, extractors, importers, daemon, dashboard, MCP adapter
web/          # marketing site (Next.js -> Vercel)
docs/         # EVENT_SCHEMA.md, ARCHITECTURE.md, CONTEXT_DEPTH.md
experiments/  # Phase-0 validation scripts (standalone)
```

## Submitting code

1. Fork and branch from `dev` — that's the default branch and where every PR targets, `main` is not. If you're stacking a PR on another still-open one, open it against `dev` anyway rather than the other branch's head; a stacked PR can silently merge into its parent branch instead of `dev` if the merge order doesn't go the way you expect, and the change never actually ships. Verify a merge landed by checking the file content on `dev`, not the PR's "Merged" badge.
2. Make focused changes — one feature or fix per PR.
3. Verify locally before pushing: `cd persnallyd && npm run lint && npm run build && npm test` (strict `tsc --noEmit`, ESLint, and the full suite incl. the MCP protocol e2e must all be clean).
4. Open a PR with a clear description: what changed, why, how it was verified, known risks.
5. `dev` requires passing status checks before merge — persnallyd (lint + type check + build + test), the install smoke matrix, CodeQL, Dependency Review, gitleaks, and an `npm audit` gate all run on every PR. A red check means something real; don't merge past it.

### Security & data hygiene

- Never commit secrets, API keys, or tokens — GitHub's secret scanning and push protection are on, and gitleaks scans every PR as a second layer.
- If you add a dependency, Dependency Review will block a known-vulnerable or copyleft-licensed one automatically — expect that, don't route around it.
- `PIVOT.md` and `launch/` are internal strategy docs and must stay gitignored — a CI check fails the build if either is re-tracked (this repo had to scrub them from history once already).
- If you find a security issue, follow `SECURITY.md` — don't open a public issue for it.

## Code style (TypeScript)

- Strict mode; no `any` unless unavoidable; explicit return types on public functions.
- Small, single-responsibility functions; obvious data flow.
- Comments only where code can't speak — a constraint, an invariant, a non-obvious *why*. Never narrate what the code does.
- Errors handled deliberately — no silent `catch`.

The bar: minimal and simple over clever, prod-ready from the first commit, deliberate error handling (no silent swallowing), and a clean `npm test` + strict `tsc --noEmit` before every PR.

## Reporting bugs / requesting features

Open an issue using the **Bug Report** or **Feature Request** template.

## Questions?

Open a GitHub discussion or an issue — happy to help you get started.
