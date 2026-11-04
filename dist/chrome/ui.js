// The two shared surfaces: the status toast (one at a time, mirrored into a polite live region) and the sheet
// (one panel at a time; a side panel on wide screens, a bottom sheet under 40em).
import { button, element, uniqueId } from "./dom.js";
const AUTO_HIDE_MS = 2600;
export class Toast {
    live;
    strings;
    node;
    timer;
    constructor(live, strings) {
        this.live = live;
        this.strings = strings;
        this.node = element("div", { class: "cms-toast", hidden: true });
    }
    /** Replaces whatever toast is showing. Info and saved toasts without actions hide themselves. */
    show(message, kind = "info", actions = []) {
        this.clearTimer();
        this.node.dataset.kind = kind;
        const buttons = actions.map((action) => button(action.label, action.onClick, action.variant));
        if (kind === "error")
            buttons.push(button(this.strings.close, () => this.hide(), "ghost"));
        this.node.replaceChildren(element("p", { class: "cms-toast__message" }, [message]), element("div", { class: "cms-toast__actions" }, buttons));
        this.node.hidden = false;
        this.announce(message);
        if (actions.length === 0 && (kind === "info" || kind === "saved")) {
            this.timer = setTimeout(() => this.hide(), AUTO_HIDE_MS);
        }
    }
    announce(message) {
        this.live.textContent = message;
    }
    hide() {
        this.clearTimer();
        this.node.hidden = true;
        this.node.replaceChildren();
    }
    clearTimer() {
        if (this.timer !== undefined)
            clearTimeout(this.timer);
        this.timer = undefined;
    }
}
export class Sheet {
    node;
    title;
    body;
    teardown;
    opener;
    constructor(strings) {
        const titleId = uniqueId("cms-sheet-title");
        this.title = element("h2", { class: "cms-sheet__title", id: titleId });
        this.body = element("div", { class: "cms-sheet__body" });
        this.node = element("section", { class: "cms-panel cms-sheet", role: "dialog", "aria-labelledby": titleId, hidden: true }, [
            element("header", { class: "cms-sheet__header" }, [
                this.title,
                button(strings.close, () => this.close(), "ghost"),
            ]),
            this.body,
        ]);
    }
    get isOpen() {
        return !this.node.hidden;
    }
    /** Opens with fresh content. `build` may return a teardown, run when the sheet closes or is replaced. */
    open(title, build, opener) {
        this.close(false);
        this.opener = opener;
        this.title.textContent = title;
        this.node.hidden = false;
        this.teardown = build(this.body) ?? undefined;
        const first = this.body.querySelector("button, select, input, textarea, a[href], [tabindex]");
        (first ?? this.node.querySelector("button"))?.focus();
    }
    close(returnFocus = true) {
        if (this.node.hidden)
            return;
        this.teardown?.();
        this.teardown = undefined;
        this.body.replaceChildren();
        this.node.hidden = true;
        if (returnFocus)
            this.opener?.focus();
        this.opener = undefined;
    }
}
//# sourceMappingURL=ui.js.map