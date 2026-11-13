// The server-side half of `@yl/editor/richtext`: one documented HTML shape (docs/chrome.md → Rich text), enforced
// whichever widget or client wrote the value. No DOM and no dependencies, so it runs anywhere the store does.
//
// No zod either: the browser widget runs its output through it too, and chrome code ships no zod.
//
// Safety comes from the output side, not the parser: the input is parsed loosely, then the result is written from
// scratch with every piece of text escaped and only the tags and `href` below. However a browser would have read the
// input, the output can only contain the stored shape.
export type RichTextHeading = 2 | 3;

export interface RichTextOptions {
  /** Heading levels the field allows. Default none: headings become paragraphs. */
  headings?: readonly RichTextHeading[];
}

interface ElementNode {
  tag: string;
  attrs: Map<string, string>;
  children: TreeNode[];
}
type TreeNode = ElementNode | string;

/** Their content is text to the browser, and none of it belongs in the output. */
const RAW_TEXT = new Set(["script", "style", "textarea", "title", "xmp", "iframe", "noembed", "noframes", "noscript"]);
/** Dropped with everything inside them. */
const DROPPED = new Set([...RAW_TEXT, "svg", "math", "template", "object", "embed", "head", "select", "button"]);
const VOID = new Set([
  "area",
  "base",
  "br",
  "col",
  "embed",
  "hr",
  "img",
  "input",
  "link",
  "meta",
  "param",
  "source",
  "track",
  "wbr",
]);
/** Start tags that close an open paragraph, as a browser's parser does. */
const CLOSES_P = new Set([
  "p",
  "div",
  "ul",
  "ol",
  "li",
  "h1",
  "h2",
  "h3",
  "h4",
  "h5",
  "h6",
  "blockquote",
  "section",
  "article",
  "table",
  "pre",
]);
const HEADINGS = new Set(["h1", "h2", "h3", "h4", "h5", "h6"]);
/** Elements whose content is laid out as blocks; anything else in a block context is inline. */
const BLOCKISH = new Set([
  ...CLOSES_P,
  "header",
  "footer",
  "main",
  "nav",
  "aside",
  "figure",
  "figcaption",
  "caption",
  "thead",
  "tbody",
  "tfoot",
  "tr",
  "td",
  "th",
  "dl",
  "dt",
  "dd",
  "details",
  "summary",
  "address",
  "fieldset",
  "legend",
  "form",
  "hgroup",
  "center",
  "menu",
  "dir",
]);
/** Where an open paragraph, list item or link stops being the one a new start tag closes. */
const P_SCOPE = new Set(["li", "ul", "ol", "div", "blockquote", "td", "th"]);
const LI_SCOPE = new Set(["ul", "ol"]);
const rawTextEnd = new Map<string, RegExp>();

/** An element that lays out blocks, or holds one somewhere inside: its content is blocks, not inline text. */
function holdsBlocks(node: TreeNode): boolean {
  if (typeof node === "string" || DROPPED.has(node.tag)) return false;
  return BLOCKISH.has(node.tag) || node.children.some(holdsBlocks);
}

const NAMED: Record<string, string> = {
  amp: "&",
  lt: "<",
  gt: ">",
  quot: '"',
  apos: "'",
  nbsp: "\u00a0",
  copy: "©",
  reg: "®",
  trade: "™",
  hellip: "…",
  mdash: "—",
  ndash: "–",
  lsquo: "‘",
  rsquo: "’",
  ldquo: "“",
  rdquo: "”",
};

function decodeEntities(text: string): string {
  return text.replace(/&(#[0-9]{1,8}|#[xX][0-9a-fA-F]{1,7}|[a-zA-Z]{2,8});?/g, (match, body: string) => {
    if (body.startsWith("#")) {
      const code = body[1] === "x" || body[1] === "X" ? parseInt(body.slice(2), 16) : parseInt(body.slice(1), 10);
      const valid = code > 0 && code <= 0x10ffff && !(code >= 0xd800 && code <= 0xdfff);
      return valid ? String.fromCodePoint(code) : "\ufffd";
    }
    return NAMED[body] ?? match;
  });
}

const escapeText = (text: string): string =>
  text
    .replace(/&/g, "&amp;")
    .replace(/</g, "&lt;")
    .replace(/>/g, "&gt;")
    .replace(/\u00a0/g, "&nbsp;");

const escapeAttribute = (text: string): string => escapeText(text).replace(/"/g, "&quot;");

/** Builds a loose tree from HTML. Malformed input still gives a tree; what it holds only decides which text survives. */
function parse(html: string): ElementNode {
  const root: ElementNode = { tag: "#root", attrs: new Map(), children: [] };
  const stack: ElementNode[] = [root];
  const current = () => stack[stack.length - 1] ?? root;
  const closeTo = (index: number) => {
    stack.length = Math.max(index, 1);
  };
  const lastIndexOf = (tag: string, stopAt?: Set<string>) => {
    for (let index = stack.length - 1; index > 0; index -= 1) {
      const name = stack[index]?.tag;
      if (name === tag) return index;
      if (name !== undefined && stopAt?.has(name)) return -1;
    }
    return -1;
  };
  const text = (value: string) => {
    if (value) current().children.push(decodeEntities(value.replace(/\0/g, "")));
  };

  let at = 0;
  while (at < html.length) {
    const open = html.indexOf("<", at);
    if (open === -1) {
      text(html.slice(at));
      break;
    }
    text(html.slice(at, open));
    const rest = html.slice(open);
    if (rest.startsWith("<!--")) {
      const end = html.indexOf("-->", open + 4);
      at = end === -1 ? html.length : end + 3;
      continue;
    }
    if (/^<[!?]/.test(rest)) {
      const end = html.indexOf(">", open);
      at = end === -1 ? html.length : end + 1;
      continue;
    }
    const endTag = /^<\/([a-zA-Z][^\s/>]*)[^>]*>?/.exec(rest);
    if (endTag) {
      const tag = (endTag[1] ?? "").toLowerCase();
      const index = lastIndexOf(tag);
      if (index > 0) closeTo(index);
      at = open + endTag[0].length;
      continue;
    }
    const startTag = /^<([a-zA-Z][^\s/>]*)/.exec(rest);
    if (!startTag) {
      text("<");
      at = open + 1;
      continue;
    }
    const tag = (startTag[1] ?? "").toLowerCase();
    // Attributes: names, then an optional `=` and a quoted or bare value, until the tag's `>`.
    const attrs = new Map<string, string>();
    let cursor = open + startTag[0].length;
    for (;;) {
      while (cursor < html.length && /[\s/]/.test(html[cursor] ?? "")) cursor += 1;
      if (cursor >= html.length || html[cursor] === ">") break;
      const name = /^[^\s/>=]+/.exec(html.slice(cursor))?.[0] ?? html[cursor] ?? "";
      cursor += name.length;
      while (cursor < html.length && /\s/.test(html[cursor] ?? "")) cursor += 1;
      let value = "";
      if (html[cursor] === "=") {
        cursor += 1;
        while (cursor < html.length && /\s/.test(html[cursor] ?? "")) cursor += 1;
        const quote = html[cursor];
        if (quote === '"' || quote === "'") {
          const end = html.indexOf(quote, cursor + 1);
          value = html.slice(cursor + 1, end === -1 ? html.length : end);
          cursor = end === -1 ? html.length : end + 1;
        } else {
          value = /^[^\s>]*/.exec(html.slice(cursor))?.[0] ?? "";
          cursor += value.length;
        }
      }
      const key = name.toLowerCase();
      if (!attrs.has(key)) attrs.set(key, decodeEntities(value));
    }
    at = Math.min(cursor + 1, html.length);

    if (RAW_TEXT.has(tag)) {
      let end = rawTextEnd.get(tag);
      if (!end) rawTextEnd.set(tag, (end = new RegExp(`</${tag}[\\s/>]`, "i")));
      const close = end.exec(html.slice(at));
      at = close ? at + close.index : html.length;
      continue;
    }
    if (CLOSES_P.has(tag)) {
      const p = lastIndexOf("p", P_SCOPE);
      if (p > 0) closeTo(p);
    }
    if (tag === "li") {
      const li = lastIndexOf("li", LI_SCOPE);
      if (li > 0) closeTo(li);
    }
    if (tag === "a") {
      const a = lastIndexOf("a");
      if (a > 0) closeTo(a);
    }
    const node: ElementNode = { tag, attrs, children: [] };
    current().children.push(node);
    if (!VOID.has(tag)) stack.push(node);
  }
  return root;
}

/** `https:`, `http:`, `mailto:`, `tel:`, or a path on this site. Browsers ignore tabs and newlines inside a URL. */
export function isAllowedHref(href: string): boolean {
  // eslint-disable-next-line no-control-regex
  const cleaned = href.replace(/[\u0000- ]/g, "");
  return /^(https?:|mailto:|tel:)/i.test(cleaned) || /^\/(?![/\\])/.test(cleaned);
}

class Writer {
  constructor(private readonly headings: ReadonlySet<string>) {}

  inline(nodes: readonly TreeNode[], inLink: boolean): string {
    let out = "";
    for (const node of nodes) {
      if (typeof node === "string") {
        out += escapeText(node);
        continue;
      }
      if (DROPPED.has(node.tag)) continue;
      if (node.tag === "br") {
        out += "<br>";
        continue;
      }
      const inner = this.inline(node.children, inLink || node.tag === "a");
      if (node.tag === "strong" || node.tag === "b") out += inner ? `<strong>${inner}</strong>` : "";
      else if (node.tag === "em" || node.tag === "i") out += inner ? `<em>${inner}</em>` : "";
      else if (node.tag === "a") {
        const href = node.attrs.get("href");
        out +=
          !inLink && href !== undefined && isAllowedHref(href) && inner
            ? `<a href="${escapeAttribute(href.trim())}">${inner}</a>`
            : inner;
      } else out += inner;
    }
    return out;
  }

  /** Content laid out as blocks: loose inline runs become paragraphs, unknown containers are flattened. */
  blocks(nodes: readonly TreeNode[]): string[] {
    const out: string[] = [];
    let run: TreeNode[] = [];
    const flush = () => {
      const inner = this.inline(run, false);
      run = [];
      if (inner.trim() !== "") out.push(`<p>${inner}</p>`);
    };
    for (let index = 0; index < nodes.length; index += 1) {
      const node = nodes[index];
      if (node === undefined) continue;
      if (typeof node === "string" || !holdsBlocks(node)) {
        if (typeof node !== "string" && DROPPED.has(node.tag)) continue;
        run.push(node);
        continue;
      }
      flush();
      if (node.tag === "li") {
        // A run of list items outside a list is one list; whitespace between them doesn't break it.
        const items: TreeNode[] = [node];
        while (index + 1 < nodes.length) {
          const next = nodes[index + 1];
          if (typeof next === "string" ? next.trim() !== "" : next?.tag !== "li") break;
          if (typeof next !== "string" && next !== undefined) items.push(next);
          index += 1;
        }
        const listed = this.listItems(items);
        if (listed) out.push(`<ul>${listed}</ul>`);
        continue;
      }
      if (node.tag === "p" || HEADINGS.has(node.tag)) {
        const tag = this.headings.has(node.tag) ? node.tag : "p";
        out.push(`<${tag}>${this.inline(node.children, false)}</${tag}>`);
      } else if (node.tag === "ul" || node.tag === "ol") {
        const items = this.listItems(node.children);
        if (items) out.push(`<${node.tag}>${items}</${node.tag}>`);
      } else {
        out.push(...this.blocks(node.children));
      }
    }
    flush();
    return out;
  }

  private listItems(nodes: readonly TreeNode[]): string {
    let out = "";
    let loose: TreeNode[] = [];
    const item = (children: readonly TreeNode[]) => {
      const inner = this.blocks(children)
        .map((block) => (/^<h[23]>/.test(block) ? block.replace(/^<h([23])>(.*)<\/h\1>$/s, "<p>$2</p>") : block))
        .join("");
      if (inner) out += `<li>${inner}</li>`;
    };
    const flushLoose = () => {
      if (loose.some((node) => typeof node !== "string" || node.trim() !== "")) item(loose);
      loose = [];
    };
    for (const node of nodes) {
      if (typeof node !== "string" && node.tag === "li") {
        flushLoose();
        item(node.children);
      } else loose.push(node);
    }
    flushLoose();
    return out;
  }
}

/**
 * Rewrites rich text HTML into the stored shape: `p`, `h2`/`h3` when allowed, `ul`/`ol` whose `li` hold paragraphs
 * and nested lists, and inside those `strong`, `em`, `br` and `a href`. Links keep only `https:`, `http:`, `mailto:`,
 * `tel:` or a path starting with one `/`; any other link keeps its text. Every other element is dropped, keeping its
 * text, except scripts, styles, embedded documents and foreign content, which go with their content. Attributes other
 * than a link's `href` are dropped. A value with no text left is `""`. Running it twice gives the same result.
 */
export function sanitizeRichText(html: string, options: RichTextOptions = {}): string {
  const headings = new Set((options.headings ?? []).map((level) => `h${level}`));
  const blocks = new Writer(headings).blocks(parse(html).children);
  const output = blocks.join("");
  const hasText = /\S/.test(output.replace(/<[^>]*>|&nbsp;/g, ""));
  return hasText || output.includes("<br>") ? output : "";
}
