-- Lifecycle verbs: scheduled publish, unpublish and restore-from-revision.
-- documents.scheduled_at holds the ISO time a draft is due to be published (NULL when nothing is scheduled).
-- revisions.action gains 'restore_revision' and 'unpublish'. SQLite cannot alter a CHECK, so the revisions table is
-- rebuilt: create the new table, copy every row, drop the old one, rename, recreate the index. Revision ids are kept.
ALTER TABLE documents ADD COLUMN scheduled_at TEXT;

CREATE TABLE revisions_new (
  id INTEGER PRIMARY KEY,
  document_id INTEGER NOT NULL REFERENCES documents (id) ON DELETE CASCADE,
  action TEXT NOT NULL CHECK (action IN ('publish', 'retire', 'restore', 'rename', 'restore_revision', 'unpublish')),
  slug TEXT NOT NULL,
  payload TEXT NOT NULL CHECK (json_valid(payload)),
  created_at TEXT NOT NULL,
  actor TEXT
);
INSERT INTO revisions_new (id, document_id, action, slug, payload, created_at, actor)
  SELECT id, document_id, action, slug, payload, created_at, actor FROM revisions;
DROP TABLE revisions;
ALTER TABLE revisions_new RENAME TO revisions;
CREATE INDEX revisions_document_idx ON revisions (document_id, id);
