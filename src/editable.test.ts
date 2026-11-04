import { expect, test } from "vitest";
import { editable } from "./editable.ts";

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
