// `@yl/editor/chrome`: the in-place editor island. Framework-free and DOM-only; load it for signed-in editors only,
// alongside `@yl/editor/chrome/chrome.css`. See docs/chrome.md.
export { mountEditor } from "./mount.ts";
export { createDefaultWidgets, defaultWidgets, missingWidget, openPopover, type Popover } from "./widgets.ts";
export { createClient, ApiError, type ArrayOperation, type ContentClient } from "./client.ts";
export { defaultStrings, type Strings } from "./strings.ts";
export type { EditableAttrs, EditFieldType } from "../editable.ts";
export type {
  DocumentState,
  DocumentSummary,
  EditorApi,
  EditorHandle,
  EditorOptions,
  ErrorCode,
  FieldInfo,
  Panel,
  StatusKind,
  Widget,
  WidgetContext,
  WidgetHandle,
  WireDocument,
  WireRevision,
} from "./types.ts";
