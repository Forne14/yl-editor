-- Optimistic concurrency and revision attribution.
-- documents.version increments on every mutation; a write that names a stale expectedVersion is refused.
-- revisions.actor records who published, retired, restored or renamed the document (NULL when the host passes none).
ALTER TABLE documents ADD COLUMN version INTEGER NOT NULL DEFAULT 0;
ALTER TABLE revisions ADD COLUMN actor TEXT;
