import { describe, expect, it } from "vitest";
import { z } from "zod";
import { richText } from "./schema.ts";
import { sanitizeRichText } from "./sanitize.ts";

describe("sanitizeRichText: the stored shape", () => {
  it("keeps what the widget writes unchanged", () => {
    const html =
      '<p>Our <strong>sourdough</strong> proves for <em>48 hours</em>. See <a href="/bread">bread</a>.</p>' +
      "<ul><li><p>Rye</p><ol><li><p>Tuesdays</p></li></ol></li><li><p>Buns</p></li></ul><p>Line<br>break</p>";
    expect(sanitizeRichText(html)).toBe(html);
  });

  it("keeps headings only at the levels the field allows, else makes them paragraphs", () => {
    const html = "<h2>Title</h2><h3>Sub</h3><h1>Big</h1><h4>Small</h4>";
    expect(sanitizeRichText(html)).toBe("<p>Title</p><p>Sub</p><p>Big</p><p>Small</p>");
    expect(sanitizeRichText(html, { headings: [2, 3] })).toBe("<h2>Title</h2><h3>Sub</h3><p>Big</p><p>Small</p>");
    expect(sanitizeRichText(html, { headings: [3] })).toBe("<p>Title</p><h3>Sub</h3><p>Big</p><p>Small</p>");
  });

  it("writes b and i as strong and em", () => {
    expect(sanitizeRichText("<p><b>bold</b> <i>it</i></p>")).toBe("<p><strong>bold</strong> <em>it</em></p>");
  });

  it("wraps loose inline content in paragraphs and list item content in a paragraph", () => {
    expect(sanitizeRichText("Hello <b>there</b>")).toBe("<p>Hello <strong>there</strong></p>");
    expect(sanitizeRichText("<ul><li>One</li><li>Two <em>2</em></li></ul>")).toBe(
      "<ul><li><p>One</p></li><li><p>Two <em>2</em></p></li></ul>",
    );
  });

  it("flattens unknown containers and keeps their text", () => {
    expect(sanitizeRichText('<div class="x"><section><p>A</p></section><span style="color:red">B</span></div>')).toBe(
      "<p>A</p><p>B</p>",
    );
    expect(sanitizeRichText("<blockquote>Quote</blockquote><table><tr><td>Cell</td></tr></table>")).toBe(
      "<p>Quote</p><p>Cell</p>",
    );
  });

  it("keeps blocks apart inside inline wrappers, tables and definition lists", () => {
    expect(sanitizeRichText("<span><p>One</p><p>Two</p></span>")).toBe("<p>One</p><p>Two</p>");
    expect(sanitizeRichText("<table><tbody><tr><td>a</td><td>b</td></tr></tbody></table>")).toBe("<p>a</p><p>b</p>");
    expect(sanitizeRichText("<dl><dt>A</dt><dd>B</dd></dl>")).toBe("<p>A</p><p>B</p>");
    expect(sanitizeRichText("<b><p>Bold para</p><ul><li>x</li></ul></b>")).toBe(
      "<p>Bold para</p><ul><li><p>x</p></li></ul>",
    );
  });

  it("gathers a run of list items outside a list into one list", () => {
    expect(sanitizeRichText("<li>a</li>\n<li>b</li><p>c</p><li>d</li>")).toBe(
      "<ul><li><p>a</p></li><li><p>b</p></li></ul><p>c</p><ul><li><p>d</p></li></ul>",
    );
  });

  it("handles a long value without trouble", () => {
    const html = "<p>" + '<a href="/x" title="t">link</a> <em>word</em> '.repeat(5000) + "</p>";
    const started = performance.now();
    expect(sanitizeRichText(html)).toContain('<a href="/x">link</a> <em>word</em>');
    expect(performance.now() - started).toBeLessThan(1000);
  });

  it("returns an empty string for a document with no content", () => {
    expect(sanitizeRichText("")).toBe("");
    expect(sanitizeRichText("<p></p>")).toBe("");
    expect(sanitizeRichText("<p></p><p>  </p>")).toBe("");
  });

  it("keeps empty paragraphs between content, as the widget writes them", () => {
    expect(sanitizeRichText("<p>A</p><p></p><p>B</p>")).toBe("<p>A</p><p></p><p>B</p>");
  });

  it("escapes text, and decodes entities once so the output is canonical", () => {
    expect(sanitizeRichText("<p>a &lt;b&gt; &amp; c &#169; &#x263A; &nbsp;d</p>")).toBe(
      "<p>a &lt;b&gt; &amp; c © ☺ &nbsp;d</p>",
    );
    expect(sanitizeRichText("<p>5 < 6 & 7 > 3</p>")).toBe("<p>5 &lt; 6 &amp; 7 &gt; 3</p>");
  });

  it("is idempotent", () => {
    const inputs = [
      '<p>x<a href="https://a.test/?q=1&amp;r=2">y</a></p>',
      "Loose <b>text</b><ul><li>i</li></ul>",
      "<p>&amp;lt;script&amp;gt;</p>",
      '<div><a href="java&#x09;script:alert(1)">z</a></div>',
    ];
    for (const input of inputs) {
      const once = sanitizeRichText(input, { headings: [2] });
      expect(sanitizeRichText(once, { headings: [2] })).toBe(once);
    }
  });
});

describe("sanitizeRichText: hostile input", () => {
  it("drops scripts and styles with their content", () => {
    expect(sanitizeRichText("<p>a<script>alert(1)</script>b</p><style>p{color:red}</style>")).toBe("<p>ab</p>");
    expect(sanitizeRichText("<p>a<SCRIPT>alert(1)</SCRIPT >b</p>")).toBe("<p>ab</p>");
    expect(sanitizeRichText("<p>a<script>never closed")).toBe("<p>a</p>");
  });

  it("drops embedded documents and foreign content whole", () => {
    expect(sanitizeRichText('<iframe src="https://evil.test"></iframe><p>ok</p>')).toBe("<p>ok</p>");
    expect(sanitizeRichText("<svg><script>alert(1)</script><text>t</text></svg><p>ok</p>")).toBe("<p>ok</p>");
    expect(sanitizeRichText('<math><mi xlink:href="javascript:alert(1)">m</mi></math>')).toBe("");
    expect(sanitizeRichText("<template><img src=x onerror=alert(1)></template><p>ok</p>")).toBe("<p>ok</p>");
    expect(sanitizeRichText('<object data="x.swf"></object><embed src="x"><p>ok</p>')).toBe("<p>ok</p>");
  });

  it("drops every attribute but a safe href", () => {
    expect(sanitizeRichText('<p onclick="alert(1)" style="x" class="c" id="i">t</p>')).toBe("<p>t</p>");
    expect(sanitizeRichText('<p><img src=x onerror="alert(1)">t</p>')).toBe("<p>t</p>");
    expect(sanitizeRichText('<p><a href="/a" onmouseover="alert(1)" target="_blank" rel="x">t</a></p>')).toBe(
      '<p><a href="/a">t</a></p>',
    );
    expect(sanitizeRichText('<p><strong style="background:url(javascript:alert(1))">t</strong></p>')).toBe(
      "<p><strong>t</strong></p>",
    );
  });

  it.each([
    "javascript:alert(1)",
    "JavaScript:alert(1)",
    " javascript:alert(1)",
    "java\tscript:alert(1)",
    "java&#x09;script:alert(1)",
    "&#106;avascript:alert(1)",
    "jav&#x61;script:alert(1)",
    "vbscript:msgbox(1)",
    "data:text/html,<script>alert(1)</script>",
    "//evil.test/x",
    "/\\evil.test/x",
    "relative/path",
    "#top",
    "",
  ])("drops a link to %j and keeps its text", (href) => {
    expect(sanitizeRichText(`<p><a href="${href}">t</a></p>`)).toBe("<p>t</p>");
  });

  it.each([
    ["https://example.test/a?b=1&c=2", "https://example.test/a?b=1&amp;c=2"],
    ["http://example.test", "http://example.test"],
    ["mailto:a@example.test", "mailto:a@example.test"],
    ["tel:+441234", "tel:+441234"],
    ["/bread", "/bread"],
    ['/q"><script>', "/q&quot;&gt;&lt;script&gt;"],
  ])("keeps a link to %j", (href, written) => {
    const quoted = href.replaceAll("&", "&amp;").replaceAll('"', "&quot;");
    expect(sanitizeRichText(`<p><a href="${quoted}">t</a></p>`)).toBe(`<p><a href="${written}">t</a></p>`);
  });

  it("does not nest links", () => {
    expect(sanitizeRichText('<p><a href="/a">x<a href="/b">y</a></a></p>')).toBe(
      '<p><a href="/a">x</a><a href="/b">y</a></p>',
    );
  });

  it("drops comments, doctypes and processing instructions", () => {
    expect(sanitizeRichText("<!doctype html><!-- <script>alert(1)</script> --><?php x ?><p>ok</p>")).toBe("<p>ok</p>");
    expect(sanitizeRichText("<p>a<!-- never closed <script>alert(1)</script>")).toBe("<p>a</p>");
  });

  it("never lets a stray angle bracket become markup", () => {
    expect(sanitizeRichText("<p><<script>alert(1)//<</script></p>")).toBe("<p>&lt;</p>");
    expect(sanitizeRichText('<p><img src="x" alt="<script>">t</p>')).toBe("<p>t</p>");
    expect(sanitizeRichText("<p>a</p ><p/onclick=alert(1)>b</p>")).toBe("<p>a</p><p>b</p>");
    expect(sanitizeRichText('<p title="a>b">c</p>')).toBe("<p>c</p>");
  });

  it("closes what was left open", () => {
    expect(sanitizeRichText("<p><strong>a<em>b")).toBe("<p><strong>a<em>b</em></strong></p>");
    expect(sanitizeRichText("<ul><li>a<li>b</ul>")).toBe("<ul><li><p>a</p></li><li><p>b</p></li></ul>");
    expect(sanitizeRichText("<p>a<p>b")).toBe("<p>a</p><p>b</p>");
  });
});

describe("richText", () => {
  it("is a zod string schema that sanitises on parse", () => {
    const schema = z.object({ lede: richText({ headings: [2] }) });
    expect(schema.parse({ lede: '<h2 onclick="x">T</h2><script>1</script>' })).toEqual({ lede: "<h2>T</h2>" });
    expect(schema.safeParse({ lede: 3 }).success).toBe(false);
  });
});
