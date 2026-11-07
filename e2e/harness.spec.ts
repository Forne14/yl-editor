// Proves the fixtures the other specs build on: seeding raw rows, reading them back, the content API as any role,
// publish-due, the store clock, and a second guarded context sharing the tenant.
import { expect, test } from "./fixtures.ts";

test("seed stores payloads exactly as written, even malformed, and readDoc returns them", async ({ demo }) => {
  const [seeded] = await demo.seed({
    key: "pages/home",
    draftPayload: "{not json",
    published: { title: 5 },
    version: 7,
  });
  expect(seeded?.draftPayload).toBe("{not json");
  expect(seeded?.draft).toBeUndefined();
  expect(seeded?.published).toEqual({ title: 5 });

  const row = await demo.readDoc("pages/home");
  expect(row).toMatchObject({ key: "pages/home", type: "page", version: 7, draftPayload: "{not json", revisions: [] });
  expect(await demo.readDoc("pages/missing")).toBeNull();
});

test("resetTenant restores the default seed or empties the database", async ({ demo }) => {
  await demo.seed({ key: "pages/home", published: { title: "Changed" } });
  await demo.resetTenant();
  const home = await demo.readDoc("pages/home");
  expect(home?.published).toMatchObject({ title: "Welcome to the demo" });
  expect(home?.revisions.map((revision) => revision.action)).toEqual(["publish"]);

  await demo.resetTenant({ empty: true });
  expect(await demo.readDoc("pages/home")).toBeNull();
});

test("content calls the real API as any role in this tenant", async ({ demo }) => {
  const write = await demo.content("POST", "field", { key: "pages/about", path: "title", value: "Hello" });
  expect(write.status).toBe(200);
  expect((await demo.readDoc("pages/about"))?.draft).toMatchObject({ title: "Hello" });

  const denied = await demo.content("POST", "publish", { key: "pages/about" }, { role: "contributor" });
  expect(denied).toEqual({ status: 403, body: { error: { code: "forbidden", message: "missing pages.publish" } } });

  expect(await demo.changes()).toEqual([{ action: "field", key: "pages/about", actor: "Editor (demo)" }]);
});

test("publishDue runs the real publish-due route, which only the cron role may call", async ({ demo }) => {
  await demo.seed({
    key: "pages/about",
    published: { title: "About us" },
    draft: { title: "Scheduled title" },
    scheduledAt: "2030-01-01T09:00:00.000Z",
  });

  expect(await demo.publishDue({ role: "editor" })).toEqual({
    status: 403,
    body: { error: { code: "forbidden", message: "Scheduler only" } },
  });
  expect((await demo.publishDue()).body).toEqual({ documents: [], failed: [] });

  const due = await demo.publishDue({ now: "2030-01-01T09:00:00.000Z" });
  expect(due.status).toBe(200);
  expect(due.body).toMatchObject({ documents: [{ key: "pages/about", scheduledAt: null }], failed: [] });
  expect((await demo.readDoc("pages/about"))?.published).toEqual({ title: "Scheduled title" });
});

test("setClock fixes the store's clock", async ({ demo }) => {
  await demo.setClock("2031-02-03T04:05:06.000Z");
  await demo.content("POST", "field", { key: "pages/about", path: "body", value: "New body" });
  await demo.content("POST", "publish", { key: "pages/about" });
  expect((await demo.readDoc("pages/about"))?.publishedAt).toBe("2031-02-03T04:05:06.000Z");
});

test("newContext opens a second guarded browser in the same tenant, with its own role", async ({ page, demo }) => {
  await demo.openEditor();
  const other = await demo.newContext({ role: "contributor" });
  const otherPage = await demo.openEditor({ context: other });
  await expect(otherPage.locator(".cms-bar")).toContainText("Editing as Contributor");

  await demo.content("POST", "field", { key: "pages/about", path: "title", value: "From elsewhere" });
  await otherPage.reload();
  await expect(otherPage.locator("#about-title")).toHaveText("From elsewhere");
  await expect(page.locator(".cms-bar")).toContainText("Editing as Editor");
});

test("the editor page loads on a document whose draft is not valid JSON", async ({ page, demo }) => {
  await demo.seed({ key: "pages/about", published: { title: "About us" }, draftPayload: "{broken" });
  await demo.openEditor();
  await expect(page.locator("#about-title")).toHaveClass(/cms-field/);
});
