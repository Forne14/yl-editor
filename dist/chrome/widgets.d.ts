import type { EditFieldType } from "../editable.ts";
import { type Strings } from "./strings.ts";
import type { Widget, WidgetContext } from "./types.ts";
export interface Popover {
    root: HTMLElement;
    close(): void;
}
/**
 * A small dialog anchored under a field, themed by `.cms-root` so it picks up the tokens wherever it is appended.
 * Under 40em the stylesheet turns it into a bottom sheet. Exported so host widgets can reuse it.
 *
 * `onLeave` fires at most once per popover, when the editor leaves it: a completed primary press or tap outside the
 * popover and `anchor`, or focus moving out of the popover. A press that opens a context menu isn't leaving. Anything
 * of the host's outside the popover's own element counts as outside, including a dropdown it appends to `body`. It
 * never fires after `close()`. Presses inside the popover are left to the browser.
 */
export declare function openPopover(anchor: HTMLElement, label: string, onLeave?: () => void): Popover;
/** Lets the default widgets show `message` as an info toast for `ctx`. Called by `mountEditor` only. */
export declare function provideStatus(ctx: WidgetContext, show: (message: string) => void): void;
/** Commit-or-cancel bookkeeping every widget needs: only the first outcome counts. */
declare function once(ctx: WidgetContext): {
    commit(next: unknown): void;
    cancel(): void;
};
interface FormWidgetParts {
    control: HTMLElement;
    read(): unknown;
    /** Focus target; defaults to `control`. */
    focusTarget?: HTMLElement;
    /** The control holds something `read` can't represent, such as a half-typed date. */
    unreadable?(): boolean;
    /** Placed right under `control`, such as the line saying why Enter was refused. */
    note?: HTMLElement;
}
/**
 * The shape every popover widget shares: a labelled control in a popover, Esc and Cancel to back out, and
 * leaving the popover commits whatever the control holds (the chrome skips the save when nothing changed).
 * Exported for the tests only; `index.ts` doesn't re-export it.
 */
export declare function formWidget(strings: Strings, build: (ctx: WidgetContext, outcome: ReturnType<typeof once>, finish: () => void) => FormWidgetParts): Widget;
/** Shown in place of an editor when nothing is registered for a type. It never throws. */
export declare function missingWidget(strings: Strings, type: string): Widget;
export declare function createDefaultWidgets(strings?: Strings): Record<EditFieldType, Widget>;
export declare const defaultWidgets: Record<EditFieldType, Widget>;
export {};
//# sourceMappingURL=widgets.d.ts.map