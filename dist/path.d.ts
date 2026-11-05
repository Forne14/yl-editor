import { type ArrayOp, type PathSegment } from "./types.ts";
/** A stable-key segment: resolves to the array element whose own `_key` equals `key`. See docs/paths.md. */
export interface KeySegment {
    readonly key: string;
}
/** Any segment the path functions accept: a property name, an array index, or a stable key. */
export type Segment = PathSegment | KeySegment;
/**
 * Parses `a.b.0.c` and `items[_key=abc].title` into segments. A `name[_key=<id>]` part yields the segment
 * for `name` followed by a `{ key: id }` segment. Throws `PathError` on any malformed or forbidden part.
 */
export declare function parsePath(path: string): Segment[];
/**
 * The inverse of `parsePath`: `parsePath(formatPath(s))` deep-equals `s`, and `formatPath(parsePath(p)) === p`
 * for every canonical path (no leading zeros in indices). Throws `PathError` for segment lists the grammar
 * cannot express: a key segment first or right after another key segment, a name that is empty, all digits,
 * or contains `.` or `[_key=`, a forbidden name or `_key`, or a negative or fractional index.
 */
export declare function formatPath(segments: readonly Segment[]): string;
export declare function getAt(root: unknown, path: Segment[]): unknown;
export declare function setAt<T>(root: T, path: Segment[], value: unknown): T;
export declare function applyArrayOp<T>(root: T, path: Segment[], op: ArrayOp): T;
//# sourceMappingURL=path.d.ts.map