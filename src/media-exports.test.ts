import { describe, expect, test } from "vitest";
import {
  MediaRefusal,
  mediaValue,
  type MediaFieldRef,
  type MediaJobState,
  type MediaStore,
  type MediaUploadAnswer,
  type ResolvedMedia,
} from "./index.ts";

describe("mediaValue", () => {
  test("takes { id, alt } and { id, alt: '', decorative: true }", () => {
    expect(mediaValue().parse({ id: "m_1", alt: "Buns on a rack" })).toEqual({ id: "m_1", alt: "Buns on a rack" });
    expect(mediaValue().parse({ id: "m_1", alt: "", decorative: true })).toEqual({
      id: "m_1",
      alt: "",
      decorative: true,
    });
  });

  test("takes { id, alt: '' }: alt text not written yet", () => {
    expect(mediaValue().safeParse({ id: "m_1", alt: "" }).success).toBe(true);
  });

  test("refuses decorative with alt text", () => {
    expect(mediaValue().safeParse({ id: "m_1", alt: "Buns", decorative: true }).success).toBe(false);
  });

  test("refuses an empty id, a missing alt, a bare id and extra keys such as URLs", () => {
    expect(mediaValue().safeParse({ id: "", alt: "" }).success).toBe(false);
    expect(mediaValue().safeParse({ id: "m_1" }).success).toBe(false);
    expect(mediaValue().safeParse("m_1").success).toBe(false);
    expect(mediaValue().safeParse({ id: "m_1", alt: "", src: "/media/m_1.webp" }).success).toBe(false);
  });

  test("refuses null unless made nullable", () => {
    expect(mediaValue().safeParse(null).success).toBe(false);
    expect(mediaValue().nullable().parse(null)).toBeNull();
  });
});

describe("MediaRefusal", () => {
  test("carries its code, message and detail", () => {
    const refusal = new MediaRefusal("too_large", "Over 40 MB", { limit: 40_000_000 });
    expect(refusal).toBeInstanceOf(Error);
    expect(refusal).toMatchObject({ name: "MediaRefusal", code: "too_large", message: "Over 40 MB" });
    expect(refusal.detail).toEqual({ limit: 40_000_000 });
    expect(new MediaRefusal("busy", "Busy").detail).toEqual({});
  });
});

test("a host can implement MediaStore with its own variant shape", async () => {
  // The assignment is the assertion: `npm run check` fails if the interface changes shape.
  type Variants = { w: number; key: string }[];
  const media: ResolvedMedia<Variants> = {
    id: "m_1",
    render: { kind: "image", src: "/m/1.webp", width: 2, height: 1 },
    variants: [{ w: 2, key: "m/1.webp" }],
  };
  const store: MediaStore<Variants> = {
    upload: async (body, file, field: MediaFieldRef): Promise<MediaUploadAnswer<Variants>> => {
      await body.cancel();
      return file.size === null
        ? { status: "processing", job: `${field.key}:${field.path}` }
        : { status: "ready", media };
    },
    job: async (): Promise<MediaJobState<Variants> | null> => ({ status: "ready", media }),
    resolve: async (ids) => new Map(ids.filter((id) => id === media.id).map((id) => [id, media])),
  };
  const answer = await store.upload(
    new ReadableStream(),
    { filename: "a.png", type: "image/png", size: null },
    { key: "pages/home", path: "hero" },
    { signal: new AbortController().signal },
  );
  expect(answer).toEqual({ status: "processing", job: "pages/home:hero" });
  expect([...(await store.resolve(["m_1", "m_2"])).keys()]).toEqual(["m_1"]);
});
