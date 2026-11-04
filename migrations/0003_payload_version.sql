-- Schema evolution: the registry version a stored payload was written under.
-- A reader behind the registry entry's version runs its migrate hook before validating; the migrated payload is
-- persisted on the next draft write. Rows written before 0003 read as version 1, the registry default.
ALTER TABLE documents ADD COLUMN payload_version INTEGER NOT NULL DEFAULT 1;
