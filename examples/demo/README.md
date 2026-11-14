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
fields, for multi-document publish and discard. `pages/team` is a keyed list (max 4, Duplicate on),
rendered only with `&lists=1` so the specs that walk the whole page are unaffected. `settings/site` has the footer, a type only `owner` may edit. Visitors
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

## Timeouts

Tests use Playwright's default 30s timeout, which leaves CI plenty of headroom. On a machine busy with other work,
raise it for a local run rather than in the specs, so a hung test still fails at 30s in CI:

```sh
npm run test:e2e -- --timeout=60000
```

## Firefox workers

The Firefox project runs on at most 2 workers (#24). With Playwright 1.65.0, Firefox's content process segfaults
when several Firefox workers start together on a loaded machine. It shows as `Page crashed` or `Target crashed`,
usually during an axe check, and a rerun passes. Every crash report from macOS is the same null write inside the
browser, so it is a browser bug there, not a chrome one.

Local runs default to half the cores, so the cap lowers the load there. CI already runs 2 workers in total, so the cap
changes nothing on CI. There the crash is rare: 2 in about 70 full suites, and none in 8 full suites plus about 12
suites' worth of Firefox-only axe checks run to reproduce it, so it could not be traced further (#24). If a CI job
fails this way, check that it is a crash, not an assertion failure, before rerunning it, and open an issue if it
starts turning up often. Locally, rerun the spec on its own
(`--project=firefox --workers=1`) rather than adding retries. Retest after a Playwright upgrade and drop the cap once
the crash is gone.
