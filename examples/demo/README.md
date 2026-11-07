# Demo site

A small server-rendered page that uses the package the way a host would: the real SQLite store, content handlers and
document access, imported as `@yl/editor/*` (so they resolve to `dist/`), and the built chrome served from `dist/`
under a strict Content Security Policy. The Playwright specs in `e2e/` run against it. It is not part of the published
package.

## Run it

```sh
npm run build
DEMO_TEST_HOOKS=1 node examples/demo/server.ts   # PORT defaults to 4317
```

Open <http://127.0.0.1:4317/> for the visitor page, then <http://127.0.0.1:4317/__test/sign-in?role=editor> to sign
in and open the editor (`/?edit=1`; add `&scheduling=1` for "Publish at"). Roles: `anonymous`, `contributor` (edits
pages, can't publish), `editor` (edits and publishes pages), `owner` (everything, including the `settings/site`
footer that is locked for the others) and `cron` (may only run `POST /api/content/publish-due`). Rebuild after changing
`src/`; the server reads `dist/` on each request, so a reload picks up the new build.

## What's on the page

`pages/home` covers text, richtext, toggle, select, number, tags, date and url fields. `pages/about` has two text
fields, for multi-document publish and discard. `settings/site` has the footer, a type only `owner` may edit. Visitors
see the published versions and no `data-edit-*` attributes, script or stylesheet; editors see drafts.

## Tenants

Each `demo-tenant` cookie value gets its own in-memory database, created with the default seed on first use. Without
the cookie you are on `default`. Restarting the server forgets everything.

## Test hooks

Only with `DEMO_TEST_HOOKS=1`, and the server listens on 127.0.0.1 only. They act on the request's tenant. Use them
through `e2e/fixtures.ts` rather than directly.

| Route                       | Does                                                                       |
| --------------------------- | -------------------------------------------------------------------------- |
| `POST /__test/reset`        | `{ empty? }`: the default seed again, or an empty database                 |
| `POST /__test/drop`         | Forgets the tenant                                                         |
| `POST /__test/role`         | `{ role }`: sets the `demo-role` cookie                                    |
| `GET /__test/sign-in?role=` | Same, then redirects to `/?edit=1`                                         |
| `GET /__test/whoami`        | `{ tenant, role }`                                                         |
| `POST /__test/seed`         | `{ documents: [...] }`: raw SQL upsert, payloads as stored text, no checks |
| `POST /__test/delete`       | `{ keys }`                                                                 |
| `GET /__test/doc?key=`      | The row as stored, with its revisions; `404` when absent                   |
| `GET /__test/csp-reports`   | CSP violation reports sent to `/__csp-report` for this tenant              |
| `GET /__test/changes`       | Successful writes seen by the handlers' `onChange`                         |
| `POST /__test/clock`        | `{ now }`: fixes the store clock (ISO), or `null` for real time            |
| `GET /__test/csp-violation` | A page with an inline `style` attribute, for the guard's own test          |
| `GET /__test/console-error` | A page that logs a console error and throws, for the guard's own test      |
