-- Opening the site to friends and family.
--
-- Anyone with the site's sign-up link can make an account, which starts a household of their own.
-- The link carries a code kept here (settings key 'site:signup'); a site admin can make a new one,
-- which stops the old link working, or turn sign-up off. Site admins also see every account and can
-- make a password link for anyone, since the site sends no email.

ALTER TABLE users ADD COLUMN site_admin INTEGER NOT NULL DEFAULT 0;
-- Whoever set the site up runs it.
UPDATE users SET site_admin = 1 WHERE id = (SELECT min(id) FROM users);

-- Recent sign-ups, so one computer can't make accounts by the hundred even with the link.
CREATE TABLE sign_ups (
  ip TEXT NOT NULL,
  at INTEGER NOT NULL                  -- ms since 1970
);
CREATE INDEX sign_ups_ip ON sign_ups (ip, at);
