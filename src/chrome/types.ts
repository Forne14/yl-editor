import type { EditFieldType } from "../editable.ts";
import type { DocumentResponse, DocumentSummary, ErrorCode, WireDocument, WireRevision } from "../http/wire.ts";
import type { Strings } from "./strings.ts";

// The wire types live with the HTTP contract in src/http; the chrome re-exports them for host widgets and panels.
export type { DocumentResponse, DocumentSummary, EditFieldType, ErrorCode, WireDocument, WireRevision };

/**
 * The chrome's view of one document: the summary, plus the draft payload once it has been fetched (`GET document`)
 * or a write has returned it.
 */
export interface DocumentState {
  key: string;
  type: string;
  version: number;
  isDraft: boolean;
  access: { edit: boolean; publish: boolean };
  /** When the published version went live; null when nothing is published. */
  publishedAt: string | null;
  /** When a scheduled publish is due. Known once the document has been fetched or written; null otherwise. */
  scheduledAt: string | null;
  /** Present once the document body has been fetched or a write or conflict has handed it to us. */
  payload?: unknown;
  /** Whether this session has written to the document. */
  touched: boolean;
  /** Paths written this session. */
  touchedPaths: ReadonlySet<string>;
}

export interface FieldInfo {
  key: string;
  path: string;
  type: EditFieldType;
  options?: string[];
  label?: string;
}

export interface WidgetContext {
  /** The host element carrying `data-edit-field`. */
  element: HTMLElement;
  field: FieldInfo;
  value: unknown;
  /** Hand the new value to the field's save queue. Resolves once the widget may close. */
  commit(next: unknown): Promise<void>;
  /** Abandon the edit; the chrome restores the field and returns focus to it. */
  cancel(): void;
  /** Say something through the polite live region. */
  announce(message: string): void;
}

export interface WidgetHandle {
  destroy(): void;
  focus?(): void;
  /** Commit whatever the widget holds now, as if the user had finished. Called before the chrome tears it down. */
  commit?(): void;
}

export interface Widget {
  mount(ctx: WidgetContext): WidgetHandle;
}

export type StatusKind = "info" | "saving" | "saved" | "error";

export interface EditorApi {
  documents(): ReadonlyMap<string, DocumentState>;
  /** Publishes now, or with `at` (an ISO datetime with offset) schedules the draft. */
  publish(key: string, options?: { at?: string }): Promise<void>;
  discard(key: string): Promise<void>;
  /** Takes the document off the live site; its content stays as a draft. */
  unpublish(key: string): Promise<void>;
  /** Copies a revision's payload into the draft and repaints the page's fields from it. */
  restoreRevision(key: string, revisionId: number): Promise<void>;
  refresh(): Promise<void>;
  status(message: string, kind?: StatusKind): void;
}

export interface Panel {
  id: string;
  label: string;
  mount(root: HTMLElement, api: EditorApi): { destroy(): void };
}

export interface EditorOptions {
  /** Where the content API lives. Default `/api/content`. */
  base?: string;
  /** Element scanned for `[data-edit-field]`. Default `document.body`. */
  root?: HTMLElement;
  widgets?: Partial<Record<EditFieldType, Widget>>;
  panels?: Panel[];
  /** Shown in the bar, e.g. "Editing as Maya (Editor)". */
  actorLabel?: string;
  strings?: Partial<Strings>;
  /** Called when the user presses Done. */
  onExit?: () => void;
}

export interface EditorHandle {
  api: EditorApi;
  /** Resolves once the first `GET documents` has settled and the highlights are attached. */
  ready: Promise<void>;
  destroy(): void;
}
