// `mountEditor`: wires the scanned fields, the save queue, the bar, the toast and the sheet together.
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

/** The value a field holds now: the server's payload once we have it, else what the page renders. */
function readValue(record: FieldRecord, payload: unknown): unknown {
  const fromPayload = payload === undefined ? undefined : valueAtPath(payload, record.info.path);
  if (fromPayload !== undefined) return fromPayload;
  const rendered = record.element.dataset.editValue;
  if (rendered !== undefined) {
    try {
      return JSON.parse(rendered);
    } catch {
      return rendered;
    }
  }
  const text = (record.element.textContent ?? "").trim();
  switch (record.info.type) {
    case "number":
      return text === "" || !Number.isFinite(Number(text)) ? null : Number(text);
    case "toggle":
      return false;
    case "tags":
      return text === "" ? [] : text.split(",").map((part) => part.trim());
    default:
      return text;
  }
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
  const actions = element("div", { class: "cms-bar__actions" });
  const bar = element("div", { class: "cms-bar", role: "region", "aria-label": strings.editingRegion }, [
    element("div", { class: "cms-bar__state" }, [stateLine, changesLine]),
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
  }

  function closeActive(returnFocus: boolean): void {
    const current = active;
    if (!current) return;
    current.closed = true;
    active = null;
    current.handle?.destroy();
    current.record.element.classList.remove("cms-field--editing");
    if (returnFocus && !destroyed) current.record.element.focus();
  }

  function openField(record: FieldRecord): void {
    if (!record.editable) {
      toast.show(record.reason ?? strings.notEditable, "info");
      return;
    }
    closeActive(false);
    const { info } = record;
    const widget = widgets[info.type] ?? missingWidget(strings, info.type);
    const initial = readValue(record, session.documents.get(info.key)?.payload);
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
      closeActive(false);
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
      if (active?.record !== record) openField(record);
    },
    { capture: true },
  );
  disposer.listen(scanRoot, "keydown", (event) => {
    const record = fieldFrom(event);
    if (!record || event.defaultPrevented || event.target !== record.element || active?.record === record) return;
    if ((event as KeyboardEvent).key !== "Enter") return;
    event.preventDefault();
    openField(record);
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

  // Bulk publish and discard act on touched documents the user may publish, listed before anything happens.
  function openBulk(kind: "publish" | "discard", opener: HTMLElement): void {
    const touched = touchedDocuments();
    const eligible = touched.filter((state) => state.access.publish);
    const title = kind === "publish" ? strings.publishTitle : strings.discardTitle;
    sheet.open(
      title,
      (body) => {
        if (eligible.length === 0) {
          body.append(element("p", {}, [kind === "publish" ? strings.nothingToPublish : strings.nothingToDiscard]));
          return;
        }
        body.append(
          element(
            "ul",
            { class: "cms-list" },
            eligible.map((state) =>
              element("li", { "data-key": state.key }, [
                element("b", {}, [state.key]),
                ` · ${state.touchedPaths.size}`,
              ]),
            ),
          ),
        );
        const others = touched.length - eligible.length;
        if (others > 0) {
          body.append(element("p", { class: "cms-muted" }, [format(strings.othersNeedPublisher, { count: others })]));
        }
        const confirm = button(
          kind === "publish" ? strings.publish : strings.discard,
          async () => {
            confirm.disabled = true;
            for (const state of eligible) {
              try {
                await api[kind](state.key);
              } catch {
                // Reported through the toast by api.publish / api.discard; carry on with the rest.
              }
            }
            sheet.close();
          },
          kind === "publish" ? "primary" : "danger",
        );
        body.append(
          element("div", { class: "cms-sheet__actions" }, [
            button(strings.cancel, () => sheet.close(), "ghost"),
            confirm,
          ]),
        );
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
        let request = 0;
        const load = async () => {
          const ticket = ++request;
          list.replaceChildren();
          try {
            const revisions = await client.revisions(picker.value);
            if (ticket !== request) return;
            if (revisions.length === 0) list.append(element("li", { class: "cms-muted" }, [strings.noRevisions]));
            for (const revision of revisions) {
              const when = new Date(revision.createdAt);
              list.append(
                element("li", {}, [
                  format(strings.revisionLine, {
                    action: revision.action,
                    actor: revision.actor ?? strings.unknownActor,
                  }),
                  " · ",
                  element("time", { datetime: revision.createdAt }, [
                    Number.isNaN(when.getTime()) ? revision.createdAt : when.toLocaleString(),
                  ]),
                ]),
              );
            }
          } catch (error) {
            if (ticket === request) list.append(element("li", { class: "cms-error" }, [errorMessage(error, strings)]));
          }
        };
        picker.addEventListener("change", () => void load());
        body.append(picker, list);
        if (keys.length > 0) void load();
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

  async function settle(kind: "publish" | "discard", key: string): Promise<void> {
    try {
      const document = kind === "publish" ? await client.publish(key) : await client.discard(key);
      session.settle(key, document);
      if (kind === "discard") {
        for (const record of fields) {
          if (record.info.key !== key) continue;
          if (document) render(record, valueAtPath(document.payload, record.info.path));
          showState(record, "idle");
        }
      }
      updateBar();
      const message = format(kind === "publish" ? strings.published : strings.discarded, { key });
      toast.show(document || kind === "publish" ? message : `${message}. ${strings.reloadToSee}`, "saved");
    } catch (error) {
      toast.show(
        format(strings.actionFailed, {
          action: kind === "publish" ? strings.publish : strings.discard,
          key,
          message: errorMessage(error, strings),
        }),
        "error",
      );
      throw error;
    }
  }

  const api: EditorApi = {
    documents: () => session.documents,
    publish: (key) => settle("publish", key),
    discard: (key) => settle("discard", key),
    async refresh() {
      closeActive(false);
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
      closeActive(false);
      sheet.close(false);
      toast.clearTimer();
      for (const record of fields) record.detach?.();
      disposer.dispose();
      chrome.remove();
    },
  };
}
