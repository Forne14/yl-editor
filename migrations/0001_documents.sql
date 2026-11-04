-- The editor's content model.
CREATE TABLE documents (
  id INTEGER PRIMARY KEY,
  key TEXT NOT NULL UNIQUE,
  type TEXT NOT NULL,
  slug TEXT NOT NULL,
  published_payload TEXT CHECK (published_payload IS NULL OR json_valid(published_payload)),
  draft_payload TEXT CHECK (draft_payload IS NULL OR json_valid(draft_payload)),
  published_at TEXT,
  draft_updated_at TEXT,
  previous_slugs TEXT NOT NULL DEFAULT '[]' CHECK (json_valid(previous_slugs)),
  retired_at TEXT,
  created_at TEXT NOT NULL,
  CHECK (published_payload IS NOT NULL OR draft_payload IS NOT NULL)
);
CREATE INDEX documents_type_idx ON documents (type);

CREATE TABLE revisions (
  id INTEGER PRIMARY KEY,
  document_id INTEGER NOT NULL REFERENCES documents (id) ON DELETE CASCADE,
  action TEXT NOT NULL CHECK (action IN ('publish', 'retire', 'restore', 'rename')),
  slug TEXT NOT NULL,
  payload TEXT NOT NULL CHECK (json_valid(payload)),
  created_at TEXT NOT NULL
);
CREATE INDEX revisions_document_idx ON revisions (document_id, id);
