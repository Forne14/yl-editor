import { expect, test } from "vitest";
import { editable, itemPath } from "./editable.ts";
import { getAt, parsePath } from "./path.ts";

test("renders nothing outside edit mode", () => expect(editable(undefined)("title", "text")).toEqual({}));
test("emits the addressing attributes in edit mode", () =>
  expect(editable("projects/scout")("parts.problem.body", "richtext")).toEqual({
    "data-edit-field": "projects/scout:parts.problem.body",
    "data-edit-type": "richtext",
  }));
test("refuses a malformed path even in edit mode", () =>
  expect(() => editable("projects/scout")("a..b", "text")).toThrow());
test("renders nothing outside edit mode even with attrs", () =>
  expect(editable(undefined)("title", "select", { options: ["a"], label: "Title" })).toEqual({}));
test("emits options as a JSON array and the label", () =>
  expect(editable("events/live")("kind", "select", { options: ["gig", "talk"], label: "Kind" })).toEqual({
    "data-edit-field": "events/live:kind",
    "data-edit-type": "select",
    "data-edit-options": '["gig","talk"]',
    "data-edit-label": "Kind",
  }));
test("omits attributes that were not given", () =>
  expect(Object.keys(editable("events/live")("title", "text", {}))).toEqual(["data-edit-field", "data-edit-type"]));
test("accepts a keyed path", () =>
  expect(editable("projects/scout")("sections[_key=a].items[_key=b].title", "text")).toEqual({
    "data-edit-field": "projects/scout:sections[_key=a].items[_key=b].title",
    "data-edit-type": "text",
  }));
test.each(["items[_key=a b].title", "items[_key=__proto__]", "__proto__[_key=a]"])("refuses keyed path %j", (p) =>
  expect(() => editable("projects/scout")(p, "text")).toThrow(),
);
test("itemPath uses the stable key when the item has one", () => {
  const doc = { items: [{ _key: "x" }, { _key: "abc", title: "T" }] };
  const path = `${itemPath("items", doc.items[1], 1)}.title`;
  expect(path).toBe("items[_key=abc].title");
  expect(getAt(doc, parsePath(path))).toBe("T");
});
test.each([
  ["a primitive", "s", 2],
  ["an object without _key", { title: "t" }, 2],
  ["a non-string _key", { _key: 7 }, 2],
  ["an invalid _key", { _key: "a b" }, 2],
  ["a forbidden _key", { _key: "__proto__" }, 2],
  ["null", null, 2],
])("itemPath falls back to the index for %s", (_name, item, index) =>
  expect(itemPath("items", item, index)).toBe("items.2"),
);
