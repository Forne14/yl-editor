// Server-side rendering of the demo page. Visitors get the published view and no editor markup; editors get the
// draft view, `editable()` attributes on every field and the island.
import { editable, type StoredDocument } from "@yl/editor";
import { ROLE_LABELS, STATUS_OPTIONS, type Session } from "./content.ts";

export const escapeHtml = (value: string): string =>
  value.replace(/[&<>"']/g, (character) => `&#${character.charCodeAt(0)};`);

const attributes = (record: Record<string, string>): string =>
  Object.entries(record)
    .map(([name, value]) => ` ${name}="${escapeHtml(value)}"`)
    .join("");

const payloadOf = (document: StoredDocument | null): Record<string, unknown> => {
  const payload = document?.payload;
  return typeof payload === "object" && payload !== null && !Array.isArray(payload)
    ? (payload as Record<string, unknown>)
    : {};
};

const text = (value: unknown): string =>
  typeof value === "string" ? value : value === undefined || value === null ? "" : JSON.stringify(value);

const MONTHS = ["Jan", "Feb", "Mar", "Apr", "May", "Jun", "Jul", "Aug", "Sep", "Oct", "Nov", "Dec"];

/** "2026-11-14" as "14 Nov 2026", so a test can prove the date widget opens from the stored value, not this text. */
export function formatDate(value: unknown): string {
  if (typeof value !== "string") return "";
  const match = /^(\d{4})-(\d{2})-(\d{2})$/.exec(value);
  if (!match) return value;
  const month = MONTHS[Number(match[2]) - 1];
  return month ? `${Number(match[3])} ${month} ${match[1]}` : value;
}

export interface PageDocuments {
  home: StoredDocument | null;
  about: StoredDocument | null;
  settings: StoredDocument | null;
}

export interface RenderOptions {
  session: Session;
  /** Render the editor: editable attributes, the stylesheet and the island. */
  editing: boolean;
  scheduling: boolean;
  /** Leave `richtext` to the default widget, the plain-text fallback, instead of `@yl/editor/richtext`. */
  richtextFallback?: boolean;
}

export function renderPage(documents: PageDocuments, options: RenderOptions): string {
  const { editing } = options;
  const homeField = editable(editing ? "pages/home" : undefined);
  const aboutField = editable(editing ? "pages/about" : undefined);
  const settingsField = editable(editing ? "settings/site" : undefined);
  const home = payloadOf(documents.home);
  const about = payloadOf(documents.about);
  const settings = payloadOf(documents.settings);
  const tags = Array.isArray(home["tags"]) ? home["tags"].map(text) : [];

  const head = [
    `<meta charset="utf-8">`,
    `<meta name="viewport" content="width=device-width, initial-scale=1">`,
    `<title>Demo Bakery</title>`,
    `<link rel="icon" href="/favicon.svg" type="image/svg+xml">`,
    `<link rel="stylesheet" href="/site.css">`,
    ...(editing
      ? [`<link rel="stylesheet" href="/pkg/chrome/chrome.css">`, `<script type="module" src="/editor.js"></script>`]
      : []),
  ].join("\n    ");

  const bodyAttributes = editing
    ? attributes({
        "data-actor-label": `Editing as ${ROLE_LABELS[options.session.role]}`,
        ...(options.scheduling ? { "data-scheduling": "1" } : {}),
        ...(options.richtextFallback ? { "data-richtext": "fallback" } : {}),
      })
    : "";

  return `<!doctype html>
<html lang="en">
  <head>
    ${head}
  </head>
  <body${bodyAttributes}>
    <main class="page">
      <section class="hero" aria-labelledby="home-title">
        <h1 id="home-title"${attributes(homeField("title", "text", { label: "Heading" }))}>${escapeHtml(text(home["title"]))}</h1>
        <div class="lede"${attributes(homeField("lede", "richtext", { label: "Lede", headings: [2, 3] }))}>${text(home["lede"])}</div>
      </section>
      <dl class="facts">
        <dt>Open</dt>
        <dd id="home-live"${attributes(homeField("live", "toggle", { label: "Open" }))}>${home["live"] === true ? "Live" : "Off"}</dd>
        <dt>Status</dt>
        <dd id="home-status"${attributes(homeField("status", "select", { label: "Status", options: STATUS_OPTIONS }))}>${escapeHtml(text(home["status"]))}</dd>
        <dt>Price</dt>
        <dd id="home-price"${attributes(homeField("price", "number", { label: "Price" }))}>${escapeHtml(text(home["price"]))}</dd>
        <dt>Tags</dt>
        <dd id="home-tags"${attributes(homeField("tags", "tags", { label: "Tags" }))}>${escapeHtml(tags.join(", "))}</dd>
        <dt>Next bake</dt>
        <dd id="home-date"${attributes(homeField("date", "date", { label: "Next bake" }))}>${escapeHtml(formatDate(home["date"]))}</dd>
        <dt>Menu</dt>
        <dd id="home-link"${attributes(homeField("link", "url", { label: "Menu link" }))}>${escapeHtml(text(home["link"]))}</dd>
      </dl>
      <section class="about" aria-labelledby="about-title">
        <h2 id="about-title"${attributes(aboutField("title", "text", { label: "About heading" }))}>${escapeHtml(text(about["title"]))}</h2>
        <p id="about-body"${attributes(aboutField("body", "text", { label: "About text" }))}>${escapeHtml(text(about["body"]))}</p>
      </section>
    </main>
    <footer class="footer">
      <p id="site-footer"${attributes(settingsField("footer", "text", { label: "Footer" }))}>${escapeHtml(text(settings["footer"]))}</p>
    </footer>
  </body>
</html>
`;
}

/** A page whose inline `style` attribute the CSP refuses: the guard's own detection test loads it. */
export const cspViolationPage = `<!doctype html>
<html lang="en">
  <head>
    <meta charset="utf-8">
    <title>CSP violation</title>
    <link rel="icon" href="/favicon.svg" type="image/svg+xml">
  </head>
  <body>
    <p id="styled" style="color: red">This inline style must be refused.</p>
  </body>
</html>
`;

/** A page whose script logs a console error and then throws, for the guard's detection test. */
export const consoleErrorPage = `<!doctype html>
<html lang="en">
  <head>
    <meta charset="utf-8">
    <title>Console error</title>
    <link rel="icon" href="/favicon.svg" type="image/svg+xml">
    <script type="module" src="/__test/console-error.js"></script>
  </head>
  <body>
    <p>Logs an error.</p>
  </body>
</html>
`;

export const consoleErrorScript = `console.error("demo console error");
setTimeout(() => {
  throw new Error("demo page error");
});
`;
