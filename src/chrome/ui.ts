// The two shared surfaces: the status toast (one at a time, mirrored into a polite live region) and the sheet
// (one panel at a time; a side panel on wide screens, a bottom sheet under 40em).
import { button, element, uniqueId } from "./dom.ts";
import type { Strings } from "./strings.ts";
import type { StatusKind } from "./types.ts";

export interface ToastAction {
  label: string;
  onClick: () => void;
  variant?: "primary" | "danger" | "ghost";
}

const AUTO_HIDE_MS = 2600;
/**
 * How long the live region stays empty before a repeated message goes back in. Many screen readers ignore a polite
 * region set to the text it already holds; emptying it first, for longer than a frame, makes the repeat a change.
 */
const REANNOUNCE_MS = 100;

export class Toast {
  readonly node: HTMLElement;
  private timer: ReturnType<typeof setTimeout> | undefined;
  private announceTimer: ReturnType<typeof setTimeout> | undefined;
  private shown = 0;

  constructor(
    private readonly live: HTMLElement,
    private readonly strings: Strings,
  ) {
    this.node = element("div", { class: "cms-toast", hidden: true });
  }

  /**
   * Replaces whatever toast is showing. Info and saved toasts without actions hide themselves. Returns a token for
   * `hideIf`.
   */
  show(message: string, kind: StatusKind = "info", actions: readonly ToastAction[] = []): number {
    this.clearTimer();
    this.shown += 1;
    this.node.dataset.kind = kind;
    const buttons = actions.map((action) => button(action.label, action.onClick, action.variant));
    if (kind === "error") buttons.push(button(this.strings.close, () => this.hide(), "ghost"));
    this.node.replaceChildren(
      element("p", { class: "cms-toast__message" }, [message]),
      element("div", { class: "cms-toast__actions" }, buttons),
    );
    this.node.hidden = false;
    this.announce(message);
    if (actions.length === 0 && (kind === "info" || kind === "saved")) {
      this.timer = setTimeout(() => this.hide(), AUTO_HIDE_MS);
    }
    return this.shown;
  }

  /** Hides the toast `show` returned `token` for, if it is still the one showing. */
  hideIf(token: number): void {
    if (token === this.shown && !this.node.hidden) this.hide();
  }

  /** Whether an error toast is showing: it stays until dismissed or resolved, so nothing should replace it. */
  get showingError(): boolean {
    return !this.node.hidden && this.node.dataset.kind === "error";
  }

  /** Puts `message` in the live region. The same message again is announced again. */
  announce(message: string): void {
    this.cancelAnnounce();
    if (this.live.textContent !== message) {
      this.live.textContent = message;
      return;
    }
    this.live.textContent = "";
    this.announceTimer = setTimeout(() => {
      this.announceTimer = undefined;
      this.live.textContent = message;
    }, REANNOUNCE_MS);
  }

  /** Drops a repeated message still waiting to go back in the live region. */
  cancelAnnounce(): void {
    if (this.announceTimer !== undefined) clearTimeout(this.announceTimer);
    this.announceTimer = undefined;
  }

  hide(): void {
    this.clearTimer();
    this.node.hidden = true;
    this.node.replaceChildren();
  }

  clearTimer(): void {
    if (this.timer !== undefined) clearTimeout(this.timer);
    this.timer = undefined;
  }
}

export class Sheet {
  readonly node: HTMLElement;
  private readonly title: HTMLElement;
  private readonly body: HTMLElement;
  private teardown: (() => void) | undefined;
  private opener: HTMLElement | undefined;

  constructor(strings: Strings) {
    const titleId = uniqueId("cms-sheet-title");
    this.title = element("h2", { class: "cms-sheet__title", id: titleId });
    this.body = element("div", { class: "cms-sheet__body" });
    this.node = element(
      "section",
      { class: "cms-panel cms-sheet", role: "dialog", "aria-labelledby": titleId, hidden: true },
      [
        element("header", { class: "cms-sheet__header" }, [
          this.title,
          button(strings.close, () => this.close(), "ghost"),
        ]),
        this.body,
      ],
    );
  }

  get isOpen(): boolean {
    return !this.node.hidden;
  }

  /** Opens with fresh content. `build` may return a teardown, run when the sheet closes or is replaced. */
  open(title: string, build: (body: HTMLElement) => (() => void) | void, opener?: HTMLElement): void {
    this.close(false);
    this.opener = opener;
    this.title.textContent = title;
    this.node.hidden = false;
    this.teardown = build(this.body) ?? undefined;
    const first = this.body.querySelector<HTMLElement>("button, select, input, textarea, a[href], [tabindex]");
    (first ?? this.node.querySelector<HTMLElement>("button"))?.focus();
  }

  close(returnFocus = true): void {
    if (this.node.hidden) return;
    this.teardown?.();
    this.teardown = undefined;
    this.body.replaceChildren();
    this.node.hidden = true;
    if (returnFocus) this.opener?.focus();
    this.opener = undefined;
  }
}
