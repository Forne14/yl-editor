# HTTP: content handlers and client

`@yl/editor/http` puts a `ContentStore` on the network behind an `Access` gate. It has no framework in it: the handlers
take a Web standard `Request` and return a `Response`, so they mount in anything that speaks the Fetch API. The same
module ships a small typed client that speaks the same wire contract.

```ts
import { createContentHandlers } from "@yl/editor/http";

const handlers = createContentHandlers({
  store, // any ContentStore
  registry, // your SchemaRegistry
  access, // your Access: canEdit / canPublish verdicts
  locals: (request) => sessionFor(request), // resolve your session; the package never looks inside it
  actor: (locals) => (locals as Session | null)?.user.email, // recorded on revisions
  onChange: (event) => activityLog.record(event), // optional
});
```

| Option       | Default        | Meaning                                                                         |
| ------------ | -------------- | ------------------------------------------------------------------------------- |
| `store`      | required       | The `ContentStore` to expose.                                                   |
| `registry`   | required       | Used by `create` to turn a type into its collection.                            |
| `access`     | required       | `canEdit` and `canPublish`, called with whatever `locals` returns.              |
| `locals`     | required       | `(request) => session`. May be async.                                           |
| `actor`      | none           | `(locals) => string \| undefined`, passed to the store as `WriteContext.actor`. |
| `base`       | `/api/content` | Path prefix, matched against the request URL's pathname.                        |
| `sameOrigin` | `true`         | Refuse requests whose `Origin` or `Sec-Fetch-Site` shows another site.          |
| `onChange`   | none           | Called after every successful write, after the response (errors are logged).    |
| `publishDue` | none           | `{ authorize(locals) }` enables `POST publish-due`; see below.                  |

`handlers.handle(request)` always resolves. `handlers.routes` lists every route as `"METHOD name"`.

## Wire contract

All bodies are JSON. `{base}` is the configured base.

| Method | Path                        | Body                                     | Success                                        |
| ------ | --------------------------- | ---------------------------------------- | ---------------------------------------------- |
| GET    | `{base}/documents?keys=a,b` | none                                     | `200 { documents: { [key]: summary } }`        |
| GET    | `{base}/document?key=k`     | none                                     | `200 { document }`                             |
| GET    | `{base}/revisions?key=k`    | none                                     | `200 { revisions: [revision] }`                |
| POST   | `{base}/field`              | `{ key, path, value, expectedVersion? }` | `200 { document }`                             |
| POST   | `{base}/array`              | `{ key, path, op, expectedVersion? }`    | `200 { document }`                             |
| POST   | `{base}/publish`            | `{ key, at?, expectedVersion? }`         | `200 { document }`                             |
| POST   | `{base}/unpublish`          | `{ key, expectedVersion? }`              | `200 { document }`                             |
| POST   | `{base}/restore-revision`   | `{ key, revisionId, expectedVersion? }`  | `200 { document }`                             |
| POST   | `{base}/publish-due`        | `{ now? }`                               | `200 { documents: [document] }`                |
| POST   | `{base}/discard`            | `{ key }`                                | `200 { document }` or `200 { document: null }` |
| POST   | `{base}/retire`             | `{ key }`                                | `200 { document }`                             |
| POST   | `{base}/restore`            | `{ key }`                                | `200 { document }`                             |
| POST   | `{base}/rename`             | `{ key, slug }`                          | `200 { document }`                             |
| POST   | `{base}/create`             | `{ type, slug, payload }`                | `201 { document }`                             |

- `op` is `{ kind: "insert", index, value }`, `{ kind: "move", from, to }` or `{ kind: "remove", index }`.
- `document` is the `StoredDocument` as JSON:
  `{ id, key, type, slug, payload, isDraft, publishedAt, draftUpdatedAt, previousSlugs, retiredAt, version, scheduledAt }`.
- `document` reads one document with the same view as `documents` (draft, retired included), whole, payload and all.
  An unknown key is `404 not_found`.
- A `documents` summary is `{ key, type, version, isDraft, draftUpdatedAt, publishedAt, access: { edit, publish } }`.
  Unknown keys are left out. Keys are deduped, and more than 100 distinct keys is a `400 bad_request`. Reads use the draft view and include retired documents, because the editor needs to see
  what it is editing.
- A revision is `{ id, action, slug, payload, actor, createdAt }`.
- `discard` returns `null` when the document had never been published, so discarding its draft removed it.
- `publish` with `at` (an ISO 8601 datetime with `Z` or an offset, such as `2030-01-01T09:00:00+02:00`) does not publish:
  it validates the draft and sets `scheduledAt`, and `publish-due` promotes it later. Anything else in `at` is a
  `400 bad_request`. The change it fires is still `publish`.
- `unpublish` takes a published document back to draft-only without retiring it. The published payload becomes the
  draft unless a draft already exists. A document that was never published is a `409 state`.
- `restore-revision` copies the payload of revision `revisionId` (an `id` from `revisions`) into the draft; the
  published payload is untouched. A revision that does not exist, or belongs to another document, is `404 not_found`.
- `publish-due` publishes every scheduled draft whose `scheduledAt` is at or before `now` (an ISO datetime; default:
  the store's clock) and returns them in the order they were due, possibly `[]`.
- Pass `expectedVersion` on `field`, `array`, `publish`, `unpublish` and `restore-revision` to get optimistic
  concurrency: a stale version is a `conflict`.

The zod schemas for every body and query (`FieldRequestSchema`, `ArrayRequestSchema`, `KeyRequestSchema`,
`PublishRequestSchema`, `UnpublishRequestSchema`, `RestoreRevisionRequestSchema`, `PublishDueRequestSchema`,
`RenameRequestSchema`, `CreateRequestSchema`, `DocumentsQuerySchema`, `DocumentQuerySchema`, `RevisionsQuerySchema`)
and the `WireDocument`, `DocumentSummary`, `WireRevision`, `WireArrayOp`, `PublishDueResponse` and `ErrorEnvelope`
types are exported, so a client of your own can share them.

Inside the package the contract is split in two. `wire-types.ts` holds the types, the header constants, the
code-to-status map and the `isErrorEnvelope` guard, and imports nothing. `wire.ts` holds the zod schemas and re-exports
everything from `wire-types.ts`. The client imports only `wire-types.ts`, so a browser bundle that uses it carries
neither zod nor the core; a test checks this. `WireDocument` and `WireArrayOp` mirror `StoredDocument` and `ArrayOp`,
and a compile-time check in `wire.ts` fails the build if they drift apart.

## Gating

| Route                                                 | Verdict                | Document the verdict is about                                   |
| ----------------------------------------------------- | ---------------------- | --------------------------------------------------------------- |
| `documents`                                           | none to list           | Each listed document; `access.edit` and `access.publish` report |
| `document`, `revisions`                               | `canEdit`              | The stored row                                                  |
| `field`, `array`, `discard`, `restore-revision`       | `canEdit`              | The stored row                                                  |
| `publish`, `unpublish`, `retire`, `restore`, `rename` | `canPublish`           | The stored row                                                  |
| `create`                                              | `canEdit`              | `{ type, key: "<collection>/<slug>" }` from the body            |
| `publish-due`                                         | `publishDue.authorize` | None: it acts on whatever is due                                |

The stored row is read with `{ draft: true, includeRetired: true }`, so its `type` comes from the database rather than
from the request. A key that does not exist is `404` before any verdict is asked for. `create` looks its type up in the
registry and answers `422 validation` "Unknown document type" when it is not there.

`documents` lists a document the actor cannot edit, with `access.edit: false`, so an editing interface can show it
greyed out instead of pretending it is absent. When a verdict denies, its `reason` becomes the error `message`.

`restore-revision` needs only `canEdit` because it writes the draft, never the published payload. Scheduling with
`publish { at }` needs `canPublish`, like publishing now.

### `publish-due` and its `authorize` option

`publish-due` publishes across every document at once, so there is no stored row to ask `canPublish` about. It is off
unless the host passes `publishDue`:

```ts
createContentHandlers({
  // ...
  publishDue: {
    // (locals: unknown) => AccessVerdict | Promise<AccessVerdict>
    authorize: (locals) =>
      (locals as Session | null)?.isCron ? { allowed: true } : { allowed: false, reason: "Cron only" },
  },
});
```

Without the option every call is `403 forbidden` ("publish-due is not enabled"), before the body is read. With it,
`authorize` gets whatever `locals` returned; a denying verdict is `403` with its reason. A scheduler that already has a
store at hand can call `store.publishDue()` directly instead and skip HTTP.

## The CSRF and same-origin guard

Hosts usually authenticate these routes with a session cookie, and a browser attaches cookies to any request to your
origin, including one a hostile page triggers. Two checks stop that:

1. **Every request must carry `X-Requested-With: yl-editor`.** An HTML form cannot set a custom header, and `fetch`
   from another origin cannot set one without the browser first sending a CORS preflight, which these handlers never
   approve. A request without the header is refused `403 forbidden`.
2. **With `sameOrigin` on (the default)**, a request whose `Sec-Fetch-Site` is `cross-site`, or whose `Origin` differs
   from the request URL's origin, is refused `403 forbidden`. This is a second line in case a CORS policy elsewhere in
   the host is looser than it should be.

The `Origin` check compares against `new URL(request.url).origin`. Behind a proxy that rewrites the host or the scheme,
make sure the `Request` your framework hands over carries the public URL, or turn `sameOrigin` off and rely on the
header and your proxy. Clients that are not browsers simply send the header.

Route and method are checked first, so an unknown path is `404` and a wrong method is `405` regardless of headers.

## Errors

Every failure has the same shape:

```json
{ "error": { "code": "conflict", "message": "…", "issues": [], "current": {} } }
```

| Code          | Status | When                                                                         |
| ------------- | ------ | ---------------------------------------------------------------------------- |
| `forbidden`   | 403    | Missing header, cross-site request, or a denying verdict (reason in message) |
| `not_found`   | 404    | Unknown key, or unknown route                                                |
| `conflict`    | 409    | Stale `expectedVersion`; `current` holds the document as it is now           |
| `validation`  | 422    | The payload fails its schema, or `create` names an unknown type; `issues`    |
| `path`        | 400    | A path the store cannot follow                                               |
| `state`       | 409    | A lifecycle step that does not apply, such as retiring a retired document    |
| `slug`        | 400    | A slug that is not lower-case words joined by hyphens                        |
| `bad_request` | 400    | Body that is not JSON, or fails the request schema (`issues`); 405 on method |
| `internal`    | 500    | Anything else. The message is always "Internal error"                        |

A wrong method answers `405` with an `Allow` header and code `bad_request`. An unexpected error is logged with
`console.error` and never reaches the response, so a database message cannot leak a path or a query.

`current` on a conflict is the draft view of the document, so the client can offer to take the other person's version
or to reapply its own change on top with the new `version`.

## `onChange`: the activity-log seam

After every successful write the handlers call `onChange` with:

```ts
{ action: "create" | "field" | "array" | "publish" | "unpublish" | "discard" | "retire" | "restore" | "rename"
    | "restore_revision";
  key: string; document: StoredDocument | null; actor?: string }
```

`key` is the key the request named (for `rename`, the old key; `document.key` is the new one). `publish` with `at`
fires `publish` with the scheduled draft, and `publish-due` fires one `publish` per document it published. Reads never fire it,
and neither do refused or failed writes. It runs after the response is built and is not awaited on the response path; its errors are logged with
`console.error`, not returned. The write's response is unchanged: the change has already happened, and a broken activity log must not tell the editor it
failed.

## Mounting

The handlers own everything under `base`, so mount them on a catch-all route at that prefix.

Astro, in `src/pages/api/content/[...route].ts`:

```ts
import type { APIRoute } from "astro";
import { handlers } from "../../../lib/content-handlers";

export const prerender = false;
export const ALL: APIRoute = ({ request }) => handlers.handle(request);
```

Astro resolves the session in middleware and puts it on `context.locals`, which the handlers cannot see from the
`Request` alone. Either keep it in a `WeakMap<Request, …>` from the middleware, as the SvelteKit sketch below does, or
build the handlers inside the route with `locals: () => context.locals`; construction is cheap.

SvelteKit, in `src/hooks.server.ts`:

```ts
import type { Handle } from "@sveltejs/kit";
import { createContentHandlers } from "@yl/editor/http";

const sessions = new WeakMap<Request, App.Locals>();
const handlers = createContentHandlers({ store, registry, access, locals: (request) => sessions.get(request) });

export const handle: Handle = async ({ event, resolve }) => {
  if (event.url.pathname.startsWith("/api/content/")) {
    sessions.set(event.request, event.locals);
    return handlers.handle(event.request);
  }
  return resolve(event);
};
```

Anything else that hands you a `Request` works the same way: a Node server through an adapter, Bun, Deno, or a worker.

## Client

```ts
import { createContentClient, ContentRequestError } from "@yl/editor/http";

const content = createContentClient(); // base "/api/content", global fetch

const summaries = await content.documents(["pages/home", "pages/about"]);
try {
  await content.field("pages/home", "hero.title", "Hello", summaries["pages/home"]?.version);
} catch (error) {
  if (error instanceof ContentRequestError && error.code === "conflict") showTheirs(error.current);
  else throw error;
}
```

| Method                                          | Returns                        |
| ----------------------------------------------- | ------------------------------ |
| `documents(keys)`                               | `Record<key, DocumentSummary>` |
| `document(key)`                                 | `WireDocument`                 |
| `field(key, path, value, expectedVersion?)`     | `WireDocument`                 |
| `array(key, path, op, expectedVersion?)`        | `WireDocument`                 |
| `publish(key, { at? }?)`                        | `WireDocument`                 |
| `unpublish(key)`, `retire(key)`, `restore(key)` | `WireDocument`                 |
| `restoreRevision(key, revisionId)`              | `WireDocument`                 |
| `publishDue(now?)`                              | `WireDocument[]`               |
| `discard(key)`                                  | `WireDocument \| null`         |
| `rename(key, slug)`                             | `WireDocument`                 |
| `revisions(key)`                                | `WireRevision[]`               |
| `create(type, slug, payload)`                   | `WireDocument`                 |

The client sends `X-Requested-With: yl-editor` and `credentials: "same-origin"` on every request. Any non-2xx response
throws a `ContentRequestError` with `status`, `code`, `message`, and `issues` or `current` when the server sent them; a
response that is not an error envelope (a proxy's 502 page, say) throws with code `internal`. `documents([])` returns
`{}` without a request.

Options are `base` (an absolute URL works, for use outside a browser) and `fetch`, which lets you add headers, run it
in tests, or point it straight at the handlers:

```ts
const client = createContentClient({
  base: "http://localhost/api/content",
  fetch: (input, init) => handlers.handle(new Request(input, init)),
});
```
