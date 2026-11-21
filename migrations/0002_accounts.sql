-- Accounts and shared households.
--
-- Everyone signs in with their own email and password. Projects, receipts and settings belong to a
-- household; everyone in a household sees and edits all of its projects. A person can be in more
-- than one household (their own, and a friend's they were invited to) and switches between them.
-- New people join only through an invite link made by someone already in the household.

CREATE TABLE users (
  id INTEGER PRIMARY KEY AUTOINCREMENT,
  email TEXT NOT NULL UNIQUE COLLATE NOCASE,
  name TEXT NOT NULL DEFAULT '',
  password TEXT NOT NULL,              -- pbkdf2$<iterations>$<salt b64>$<hash b64>
  created_at TEXT NOT NULL
);

CREATE TABLE households (
  id INTEGER PRIMARY KEY AUTOINCREMENT,
  name TEXT NOT NULL,
  created_at TEXT NOT NULL
);

CREATE TABLE members (
  household_id INTEGER NOT NULL REFERENCES households (id) ON DELETE CASCADE,
  user_id INTEGER NOT NULL REFERENCES users (id) ON DELETE CASCADE,
  role TEXT NOT NULL DEFAULT 'member',  -- 'owner' (can remove people and reset passwords) or 'member'
  joined_at TEXT NOT NULL,
  PRIMARY KEY (household_id, user_id)
);
CREATE INDEX members_user ON members (user_id);

-- A signed-in browser. The cookie holds a random token; only its SHA-256 is kept here.
CREATE TABLE sessions (
  id TEXT PRIMARY KEY,                 -- SHA-256 of the cookie's token, hex
  user_id INTEGER NOT NULL REFERENCES users (id) ON DELETE CASCADE,
  household_id INTEGER,                -- the household this browser is looking at
  expires_at INTEGER NOT NULL,         -- ms since 1970
  created_at TEXT NOT NULL
);
CREATE INDEX sessions_user ON sessions (user_id);

-- Links that let someone join a household ('join'), or set a new password ('reset', made by a
-- household owner for someone in it). Used once; only the token's SHA-256 is kept.
CREATE TABLE links (
  id TEXT PRIMARY KEY,                 -- SHA-256 of the link's token, hex
  kind TEXT NOT NULL,                  -- 'join' or 'reset'
  household_id INTEGER NOT NULL REFERENCES households (id) ON DELETE CASCADE,
  user_id INTEGER,                     -- reset: whose password
  created_by INTEGER NOT NULL,
  expires_at INTEGER NOT NULL,
  used_at TEXT,
  created_at TEXT NOT NULL
);

-- Failed sign-ins, so a password can't be guessed by trying thousands.
CREATE TABLE sign_in_failures (
  email TEXT NOT NULL COLLATE NOCASE,
  at INTEGER NOT NULL
);
CREATE INDEX sign_in_failures_email ON sign_in_failures (email, at);

-- Everything made before accounts goes to the first household. The first person to set up an
-- account (with the old site password) becomes its owner.
INSERT INTO households (id, name, created_at) VALUES (1, 'Our home', strftime('%Y-%m-%dT%H:%M:%fZ', 'now'));

ALTER TABLE projects ADD COLUMN household_id INTEGER NOT NULL DEFAULT 1;
CREATE INDEX projects_household ON projects (household_id);
ALTER TABLE receipts ADD COLUMN household_id INTEGER NOT NULL DEFAULT 1;
CREATE INDEX receipts_household ON receipts (household_id, date);

-- Settings are kept per household, under the key 'settings:<household id>'.
UPDATE settings SET key = 'settings:1' WHERE key = 'settings';
