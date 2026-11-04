type Attributes = Record<string, string | boolean | undefined>;
type Child = Node | string | null | undefined | false;
export declare function element<Tag extends keyof HTMLElementTagNameMap>(tag: Tag, attributes?: Attributes, children?: readonly Child[]): HTMLElementTagNameMap[Tag];
export declare function button(label: string, onClick: (event: MouseEvent) => void, variant?: "primary" | "danger" | "ghost", attributes?: Attributes): HTMLButtonElement;
/** Collects teardown callbacks so `destroy()` can prove it removed every listener it added. */
export declare class Disposer {
    private readonly callbacks;
    listen<Target extends EventTarget>(target: Target, type: string, handler: (event: Event) => void, options?: AddEventListenerOptions): void;
    add(callback: () => void): void;
    dispose(): void;
}
export declare function uniqueId(prefix: string): string;
/** Reads a value at a dotted path, own properties only, so a key like `__proto__` never walks the prototype. */
export declare function valueAtPath(root: unknown, path: string): unknown;
export {};
//# sourceMappingURL=dom.d.ts.map