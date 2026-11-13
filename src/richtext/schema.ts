import { z } from "zod";
import { sanitizeRichText, type RichTextOptions } from "./sanitize.ts";

/**
 * A zod schema for a rich text field: a string, run through `sanitizeRichText` on every parse. A store that keeps the
 * parsed payload (the SQLite store does) stores the clean shape; any store serves it on validated reads.
 */
export function richText(options: RichTextOptions = {}) {
  return z.string().transform((html) => sanitizeRichText(html, options));
}
