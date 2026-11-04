import { type ArrayOp, type PathSegment } from "./types.ts";
export declare function parsePath(path: string): PathSegment[];
export declare function getAt(root: unknown, path: PathSegment[]): unknown;
export declare function setAt<T>(root: T, path: PathSegment[], value: unknown): T;
export declare function applyArrayOp<T>(root: T, path: PathSegment[], op: ArrayOp): T;
//# sourceMappingURL=path.d.ts.map