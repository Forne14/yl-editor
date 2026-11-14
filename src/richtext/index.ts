// `@yl/editor/richtext`: the rich text widget, built on TipTap (an optional peer dependency). Import it only where
// editors load the chrome; `@yl/editor/chrome` never imports it. The server half, `sanitizeRichText` and `richText`,
// comes from `@yl/editor`. See docs/chrome.md → Rich text.
export { createRichTextWidget, richTextWidget, type RichTextWidgetOptions } from "./widget.ts";
