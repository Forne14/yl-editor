# Brief: make `@yl/editor` the shared package

Context for the session that works on this repo. Decided in SOTR's PM-1 grill (2026-11-04), recorded in
`southoftheriver/docs/adr/0013-in-place-editing-with-yl-editor.md`. The source of the code is
`~/Repos/portfolio/packages/editor` as of that date; nothing was changed in the copy.

## Why its own repo

Three apps want it (portfolio on SQLite, skinmenu, SOTR on Postgres). A vendored copy per app drifts and forks the
lifecycle tests; an npm workspace inside portfolio can't be installed on another app's box or CI. So: own public repo,
consumed by git tag, no npm publishing.

## The enhancements SOTR needs, in order

1. **`Access` takes the document.** Today: `canEdit(locals: unknown): boolean` / `canPublish(locals: unknown)`.
   Needed: `canEdit(locals, doc)` / `canPublish(locals, doc)` with `doc: { type: string; key: string }`. One page can
   carry documents from different permission families (SOTR: the hero is `pages.*`, a product is `shop.manage`, a
   show is `radio.manage`), so the host maps document type → permission in one table. Keep `locals` opaque: the
   package never learns the host's user shape.
2. **`ContentStore` becomes async.** Every method returns a `Promise`. The SQLite store is synchronous underneath and
   simply resolves; a Postgres store (`postgres` by porsager) can't be synchronous. Update the lifecycle tests to
   `await`. Consider whether `create` and `writeField` should take an optional `actor` for revision attribution; SOTR's
   activity log wants "who changed what", but it can also be written by the host around the store call. Decide and
   record it in the README.
3. **Export the lifecycle tests as a contract suite.** `src/contract.ts` exports
   `runContentStoreContract(name, makeStore: () => Promise<ContentStore>)` (or similar) that registers the same
   `describe`/`test` blocks the SQLite store runs today, so a host does
   `runContentStoreContract("postgres", () => makePostgresStore(testDb, testRegistry))` in its own test file. The
   SQLite tests in this repo become the first consumer of the contract.
4. **Typed `Access` for the field type.** `editable()` already carries `data-edit-type`. Decide whether the chrome
   (host-side) or the package owns the `EditFieldType → widget` mapping; the package should stay widget-free (SOTR
   mounts TipTap for `richtext`, portfolio uses contenteditable).

## Rules to keep

- No framework code in the package: zod and TypeScript only. Stores are peer concerns.
- Paths refuse `__proto__`, `prototype`, `constructor` and negative or non-integer indices (`path.test.ts`). Any new
  path surface keeps that.
- `editable(undefined)` returns `{}`: anonymous HTML carries no editor attributes. Keep it that way; SOTR tests in e2e
  that visitors get zero editor bytes.
- Descriptive names, no single letters. British English in docs.
- A change that breaks a consumer is a major tag; say so in the tag message.

## Consumers today

| App         | Store              | Branch or ticket that adopts the tag                  |
| ----------- | ------------------ | ----------------------------------------------------- |
| portfolio   | SQLite (shipped)   | replace `packages/editor` with the git dependency     |
| skinmenu    | Supabase/PostgREST | its own store; `editor-capabilities.ts` is its Access |
| SOTR        | Postgres (BO-2)    | `Forne14/sotr#26`, after PM-2 lands the atoms         |
