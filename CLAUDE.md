# @yl/editor

In-place editing core: draft/publish `ContentStore`, schema registry, path ops, `editable()`, HTTP handlers and browser chrome. Once production ready, sites will consume it as a git tag and bring their own storage. Details are in `docs/`: `store.md`, `http.md`, `chrome.md`, `access.md`, `paths.md`, `diff.md`.

## Commands

- `npm run verify` runs lint, typecheck and unit tests. It must pass before a PR.
- `npm run build` builds `dist/`. CI runs it too.
- `npm run format` applies Prettier.
- `npx vitest run <file>` runs one test file.
- `npm run test:e2e` builds, then runs the Playwright specs in `e2e/` on Chromium, Firefox and WebKit against the demo
  site in `examples/demo/` (see its README). Install browsers once with `npx playwright install`. `verify` stays
  browser-free.
- Node >=24.

## Design changes need a prototype first

Any change to the visual interface or design needs a hi-fidelity prototype in an HTML file first. Keep prototypes in `docs/specs/artefacts/`. Show it to Yassine and get his approval before building. Decide from the rendered page, not from a text description.

## Public surface

- Breaking changes are allowed before 1.0; mark them **Breaking** in the changelog. After 1.0, avoid them. Public means exports, wire shapes, documented attributes such as `data-edit-value`, and `defaultStrings` keys.
- This package has no consumers yet. `~/Repos/portfolio`, `~/Repos/southoftheriver` and `~/Repos/Tego/skinmenu` keep their own editors until this one is production ready, so don't change them or plan work around them here. Read them only as reference. Real-browser testing happens in this repo.
- Every user-visible change goes in `CHANGELOG.md` under `[Unreleased]`. Mark real breaks as **Breaking**. Update the matching doc in `docs/` in the same PR.
- Consumers never edit `node_modules/@yl/editor`. Fixes land here and go back as a new tag.

## Code rules

- `src/http/client.ts` and `src/http/wire-types.ts` must stay free of zod and `src/types.ts` (enforced by `client-isolation.test.ts`). Chrome code ships to the browser too, so don't pull zod into it at runtime.
- `WireDocument` must stay identical to `StoredDocument` (compile-time guard in `src/http/wire.ts`).
- Custom stores must pass the contract suite (`src/contract.ts`). Store behaviour changes go there as well.
- Schema changes are new numbered files in `migrations/`. Never edit a shipped migration. Say in the changelog that it must be applied before upgrading.
- Chrome text goes through `src/chrome/strings.ts` so hosts can override it.
- Hosts run strict CSPs, so chrome output has no inline `style=` attributes or inline scripts. Dynamic positions are set only as CSS custom properties through `style.setProperty` (`fields.ts`, `widgets.ts`), which CSP allows.
- Chrome must meet WCAG 2.2 AA: full keyboard operation and visible focus.
- Chrome tests run in happy-dom, which doesn't prove browser behaviour. Say so when reporting chrome work unless it was run in a real browser.
- Test logic changes. Use descriptive names. Comment only a non-obvious why. Never commit secrets or `.env` files.

## Git and release

- Work is tracked in GitHub issues. Branch from `main` and PR back to `main`. Use `Closes #n` only when the issue is really finished. Commits are `type(scope): summary`.
- CI `verify` is the automated gate. There is no CodeRabbit here: run the `code-review` skill on any PR that changes code before merging, and again after each round of fixes, until a round finds no severe or major issues and at most a few minor ones.
- Release: bump the version and date the changelog in a `chore: release X.Y.Z` commit on `main`, then `npm run release -- vX.Y.Z`, then `git push origin vX.Y.Z`. Branches never track `dist/`; it exists only on the tag.
