// `@yl/editor/chrome`: the in-place editor island. Framework-free and DOM-only; load it for signed-in editors only,
// alongside `@yl/editor/chrome/chrome.css`. See docs/chrome.md.
export { mountEditor } from "./mount.js";
export { createDefaultWidgets, defaultWidgets, missingWidget, openPopover } from "./widgets.js";
export { createContentClient, ContentRequestError } from "../http/client.js";
export { defaultStrings } from "./strings.js";
//# sourceMappingURL=index.js.map