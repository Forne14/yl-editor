// `mountEditor`: wires the scanned fields, the save queue, the bar, the toast and the sheet together.
import { diffPayloads, type DiffEntry } from "../diff.ts";
import { renderRichText } from "../richtext/render.ts";
import { ContentRequestError, createContentClient } from "../http/client.ts";
import { Disposer, button, element, uniqueId, valueAtPath } from "./dom.ts";
import { Badge, attach, groupByDocument, scanFields, showState, type FieldRecord } from "./fields.ts";
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
} from "./types.ts";
import { Sheet, Toast } from "./ui.ts";
import { createDefaultWidgets, missingWidget, provideStatus, provideStrings } from "./widgets.ts";

interface ActiveWidget {
  record: FieldRecord;
  handle: WidgetHandle | undefined;
  closed: boolean;
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
        for (const record of recordsFor(slot)) showState(record, slot.state);
        if (slot.state === "saving") toast.show(strings.saving, "saving");
        updateBar();
      },
      saved(slot, value) {
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
    const opened: ActiveWidget = { record, handle: undefined, closed: false };
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
        if (!sameValue(next, initial) || slot.state === "failed") await session.save(info.key, info.path, next);
      },
      cancel() {
        if (opened.closed) return;
        if (active === opened) closeActive(true);
        opened.closed = true;
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
      enterButton.blur();
    } else {
      openTicket += 1;
      closeActive(false, true);
      sheet.close(false);
      badge.hide();
      for (const record of fields) record.detach?.();
      enterButton.focus();
    }
  }

  function attachRecord(record: FieldRecord): void {
    descriptions.append(record.description);
    attach(record, strings.pressEnterToEdit);
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
            // `min` isn't enforced on typed values, and the clock may have passed this time since it was typed.
            if (inPast()) {
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
        if (publishAt) {
          publishAt.min = localInputValue(new Date());
          publishAt.addEventListener("input", syncConfirm);
          publishAt.addEventListener("change", syncConfirm);
          // Clearing a date's last segments changes no `value`, so no `input` fires; the key's release still says so.
          publishAt.addEventListener("keyup", syncConfirm);
          publishAt.addEventListener("blur", () => {
            if (publishAt.validity.badInput) incompleteLeft = true;
            syncConfirm();
          });
          body.append(element("label", { class: "cms-field-label" }, [strings.publishAt, publishAt]), pastNote);
        }
        body.append(element("div", { class: "cms-sheet__actions" }, [cancel, confirm]));
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
        session.settle(key, written);
        if (written) repaint(key, written.payload, true);
        else {
          // Never published: the store deleted it, so there is nothing left to edit.
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
      for (const record of fields) record.detach?.();
      const previous = byElement;
      fields = scanFields(scanRoot);
      byElement = new Map(fields.map((record) => [record.element, record]));
      for (const record of fields) record.cleared = previous.get(record.element)?.cleared;
      let loadError: string | undefined;
      try {
        await session.load([...groupByDocument(fields).keys()]);
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
      for (const record of fields) {
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
      updateBar();
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
      disposer.dispose();
      chrome.remove();
    },
  };
}
