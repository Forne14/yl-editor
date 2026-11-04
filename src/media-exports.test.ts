import { expect, test } from "vitest";
import { MediaVariantSchema, type MediaStore, type MediaVariant } from "./index.ts";

test("MediaVariantSchema parses a valid variant and refuses an invalid one", () => {
  const variant: MediaVariant = { width: 640, format: "webp", url: "/media/a.webp" };
  expect(MediaVariantSchema.parse(variant)).toEqual(variant);
  expect(MediaVariantSchema.safeParse({ ...variant, format: "gif" }).success).toBe(false);
});

test("a host can implement MediaStore", async () => {
  // The assignment is the assertion: `npm run check` fails if the interface changes shape.
  const store: MediaStore = {
    upload: async (file, meta) => ({ id: `${meta.role}-${meta.filename}-${file.byteLength}` }),
    resolve: async (id) => (id === "known" ? [{ width: 640, format: "avif", url: "/media/a.avif" }] : null),
  };
  await expect(store.upload(new Uint8Array(2), { role: "hero", filename: "a.png", alt: "" })).resolves.toEqual({
    id: "hero-a.png-2",
  });
  await expect(store.resolve("missing")).resolves.toBeNull();
});
