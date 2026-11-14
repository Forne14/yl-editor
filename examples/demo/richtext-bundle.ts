// The rich text widget for the browser. dist/richtext/ imports TipTap by bare name, which a page can only resolve
// through an import map, and the demo's strict CSP refuses an inline one. So the server bundles it with TipTap once,
// on first request. Its imports of the chrome stay external, pointing at /pkg/chrome/, so the page loads one copy of
// the chrome: the widget reads the strings `mountEditor` hands it from that copy.
import { fileURLToPath } from "node:url";
import { rolldown } from "rolldown";

const entry = fileURLToPath(new URL("../../dist/richtext/index.js", import.meta.url));

let pending: Promise<string> | undefined;

export function richTextBundle(): Promise<string> {
  pending ??= build().catch((error: unknown) => {
    pending = undefined;
    throw error;
  });
  return pending;
}

async function build(): Promise<string> {
  const bundle = await rolldown({
    input: entry,
    platform: "browser",
    makeAbsoluteExternalsRelative: false,
    plugins: [
      {
        name: "chrome-from-pkg",
        resolveId(source) {
          const match = /^\.\.\/chrome\/(.+)$/.exec(source);
          return match ? { id: `/pkg/chrome/${match[1]}`, external: true } : null;
        },
      },
    ],
  });
  try {
    const { output } = await bundle.generate({ format: "esm" });
    const [chunk] = output;
    return chunk.code;
  } finally {
    await bundle.close();
  }
}
