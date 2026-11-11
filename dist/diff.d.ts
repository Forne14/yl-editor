export type DiffEntry = {
    path: string;
    kind: "added" | "removed" | "changed";
    before?: unknown;
    after?: unknown;
};
/**
 * Structural diff of two JSON payloads. Paths use the `parsePath` grammar
 * (`hero.title`, `items.2.label`); the root value itself has path "".
 */
export declare function diffPayloads(before: unknown, after: unknown): DiffEntry[];
//# sourceMappingURL=diff.d.ts.map