// Rich text as page content, shared by the chrome's repaint and the rich text widget. DOM only: no TipTap and no zod,
// so `@yl/editor/chrome` can import it without pulling in the widget.
import { sanitizeRichText, type RichTextHeading } from "./sanitize.ts";

/** The heading levels a field allows: `data-edit-headings="2 3"`. */
export function headingLevels(target: HTMLElement): RichTextHeading[] {
  const tokens = (target.dataset.editHeadings ?? "").split(/[\s,]+/);
  return ([2, 3] as const).filter((level) => tokens.includes(String(level)));
}

/**
 * Already-sanitised HTML as nodes owned by `doc`. Parsed in an inert document and imported, so the live page never
 * sees `innerHTML` and nothing in the markup runs while it is parsed.
 */
export function parseRichText(html: string, doc: Document): Node[] {
  if (html === "") return [];
  const view = doc.defaultView ?? window;
  const parsed = new view.DOMParser().parseFromString(`<body>${html}</body>`, "text/html");
  return [...parsed.body.childNodes].map((node) => doc.importNode(node, true));
}

/** Replaces the field's content with `html`, sanitised to the stored shape and the headings the field allows. */
export function renderRichText(target: HTMLElement, html: string): void {
  const clean = sanitizeRichText(html, { headings: headingLevels(target) });
  target.replaceChildren(...parseRichText(clean, target.ownerDocument));
}
