import { element, uniqueId } from "./dom.js";
export function parseField(target) {
    const address = target.dataset.editField ?? "";
    const separator = address.lastIndexOf(":");
    if (separator <= 0 || separator === address.length - 1)
        return null;
    const info = {
        key: address.slice(0, separator),
        path: address.slice(separator + 1),
        // Kept as written: an unknown type still gets a highlight and a "No editor registered" message.
        type: (target.dataset.editType ?? "text"),
    };
    if (target.dataset.editLabel)
        info.label = target.dataset.editLabel;
    if (target.dataset.editOptions) {
        try {
            const options = JSON.parse(target.dataset.editOptions);
            if (Array.isArray(options))
                info.options = options.map(String);
        }
        catch {
            // A malformed list leaves the select with only its current value.
        }
    }
    return info;
}
/** Every `[data-edit-field]` under `root`, outside the chrome's own surfaces. */
export function scanFields(root) {
    const records = [];
    const candidates = [
        ...(root.matches("[data-edit-field]") ? [root] : []),
        ...root.querySelectorAll("[data-edit-field]"),
    ];
    for (const target of candidates) {
        if (target.closest(".cms-root"))
            continue;
        const info = parseField(target);
        if (!info)
            continue;
        records.push({
            element: target,
            info,
            id: `${info.key}:${info.path}`,
            editable: false,
            description: element("span", { id: uniqueId("cms-field-desc") }),
        });
    }
    return records;
}
export function groupByDocument(records) {
    const groups = new Map();
    for (const record of records) {
        const group = groups.get(record.info.key) ?? [];
        group.push(record);
        groups.set(record.info.key, group);
    }
    return groups;
}
export function badgeText(record) {
    const parts = [record.info.label ?? record.info.path, record.info.type];
    if (!record.editable && record.reason)
        parts.push(record.reason);
    return parts.join(" · ");
}
/** Adds the highlight. `hint` is read to assistive technology after the field's own content. */
export function attach(record, hint) {
    record.detach?.();
    const target = record.element;
    const previousTabindex = target.getAttribute("tabindex");
    const previousDescribedBy = target.getAttribute("aria-describedby");
    const hadClass = target.hasAttribute("class");
    record.description.textContent = record.editable ? `${badgeText(record)} · ${hint}` : badgeText(record);
    target.classList.add("cms-field");
    target.classList.toggle("cms-field--locked", !record.editable);
    target.dataset.cmsState = "idle";
    if (previousTabindex === null)
        target.tabIndex = 0;
    target.setAttribute("aria-describedby", previousDescribedBy ? `${previousDescribedBy} ${record.description.id}` : record.description.id);
    record.detach = () => {
        target.classList.remove("cms-field", "cms-field--locked", "cms-field--editing", "cms-field--saving", "cms-field--saved", "cms-field--failed");
        if (!hadClass && target.classList.length === 0)
            target.removeAttribute("class");
        delete target.dataset.cmsState;
        if (previousTabindex === null)
            target.removeAttribute("tabindex");
        if (previousDescribedBy === null)
            target.removeAttribute("aria-describedby");
        else
            target.setAttribute("aria-describedby", previousDescribedBy);
        record.description.remove();
        record.detach = undefined;
    };
}
export function showState(record, state) {
    const target = record.element;
    target.dataset.cmsState = state;
    for (const name of ["saving", "saved", "failed"])
        target.classList.toggle(`cms-field--${name}`, name === state);
}
/** One floating badge, moved to whichever field is hovered or focused. Positioned through custom properties. */
export class Badge {
    node = element("div", { class: "cms-badge", "aria-hidden": "true", hidden: true });
    show(record) {
        const rect = record.element.getBoundingClientRect();
        this.node.textContent = badgeText(record);
        this.node.classList.toggle("cms-badge--locked", !record.editable);
        this.node.style.setProperty("--cms-badge-top", `${rect.top}px`);
        this.node.style.setProperty("--cms-badge-left", `${rect.left}px`);
        this.node.hidden = false;
    }
    hide() {
        this.node.hidden = true;
    }
}
//# sourceMappingURL=fields.js.map