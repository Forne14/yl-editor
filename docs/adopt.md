# Prompt: move this app onto `@yl/editor` from its own repo

Paste the block below into a Claude Code session started in the app's repo (portfolio, skinmenu, or any app that still
vendors or workspaces the editor). Fill the two placeholders first.

---

Move this app onto the shared `@yl/editor` package, which now lives in its own public repo at
`github.com/Forne14/yl-editor` and is consumed as a git dependency pinned to a tag. The decision and the reasons are
in `~/Repos/southoftheriver/docs/adr/0013-in-place-editing-with-yl-editor.md`; the package's own brief is
`~/Repos/yl-editor/BRIEF.md`. Read both before changing anything.

Target tag: `<TAG, e.g. v0.2.0>`. This app's store: `<SQLite shipped by the package | our own store on <database>>`.

Do, in this order, on a branch off the default branch:

1. Find every way this app reaches the editor today: a `packages/editor` workspace, a vendored copy, relative imports,
   path aliases. List them before touching them.
2. Add `"@yl/editor": "github:Forne14/yl-editor#<TAG>"` to `package.json`, remove the workspace entry or vendored copy,
   and point every import at the package (`@yl/editor`, `@yl/editor/sqlite`, `@yl/editor/contract`). Keep the
   lockfile honest: `npm install`, commit the lockfile.
3. Implement the current seams exactly as the tag defines them. In particular `Access.canEdit(locals, doc)` and
   `Access.canPublish(locals, doc)` take the document; map document type to this app's permission model in one place
   (the module that already names roles or capabilities, never a page). `ContentStore` is async: `await` every call.
4. If this app has its own store, run the package's contract suite against it in this app's unit tests
   (`runContentStoreContract(...)` from `@yl/editor/contract`) and make it green. If it uses the shipped SQLite store,
   its tests already run in the package; add one smoke test here that opens the store against this app's database and
   publishes a document.
5. Keep the visitor path clean: `editable(undefined)` outside edit mode, no editor attributes or bytes for anonymous
   visitors. If there is an e2e test for that, keep it green; if there is none, add one.
6. Run this app's full verify gate. Update its CLAUDE.md (dependency table, "how the editor is shared") and amend the
   ADR that introduced the editor here with one status line pointing at the SOTR ADR-0013 decision and the tag.
7. Open a PR. In the body, name the tag, list every seam this app implements, and anything the package should change
   next; those go into `~/Repos/yl-editor/BRIEF.md` as a comment on the PR, not into this app.

Never edit files under `node_modules/@yl/editor`: a fix goes to the package repo and comes back as a new tag.

---
