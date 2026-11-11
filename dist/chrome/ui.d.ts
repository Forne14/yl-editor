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
    private announceTimer;
    private shown;
    constructor(live: HTMLElement, strings: Strings);
    /**
     * Replaces whatever toast is showing. Info and saved toasts without actions hide themselves. Returns a token for
     * `hideIf`.
     */
    show(message: string, kind?: StatusKind, actions?: readonly ToastAction[]): number;
    /** Hides the toast `show` returned `token` for, if it is still the one showing. */
    hideIf(token: number): void;
    /** Whether an error toast is showing: it stays until dismissed or resolved, so nothing should replace it. */
    get showingError(): boolean;
    /** Puts `message` in the live region. The same message again is announced again. */
    announce(message: string): void;
    /** Drops a repeated message still waiting to go back in the live region. */
    cancelAnnounce(): void;
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