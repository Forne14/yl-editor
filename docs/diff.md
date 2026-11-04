# diffPayloads

```ts
function diffPayloads(before: unknown, after: unknown): DiffEntry[];
type DiffEntry = { path: string; kind: "added" | "removed" | "changed"; before?: unknown; after?: unknown };
```

A pure structural diff of two JSON payloads, for a "what changes" step before Publish.

- Paths use the `parsePath` grammar: dot-separated, array indices as numbers (`hero.title`, `items.2.label`). The root path is `""`.
- Objects recurse per key. Order: keys in `after` order, then keys only in `before`.
- Arrays compare index by index (no move detection); extra trailing entries are `added` / `removed`.
- Primitives compare with `===`. `undefined` and missing are the same; `null` is a value.
- A type change (object to string, array to object) is a single `changed` entry at that path.
- Identical inputs return `[]`.

```ts
diffPayloads({ hero: { title: "a" } }, { hero: { title: "b" }, cta: "Go" });
// [
//   { path: "hero.title", kind: "changed", before: "a", after: "b" },
//   { path: "cta", kind: "added", after: "Go" },
// ]
```
