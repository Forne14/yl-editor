import type { FieldInfo } from "./types.ts";
export interface FieldRecord {
    element: HTMLElement;
    info: FieldInfo;
    /** `<key>:<path>`, the save slot id. */
    id: string;
    editable: boolean;
    reason?: string;
    description: HTMLElement;
    detach?: () => void;
}
export declare function parseField(target: HTMLElement): FieldInfo | null;
/** Every `[data-edit-field]` under `root`, outside the chrome's own surfaces. */
export declare function scanFields(root: HTMLElement): FieldRecord[];
export declare function groupByDocument(records: readonly FieldRecord[]): Map<string, FieldRecord[]>;
export declare function badgeText(record: FieldRecord): string;
/** Adds the highlight. `hint` is read to assistive technology after the field's own content. */
export declare function attach(record: FieldRecord, hint: string): void;
export declare function showState(record: FieldRecord, state: string): void;
/** One floating badge, moved to whichever field is hovered or focused. Positioned through custom properties. */
export declare class Badge {
    readonly node: HTMLDivElement;
    show(record: FieldRecord): void;
    hide(): void;
}
//# sourceMappingURL=fields.d.ts.map