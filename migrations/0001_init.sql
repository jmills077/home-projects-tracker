-- Home Projects Tracker schema.
--
-- A project keeps its working details (what it is, budget, lumber, design notes, to-do and shopping
-- lists, cut list, purchases, due dates) as one JSON document in `data`. Columns the pages sort and
-- filter on sit beside it.

CREATE TABLE settings (
  key TEXT PRIMARY KEY,
  value TEXT NOT NULL            -- JSON
);

CREATE TABLE projects (
  id INTEGER PRIMARY KEY AUTOINCREMENT,
  stream TEXT NOT NULL DEFAULT 'home',      -- 'home' (home improvement) or 'shop' (a shop build)
  status TEXT NOT NULL DEFAULT 'planned',   -- planned, in_progress, complete
  stage TEXT NOT NULL DEFAULT 'ideation',   -- ideation, design, build, install
  data TEXT NOT NULL,            -- JSON: the project's details
  calc TEXT NOT NULL DEFAULT '{}',      -- JSON: totals worked out by the browser as of the last save
  history TEXT NOT NULL DEFAULT '[]',   -- JSON: status and phase changes, oldest first
  created_at TEXT NOT NULL,
  updated_at TEXT NOT NULL
);
CREATE INDEX projects_status ON projects (status);

-- Every receipt photo. Line items for a project live with that project (data.purchases, each naming
-- its receipt by id), since one receipt can be split across projects; lines that aren't for any one
-- project live here, in `general`.
-- The photo is a JPEG as base64 text (about 0.3-1 MB each; a D1 row holds up to 2 MB).
CREATE TABLE receipts (
  id TEXT PRIMARY KEY,                 -- made by the browser, e.g. r<time in base 36>
  store TEXT NOT NULL DEFAULT '',
  date TEXT NOT NULL DEFAULT '',       -- purchase date, YYYY-MM-DD
  total REAL NOT NULL DEFAULT 0,       -- the receipt's total as printed (or entered)
  tax REAL NOT NULL DEFAULT 0,
  notes TEXT NOT NULL DEFAULT '',      -- what was bought and why, typed in when scanning
  general TEXT NOT NULL DEFAULT '[]',  -- JSON: lines not for any one project: [{ id, item, qty, amount }]
  mime TEXT NOT NULL DEFAULT '',       -- '' when there is no photo (a purchase entered by hand)
  image TEXT NOT NULL DEFAULT '',      -- base64
  created_at TEXT NOT NULL
);
CREATE INDEX receipts_date ON receipts (date);
