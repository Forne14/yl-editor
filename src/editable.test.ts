import { expect, test } from "vitest";
import { editable } from "./editable";

test("renders nothing outside edit mode", () => expect(editable(undefined)("title", "text")).toEqual({}));
test("emits the addressing attributes in edit mode", () =>
  expect(editable("projects/scout")("parts.problem.body", "richtext")).toEqual({
    "data-edit-field": "projects/scout:parts.problem.body",
    "data-edit-type": "richtext",
  }));
test("refuses a malformed path even in edit mode", () =>
  expect(() => editable("projects/scout")("a..b", "text")).toThrow());
