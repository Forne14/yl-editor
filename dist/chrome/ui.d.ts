import type { Strings } from "./strings.ts";
import type { StatusKind } from "./types.ts";
export interface ToastAction {
    label: string;
    onClick: () => void;
    variant?: "primary" | "danger" | "ghost";
}
export declare class Toast {
    private readonly live;
    private readonly strings;
    readonly node: HTMLElement;
    private timer;
    constructor(live: HTMLElement, strings: Strings);
    /** Replaces whatever toast is showing. Info and saved toasts without actions hide themselves. */
    show(message: string, kind?: StatusKind, actions?: readonly ToastAction[]): void;
    announce(message: string): void;
    hide(): void;
    clearTimer(): void;
}
export declare class Sheet {
    readonly node: HTMLElement;
    private readonly title;
    private readonly body;
    private teardown;
    private opener;
    constructor(strings: Strings);
    get isOpen(): boolean;
    /** Opens with fresh content. `build` may return a teardown, run when the sheet closes or is replaced. */
    open(title: string, build: (body: HTMLElement) => (() => void) | void, opener?: HTMLElement): void;
    close(returnFocus?: boolean): void;
}
//# sourceMappingURL=ui.d.ts.map