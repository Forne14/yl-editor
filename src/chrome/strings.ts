/**
 * Every word the chrome shows. Hosts translate or reword by passing `strings` to `mountEditor`; placeholders in
 * braces are filled by `format`.
 */
export const defaultStrings = {
  editThisPage: "Edit this page",
  editingRegion: "Editing",
  draftsSaveAsYouGo: "drafts save as you go",
  noChanges: "No changes yet · published version unchanged until you press Publish",
  oneChange: "1 change on this page · published version unchanged until you press Publish",
  changes: "{fields} changes on this page · published version unchanged until you press Publish",
  changesAcross: "{fields} changes across {documents} documents · published version unchanged until you press Publish",
  othersNeedPublisher: "{count} other changed documents need someone with publish access.",
  othersNeedEditor: "{count} other changed documents need someone with edit access.",
  reloadToSee: "Reload the page to see the published version.",
  actionFailed: "{action} failed for {key}: {message}",
  done: "Done",
  discard: "Discard",
  publish: "Publish",
  revisions: "Revisions",
  close: "Close",
  cancel: "Cancel",
  confirm: "Confirm",
  retry: "Retry",
  saving: "Saving…",
  saved: "Draft saved",
  saveFailed: "Not saved: {message}",
  networkError: "Couldn’t reach the server",
  loadFailed: "Couldn’t load the documents on this page",
  notEditable: "Not editable: you don’t have edit access to this document",
  unknownDocument: "Not editable: the server doesn’t know this document",
  pressEnterToEdit: "Press Enter to edit",
  noWidget: "No editor registered for {type}",
  richtextFallback: "Plain text only. Register a rich text widget for formatting.",
  conflict: "Someone else changed this field since you opened the page.",
  keepMine: "Keep mine (overwrite)",
  takeTheirs: "Take theirs (reload field)",
  publishTitle: "Publish these documents?",
  discardTitle: "Discard drafts for these documents?",
  nothingToPublish: "Nothing you can publish has changed this session.",
  nothingToDiscard: "Nothing you can discard has changed this session.",
  published: "Published {key}",
  discarded: "Discarded draft of {key}",
  discardedNeverPublished: "Discarded {key}; it had never been published.",
  revisionsTitle: "Revisions of {key}",
  noRevisions: "No revisions yet.",
  revisionLine: "{action} by {actor}",
  unknownActor: "someone",
  chooseDocument: "Document",
  addTag: "Add tag",
  removeTag: "Remove {tag}",
  yes: "On",
  no: "Off",
};

export type Strings = typeof defaultStrings;

export function format(template: string, values: Record<string, string | number>): string {
  return template.replace(/\{(\w+)\}/g, (match, name: string) => (name in values ? String(values[name]) : match));
}
