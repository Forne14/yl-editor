// Field groups: a `[data-edit-group]` wrapper whose plain fields are drawn as one dashed outline.
export interface GroupRecord {
  element: HTMLElement;
  detach?: () => void;
  paint: () => void;
  schedule: () => void;
}

export function scanGroups(_root: HTMLElement): GroupRecord[] {
  throw new Error("not implemented");
}

export function attachGroup(
  _record: GroupRecord,
  _recordOf: (element: HTMLElement) => { editable: boolean } | undefined,
): void {
  throw new Error("not implemented");
}

export interface OutlineWatch {
  schedule(): void;
  check(): void;
  destroy(): void;
}

export function createOutlineWatch(_root: HTMLElement, _active: () => boolean): OutlineWatch {
  throw new Error("not implemented");
}
