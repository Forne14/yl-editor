// `mountEditor`: wires the scanned fields, the save queue, the bar, the toast and the sheet together.
import { diffPayloads, type DiffEntry } from "../diff.ts";
import { ContentRequestError, createContentClient } from "../http/client.ts";
import { Disposer, button, element, valueAtPath } from "./dom.ts";
import { Badge, attach, groupByDocument, scanFields, showState, type FieldRecord } from "./fields.ts";
import { Session, type SaveSlot } from "./session.ts";
import { defaultStrings, format, type Strings } from "./strings.ts";
import type {
  EditorApi,
  EditorHandle,
  EditorOptions,
  StatusKind,
  Widget,
  WidgetContext,
  WidgetHandle,
} from "./types.ts";
import { Sheet, Toast } from "./ui.ts";
import { createDefaultWidgets, missingWidget } from "./widgets.ts";

interface ActiveWidget {
  record: FieldRecord;
  handle: WidgetHandle | undefined;
  closed: boolean;
}

const TEXT_TYPES = new Set(["text", "richtext"]);

function sameValue(left: unknown, right: unknown): boolean {
  return JSON.stringify(left) === JSON.stringify(right);
}

function errorMessage(error: unknown, strings: Strings): string {
  if (error instanceof ContentRequestError) return error.message;
  // Anything else came from fetch itself: the server could not be reached.
  return strings.networkError;
}

/**
 * The starting value of an in-place text edit: the payload's when we have it, else the text being edited (the
 * element is the editor, so its text is what the editor starts from). Every other type reads the fetched payload.
 */
function textValue(record: FieldRecord, payload: unknown): unknown {
  const fromPayload = payload === undefined ? undefined : valueAtPath(payload, record.info.path);
  return fromPayload !== undefined ? fromPayload : (record.element.textContent ?? "").trim();
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

/** A `datetime-local` value (wall-clock time, no zone) as an ISO string with the browser's offset. */
function localToIso(value: string): string | undefined {
  const when = new Date(value);
  if (value === "" || Number.isNaN(when.getTime())) return undefined;
  const offset = -when.getTimezoneOffset();
  const sign = offset >= 0 ? "+" : "-";
  const zone = `${sign}${pad(Math.floor(Math.abs(offset) / 60))}:${pad(Math.abs(offset) % 60)}`;
  return (
    `${when.getFullYear()}-${pad(when.getMonth() + 1)}-${pad(when.getDate())}` +
    `T${pad(when.getHours())}:${pad(when.getMinutes())}:${pad(when.getSeconds())}${zone}`
  );
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

  const session = new Session(
    client,
    {
      stateChanged(slot) {
        for (const record of recordsFor(slot)) showState(record, slot.state);
        if (slot.state === "saving") toast.show(strings.saving, "saving");
        updateBar();
      },
      saved(slot, value) {
        for (const record of recordsFor(slot)) if (!TEXT_TYPES.has(record.info.type)) render(record, value);
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

  /** Repaint a host element after a value changed underneath it, if it is plain text we can safely replace. */
  function render(record: FieldRecord, value: unknown): void {
    const target = record.element;
    if (target.children.length === 0 && record.info.type !== "toggle" && value !== undefined) {
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
    for (const record of recordsFor(slot)) render(record, valueAtPath(payload, slot.path));
    toast.hide();
  }

  function touchedDocuments() {
    return [...session.documents.values()].filter((state) => state.touched);
  }

  function updateBar(): void {
    const touched = touchedDocuments();
    const fieldCount = touched.reduce((sum, state) => sum + state.touchedPaths.size, 0);
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
          state.access.publish
            ? button(strings.publishNow, () => void api.publish(state.key).catch(() => undefined), "ghost")
            : null,
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
    let initial: unknown;
    if (TEXT_TYPES.has(info.type) || !registered) {
      initial = textValue(record, session.documents.get(info.key)?.payload);
    } else {
      // Popover widgets start from the stored value, never from what the page happens to render.
      try {
        initial = valueAtPath((await session.document(info.key)).payload, info.path);
      } catch (error) {
        if (ticket === openTicket && !destroyed)
          toast.show(format(strings.loadFieldFailed, { message: errorMessage(error, strings) }), "error");
        return;
      }
      if (ticket !== openTicket || destroyed || !editing) return;
      updateBar();
    }
    const opened: ActiveWidget = { record, handle: undefined, closed: false };
    const context: WidgetContext = {
      element: record.element,
      field: { ...info, options: info.options ? [...info.options] : undefined },
      value: initial,
      async commit(next) {
        if (opened.closed) return;
        if (active === opened) closeActive(true);
        opened.closed = true;
        if (!sameValue(next, initial)) await session.save(info.key, info.path, next);
      },
      cancel() {
        if (opened.closed) return;
        if (active === opened) closeActive(true);
        opened.closed = true;
      },
      announce: (message) => toast.announce(message),
    };
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

  function fillChanges(key: string, target: HTMLElement, isOpen: () => boolean): void {
    target.append(element("p", { class: "cms-muted" }, [strings.loadingChanges]));
    const note = (text: string, className = "cms-muted") =>
      target.replaceChildren(element("p", { class: className }, [text]));
    changesOf(key).then(
      (changes) => {
        if (!isOpen()) return;
        if (changes === null) note(strings.firstPublish);
        else if (changes.length === 0) note(strings.noDifferences);
        else target.replaceChildren(element("ul", { class: "cms-list" }, changes.map(changeLine)));
      },
      (error: unknown) => {
        if (isOpen()) note(format(strings.changesFailed, { message: errorMessage(error, strings) }), "cms-error");
      },
    );
  }

  // Bulk publish and discard act on touched documents the user may publish, listed before anything happens.
  function openBulk(kind: "publish" | "discard", opener: HTMLElement): void {
    const touched = touchedDocuments();
    const eligible = touched.filter((state) => (kind === "publish" ? state.access.publish : state.access.edit));
    const title = kind === "publish" ? strings.publishTitle : strings.discardTitle;
    sheet.open(
      title,
      (body) => {
        let isOpen = true;
        if (eligible.length === 0) {
          body.append(element("p", {}, [kind === "publish" ? strings.nothingToPublish : strings.nothingToDiscard]));
          return;
        }
        body.append(
          element(
            "ul",
            { class: "cms-list" },
            eligible.map((state) => {
              const item = element("li", { "data-key": state.key }, [
                element("b", {}, [state.key]),
                ` · ${state.touchedPaths.size}`,
              ]);
              if (kind === "publish") {
                const changes = element("div", { class: "cms-diff" });
                item.append(changes);
                fillChanges(state.key, changes, () => isOpen);
              }
              return item;
            }),
          ),
        );
        const others = touched.length - eligible.length;
        if (others > 0) {
          body.append(
            element("p", { class: "cms-muted" }, [
              format(kind === "publish" ? strings.othersNeedPublisher : strings.othersNeedEditor, { count: others }),
            ]),
          );
        }
        const publishAt = element("input", { class: "cms-input", type: "datetime-local" });
        const at = () => localToIso(publishAt.value);
        const confirm = button(
          kind === "publish" ? strings.publish : strings.discard,
          async () => {
            confirm.disabled = true;
            const when = at();
            for (const state of eligible) {
              try {
                if (kind === "publish") await api.publish(state.key, when !== undefined ? { at: when } : undefined);
                else await api.discard(state.key);
              } catch {
                // Reported through the toast by api.publish / api.discard; carry on with the rest.
              }
            }
            sheet.close();
          },
          kind === "publish" ? "primary" : "danger",
        );
        if (kind === "publish") {
          const syncConfirm = () => {
            confirm.textContent = at() !== undefined ? strings.schedule : strings.publish;
            // A half-typed date reads as empty; publishing right now would be the wrong guess.
            confirm.disabled = publishAt.validity.badInput;
          };
          publishAt.addEventListener("input", syncConfirm);
          publishAt.addEventListener("change", syncConfirm);
          body.append(element("label", { class: "cms-field-label" }, [strings.publishAt, publishAt]));
        }
        body.append(
          element("div", { class: "cms-sheet__actions" }, [
            button(strings.cancel, () => sheet.close(), "ghost"),
            confirm,
          ]),
        );
        return () => {
          isOpen = false;
        };
      },
      opener,
    );
  }

  function openRevisions(opener: HTMLElement): void {
    const keys = [...groupByDocument(fields).keys()];
    const recent = touchedDocuments().at(-1)?.key ?? keys[0];
    sheet.open(
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
      sheet.open(
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

  /** A lifecycle write on the document's chain; a failure becomes a toast and is rethrown to the caller. */
  async function lifecycle<Result>(action: string, key: string, task: () => Promise<Result>): Promise<Result> {
    try {
      return await session.run(key, task);
    } catch (error) {
      toast.show(format(strings.actionFailed, { action, key, message: errorMessage(error, strings) }), "error");
      throw error;
    }
  }

  async function publish(key: string, at: string | undefined): Promise<void> {
    const document = await lifecycle(strings.publish, key, () =>
      client.publish(key, at !== undefined ? { at } : undefined),
    );
    if (at !== undefined) {
      // Scheduled, not published: the draft is still this session's change until it goes live.
      session.adopt(document);
      updateBar();
      toast.show(format(strings.scheduled, { key, time: formatTime(document.scheduledAt ?? at) }), "saved");
      return;
    }
    session.settle(key, document);
    updateBar();
    toast.show(format(strings.published, { key }), "saved");
  }

  async function discard(key: string): Promise<void> {
    const document = await lifecycle(strings.discard, key, () => client.discard(key));
    session.settle(key, document);
    for (const record of fields) {
      if (record.info.key !== key) continue;
      if (document) {
        render(record, valueAtPath(document.payload, record.info.path));
        showState(record, "idle");
      } else {
        // Never published: the store deleted it, so there is nothing left to edit.
        if (active?.record === record) closeActive(false);
        record.detach?.();
        record.editable = false;
        record.reason = strings.unknownDocument;
      }
    }
    if (!document) session.documents.delete(key);
    updateBar();
    toast.show(format(document ? strings.discarded : strings.discardedNeverPublished, { key }), "saved");
  }

  async function unpublish(key: string): Promise<void> {
    const document = await lifecycle(strings.unpublish, key, () => client.unpublish(key));
    session.adopt(document);
    updateBar();
    toast.show(format(strings.unpublished, { key }), "saved");
  }

  async function restoreRevision(key: string, revisionId: number): Promise<void> {
    // An edit still open goes onto the chain first, so the restore lands after it rather than under it.
    closeActive(false, true);
    let before: unknown;
    const document = await lifecycle(strings.restore, key, async () => {
      before = await session.document(key).then(
        (current) => current.payload,
        () => undefined,
      );
      return client.restoreRevision(key, revisionId);
    });
    session.adopt(document);
    session.touch(
      key,
      diffPayloads(before, document.payload).map((entry) => entry.path),
    );
    for (const record of fields) {
      if (record.info.key !== key) continue;
      if (active?.record === record) closeActive(false);
      render(record, valueAtPath(document.payload, record.info.path));
      showState(record, "idle");
    }
    updateBar();
    toast.show(format(strings.restored, { key }), "saved");
  }

  const api: EditorApi = {
    documents: () => session.documents,
    publish: (key, options) => publish(key, options?.at),
    discard,
    unpublish,
    restoreRevision,
    async refresh() {
      openTicket += 1;
      closeActive(false, true);
      for (const record of fields) record.detach?.();
      fields = scanFields(scanRoot);
      byElement = new Map(fields.map((record) => [record.element, record]));
      let loadError: string | undefined;
      try {
        await session.load([...groupByDocument(fields).keys()]);
      } catch (error) {
        loadError = `${strings.loadFailed}: ${errorMessage(error, strings)}`;
        toast.show(loadError, "error", [{ label: strings.retry, onClick: () => void api.refresh() }]);
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
    status: (message: string, kind: StatusKind = "info") => toast.show(message, kind),
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
      for (const record of fields) record.detach?.();
      disposer.dispose();
      chrome.remove();
    },
  };
}
