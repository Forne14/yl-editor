# Paths

```ts
function parsePath(path: string): Segment[];
function formatPath(segments: readonly Segment[]): string;
function getAt(root: unknown, path: Segment[]): unknown;
function setAt<T>(root: T, path: Segment[], value: unknown): T;
function applyArrayOp<T>(root: T, path: Segment[], op: ArrayOp): T;
function itemPath(base: string, item: unknown, index: number): string; // src/editable.ts

type Segment = string | number | { key: string };
```

A path addresses one value inside a document's JSON payload. It is what `editable()` writes into `data-edit-field` and what a save sends back to the store.

## Grammar

```text
path     = part *( "." part )
part     = name [ "[_key=" id "]" ]
name     = 1*( any character except "." )    ; all digits => array index
id       = 1*( ALPHA / DIGIT / "_" / "-" )
```

- `hero.title` is `["hero", "title"]`. `items.2.title` is `["items", 2, "title"]`: an all-digit part is an array index.
- `items[_key=abc].title` is `["items", { key: "abc" }, "title"]`: a keyed part yields its name, then a key segment.
- Nesting works: `sections[_key=a].items[_key=b].title`.
- Only one `[_key=...]` per part, and only at its end. `[_key=a]` (no name), `items[_key=a][_key=b]`, `items[_key=a]x`, an empty id or an id outside `[A-Za-z0-9_-]` are rejected.
- `__proto__`, `prototype` and `constructor` are rejected as a name and as a `_key` id.
- Every rejection throws `PathError`.

`formatPath` is the inverse of `parsePath`: `parsePath(formatPath(segments))` deep-equals `segments`, and `formatPath(parsePath(path)) === path` for canonical paths (indices without leading zeros; `items.01` parses to `["items", 1]` and formats back as `items.1`). It throws `PathError` for segment lists the grammar cannot spell: a key segment first or right after another key segment, a name that is empty, all digits or contains `.` or `[_key=`, a forbidden name, or a negative or fractional index.

## Stable keys

Index paths break under concurrent edits: if someone moves `items.0` below `items.2` while you have the page open, your save of `items.2.title` lands on what is now a different item. A key segment names the item instead of its position.

- `getAt` resolves `{ key: id }` to the first element of the current array whose own `_key === id`. It returns `undefined` when the parent is not an array or no element matches. Inherited `_key` properties are ignored.
- `setAt` and `applyArrayOp` resolve key segments the same way, anywhere in the path. A key segment with no matching element throws `PathError` (`No item with _key=<id>`), as does a key segment into a non-array. Inputs are never mutated.
- `setAt` with a key segment as the last segment replaces that whole element.

**`_key` is the host's responsibility.** The editor never generates, checks or rewrites `_key` values; the sqlite store does not add them either. If you want keyed paths, store a `_key` on each array item (unique within its array; duplicates resolve to the first match) and keep it when the item is edited, moved or replaced. Items inserted with an `ArrayOp` should carry their own `_key`.

When rendering list items, build paths with `itemPath`, which picks the keyed form when it can:

```tsx
{
  doc.items.map((item, i) => <h3 {...edit(`${itemPath("items", item, i)}.title`, "text")}>{item.title}</h3>);
}
// item = { _key: "abc", ... } -> "items[_key=abc].title"
// item without a usable _key  -> "items.2.title"
```

`itemPath` returns `base[_key=<id>]` when `item` is an object with an own string `_key` that is a valid id and not a forbidden name, otherwise `base.<index>`.

## Index paths stay valid

Index paths are unchanged and remain the only option for arrays of primitives (`tags.0`) and items without a `_key`. Both forms can be mixed in one path (`sections[_key=a].items.0`).

## Caveats

- `diffPayloads` still emits index paths (`items.2.title`) and compares arrays index by index; it does not use `_key`. See [diff.md](diff.md).
- The `ArrayOp` shape is unchanged: `insert`, `move` and `remove` still take indices inside the target array. Only the path to the array can be keyed.
