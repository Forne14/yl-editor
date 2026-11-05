import type { EditFieldType } from "../editable.ts";
import { type Strings } from "./strings.ts";
import type { Widget } from "./types.ts";
export interface Popover {
    root: HTMLElement;
    close(): void;
}
/**
 * A small dialog anchored under a field, themed by `.cms-root` so it picks up the tokens wherever it is appended.
 * Under 40em the stylesheet turns it into a bottom sheet. Exported so host widgets can reuse it.
 */
export declare function openPopover(anchor: HTMLElement, label: string, onLeave?: () => void): Popover;
/** Shown in place of an editor when nothing is registered for a type. It never throws. */
export declare function missingWidget(strings: Strings, type: string): Widget;
export declare function createDefaultWidgets(strings?: Strings): Record<EditFieldType, Widget>;
export declare const defaultWidgets: Record<EditFieldType, Widget>;
//# sourceMappingURL=widgets.d.ts.map