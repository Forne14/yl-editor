// The editor island, loaded only for signed-in editors. It imports the built chrome straight from dist/ (served at
// /pkg/) and reads its options from data-* attributes on <body>, so the page needs no inline script.
import { mountEditor } from "/pkg/chrome/index.js";

const { actorLabel, scheduling } = document.body.dataset;
const editor = mountEditor({ actorLabel, scheduling: scheduling === "1" });

// Specs reach the handle through `window.demoEditor` and wait on `data-editor-ready` instead of sleeping.
window.demoEditor = editor;
editor.ready.then(
  () => {
    document.documentElement.dataset.editorReady = "true";
  },
  (error) => {
    document.documentElement.dataset.editorReady = "failed";
    console.error("[demo] editor failed to load", error);
  },
);
