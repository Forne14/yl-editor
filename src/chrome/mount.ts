// `mountEditor`: wires the scanned fields, the save queue, the bar, the toast and the sheet together.
import { diffPayloads, type DiffEntry } from "../diff.ts";
import { renderRichText } from "../richtext/render.ts";
import { ContentRequestError, createContentClient } from "../http/client.ts";
import type { WireArrayOp } from "../http/wire-types.ts";
import { Disposer, button, element, isItemKey, uniqueId, valueAtPath } from "./dom.ts";
import { Badge, attach, groupByDocument, scanFields, showState, type FieldRecord } from "./fields.ts";
import {
  attachList,
  itemKeyOf,
  itemName,
  newItemKey,
  scanLists,
  storedIndex,
  type ItemAction,
  type ItemRecord,
  type ListRecord,
} from "./lists.ts";
import { ChangesUnavailableError, Session, type Review, type SaveSlot } from "./session.ts";
import { defaultStrings, format, type Strings } from "./strings.ts";
import type {
  DocumentState,
  EditorApi,
  EditorHandle,
  EditorOptions,
  StatusKind,
  Widget,
  WidgetContext,
  WidgetHandle,
  WireDocument,
} from "./types.ts";
import { Sheet, Toast } from "./ui.ts";
import { createDefaultWidgets, missingWidget, provideStatus, provideStrings } from "./widgets.ts";

interface ActiveWidget {
  record: FieldRecord;
  handle: WidgetHandle | undefined;
  closed: boolean;
  slot: SaveSlot;
  /** Marked by a catch-up while it was open: the document adopted then (see `guarded`). */
  theirs?: WireDocument;
}

const TEXT_TYPES = new Set(["text", "richtext"]);

function sameValue(left: unknown, right: unknown): boolean {
  return JSON.stringify(left) === JSON.stringify(right);
}

function isConflict(error: unknown): error is ContentRequestError {
  return error instanceof ContentRequestError && error.code === "conflict";
}

function errorMessage(error: unknown, strings: Strings): string {
  if (error instanceof ContentRequestError) return error.message;
  if (error instanceof ChangesUnavailableError) {
    return error.reason === "moving" ? strings.changesKeptMoving : strings.changesUnreadable;
  }
  // Anything else came from fetch itself: the server could not be reached.
  return strings.networkError;
}

/** A field's `data-edit-value`: parsed as JSON, or the attribute as written when it is not JSON. */
function editValueAttribute(record: FieldRecord): unknown {
  const attribute = record.element.dataset.editValue;
  if (attribute === undefined || (record.cleared && attribute === record.cleared.editValue)) return undefined;
  try {
    return JSON.parse(attribute) as unknown;
  } catch {
    return attribute;
  }
}

/**
 * The starting value of an in-place text edit: the payload's when we have it, else `data-edit-value`, else the text
 * being edited (the element is the editor, so its text is what the editor starts from). Every other type reads the
 * fetched payload.
 */
function textValue(record: FieldRecord, payload: unknown): unknown {
  const fromPayload = payload === undefined ? undefined : valueAtPath(payload, record.info.path);
  if (fromPayload !== undefined) return fromPayload;
  const fromAttribute = editValueAttribute(record);
  return fromAttribute !== undefined ? fromAttribute : (record.element.textContent ?? "").trim();
}

const SHORT_LIMIT = 48;

function short(value: unknown): string {
  const text = typeof value === "string" ? JSON.stringify(value) : (JSON.stringify(value) ?? String(value));
  return text.length > SHORT_LIMIT ? `${text.slice(0, SHORT_LIMIT - 1)}…` : text;
}

function formatTime(iso: string): string {
  const when = new Date(iso);
  return Number.isNaN(when.getTime()) ? iso : when.toLocaleString();
}

function pad(value: number): string {
  return String(value).padStart(2, "0");
}

/** A `Date` as a `datetime-local` value, to the minute. */
function localInputValue(when: Date): string {
  return (
    `${when.getFullYear()}-${pad(when.getMonth() + 1)}-${pad(when.getDate())}` +
    `T${pad(when.getHours())}:${pad(when.getMinutes())}`
  );
}

/** A `datetime-local` value (wall-clock time, no zone) as an ISO string with the browser's offset. */
function localToIso(value: string): string | undefined {
  const when = new Date(value);
  if (value === "" || Number.isNaN(when.getTime())) return undefined;
  const offset = -when.getTimezoneOffset();
  const sign = offset >= 0 ? "+" : "-";
  const zone = `${sign}${pad(Math.floor(Math.abs(offset) / 60))}:${pad(Math.abs(offset) % 60)}`;
  return `${localInputValue(when)}:${pad(when.getSeconds())}${zone}`;
}

/** A document's share of the change count. An unpublish changes a document without changing a field; it still counts. */
function changeCount(state: DocumentState): number {
  return state.touched ? Math.max(state.touchedPaths.size, 1) : 0;
}

export function mountEditor(options: EditorOptions = {}): EditorHandle {
  const strings: Strings = { ...defaultStrings, ...options.strings };
  const base = options.base ?? "/api/content";
  const scanRoot = options.root ?? document.body;
  const widgets: Partial<Record<string, Widget>> = { ...createDefaultWidgets(strings), ...options.widgets };
  const client = createContentClient({ base });
  const disposer = new Disposer();

  const live = element("div", { class: "cms-live", role: "status", "aria-live": "polite" });
  const descriptions = element("div", { class: "cms-visually-hidden" });
  const toast = new Toast(live, strings);
  const sheet = new Sheet(strings);
  const badge = new Badge();
  const stateLine = element("b", { class: "cms-bar__actor" }, [
    [options.actorLabel, strings.draftsSaveAsYouGo].filter(Boolean).join(" · "),
  ]);
  const changesLine = element("small", { class: "cms-bar__changes" });
  const scheduleLine = element("div", { class: "cms-bar__schedule", hidden: true });
  const actions = element("div", { class: "cms-bar__actions" });
  const bar = element("div", { class: "cms-bar", role: "region", "aria-label": strings.editingRegion }, [
    element("div", { class: "cms-bar__state" }, [stateLine, changesLine, scheduleLine]),
    actions,
  ]);
  const enterButton = button(strings.editThisPage, () => setEditing(true), "primary", {
    class: "cms-btn cms-btn--primary cms-enter",
    hidden: true,
  });
  const chrome = element("div", { class: "cms-root" }, [
    bar,
    sheet.node,
    toast.node,
    badge.node,
    enterButton,
    live,
    descriptions,
  ]);

  let fields: FieldRecord[] = [];
  let byElement = new Map<HTMLElement, FieldRecord>();
  let lists: ListRecord[] = [];
  /** A field's emptied state, kept for an element that left the page, in case Undo puts it back. */
  const clearedOf = new WeakMap<HTMLElement, FieldRecord["cleared"]>();
  /** The reason fields are locked after the last load failed, until one succeeds. */
  let loadError: string | undefined;
  /**
   * Documents whose lists' markup is about to change: a list write on its way, or a swap queued or running (one after
   * Discard, Restore or a conflict too). A swap replaces a document's outermost lists, so the lock is the document,
   * counted per holder: nothing inside any of its lists (a nested list, another document's list nested in one) acts or
   * opens until every holder is done.
   */
  const locks = new Map<string, number>();
  const lock = (key: string) => locks.set(key, (locks.get(key) ?? 0) + 1);
  const unlock = (key: string) => {
    const left = (locks.get(key) ?? 1) - 1;
    if (left <= 0) locks.delete(key);
    else locks.set(key, left);
  };
  /** An element Undo puts back in one copy of a list, and where it was: its markup is the host's. */
  interface Restore {
    key: string;
    element: HTMLElement;
    parent: Node;
    next: Node | null;
  }
  /** One removal Undo can put back. */
  interface Removal {
    listId: string;
    key: string;
    path: string;
    value: unknown;
    index: number;
    name: string;
    /** Per copy of the list (by its element): the item's own element, and where it was. Its markup is the host's. */
    places: Map<HTMLElement, Restore>;
    /** The keys either side of it when it went, so Undo puts it back between them. */
    before: string | undefined;
    after: string | undefined;
    /** Its own 15-second window. */
    timer: ReturnType<typeof setTimeout> | undefined;
    /** The toast that offers its Undo, while that one is showing. */
    toast: number | undefined;
    /** Its removal dropped an unsaved change: every toast for it says so. */
    droppedChange?: boolean;
    /** Its window is over: a failed Undo doesn't bring it back. */
    expired?: boolean;
  }
  /** Removals that Undo puts back, newest last. */
  const removals: Removal[] = [];
  let active: ActiveWidget | null = null;
  let editing = true;
  let destroyed = false;
  let openTicket = 0;
  /** The toast that reported the last failed load, hidden once a load succeeds. */
  let loadFailureToast: number | undefined;

  const session = new Session(
    client,
    {
      stateChanged(slot) {
        // A save that lands after destroy: the markup is the host's again.
        if (destroyed) return;
        for (const record of recordsFor(slot)) showState(record, slot.state);
        if (slot.state === "saving") toast.show(strings.saving, "saving");
        updateBar();
      },
      saved(slot, value) {
        if (destroyed) return;
        for (const record of recordsFor(slot)) {
          record.cleared = undefined;
          if (!TEXT_TYPES.has(record.info.type)) render(record, value);
        }
        if (slot.state === "saved") toast.show(strings.saved, "saved");
      },
      failed(slot, error) {
        toast.show(format(strings.saveFailed, { message: errorMessage(error, strings) }), "error", [
          { label: strings.retry, onClick: () => void session.retry(slot), variant: "primary" },
        ]);
      },
      conflicted(slot) {
        toast.show(strings.conflict, "error", [
          { label: strings.keepMine, onClick: () => void session.keepMine(slot), variant: "danger" },
          { label: strings.takeTheirs, onClick: () => takeTheirs(slot), variant: "primary" },
        ]);
      },
    },
    base,
  );

  function recordsFor(slot: SaveSlot): FieldRecord[] {
    return fields.filter((record) => record.id === slot.id);
  }

  /**
   * Repaint a host element after a value changed underneath it, if it is plain text we can safely replace or rich text,
   * which is rendered from its sanitised HTML whatever the element held (a value that isn't a string empties it, as it
   * does plain text). A save never
   * passes `undefined`, but content replaced by Discard, Restore or a conflict can lack the path: `clearMissing` then
   * empties plain text, so the page stops showing a value that is gone, and sets aside the `data-edit-value` it had at
   * that moment. A field already emptied keeps the one set aside then: a later one is the host's. A field it can't
   * empty still shows its content, so its attribute stands. `cms:change` carries `undefined` either way.
   */
  function render(record: FieldRecord, value: unknown, clearMissing = false): void {
    const target = record.element;
    const richText = record.info.type === "richtext";
    const plain = !richText && target.children.length === 0 && record.info.type !== "toggle";
    if (value !== undefined) record.cleared = undefined;
    if (richText && value === undefined && clearMissing) {
      record.cleared ??= { editValue: target.dataset.editValue };
      target.replaceChildren();
    } else if (richText && value !== undefined) {
      renderRichText(target, typeof value === "string" ? value : "");
    } else if (plain && value === undefined && clearMissing) {
      record.cleared ??= { editValue: target.dataset.editValue };
      target.textContent = "";
    } else if (plain && value !== undefined) {
      target.textContent = Array.isArray(value)
        ? value.join(", ")
        : value === null || typeof value === "object"
          ? ""
          : String(value);
    }
    target.dispatchEvent(
      new CustomEvent("cms:change", { bubbles: true, detail: { key: record.info.key, path: record.info.path, value } }),
    );
  }

  function takeTheirs(slot: SaveSlot): void {
    const payload = session.takeTheirs(slot);
    // No payload means no conflict was held, so nothing says the value is gone.
    const clearMissing = payload !== undefined;
    for (const record of recordsFor(slot)) {
      // A widget reopened on the field would put its own content back when it closes, over theirs.
      if (active?.record === record) closeActive(false);
      render(record, valueAtPath(payload, slot.path), clearMissing);
    }
    toast.hide();
  }

  function touchedDocuments() {
    return [...session.documents.values()].filter((state) => state.touched);
  }

  /** What Publish and Discard list: touched documents, plus any whose first save is still queued or on the wire. */
  function bulkDocuments() {
    return [...session.documents.values()].filter((state) => state.touched || session.isSaving(state.key));
  }

  function updateBar(): void {
    const touched = touchedDocuments();
    const fieldCount = touched.reduce((sum, state) => sum + changeCount(state), 0);
    changesLine.dataset.documents = String(touched.length);
    changesLine.dataset.fields = String(fieldCount);
    changesLine.textContent =
      fieldCount === 0
        ? strings.noChanges
        : touched.length > 1
          ? format(strings.changesAcross, { fields: fieldCount, documents: touched.length })
          : fieldCount === 1
            ? strings.oneChange
            : format(strings.changes, { fields: fieldCount });
    const scheduled = [...session.documents.values()].filter((state) => state.scheduledAt !== null);
    scheduleLine.hidden = scheduled.length === 0;
    scheduleLine.replaceChildren(
      ...scheduled.map((state) =>
        element("p", { class: "cms-bar__scheduled", "data-key": state.key }, [
          element("small", {}, [
            format(strings.scheduledFor, { key: state.key, time: formatTime(state.scheduledAt ?? "") }),
          ]),
          state.access.publish ? button(strings.publishNow, () => publishNow(state.key), "ghost") : null,
        ]),
      ),
    );
  }

  function closeActive(returnFocus: boolean, commit = false): void {
    const current = active;
    if (!current) return;
    if (commit && current.handle?.commit) {
      // The widget's commit closes it through the context (and skips the save when nothing changed).
      current.handle.commit();
      if (active !== current) return;
    }
    current.closed = true;
    active = null;
    current.handle?.destroy();
    current.record.element.classList.remove("cms-field--editing");
    if (returnFocus && !destroyed) current.record.element.focus();
  }

  async function openField(record: FieldRecord): Promise<void> {
    // Its markup is about to be replaced by the page's.
    if (refuseBusy(record.element)) return;
    if (!record.editable) {
      toast.show(record.reason ?? strings.notEditable, "info");
      return;
    }
    closeActive(false, true);
    const ticket = ++openTicket;
    const { info } = record;
    const registered = widgets[info.type];
    const widget = registered ?? missingWidget(strings, info.type);
    const slot = session.slot(info.key, info.path);
    const committed = session.committedValue(info.key, info.path);
    let initial: unknown;
    if (committed) {
      initial = committed.value;
    } else if (TEXT_TYPES.has(info.type) || !registered) {
      initial = textValue(record, session.documents.get(info.key)?.payload);
    } else {
      // Popover widgets start from the stored value, never from the page's text. `data-edit-value` stands in only
      // when there is no stored value to read: the path is missing, or the fetch failed (which the next open retries).
      let stored: unknown;
      let failure: { error: unknown } | undefined;
      try {
        stored = valueAtPath((await session.document(info.key)).payload, info.path);
      } catch (error) {
        failure = { error };
      }
      if (ticket !== openTicket || destroyed || !editing || !record.editable) return;
      // A swap replaced the element meanwhile.
      if (!record.element.isConnected || refuseBusy(record.element)) return;
      initial = stored === undefined ? editValueAttribute(record) : stored;
      if (failure) {
        const message = errorMessage(failure.error, strings);
        if (initial === undefined) {
          toast.show(format(strings.loadFieldFailed, { message }), "error");
          return;
        }
        toast.show(format(strings.loadFieldFallback, { message }), "info");
      }
      updateBar();
    }
    const opened: ActiveWidget = { record, handle: undefined, closed: false, slot };
    /** A marked widget closed with nothing of the editor's to hold: the field shows the adopted value. */
    const showTheirs = (theirs: WireDocument) => {
      // A value that failed to save is still the editor's, and the field keeps showing it.
      if (slot.state === "failed") return;
      render(record, valueAtPath(theirs.payload, info.path), true);
      showState(record, "idle");
    };
    const context: WidgetContext = {
      element: record.element,
      field: { ...info, options: info.options ? [...info.options] : undefined },
      value: initial,
      get unsaved() {
        return slot.state === "failed";
      },
      async commit(next) {
        if (opened.closed) return;
        if (active === opened) closeActive(true);
        opened.closed = true;
        const changed = !sameValue(next, initial) || slot.state === "failed";
        const { theirs } = opened;
        if (theirs) {
          // Sent now, it would go out on their version and overwrite what the editor hasn't seen.
          if (destroyed) return;
          if (changed) session.holdConflict(info.key, info.path, next, theirs);
          else showTheirs(theirs);
          return;
        }
        if (changed) await session.save(info.key, info.path, next);
      },
      cancel() {
        if (opened.closed) return;
        if (active === opened) closeActive(true);
        opened.closed = true;
        if (opened.theirs && !destroyed) showTheirs(opened.theirs);
      },
      announce: (message) => toast.announce(message),
    };
    // An error toast stays until dismissed or resolved (a failed save's Retry, a conflict's choice): an info toast
    // replacing it would take the unsaved change out of view when it hides itself.
    provideStrings(context, strings);
    provideStatus(context, (message) => {
      if (toast.showingError) toast.announce(message);
      else toast.show(message, "info");
    });
    active = opened;
    record.element.classList.add("cms-field--editing");
    try {
      opened.handle = widget.mount(context);
      if (!opened.closed) opened.handle.focus?.();
    } catch (error) {
      closeActive(true);
      toast.show(errorMessage(error, strings), "error");
    }
  }

  function setEditing(next: boolean): void {
    editing = next;
    bar.hidden = !next;
    enterButton.hidden = next;
    if (next) {
      for (const record of fields) attachRecord(record);
      for (const list of lists) attachListRecord(list);
      enterButton.blur();
    } else {
      openTicket += 1;
      closeActive(false, true);
      sheet.close(false);
      badge.hide();
      for (const record of fields) record.detach?.();
      for (const list of lists) list.detach?.();
      enterButton.focus();
    }
  }

  function attachRecord(record: FieldRecord): void {
    descriptions.append(record.description);
    attach(record, strings.pressEnterToEdit);
  }

  /**
   * How a list is dressed (rulings on #28, 2026-11-15 and 2026-11-18):
   * - a list inside another list's item gets no list chrome: its fields are cells of the outer item's row;
   * - every copy of a list on the page gets list chrome, and a change shows in all of them;
   * - keyed items get the full toolbar when their fields are addressed by key too;
   * - keys are the content's (`keyedItems`, `addListKeys`): the chrome never invents one for a stored item. A list
   *   with an item rendered without a key keeps the one outline and grid with no list actions, and the console tells
   *   the site's developer why.
   */
  function attachListRecord(list: ListRecord): void {
    list.detach?.();
    // Nested means inside an item of a list the chrome dresses: under a list the editor can't edit, it is top-level.
    // Worked out afresh from where it was scanned each time, as the outer list's access can change.
    if (list.insideItem) {
      const outer = list.element.parentElement?.closest("[data-edit-item]")?.closest<HTMLElement>("[data-edit-list]");
      const outerRecord = lists.find((other) => other.element === outer);
      list.nested = outerRecord !== undefined && session.documents.get(outerRecord.info.key)?.access.edit === true;
    }
    if (list.nested || session.documents.get(list.info.key)?.access.edit !== true) return;
    const unkeyed = list.items.some((item) => item.itemKey === undefined);
    const byPosition = unkeyed ? undefined : fieldByPosition(list);
    if (unkeyed || byPosition !== undefined) {
      if (!warned.has(list.id)) {
        warned.add(list.id);
        console.warn(
          unkeyed
            ? `[yl-editor] ${list.id} has no Add, Remove or Move: its items have no _key, so an edit can't be tied to an item. Give each item a _key to turn them on. See docs/chrome.md → Lists.`
            : `[yl-editor] ${list.id} has no Add, Remove or Move: its field ${byPosition} is addressed by position inside a keyed item. Render an item's fields with editable(docKey).itemFields(path, item, index). See docs/chrome.md → Lists.`,
        );
      }
      attachList(list, strings, { actions: false, canAdd: false, canUndo: false, add() {}, undo() {}, act() {} });
      return;
    }
    attachList(list, strings, {
      actions: true,
      canAdd: options.lists?.[list.id]?.newItem !== undefined,
      canUndo: removals.some((removal) => removal.listId === list.id),
      undo: () => void undoRemoval(list.id, undefined, list),
      add: () => void addItem(list),
      act: (item, action, pressed) => void actOnItem(list, item, action, pressed),
    });
  }

  /** Lists the console has already warned about. */
  const warned = new Set<string>();

  /**
   * The first field inside the list's items addressed by position (`artists.2.name`), if any. After an add, remove
   * or move that address names another item, so such a list gets no list actions (ruled 2026-11-18): the site renders
   * an item's fields by key, with `editable(docKey).itemFields(path, item, index)`.
   */
  function fieldByPosition(list: ListRecord): string | undefined {
    const prefix = `${list.info.key}:${list.info.path}.`;
    for (const item of list.items) {
      for (const node of item.element.querySelectorAll<HTMLElement>("[data-edit-field]")) {
        const address = node.dataset.editField ?? "";
        if (address.startsWith(prefix) && /^\d/.test(address.slice(prefix.length)))
          return address.slice(list.info.key.length + 1);
      }
    }
    return undefined;
  }

  /** Every copy of a list on the page, in page order. */
  function copiesOf(id: string): ListRecord[] {
    return lists.filter((list) => list.id === id && !list.nested && list.element.isConnected).sort(byPageOrder);
  }

  /** The stored array at the list's path, after the writes queued before this one. */
  async function storedItems(list: ListRecord): Promise<unknown[]> {
    const payload = (await session.document(list.info.key)).payload;
    const items = valueAtPath(payload, list.info.path);
    return Array.isArray(items) ? items : [];
  }

  /** What a list write came to: the stored array (null when the answer holds none), or why nothing was written. */
  type WriteOutcome = { written: true; stored: unknown[] | null } | { written: false; conflict: boolean };

  /**
   * One array operation on the document's write chain. `build` sees the stored array at the moment the write goes out,
   * so an index is never stale. Resolves with the stored array after the write; null when the write landed but the
   * answer holds no array at the path (only the page can show that); undefined when nothing was written. A failure has
   * been shown, and a conflict catches the page up as the other actions do.
   */
  async function listWrite(
    list: ListRecord,
    action: string,
    build: (items: unknown[]) => WireArrayOp | undefined,
    /** Runs on the document's write chain right after the write, before any save queued behind it starts. */
    onWritten?: () => void,
  ): Promise<WriteOutcome> {
    const { key, path } = list.info;
    closeActive(false, true);
    let after: unknown[] | null | undefined;
    try {
      await lifecycle(
        action,
        key,
        guarded(key, async (expectedVersion) => {
          const op = build(await storedItems(list));
          if (!op) return;
          const document = await client.array(key, path, op, expectedVersion);
          session.applyWrite(expectedVersion, document);
          session.touch(key, [path]);
          updateBar();
          const stored = valueAtPath(document.payload, path);
          after = Array.isArray(stored) ? stored : null;
          onWritten?.();
        }),
      );
    } catch (error) {
      // Shown by `lifecycle`. After a conflict the content is another editor's: no removal of it can be put back.
      if (isConflict(error)) forgetRemovals(key);
      return { written: false, conflict: isConflict(error) };
    }
    return after === undefined ? { written: false, conflict: false } : { written: true, stored: after };
  }

  /**
   * Move, Remove and Undo need no markup from the page: every item is keyed, so the chrome puts the items' own elements
   * in the stored order and takes out the ones no longer stored. Each item keeps a place the items hold now (or, for an
   * element Undo puts back, the place it was taken from), so markup between items stays where it is. Returns false when
   * the page can't show the stored list from what it has (the list is gone, an item has no element, or the items are
   * wrapped in markup of the host's), and the caller then asks the page.
   */
  function arrangeList(list: ListRecord, stored: readonly unknown[], restore?: Restore): boolean {
    if (!list.element.isConnected) return false;
    const elements = new Map<string, HTMLElement>();
    for (const item of list.items) {
      if (item.itemKey === undefined || elements.has(item.itemKey)) return false;
      elements.set(item.itemKey, item.element);
    }
    if (restore) {
      if (elements.has(restore.key)) return false;
      elements.set(restore.key, restore.element);
    }
    const order = stored.map(itemKeyOf);
    if (order.some((itemKey) => itemKey === undefined || !elements.has(itemKey))) return false;
    // The same key twice in the store: only the page knows which element is which.
    if (new Set(order).size !== order.length) return false;
    const parents = new Set<Node | null>([...elements.values()].map((element) => element.parentNode).filter(Boolean));
    if (restore) parents.add(restore.parent);
    if (parents.size > 1) return false;
    if (restore && !(restore.parent.isConnected && list.element.contains(restore.parent))) return false;
    // The element it sat before has gone too: only the page knows where it belongs among the host's own markup.
    if (restore && restore.next !== null && restore.next.parentNode !== restore.parent) return false;
    const nested = lists.filter((other) => other !== list && list.element.contains(other.element));
    for (const other of nested) other.detach?.();
    list.detach?.();
    // One place per item that stays, marked where it is now, plus the place a restored element came from.
    const places: Comment[] = [];
    for (const item of list.items) {
      if (item.itemKey === undefined || !order.includes(item.itemKey)) continue;
      const place = document.createComment("");
      item.element.before(place);
      places.push(place);
    }
    if (restore) {
      const place = document.createComment("");
      restore.parent.insertBefore(place, restore.next);
      const after = places.findIndex(
        (other) => place.compareDocumentPosition(other) & Node.DOCUMENT_POSITION_FOLLOWING,
      );
      places.splice(after < 0 ? places.length : after, 0, place);
    }
    for (const element of elements.values()) element.remove();
    order.forEach((itemKey, index) => places[index]?.before(elements.get(itemKey as string) as HTMLElement));
    for (const place of places) place.remove();
    // By element: a rescan may already have made a newer record for the same list.
    lists = lists.filter(
      (other) => other.element !== list.element && !nested.some((inner) => inner.element === other.element),
    );
    rescanWithin([list.element]);
    // The element Undo put back may still show a value since dropped: its own fields show what is stored.
    if (restore) {
      for (const record of fields) {
        const own = record.info.key === list.info.key && record.info.path.startsWith(`${list.info.path}[`);
        // A value still on its way is the editor's newest: rescanWithin has shown it.
        const committed = session.committedValue(record.info.key, record.info.path);
        if (own && !committed && restore.element.contains(record.element)) {
          render(record, valueAtPath({ items: stored }, `items${record.info.path.slice(list.info.path.length)}`), true);
        }
      }
    }
    return true;
  }

  /** After a Move, Remove or Undo: every copy shows the stored order, from its own markup or from the page. */
  async function settleCopies(
    id: string,
    key: string,
    stored: readonly unknown[] | null,
    restores?: Map<HTMLElement, Restore>,
  ) {
    let needsPage = stored === null;
    if (stored !== null) {
      for (const copy of copiesOf(id)) {
        if (!arrangeList(copy, stored, restores?.get(copy.element))) needsPage = true;
      }
    }
    if (needsPage) await swapLists(key);
  }

  /**
   * Add and Duplicate need the host's markup for an item that didn't exist: the chrome asks the page again and swaps
   * every copy of the list in. The page must render the draft for an editor, as it does on a reload.
   */
  function listWriteAndSwap(
    list: ListRecord,
    action: string,
    build: (items: unknown[]) => WireArrayOp | undefined,
  ): Promise<boolean> {
    return withLock(list.info.key, async () => {
      if (!(await listWrite(list, action, build)).written) return false;
      await swapLists(list.info.key);
      return true;
    });
  }

  /** Move, Remove and Undo: the write, then every copy's own markup in the stored order, under the document's lock. */
  function listWriteAndSettle(
    list: ListRecord,
    action: string,
    build: (items: unknown[]) => WireArrayOp | undefined,
    onWritten?: () => void,
    restores?: Map<HTMLElement, Restore>,
  ): Promise<WriteOutcome> {
    return withLock(list.info.key, async () => {
      const outcome = await listWrite(list, action, build, onWritten);
      if (outcome.written) await settleCopies(list.id, list.info.key, outcome.stored, restores);
      return outcome;
    });
  }

  /** Holds the document's lock while `task` runs, and always gives it back. */
  async function withLock<Result>(key: string, task: () => Promise<Result>): Promise<Result> {
    lock(key);
    try {
      return await task();
    } finally {
      unlock(key);
    }
  }

  /**
   * One queue for every swap on the page: a list of one document can hold another's, so an older fetch must never land
   * after a newer one. Calls made while a swap runs share the next run, which fetches once for every document waiting,
   * after the running one has finished, so it sees every write made before the call.
   */
  let swapChain: Promise<void> = Promise.resolve();
  /** Per document, how many calls are waiting for the next run; each holds a lock until that run is over. */
  const swapWanted = new Map<string, number>();

  function swapLists(key: string): Promise<void> {
    lock(key);
    swapWanted.set(key, (swapWanted.get(key) ?? 0) + 1);
    // A swap that failed must not take the ones queued behind it down with it.
    const next = swapChain.then(async () => {
      if (swapWanted.size === 0) return;
      const taken = new Map(swapWanted);
      swapWanted.clear();
      try {
        await swapOnce(new Set(taken.keys()));
      } catch {
        if (!destroyed) showListReload();
      } finally {
        for (const [taker, count] of taken) for (let index = 0; index < count; index += 1) unlock(taker);
      }
    });
    swapChain = next;
    return next;
  }

  function showListReload(): void {
    toast.show(strings.listReload, "error", [
      { label: strings.reload, onClick: () => location.reload(), variant: "primary" },
    ]);
  }

  /** How long a list's page fetch may take before the chrome gives up and offers Reload. */
  const SWAP_TIMEOUT_MS = 15000;

  async function swapOnce(keys: ReadonlySet<string>): Promise<void> {
    if (!lists.some((list) => keys.has(list.info.key))) return;
    let page: Document | undefined;
    try {
      // Never a cached copy: it would lack the write just made. A page that never answers frees the lists after 15 s.
      const response = await fetch(location.href, {
        credentials: "same-origin",
        cache: "no-store",
        headers: { Accept: "text/html" },
        signal: AbortSignal.timeout(SWAP_TIMEOUT_MS),
      });
      if (response.ok) page = new DOMParser().parseFromString(await response.text(), "text/html");
    } catch {
      // Reported below.
    }
    if (destroyed) return;
    // Every copy of a list, in page order: the page's first copy replaces this page's first copy, and so on.
    const fresh = new Map<string, Element[]>();
    for (const node of page?.querySelectorAll("[data-edit-list]") ?? []) {
      const id = node.getAttribute("data-edit-list") ?? "";
      fresh.set(id, [...(fresh.get(id) ?? []), node]);
    }
    // Read after the fetch: the lists on the page now. A list inside another (of any document) comes with its
    // outermost list, which is the one swapped.
    const own = lists
      .filter((list) => keys.has(list.info.key) && list.element.isConnected)
      .map((list) => lists.find((outer) => outer.element === outermostList(list.element)) ?? list);
    const targets = [...new Set(own)].sort(byPageOrder);
    const swapped: HTMLElement[] = [];
    let missing = false;
    // Each target's place among the outermost copies of its list on this page, matched to the same place among the
    // outermost copies on the fetched page; taken before any of them is replaced.
    const topLevel = (id: string) =>
      lists.filter((list) => list.id === id && outermostList(list.element) === list.element).sort(byPageOrder);
    const places = new Map(targets.map((list) => [list, topLevel(list.id).indexOf(list)]));
    for (const list of targets) {
      const index = places.get(list) ?? 0;
      const node = fresh.get(list.id)?.filter((candidate) => !candidate.parentElement?.closest("[data-edit-list]"))[
        index
      ];
      if (!node) {
        missing = true;
        continue;
      }
      list.detach?.();
      const imported = document.importNode(node, true) as HTMLElement;
      list.element.replaceWith(imported);
      swapped.push(imported);
    }
    if (missing) showListReload();
    if (swapped.length > 0) rescanWithin(swapped);
  }

  /**
   * After a swap: only the swapped elements are new. Records for elements that left the page go; the new elements'
   * fields and lists are scanned and dressed. Every other field keeps its record, its state and any open widget.
   */
  function rescanWithin(nodes: readonly HTMLElement[]): void {
    if (active && !active.record.element.isConnected) closeActive(false, true);
    for (const record of fields) {
      if (record.element.isConnected) continue;
      record.detach?.();
      // Undo may bring the element back: it comes back emptied if it went emptied.
      clearedOf.set(record.element, record.cleared);
    }
    for (const list of lists) if (!list.element.isConnected) list.detach?.();
    fields = fields.filter((record) => record.element.isConnected);
    lists = lists.filter((list) => list.element.isConnected);
    // Elements still on the page keep their records (a rearranged list keeps most of its fields).
    const added = nodes.flatMap((node) => scanFields(node, (element) => !byElement.has(element)));
    for (const record of added) record.cleared = clearedOf.get(record.element);
    const addedLists = nodes.flatMap((node) => scanLists(node));
    lists.push(...addedLists);
    fields.push(...added);
    byElement = new Map(fields.map((record) => [record.element, record]));
    for (const record of added) {
      dressRecord(record);
      // The page renders what is stored. A value still on its way or failed is the editor's, and so is its state.
      const committed = session.committedValue(record.info.key, record.info.path);
      if (committed) render(record, committed.value);
      const state = session.slot(record.info.key, record.info.path).state;
      if (state !== "idle") showState(record, state);
    }
    // Swaps take outermost lists, and a rearranged list holds none with chrome, so only the new records need dressing.
    if (editing) for (const list of addedLists) attachListRecord(list);
    updateBar();
  }

  /** Whether `node` is inside a list whose document's markup is about to be swapped. */
  function isBusy(node: Element): boolean {
    // Anything in the outermost list a locked list sits in (that is what its swap replaces), and anything holding one.
    return lists.some(
      (list) => locks.has(list.info.key) && (outermostList(list.element).contains(node) || node.contains(list.element)),
    );
  }

  /** The outermost `[data-edit-list]` holding `element` (itself when none does). */
  function outermostList(element: HTMLElement): HTMLElement {
    let top = element;
    for (let up = top.parentElement?.closest<HTMLElement>("[data-edit-list]"); up;) {
      top = up;
      up = up.parentElement?.closest<HTMLElement>("[data-edit-list]");
    }
    return top;
  }

  const byPageOrder = (a: ListRecord, b: ListRecord) =>
    a.element.compareDocumentPosition(b.element) & Node.DOCUMENT_POSITION_FOLLOWING ? -1 : 1;

  /** A press inside a list waiting for the page: say so, rather than nothing happening. */
  function refuseBusy(node: Element): boolean {
    if (!isBusy(node)) return false;
    toast.announce(strings.listBusy);
    return true;
  }

  function itemByKey(list: ListRecord | undefined, itemKey: string | undefined): ItemRecord | undefined {
    return itemKey === undefined ? undefined : list?.items.find((item) => item.itemKey === itemKey);
  }

  /** Focus an item's toolbar: `preferred` if it is there and not inert, else its first button that isn't. */
  function focusTools(item: ItemRecord | undefined, preferred?: ItemAction): void {
    const tools = item?.element.querySelector<HTMLElement>(":scope > .cms-item__tools");
    if (!tools) return;
    const buttons = [...tools.querySelectorAll<HTMLButtonElement>("button[data-action]")];
    const target =
      buttons.find((node) => node.dataset.action === preferred && node.getAttribute("aria-disabled") !== "true") ??
      buttons.find((node) => node.getAttribute("aria-disabled") !== "true") ??
      buttons[0];
    if (!target) return;
    for (const node of buttons) node.tabIndex = node === target ? 0 : -1;
    // Without hover the toolbar's buttons show only while the item is open: focus its chip instead.
    const chip = tools.querySelector<HTMLButtonElement>(".cms-item__chip");
    if (chip && getComputedStyle(target).display === "none") chip.focus();
    else target.focus();
  }

  /**
   * Whether the chrome may move focus after a list operation: the editor hasn't opened another field or a sheet while
   * it ran, and focus isn't somewhere else they chose: it fell to the body with a replaced element, or is in that list.
   */
  function focusIsFree(list: ListRecord | undefined): boolean {
    if (active || sheet.isOpen) return false;
    const focused = document.activeElement;
    if (focused === null || focused === document.body) return true;
    return list?.element.contains(focused) === true;
  }

  /**
   * Opens the new item's first field, or the one the host named, for typing. A field edited in place starts with its
   * text selected, so typing replaces the new item's default rather than adding to it.
   */
  async function openFirstField(list: ListRecord, item: ItemRecord): Promise<void> {
    const wanted = options.lists?.[list.id]?.focusField;
    const candidates = fields.filter((record) => item.element.contains(record.element));
    const record =
      (wanted !== undefined && candidates.find((entry) => entry.info.path === `${item.path}.${wanted}`)) ||
      candidates[0];
    if (!record) {
      focusTools(item);
      return;
    }
    await openField(record);
    if (active?.record !== record || !record.element.isContentEditable) return;
    const selection = document.getSelection();
    const range = document.createRange();
    range.selectNodeContents(record.element);
    selection?.removeAllRanges();
    selection?.addRange(range);
  }

  async function addItem(list: ListRecord): Promise<void> {
    if (refuseBusy(list.element)) return;
    const reason = list.addButton?.dataset.reason;
    if (reason) {
      toast.announce(reason);
      return;
    }
    const make = options.lists?.[list.id]?.newItem;
    if (!make) return;
    const copy = copiesOf(list.id).indexOf(list);
    const value: Record<string, unknown> = { ...make() };
    // A `_key` the paths can't carry would leave the new item addressed by index: the chrome makes its own instead.
    // A fixed `_key` from newItem would be used twice: the chrome makes a fresh one when it is taken.
    if (!isItemKey(value["_key"]) || list.items.some((item) => item.itemKey === value["_key"])) {
      value["_key"] = newItemKey();
    }
    const itemKey = String(value["_key"]);
    const ok = await listWriteAndSwap(list, format(strings.listAdd, { noun: list.info.noun }), (items) => ({
      kind: "insert",
      index: items.length,
      value,
    }));
    if (!ok) return;
    const fresh = copiesOf(list.id)[copy];
    const item = itemByKey(fresh, itemKey);
    if (!fresh || !item) return;
    toast.announce(
      format(strings.itemAdded, {
        item: itemName(fresh, item, strings),
        position: fresh.items.indexOf(item) + 1,
        count: fresh.items.length,
      }),
    );
    if (focusIsFree(fresh)) await openFirstField(fresh, item);
  }

  async function actOnItem(
    list: ListRecord,
    item: ItemRecord,
    action: ItemAction,
    pressed: HTMLButtonElement,
  ): Promise<void> {
    const reason = pressed.dataset.reason;
    if (pressed.getAttribute("aria-disabled") === "true") {
      if (reason) toast.announce(reason);
      return;
    }
    if (refuseBusy(list.element)) return;
    const name = itemName(list, item, strings);
    const label = pressed.getAttribute("aria-label") ?? action;
    const copy = copiesOf(list.id).indexOf(list);
    if (action === "up" || action === "down") {
      const step = action === "up" ? -1 : 1;
      // Held until the page shows the move: a swap or another press meanwhile would act on the old order.
      const outcome = await listWriteAndSettle(list, label, (items) => {
        const from = storedIndex(items, item);
        const to = from + step;
        return from < 0 || to < 0 || to >= items.length ? undefined : { kind: "move", from, to };
      });
      if (!outcome.written) return;
      const fresh = copiesOf(list.id)[copy];
      const moved = itemByKey(fresh, item.itemKey);
      if (!fresh || !moved) return;
      toast.announce(
        format(strings.itemMoved, { item: name, position: fresh.items.indexOf(moved) + 1, count: fresh.items.length }),
      );
      if (focusIsFree(fresh)) focusTools(moved, action);
      return;
    }
    if (action === "duplicate") {
      const itemKey = newItemKey();
      const ok = await listWriteAndSwap(list, label, (items) => {
        const from = storedIndex(items, item);
        const original = items[from];
        if (from < 0 || typeof original !== "object" || original === null || Array.isArray(original)) return undefined;
        return { kind: "insert", index: from + 1, value: { ...(original as object), _key: itemKey } };
      });
      if (!ok) return;
      const fresh = copiesOf(list.id)[copy];
      const duplicate = itemByKey(fresh, itemKey);
      if (!fresh || !duplicate) return;
      toast.announce(
        format(strings.itemDuplicated, {
          item: name,
          position: fresh.items.indexOf(duplicate) + 1,
          count: fresh.items.length,
        }),
      );
      if (focusIsFree(fresh)) await openFirstField(fresh, duplicate);
      return;
    }
    const position = list.items.indexOf(item);
    let removed: { value: unknown; index: number; before: string | undefined; after: string | undefined } | undefined;
    // In every copy, where Undo puts the item back: before the next markup that is the host's (the chrome's own rows
    // come and go).
    const places = new Map<HTMLElement, Restore>();
    for (const each of copiesOf(list.id)) {
      const element = itemByKey(each, item.itemKey)?.element;
      if (!element?.parentNode || item.itemKey === undefined) continue;
      let next = element.nextSibling;
      while (next instanceof Element && next.classList.contains("cms-root")) next = next.nextSibling;
      places.set(each.element, { key: item.itemKey, element, parent: element.parentNode, next });
    }
    let dropped: string[] = [];
    const outcome = await listWriteAndSettle(
      list,
      label,
      (items) => {
        const index = storedIndex(items, item);
        if (index < 0) return undefined;
        // Its neighbours, so Undo puts it back between them even after other changes in this session.
        removed = {
          value: items[index],
          index,
          before: itemKeyOf(items[index - 1]),
          after: itemKeyOf(items[index + 1]),
        };
        return { kind: "remove", index };
      },
      () => {
        // On the chain, before a save queued behind the remove starts: a value inside the removed item (or on the item
        // itself) has nowhere left to go. It is dropped, and the toast says so.
        dropped = session.dropSaves(list.info.key, (path) => path === item.path || path.startsWith(`${item.path}.`));
      },
    );
    if (!outcome.written || !removed) return;
    const entry: Removal = {
      listId: list.id,
      key: list.info.key,
      path: list.info.path,
      name,
      places,
      timer: undefined,
      toast: undefined,
      ...removed,
    };
    removals.push(entry);
    // Each removal has its own 15 seconds: nothing pauses or extends another's (ruled 2026-11-18).
    entry.timer = setTimeout(() => expireRemoval(entry), UNDO_MS);
    entry.droppedChange = dropped.length > 0;
    showRemovalToast(entry);
    const fresh = copiesOf(list.id)[copy];
    toast.announce(format(strings.itemRemoved, { item: name, count: fresh?.items.length ?? 0 }));
    const next = fresh?.items[position] ?? fresh?.items[position - 1];
    if (!focusIsFree(fresh)) return;
    if (next) focusTools(next);
    // No item left, and maybe no Add: focus goes to the list's Undo, so the keyboard user stays in the list.
    else (fresh?.addButton ?? fresh?.undoButton)?.focus();
  }

  const UNDO_MS = 15000;

  function showRemovalToast(entry: Removal): void {
    const message = format(entry.droppedChange ? strings.removedDroppedToast : strings.removedToast, {
      item: entry.name,
    });
    entry.toast = toast.show(message, "info", [
      { label: strings.undo, onClick: () => void undoRemoval(undefined, entry), variant: "primary" },
    ]);
    syncUndoButtons();
  }

  /** A removal's window is over: its button, its toast and Ctrl/⌘+Z for it go. */
  function expireRemoval(entry: Removal): void {
    entry.expired = true;
    const at = removals.indexOf(entry);
    if (at >= 0) removals.splice(at, 1);
    const showing = entry.toast !== undefined && toast.isShowing(entry.toast);
    if (entry.toast !== undefined) toast.hideIf(entry.toast);
    // An older removal still in its window gets its toast back.
    const previous = removals.at(-1);
    if (showing && previous) showRemovalToast(previous);
    else syncUndoButtons();
  }

  /** Each copy of a list shows Undo while one of the list's removals can still be undone. */
  function syncUndoButtons(): void {
    for (const list of lists) {
      if (!list.undoButton) continue;
      list.undoButton.hidden = !removals.some((removal) => removal.listId === list.id);
    }
  }

  /**
   * Undoes `entry`, else the newest removal from `listId`, else the newest of all. The removal's own window keeps
   * running; another removal's is untouched.
   */
  async function undoRemoval(listId?: string, entry?: Removal, pressedIn?: ListRecord): Promise<void> {
    const last =
      entry ?? (listId === undefined ? removals.at(-1) : removals.findLast((removal) => removal.listId === listId));
    if (!last || !removals.includes(last)) return;
    // The copy the editor pressed in: focus and the announcement stay there.
    const copies = copiesOf(last.listId);
    const copy = pressedIn && copies.includes(pressedIn) ? copies.indexOf(pressedIn) : 0;
    const list = copies[copy];
    const itemKey = itemKeyOf(last.value);
    if (!list || itemKey === undefined) {
      // Its list has left the page (or it can't be matched): it can't come back here, and mustn't block older ones.
      clearTimeout(last.timer);
      expireRemoval(last);
      return;
    }
    if (refuseBusy(list.element)) return;
    const at = removals.indexOf(last);
    removals.splice(at, 1);
    if (last.toast !== undefined) toast.hideIf(last.toast);
    syncUndoButtons();
    const outcome = await listWriteAndSettle(
      list,
      strings.undo,
      (items) => {
        const before = last.before === undefined ? -1 : items.findIndex((entry) => itemKeyOf(entry) === last.before);
        const after = last.after === undefined ? -1 : items.findIndex((entry) => itemKeyOf(entry) === last.after);
        const index = before >= 0 ? before + 1 : after >= 0 ? after : Math.min(last.index, items.length);
        return { kind: "insert", index, value: last.value };
      },
      undefined,
      last.places,
    );
    if (!outcome.written) {
      if (outcome.conflict) {
        // Another editor changed the list: putting the item back at its old place would land in their content.
        clearTimeout(last.timer);
        toast.show(format(strings.undoConflict, { key: last.key, item: last.name }), "error");
        return;
      }
      // Nothing written (offline, a refusal): the removal can still be undone, within its own window and in its place.
      if (last.expired) return;
      removals.splice(Math.min(at, removals.length), 0, last);
      showRemovalToast(last);
      return;
    }
    clearTimeout(last.timer);
    const fresh = copiesOf(last.listId)[copy];
    const restored = itemByKey(fresh, itemKey);
    if (fresh && restored) {
      toast.announce(
        format(strings.itemRestored, {
          item: last.name,
          position: fresh.items.indexOf(restored) + 1,
          count: fresh.items.length,
        }),
      );
      if (focusIsFree(fresh)) focusTools(restored);
    }
    const previous = removals.at(-1);
    if (previous) showRemovalToast(previous);
  }

  /** Content replaced by a lifecycle write: the removals Undo would put back no longer apply to it. */
  function forgetRemovals(key: string): void {
    for (const removal of [...removals]) {
      if (removal.key !== key) continue;
      clearTimeout(removal.timer);
      if (removal.toast !== undefined) toast.hideIf(removal.toast);
      removals.splice(removals.indexOf(removal), 1);
    }
    syncUndoButtons();
  }

  function fieldFrom(event: Event): FieldRecord | undefined {
    if (!editing || !(event.target instanceof Element)) return undefined;
    if (event.target.closest(".cms-root")) return undefined;
    const target = event.target.closest<HTMLElement>("[data-edit-field]");
    return target ? byElement.get(target) : undefined;
  }

  // Delegated listeners on the scanned root, so fields added by `refresh()` need nothing new.
  disposer.listen(
    scanRoot,
    "click",
    (event) => {
      const record = fieldFrom(event);
      if (!record) return;
      // Fields often sit inside links and cards; while editing, a click edits rather than navigates.
      event.preventDefault();
      if (active?.record !== record) void openField(record);
    },
    { capture: true },
  );
  disposer.listen(scanRoot, "keydown", (event) => {
    const record = fieldFrom(event);
    if (!record || event.defaultPrevented || event.target !== record.element || active?.record === record) return;
    if ((event as KeyboardEvent).key !== "Enter") return;
    event.preventDefault();
    void openField(record);
  });
  disposer.listen(scanRoot, "keydown", (event) => {
    const key = event as KeyboardEvent;
    if (!editing || key.defaultPrevented || key.key.toLowerCase() !== "z" || !(key.ctrlKey || key.metaKey)) return;
    if (key.shiftKey || key.altKey || removals.length === 0 || !(event.target instanceof Element)) return;
    const target = event.target;
    const inList = target.closest<HTMLElement>(".cms-list");
    if (!inList || target.closest("input, textarea, select, [contenteditable]")) return;
    const list = lists.find((entry) => entry.element === inList);
    if (!list || !removals.some((removal) => removal.listId === list.id)) return;
    event.preventDefault();
    void undoRemoval(list.id, undefined, list);
  });
  disposer.listen(scanRoot, "mouseover", (event) => {
    const record = fieldFrom(event);
    if (record) badge.show(record);
  });
  disposer.listen(scanRoot, "focusin", (event) => {
    const record = fieldFrom(event);
    if (record) badge.show(record);
  });
  disposer.listen(scanRoot, "mouseout", () => badge.hide());
  disposer.listen(scanRoot, "focusout", () => badge.hide());
  disposer.listen(document, "keydown", (event) => {
    if ((event as KeyboardEvent).key === "Escape" && sheet.isOpen) sheet.close();
  });
  disposer.listen(window, "scroll", () => badge.hide(), { passive: true });

  /** Every sheet goes through here: it cancels a slow popover, and an open edit lands before the sheet reads anything. */
  function openSheet(title: string, build: (body: HTMLElement) => (() => void) | void, opener: HTMLElement): void {
    openTicket += 1;
    closeActive(false, true);
    sheet.open(title, build, opener);
  }

  /** `null` is a first publish. Fetched afresh each time, so another editor's change shows. */
  async function changesOf(key: string): Promise<DiffEntry[] | null> {
    const { document, publishedPayload } = await session.documentForPublish(key);
    updateBar();
    return publishedPayload === null ? null : diffPayloads(publishedPayload, document.payload);
  }

  function changeLine(entry: DiffEntry): HTMLElement {
    const detail =
      entry.kind === "added"
        ? format(strings.diffAdded, { value: short(entry.after) })
        : entry.kind === "removed"
          ? format(strings.diffRemoved, { value: short(entry.before) })
          : format(strings.diffChanged, { before: short(entry.before), after: short(entry.after) });
    return element("li", { "data-path": entry.path, "data-kind": entry.kind }, [
      element("code", {}, [entry.path === "" ? strings.diffRoot : entry.path]),
      " ",
      detail,
    ]);
  }

  /** Never rejects: a failure is shown in `target`. Once `isCurrent` is false, the result is dropped. */
  async function fillChanges(key: string, target: HTMLElement, isCurrent: () => boolean): Promise<void> {
    const note = (text: string, className = "cms-muted") =>
      target.replaceChildren(element("p", { class: className }, [text]));
    note(strings.loadingChanges);
    try {
      const changes = await changesOf(key);
      if (!isCurrent()) return;
      if (changes === null) note(strings.firstPublish);
      else if (changes.length === 0) note(strings.noDifferences);
      else target.replaceChildren(element("ul", { class: "cms-list" }, changes.map(changeLine)));
    } catch (error) {
      if (isCurrent()) note(format(strings.changesFailed, { message: errorMessage(error, strings) }), "cms-error");
    }
  }

  interface SheetRow {
    item: HTMLElement;
    /** The " · 3" after the key. */
    count: Text;
    changes: HTMLElement;
    notice: HTMLElement | undefined;
    /** The Discard sheet's warning that this document would be deleted. */
    deletes: HTMLElement | undefined;
    review: Review | undefined;
    /** The newest diff read for this row: an older one still in flight renders nothing. */
    ticket: number;
  }

  /**
   * Bulk publish and discard act on touched documents the user may publish, listed before anything happens. `only`
   * lists one document instead, touched or not, after a publish of it conflicted.
   */
  function openBulk(kind: "publish" | "discard", opener: HTMLElement, only?: string): void {
    const title = kind === "publish" ? strings.publishTitle : strings.discardTitle;
    openSheet(
      title,
      (body) => {
        // Built here, not before `openSheet`: it commits the open edit first, and that save must be listed.
        const onlyState = only === undefined ? undefined : session.documents.get(only);
        const touched = only === undefined ? bulkDocuments() : onlyState ? [onlyState] : [];
        const eligible = touched.filter((state) => (kind === "publish" ? state.access.publish : state.access.edit));
        let isOpen = true;
        const nothing = () =>
          element("p", {}, [kind === "publish" ? strings.nothingToPublish : strings.nothingToDiscard]);
        if (eligible.length === 0) {
          body.append(nothing());
          return;
        }
        // A run is going: Confirm stays off whatever else tries to enable it. Only the sheet closing ends it early.
        let running = false;
        // The document a run has handed to `publish` or `discard`: it keeps its review if the sheet closes.
        let inFlight: string | undefined;
        const rows = new Map<string, SheetRow>();
        const leftOut: string[] = [];
        const leftOutNote = element("p", { class: "cms-muted", hidden: true });
        const othersNote = element("p", { class: "cms-muted", hidden: true });
        const otherKeys = touched.filter((state) => !eligible.includes(state)).map((state) => state.key);
        const syncOthers = () => {
          const count = otherKeys.filter(
            (key) => session.documents.get(key)?.touched === true || session.isSaving(key),
          ).length;
          const template = kind === "publish" ? strings.othersNeedPublisher : strings.othersNeedEditor;
          othersNote.hidden = count === 0;
          othersNote.textContent = count === 0 ? "" : format(template, { count });
        };
        /**
         * Resolves once none of the document's writes is queued or on the wire, however many arrive meanwhile. One wait
         * per document at a time, shared by the sheet and Confirm, so each settling rechecks the rows once.
         */
        const settling = new Map<string, Promise<void>>();
        const writesSettled = (key: string): Promise<void> => {
          const waiting = settling.get(key);
          if (waiting) return waiting;
          const wait = (async () => {
            do {
              await session.pending(key);
            } while (session.isSaving(key));
          })().finally(() => settling.delete(key));
          settling.set(key, wait);
          return wait;
        };
        /**
         * Brings the rows up to date with the writes that have settled. A document listed only because its save was on
         * its way, and which that save never changed, is another editor's to publish or discard, or to lose: it goes.
         * `only` listed its document on purpose, touched or not.
         */
        const recheckRows = () => {
          syncOthers();
          const gone: string[] = [];
          for (const [key, row] of rows) {
            const state = session.documents.get(key);
            if (state) row.count.data = ` · ${changeCount(state)}`;
            if (only !== undefined || state?.touched === true || session.isSaving(key)) continue;
            row.item.remove();
            row.ticket += 1;
            if (row.review) session.endReview(key, row.review);
            rows.delete(key);
            gone.push(key);
          }
          if (gone.length === 0) return;
          leftOut.push(...gone);
          // The note lists every document left out; the live region says only what is new.
          toast.announce(format(strings.bulkLeftOut, { keys: gone.join(", ") }));
          leftOutNote.textContent = format(strings.bulkLeftOut, { keys: leftOut.join(", ") });
          leftOutNote.hidden = false;
          if (rows.size > 0) return;
          const focusWasInside = body.contains(document.activeElement);
          body.replaceChildren(nothing(), leftOutNote, othersNote);
          if (focusWasInside) sheet.node.querySelector("button")?.focus();
        };
        const showNotice = (row: SheetRow, text: string) => {
          row.notice?.remove();
          row.notice = element("div", { class: "cms-diff" }, [element("p", { class: "cms-error" }, [text])]);
          if (kind === "publish") row.changes.before(row.notice);
          else row.item.append(row.notice);
        };
        /** Starts the review over: until the diff has loaded again, a publish falls back to the session's version. */
        const review = (key: string, row: SheetRow) => {
          if (row.review) session.endReview(key, row.review);
          row.review = session.startReview(key);
          const ticket = ++row.ticket;
          return fillChanges(key, row.changes, () => isOpen && ticket === row.ticket);
        };
        /**
         * Discarding a document with nothing published deletes it, revisions included. Reads the session each time, as a
         * write may have changed that since the sheet opened. Returns the warnings that weren't showing before.
         */
        const syncDeleteWarnings = (): string[] => {
          const added: string[] = [];
          if (kind !== "discard") return added;
          for (const [key, row] of rows) {
            const deletes = session.documents.get(key)?.publishedAt === null;
            if (deletes && !row.deletes) {
              const warning = format(strings.discardDeletes, { key });
              row.deletes = element("div", { class: "cms-diff" }, [element("p", { class: "cms-error" }, [warning])]);
              row.item.append(row.deletes);
              added.push(warning);
            } else if (!deletes && row.deletes) {
              row.deletes.remove();
              row.deletes = undefined;
            }
          }
          return added;
        };
        body.append(
          element(
            "ul",
            { class: "cms-list" },
            eligible.map((state) => {
              const changes = element("div", { class: "cms-diff" });
              const count = document.createTextNode(` · ${changeCount(state)}`);
              const item = element("li", { "data-key": state.key }, [element("b", {}, [state.key]), count]);
              if (kind === "publish") item.append(changes);
              const row: SheetRow = {
                item,
                count,
                changes,
                notice: undefined,
                deletes: undefined,
                review: undefined,
                ticket: 0,
              };
              rows.set(state.key, row);
              if (kind === "publish") void review(state.key, row);
              return item;
            }),
          ),
        );
        syncDeleteWarnings();
        syncOthers();
        body.append(othersNote, leftOutNote);
        for (const { key } of touched) {
          if (!session.isSaving(key)) continue;
          void writesSettled(key).then(() => {
            // A run rechecks for itself.
            if (isOpen && !running) recheckRows();
          });
        }
        if (only !== undefined && kind === "publish") {
          for (const row of rows.values()) showNotice(row, format(strings.publishConflict, { key: only }));
        }

        const pastNote = element("div", { class: "cms-diff", id: uniqueId("cms-publish-at-note"), hidden: true });
        const publishAt =
          kind === "publish" && options.scheduling === true
            ? element("input", { class: "cms-input", type: "datetime-local", "aria-describedby": pastNote.id })
            : null;
        const at = () => (publishAt ? localToIso(publishAt.value) : undefined);
        /** Focus left "Publish at" while it was half-typed, and it still is. */
        let incompleteLeft = false;
        let shownReason: string | undefined;
        const inPast = () => {
          const when = at();
          return when !== undefined && new Date(when).getTime() <= Date.now();
        };
        const syncConfirm = () => {
          if (running) return;
          if (!publishAt) {
            confirm.disabled = false;
            return;
          }
          // Setting `min`, even to the same value, empties a half-typed datetime-local in Chromium.
          const min = localInputValue(new Date());
          if (!publishAt.validity.badInput && publishAt.min !== min) publishAt.min = min;
          const label = at() !== undefined ? strings.schedule : strings.publish;
          // Runs on the blur a click on Confirm causes: replacing its text then loses that click in WebKit.
          if (confirm.textContent !== label) confirm.textContent = label;
          const past = inPast();
          // A half-typed date reads as empty; publishing right now would be the wrong guess.
          const incomplete = publishAt.validity.badInput;
          if (!incomplete) incompleteLeft = false;
          // Every date is half-typed while it is being typed, so that reason waits until focus leaves the input.
          const reason = past ? strings.scheduleInPast : incompleteLeft ? strings.scheduleIncomplete : undefined;
          if (reason !== shownReason) {
            if (reason !== undefined) toast.announce(reason);
            shownReason = reason;
            pastNote.hidden = reason === undefined;
            pastNote.replaceChildren(...(reason !== undefined ? [element("p", { class: "cms-error" }, [reason])] : []));
            if (reason !== undefined) publishAt.setAttribute("aria-invalid", "true");
            else publishAt.removeAttribute("aria-invalid");
          }
          confirm.disabled = incomplete || past;
        };
        /** Back to a sheet that can be confirmed, after a run that left something to do. */
        const resume = () => {
          running = false;
          if (publishAt) publishAt.disabled = false;
          syncConfirm();
          confirm.focus();
        };
        const confirm: HTMLButtonElement = button(
          kind === "publish" ? strings.publish : strings.discard,
          async () => {
            if (running) return;
            // `min` isn't enforced on typed values, and the clock may have passed this time since it was typed. A
            // half-typed date reads as no date, so it would publish now.
            if (inPast() || publishAt?.validity.badInput === true) {
              syncConfirm();
              return;
            }
            running = true;
            confirm.disabled = true;
            if (publishAt) publishAt.disabled = true;
            // Focus can't stay on a disabled button, and Cancel is what a run still offers.
            cancel.focus();
            // A document listed only for a save on its way waits to see whether that save changed it. One already
            // changed needs no wait: its write goes on the chain behind its saves.
            const unconfirmed = [...rows.keys()].filter(
              (key) => only === undefined && session.documents.get(key)?.touched !== true,
            );
            await Promise.all(unconfirmed.map(writesSettled));
            if (!isOpen) return;
            recheckRows();
            if (rows.size === 0) return;
            // A document can lose its published version while the sheet is open. Say so before acting on it.
            const newWarnings = syncDeleteWarnings();
            if (newWarnings.length > 0) toast.announce(newWarnings.join(" "));
            if (newWarnings.length > 0 || inPast()) {
              resume();
              return;
            }
            const when = at();
            const action =
              kind === "discard" ? strings.discard : when !== undefined ? strings.schedule : strings.publish;
            const keys = [...rows.keys()];
            for (const [key, row] of rows) {
              row.notice?.remove();
              row.notice = undefined;
              // Nothing reviewed yet: this goes out on the session's version, even if the diff arrives meanwhile.
              if (row.review && row.review.version === undefined) {
                session.endReview(key, row.review);
                row.review = undefined;
              }
            }
            const failed: { key: string; error: unknown }[] = [];
            for (const key of keys) {
              // Closing the sheet stops what hasn't started; its reviews have ended, and nobody is looking.
              if (!isOpen) break;
              const row = rows.get(key);
              if (!row) continue;
              inFlight = key;
              try {
                if (kind === "publish") await publish(key, when, row.review);
                else await discard(key);
                row.item.remove();
                rows.delete(key);
                if (row.review) session.endReview(key, row.review);
              } catch (error) {
                // Reported below and by `lifecycle`; carry on with the rest.
                failed.push({ key, error });
                if (!isOpen && row.review) session.endReview(key, row.review);
              }
              inFlight = undefined;
            }
            const total = keys.length;
            const notDone = keys.filter((key) => rows.has(key));
            if (notDone.length === 0) {
              if (total > 1) toast.show(format(strings.bulkDone, { action, total }), "saved");
              if (isOpen) sheet.close();
              return;
            }
            const stopped = notDone.length > failed.length;
            const message = format(stopped ? strings.bulkStopped : strings.bulkPartial, {
              action,
              total,
              done: total - notDone.length,
              keys: notDone.join(", "),
            });
            if (stopped && failed.length === 0) {
              // Nothing went wrong, but it names what didn't go out, so it mustn't hide itself.
              toast.show(message, "info", [{ label: strings.close, onClick: () => toast.hide(), variant: "ghost" }]);
            } else if (total > 1) {
              toast.show(message, "error");
            }
            if (!isOpen) return;
            syncDeleteWarnings();
            await Promise.all(
              failed.map(({ key, error }) => {
                const row = rows.get(key);
                if (!row) return undefined;
                const conflict = kind === "publish" ? strings.publishConflict : strings.actionConflict;
                showNotice(row, failureText(action, key, error, conflict));
                return kind === "publish" && isConflict(error) ? review(key, row) : undefined;
              }),
            );
            if (!isOpen) return;
            resume();
          },
          kind === "publish" ? "primary" : "danger",
        );
        const cancel = button(strings.cancel, () => sheet.close(), "ghost");
        const actions = element("div", { class: "cms-sheet__actions" }, [cancel, confirm]);
        if (publishAt) {
          publishAt.min = localInputValue(new Date());
          publishAt.addEventListener("input", syncConfirm);
          publishAt.addEventListener("change", syncConfirm);
          // Clearing a date's last segments changes no `value`, so no `input` fires; the key's release still says so.
          publishAt.addEventListener("keyup", syncConfirm);
          const settleLeft = () => {
            // Escape, Cancel or Close may have ended the sheet: nobody is left to tell.
            if (!isOpen) return;
            if (publishAt.validity.badInput) incompleteLeft = true;
            syncConfirm();
          };
          // A press on Cancel or Publish blurs the input before its click. The line would push the buttons down under
          // the pointer and lose that click, so it waits until the press is over.
          let pressing = false;
          let afterPress: (() => void) | undefined;
          const release = () => {
            window.removeEventListener("pointerup", release, true);
            window.removeEventListener("pointercancel", release, true);
            pressing = false;
            const run = afterPress;
            afterPress = undefined;
            // After the click that this release dispatches.
            if (run) setTimeout(run, 0);
          };
          actions.addEventListener("pointerdown", () => {
            if (pressing) return;
            pressing = true;
            window.addEventListener("pointerup", release, true);
            window.addEventListener("pointercancel", release, true);
          });
          publishAt.addEventListener("blur", () => {
            if (pressing) afterPress = settleLeft;
            else setTimeout(settleLeft, 0);
          });
          body.append(element("label", { class: "cms-field-label" }, [strings.publishAt, publishAt]), pastNote);
        }
        body.append(actions);
        return () => {
          isOpen = false;
          for (const [key, row] of rows) if (row.review && key !== inFlight) session.endReview(key, row.review);
        };
      },
      opener,
    );
  }

  /** After a publish outside the sheet conflicted: the sheet, on that one document's updated diff. */
  function reviewConflict(key: string): void {
    openBulk("publish", publishButton, key);
  }

  function openRevisions(opener: HTMLElement): void {
    const keys = [...groupByDocument(fields).keys()];
    const recent = touchedDocuments().at(-1)?.key ?? keys[0];
    openSheet(
      strings.revisions,
      (body) => {
        const picker = element(
          "select",
          { class: "cms-input", "aria-label": strings.chooseDocument },
          keys.map((key) => element("option", { value: key }, [key])),
        );
        if (recent) picker.value = recent;
        const list = element("ol", { class: "cms-list cms-revisions", "aria-live": "polite" });
        const documentActions = element("div", { class: "cms-sheet__actions" });
        let request = 0;
        /** Swaps the drawer's actions for a prompt; nothing is written until Confirm. */
        const askFirst = (prompt: string, act: () => Promise<void>, refocus: () => void) => {
          const confirm: HTMLButtonElement = button(
            strings.confirm,
            async () => {
              confirm.disabled = true;
              cancel.disabled = true;
              try {
                await act();
              } catch {
                // Reported through the toast by the api call.
              }
              renderActions();
              void load();
              picker.focus();
            },
            "danger",
          );
          const cancel: HTMLButtonElement = button(
            strings.cancel,
            () => {
              renderActions();
              refocus();
            },
            "ghost",
          );
          documentActions.replaceChildren(element("p", {}, [prompt]), cancel, confirm);
          cancel.focus();
        };
        const renderActions = () => {
          const key = picker.value;
          const state = session.documents.get(key);
          documentActions.replaceChildren();
          if (!state?.access.publish || state.publishedAt === null) return;
          const unpublish: HTMLButtonElement = button(
            strings.unpublish,
            () =>
              askFirst(
                format(strings.unpublishConfirm, { key }),
                () => api.unpublish(key),
                () => documentActions.querySelector("button")?.focus(),
              ),
            "danger",
          );
          documentActions.append(unpublish);
        };
        const load = async () => {
          const ticket = ++request;
          const key = picker.value;
          const canRestore = session.documents.get(key)?.access.edit === true;
          list.replaceChildren();
          try {
            const revisions = await client.revisions(key);
            if (ticket !== request) return;
            if (revisions.length === 0) list.append(element("li", { class: "cms-muted" }, [strings.noRevisions]));
            for (const revision of revisions) {
              const restore: HTMLButtonElement | null = canRestore
                ? button(
                    strings.restore,
                    () =>
                      askFirst(
                        format(strings.restoreConfirm, {
                          action: revision.action,
                          time: formatTime(revision.createdAt),
                          key,
                        }),
                        () => api.restoreRevision(key, revision.id),
                        () => restore?.focus(),
                      ),
                    "ghost",
                    { "aria-label": format(strings.restoreRevisionLabel, { id: revision.id }) },
                  )
                : null;
              list.append(
                element("li", { "data-revision": String(revision.id) }, [
                  format(strings.revisionLine, {
                    action: revision.action,
                    actor: revision.actor ?? strings.unknownActor,
                  }),
                  " · ",
                  element("time", { datetime: revision.createdAt }, [formatTime(revision.createdAt)]),
                  " ",
                  restore,
                ]),
              );
            }
          } catch (error) {
            if (ticket === request) list.append(element("li", { class: "cms-error" }, [errorMessage(error, strings)]));
          }
        };
        picker.addEventListener("change", () => {
          renderActions();
          void load();
        });
        body.append(picker, documentActions, list);
        if (keys.length > 0) {
          renderActions();
          void load();
        }
        return () => {
          request += 1;
        };
      },
      opener,
    );
  }

  for (const panel of options.panels ?? []) {
    const opener: HTMLButtonElement = button(panel.label, () =>
      openSheet(
        panel.label,
        (body) => {
          const mounted = panel.mount(body, api);
          return () => mounted.destroy();
        },
        opener,
      ),
    );
    opener.dataset.panel = panel.id;
    actions.append(opener);
  }
  const revisionsButton: HTMLButtonElement = button(strings.revisions, () => openRevisions(revisionsButton), "ghost");
  const doneButton = button(
    strings.done,
    () => {
      setEditing(false);
      options.onExit?.();
    },
    "ghost",
  );
  const discardButton: HTMLButtonElement = button(strings.discard, () => openBulk("discard", discardButton), "danger");
  const publishButton: HTMLButtonElement = button(strings.publish, () => openBulk("publish", publishButton), "primary");
  actions.append(revisionsButton, doneButton, discardButton, publishButton);

  function failureText(action: string, key: string, error: unknown, conflict = strings.actionConflict): string {
    return format(isConflict(error) ? conflict : strings.actionFailed, {
      action,
      key,
      message: errorMessage(error, strings),
    });
  }

  /**
   * A lifecycle write on the document's chain. `task` applies the result itself, so the chain doesn't release until the
   * session is up to date (see `Session.run`). A failure becomes a toast and is rethrown to the caller. Starting one
   * cancels a popover still waiting on its fetch.
   */
  async function lifecycle<Result>(
    action: string,
    key: string,
    task: () => Promise<Result>,
    conflict = strings.actionConflict,
  ): Promise<Result> {
    openTicket += 1;
    try {
      return await session.run(key, task);
    } catch (error) {
      toast.show(failureText(action, key, error, conflict), "error");
      throw error;
    }
  }

  // A field left open through a catch-up (#48, ruled 2026-11-23, option A):
  // - A catch-up is `guarded` adopting a 409's `current` (Discard, Restore, Unpublish, list writes). Publish's repaint
  //   is not one.
  // - It marks the widget open on that document (`theirs`), unless the widget's slot has a save queued or on the wire:
  //   that save goes out after the catch-up whatever the widget does, and the widget started from it.
  // - A marked widget sends nothing. A commit that changed the value (leaving it, Enter, a swap's
  //   `closeActive(false, true)`) is held through `Session.holdConflict`, as a save answered with a 409 is; Esc or an
  //   unchanged commit shows the adopted value. After destroy it holds nothing and shows nothing.
  // - A slot holding a conflict sends only through Keep mine: `save` re-holds, `retry` does nothing.
  /**
   * Repaints the document's fields from a payload the session just took. A field with a save on its way keeps what the
   * editor committed. `closeOpen` is for writes that replace the content under an open widget.
   */
  function repaint(key: string, payload: unknown, closeOpen: boolean): void {
    for (const record of fields) {
      if (record.info.key !== key || session.committedValue(key, record.info.path)) continue;
      if (active?.record === record) {
        if (!closeOpen) continue;
        closeActive(false);
      }
      render(record, valueAtPath(payload, record.info.path), true);
      showState(record, "idle");
    }
    // A list's items may have come or gone with the content: only the page can draw them.
    void swapLists(key);
  }

  /**
   * The rule for Unpublish, Restore and Discard: send the version this session knows, and on a conflict do nothing but
   * catch up, so the page shows what the editor is deciding about. `task` receives the version to send.
   */
  function guarded<Result>(key: string, task: (expectedVersion: number | undefined) => Promise<Result>) {
    return async (): Promise<Result> => {
      try {
        return await task(session.documents.get(key)?.version);
      } catch (error) {
        if (isConflict(error) && error.current) {
          session.adopt(error.current);
          const open = active;
          if (open?.record.info.key === key && !open.slot.pending && !open.slot.sending) open.theirs = error.current;
          repaint(key, error.current.payload, false);
          updateBar();
        }
        throw error;
      }
    };
  }

  async function publish(key: string, at: string | undefined, review?: Review): Promise<void> {
    const document = await lifecycle(
      strings.publish,
      key,
      async () => {
        const expectedVersion = session.publishVersion(key, review);
        const known = session.documents.get(key)?.version;
        const written = await client.publish(key, { ...(at !== undefined ? { at } : {}), expectedVersion });
        // Scheduled, not published: the draft is still this session's change until it goes live.
        if (at !== undefined) session.applyWrite(expectedVersion, written);
        else session.settle(key, written);
        // The sheet showed a change this page hasn't: the session is at that version now, so the page must be too.
        if (expectedVersion !== known) repaint(key, written.payload, false);
        updateBar();
        return written;
      },
      strings.publishConflict,
    );
    if (at !== undefined) {
      toast.show(format(strings.scheduled, { key, time: formatTime(document.scheduledAt ?? at) }), "saved");
      return;
    }
    toast.show(format(strings.published, { key }), "saved");
  }

  function publishNow(key: string): void {
    publish(key, undefined).catch((error: unknown) => {
      if (isConflict(error)) reviewConflict(key);
    });
  }

  async function discard(key: string): Promise<void> {
    const document = await lifecycle(
      strings.discard,
      key,
      guarded(key, async (expectedVersion) => {
        const written = await client.discard(key, { expectedVersion });
        session.clearFailed(key);
        forgetRemovals(key);
        session.settle(key, written);
        if (written) repaint(key, written.payload, true);
        else {
          // Never published: the store deleted it, so there is nothing left to edit.
          for (const list of lists) if (list.info.key === key) list.detach?.();
          for (const record of fields) {
            if (record.info.key !== key) continue;
            if (active?.record === record) closeActive(false);
            record.detach?.();
            record.editable = false;
            record.reason = strings.unknownDocument;
          }
          session.documents.delete(key);
        }
        updateBar();
        return written;
      }),
    );
    toast.show(format(document ? strings.discarded : strings.discardedNeverPublished, { key }), "saved");
  }

  async function unpublish(key: string): Promise<void> {
    await lifecycle(
      strings.unpublish,
      key,
      guarded(key, async (expectedVersion) => {
        session.applyWrite(expectedVersion, await client.unpublish(key, { expectedVersion }));
        // Nothing changed in the draft, but it is no longer live: that is something to publish.
        session.touch(key);
        updateBar();
      }),
    );
    toast.show(format(strings.unpublished, { key }), "saved");
  }

  async function restoreRevision(key: string, revisionId: number): Promise<void> {
    // An edit still open goes onto the chain first, so the restore lands after it rather than under it.
    closeActive(false, true);
    await lifecycle(
      strings.restore,
      key,
      guarded(key, async (expectedVersion) => {
        const before = await session.document(key).then(
          (current) => current.payload,
          () => undefined,
        );
        const written = await client.restoreRevision(key, revisionId, { expectedVersion });
        session.applyWrite(expectedVersion, written);
        session.clearFailed(key);
        forgetRemovals(key);
        session.touch(
          key,
          diffPayloads(before, written.payload).map((entry) => entry.path),
        );
        repaint(key, written.payload, true);
        updateBar();
      }),
    );
    toast.show(format(strings.restored, { key }), "saved");
  }

  /** Takes the page's fields and lists afresh. A field's emptied state carries over to the same element. */
  function scan(): void {
    for (const record of fields) record.detach?.();
    for (const list of lists) list.detach?.();
    const previous = byElement;
    fields = scanFields(scanRoot);
    byElement = new Map(fields.map((record) => [record.element, record]));
    for (const record of fields) record.cleared = previous.get(record.element)?.cleared;
    lists = scanLists(scanRoot);
  }

  /** Marks each field editable or locked from what the session knows, and dresses fields and lists while editing. */
  function dress(): void {
    for (const record of fields) dressRecord(record);
    if (editing) for (const list of lists) attachListRecord(list);
    updateBar();
  }

  function dressRecord(record: FieldRecord): void {
    const state = session.documents.get(record.info.key);
    record.editable = state?.access.edit === true;
    record.reason = record.editable
      ? undefined
      : loadError
        ? strings.loadFailed
        : state
          ? strings.notEditable
          : strings.unknownDocument;
    if (editing) attachRecord(record);
  }

  const api: EditorApi = {
    documents: () => session.documents,
    async publish(key, publishOptions) {
      try {
        await publish(key, publishOptions?.at);
      } catch (error) {
        // A host panel has no sheet to show the updated diff in, so the toast leads to one.
        if (isConflict(error)) {
          toast.show(failureText(strings.publish, key, error, strings.publishConflict), "error", [
            { label: strings.reviewChanges, onClick: () => reviewConflict(key), variant: "primary" },
          ]);
        }
        throw error;
      }
    },
    discard,
    unpublish,
    restoreRevision,
    async refresh() {
      openTicket += 1;
      closeActive(false, true);
      scan();
      loadError = undefined;
      try {
        await session.load([...new Set([...groupByDocument(fields).keys(), ...lists.map((list) => list.info.key)])]);
        // The failure is resolved; its toast goes, unless something newer has replaced it.
        if (loadFailureToast !== undefined) toast.hideIf(loadFailureToast);
        loadFailureToast = undefined;
      } catch (error) {
        loadError = `${strings.loadFailed}: ${errorMessage(error, strings)}`;
        loadFailureToast = toast.show(loadError, "error", [
          { label: strings.retry, onClick: () => void api.refresh() },
        ]);
      }
      if (destroyed) return;
      dress();
    },
    status: (message: string, kind: StatusKind = "info") => {
      toast.show(message, kind);
    },
  };

  scanRoot.ownerDocument.body.append(chrome);
  updateBar();
  const ready = api.refresh();

  return {
    api,
    ready,
    destroy() {
      if (destroyed) return;
      destroyed = true;
      closeActive(false, true);
      sheet.close(false);
      toast.clearTimer();
      toast.cancelAnnounce();
      for (const record of fields) record.detach?.();
      for (const list of lists) list.detach?.();
      for (const removal of removals) clearTimeout(removal.timer);
      disposer.dispose();
      chrome.remove();
    },
  };
}
