// Accounts, households and sign-in.
//
// Everyone has their own email and password (PBKDF2). A signed-in browser holds a random token in a
// cookie; the sessions table keeps only its SHA-256, with the household that browser is looking at.
// People join a household through a one-use invite link; a household owner can also make a one-use
// link for someone in it to set a new password. The very first account is made with the old
// site-wide password (APP_PASSWORD) and takes over everything made before accounts. Anyone else with
// the site's sign-up link can make an account, which starts a household of their own; site admins
// run that link and can make a password link for anyone (the site sends no email).
import type { Context } from 'hono';
import { getCookie, setCookie, deleteCookie } from 'hono/cookie';
import type { App } from '../env';

const COOKIE = 'home_session';
const SESSION_DAYS = 90;
// A session used within this many days of running out is extended, so a phone that opens the app
// now and then (from its home screen, say) stays signed in.
const RENEW_DAYS = 60;
const LINK_DAYS = 7;
// Workers caps PBKDF2 at 100,000 iterations.
const ITERATIONS = 100_000;
// Sign-in is refused for an email after this many wrong passwords in this many minutes.
const MAX_FAILURES = 10, FAILURE_MINUTES = 15;
// At most this many new accounts from one computer (IP address) a day, and from everyone a day.
const SIGNUPS_PER_IP = 5, SIGNUPS_PER_DAY = 50;
// The sign-up code: easy to read out, with no 0/o or 1/l to mix up.
const CODE_LETTERS = 'abcdefghjkmnpqrstuvwxyz23456789', CODE_LENGTH = 10;
const SIGNUP_KEY = 'site:signup';

export class AuthError extends Error {}

export interface User { id: number; email: string; name: string; site_admin: boolean }
export interface Household { id: number; name: string; role: string }
export interface Member { id: number; name: string; email: string; role: string; joined_at: string }
export interface Session { id: string; user: User; household: Household; households: Household[] }

// ---------- small helpers ----------

const b64 = (bytes: ArrayBuffer | Uint8Array) => btoa(String.fromCharCode(...new Uint8Array(bytes)));
const unb64 = (s: string) => new Uint8Array([...atob(s)].map(c => c.charCodeAt(0)));
const hex = (bytes: ArrayBuffer) => [...new Uint8Array(bytes)].map(b => b.toString(16).padStart(2, '0')).join('');
const sha256 = async (s: string) => hex(await crypto.subtle.digest('SHA-256', new TextEncoder().encode(s)));
const randomToken = () => b64(crypto.getRandomValues(new Uint8Array(32))).replace(/\+/g, '-').replace(/\//g, '_').replace(/=+$/, '');
const now = () => new Date().toISOString();

/** Same length in, same time taken, whether they match or not. */
function sameBytes(a: Uint8Array, b: Uint8Array) {
  if (a.length !== b.length) return false;
  let diff = 0;
  for (let i = 0; i < a.length; i++) diff |= a[i] ^ b[i];
  return diff === 0;
}

async function pbkdf2(password: string, salt: BufferSource, iterations: number) {
  const key = await crypto.subtle.importKey('raw', new TextEncoder().encode(password), 'PBKDF2', false, ['deriveBits']);
  return new Uint8Array(await crypto.subtle.deriveBits({ name: 'PBKDF2', hash: 'SHA-256', salt, iterations }, key, 256));
}

export async function hashPassword(password: string) {
  const salt = crypto.getRandomValues(new Uint8Array(16));
  return `pbkdf2$${ITERATIONS}$${b64(salt)}$${b64(await pbkdf2(password, salt, ITERATIONS))}`;
}

async function passwordIs(stored: string, attempt: string) {
  const [scheme, iterations, salt, hash] = stored.split('$');
  if (scheme !== 'pbkdf2') return false;
  return sameBytes(await pbkdf2(attempt, unb64(salt), Number(iterations)), unb64(hash));
}

// Compares the two values' hashes, so the time taken says nothing about the password.
async function siteOldPasswordIs(password: string, attempt: string) {
  const [a, b] = await Promise.all([sha256(`pw:${password}`), sha256(`pw:${attempt}`)]);
  return a === b;
}

export const cleanEmail = (v: unknown) => String(v ?? '').trim().toLowerCase().slice(0, 200);
export const cleanName = (v: unknown) => String(v ?? '').trim().replace(/\s+/g, ' ').slice(0, 80);

/** Throws with what's wrong with a new account's details, if anything. */
export function checkNewAccount(name: string, email: string, password: string) {
  if (!name) throw new AuthError('Add your name, so the others know who made a change.');
  if (!/^[^\s@]+@[^\s@]+\.[^\s@]+$/.test(email)) throw new AuthError("That email address doesn't look right.");
  checkPassword(password);
}
function checkPassword(password: string) {
  if (password.length < 8) throw new AuthError('Use a password of at least 8 characters.');
  if (password.length > 200) throw new AuthError('That password is too long.');
}

// ---------- sessions ----------

const cookieOptions = (c: Context<App>) => ({
  path: '/', httpOnly: true, sameSite: 'Lax' as const, secure: new URL(c.req.url).protocol === 'https:', maxAge: SESSION_DAYS * 86400,
});

async function startSession(c: Context<App>, userId: number, householdId: number | null) {
  const token = randomToken();
  await c.env.DB.prepare('INSERT INTO sessions (id, user_id, household_id, expires_at, created_at) VALUES (?, ?, ?, ?, ?)')
    .bind(await sha256(token), userId, householdId, Date.now() + SESSION_DAYS * 86400000, now()).run();
  setCookie(c, COOKIE, token, cookieOptions(c));
}

export async function endSession(c: Context<App>) {
  const token = getCookie(c, COOKIE);
  if (token) await c.env.DB.prepare('DELETE FROM sessions WHERE id = ?').bind(await sha256(token)).run();
  deleteCookie(c, COOKIE, { path: '/' });
}

export const householdsOf = async (db: D1Database, userId: number) => (await db.prepare(`
  SELECT h.id, h.name, m.role FROM members m JOIN households h ON h.id = m.household_id
  WHERE m.user_id = ? ORDER BY m.joined_at, h.id`).bind(userId).all<Household>()).results;

/** The signed-in person and the household they're looking at, or null when signed out. */
export async function currentSession(c: Context<App>): Promise<Session | null> {
  const token = getCookie(c, COOKIE);
  if (!token) return null;
  const id = await sha256(token), db = c.env.DB;
  const row = await db.prepare(`SELECT s.user_id, s.household_id, s.expires_at, u.email, u.name, u.site_admin
    FROM sessions s JOIN users u ON u.id = s.user_id WHERE s.id = ?`).bind(id)
    .first<{ user_id: number; household_id: number | null; expires_at: number; email: string; name: string; site_admin: number }>();
  if (!row || row.expires_at < Date.now()) return null;
  const households = await householdsOf(db, row.user_id);
  // Fall back to their first household if this one was left, or they were taken out of it.
  const household = households.find(h => h.id === row.household_id) ?? households[0];
  if (!household) {
    // Someone taken out of their last household gets a fresh one of their own.
    await createHousehold(db, row.user_id, `${firstName(row.name)}'s home`);
    return currentSession(c);
  }
  if (household.id !== row.household_id || row.expires_at - Date.now() < RENEW_DAYS * 86400000) {
    await db.prepare('UPDATE sessions SET household_id = ?, expires_at = ? WHERE id = ?')
      .bind(household.id, Date.now() + SESSION_DAYS * 86400000, id).run();
    setCookie(c, COOKIE, token, cookieOptions(c));
  }
  return { id, user: { id: row.user_id, email: row.email, name: row.name, site_admin: !!row.site_admin }, household, households };
}

export async function switchHousehold(c: Context<App>, s: Session, householdId: number) {
  if (!s.households.some(h => h.id === householdId)) throw new AuthError("You're not in that household.");
  await c.env.DB.prepare('UPDATE sessions SET household_id = ? WHERE id = ?').bind(householdId, s.id).run();
}

// ---------- signing in and up ----------

export const hasAnyUser = async (db: D1Database) => !!await db.prepare('SELECT 1 FROM users LIMIT 1').first();

export async function signIn(c: Context<App>, emailIn: unknown, password: string) {
  const db = c.env.DB, email = cleanEmail(emailIn), since = Date.now() - FAILURE_MINUTES * 60000;
  const failures = await db.prepare('SELECT count(*) AS n FROM sign_in_failures WHERE email = ? AND at > ?').bind(email, since).first<{ n: number }>();
  if ((failures?.n ?? 0) >= MAX_FAILURES) throw new AuthError(`Too many tries. Wait ${FAILURE_MINUTES} minutes and try again.`);
  const user = await db.prepare('SELECT id, password FROM users WHERE email = ?').bind(email).first<{ id: number; password: string }>();
  // Hash even when there's no such account, so the time taken doesn't say which emails have one.
  const ok = user ? await passwordIs(user.password, password) : (await hashPassword(password), false);
  if (!ok || !user) {
    await db.batch([
      db.prepare('INSERT INTO sign_in_failures (email, at) VALUES (?, ?)').bind(email, Date.now()),
      db.prepare('DELETE FROM sign_in_failures WHERE at < ?').bind(since),
    ]);
    throw new AuthError("That email and password don't match.");
  }
  await startSession(c, user.id, null);
}

async function createUser(db: D1Database, name: string, email: string, password: string) {
  checkNewAccount(name, email, password);
  if (await db.prepare('SELECT 1 FROM users WHERE email = ?').bind(email).first())
    throw new AuthError('There is already an account with that email. Sign in instead.');
  const row = await db.prepare('INSERT INTO users (email, name, password, created_at) VALUES (?, ?, ?, ?) RETURNING id')
    .bind(email, name, await hashPassword(password), now()).first<{ id: number }>();
  return row!.id;
}

export async function createHousehold(db: D1Database, userId: number, name: string) {
  const row = await db.prepare('INSERT INTO households (name, created_at) VALUES (?, ?) RETURNING id').bind(cleanName(name) || 'Our home', now()).first<{ id: number }>();
  await db.prepare("INSERT INTO members (household_id, user_id, role, joined_at) VALUES (?, ?, 'owner', ?)").bind(row!.id, userId, now()).run();
  return row!.id;
}

/** The first account: needs the old site password, and takes over the first household (everything made so far). */
export async function setUpFirstAccount(c: Context<App>, form: Record<string, unknown>) {
  const db = c.env.DB;
  if (await hasAnyUser(db)) throw new AuthError('This site is already set up. Sign in instead.');
  if (!c.env.APP_PASSWORD || !await siteOldPasswordIs(c.env.APP_PASSWORD, String(form.site_password ?? '')))
    throw new AuthError("That site password isn't right.");
  const userId = await createUser(db, cleanName(form.name), cleanEmail(form.email), String(form.password ?? ''));
  await db.prepare("INSERT OR IGNORE INTO households (id, name, created_at) VALUES (1, 'Our home', ?)").bind(now()).run();
  await db.prepare("INSERT INTO members (household_id, user_id, role, joined_at) VALUES (1, ?, 'owner', ?)").bind(userId, now()).run();
  await db.prepare('UPDATE users SET site_admin = 1 WHERE id = ?').bind(userId).run();
  await startSession(c, userId, 1);
}

// ---------- signing up from the site's sign-up link ----------

const firstName = (name: string) => name.split(' ')[0] || 'My';

/** The site's sign-up code, or '' while sign-up is off. */
export async function signupCode(db: D1Database) {
  const row = await db.prepare('SELECT value FROM settings WHERE key = ?').bind(SIGNUP_KEY).first<{ value: string }>();
  return row ? String(JSON.parse(row.value).code ?? '') : '';
}
export async function signupCodeIs(db: D1Database, attempt: unknown) {
  const code = await signupCode(db), tried = String(attempt ?? '').trim().toLowerCase();
  return !!code && !!tried && await siteOldPasswordIs(code, tried);
}

/** A new account with a household of its own. Needs the sign-up code, and only so many a day. */
export async function signUp(c: Context<App>, form: Record<string, unknown>) {
  const db = c.env.DB;
  if (!await signupCode(db)) throw new AuthError("Sign-up is turned off right now. Ask whoever sent you the site.");
  if (!await signupCodeIs(db, form.code)) throw new AuthError("That sign-up code isn't right. Check the link you were sent, or ask for a new one.");
  const ip = c.req.header('CF-Connecting-IP') ?? 'unknown', since = Date.now() - 86400000;
  const counts = await db.prepare('SELECT count(*) AS everyone, sum(ip = ?) AS here FROM sign_ups WHERE at > ?').bind(ip, since)
    .first<{ everyone: number; here: number | null }>();
  if ((counts?.here ?? 0) >= SIGNUPS_PER_IP || (counts?.everyone ?? 0) >= SIGNUPS_PER_DAY)
    throw new AuthError('A lot of accounts were made just now. Try again tomorrow.');
  const name = cleanName(form.name);
  const userId = await createUser(db, name, cleanEmail(form.email), String(form.password ?? ''));
  await db.batch([
    db.prepare('INSERT INTO sign_ups (ip, at) VALUES (?, ?)').bind(ip, Date.now()),
    db.prepare('DELETE FROM sign_ups WHERE at < ?').bind(since),
  ]);
  const householdId = await createHousehold(db, userId, cleanName(form.household) || `${firstName(name)}'s home`);
  await startSession(c, userId, householdId);
}

// ---------- running the site (site admins) ----------

export interface Account { id: number; name: string; email: string; created_at: string; site_admin: number; households: string | null }

function mustBeAdmin(s: Session) {
  if (!s.user.site_admin) throw new AuthError('Only a site admin can do that.');
}

/** What the Site card in Settings shows: the sign-up link and every account. */
export async function siteState(c: Context<App>, s: Session) {
  mustBeAdmin(s);
  const db = c.env.DB, code = await signupCode(db);
  const accounts = (await db.prepare(`SELECT u.id, u.name, u.email, u.created_at, u.site_admin,
      (SELECT group_concat(h.name, ', ') FROM members m JOIN households h ON h.id = m.household_id WHERE m.user_id = u.id) AS households
    FROM users u ORDER BY u.id`).all<Account>()).results;
  return { signupUrl: code ? `${new URL(c.req.url).origin}/signup/${code}` : '', accounts };
}

/** Makes a new sign-up code (so the old link stops working), or turns sign-up off. */
export async function setSignup(c: Context<App>, s: Session, on: boolean) {
  mustBeAdmin(s);
  const code = on ? [...crypto.getRandomValues(new Uint8Array(CODE_LENGTH))].map(b => CODE_LETTERS[b % CODE_LETTERS.length]).join('') : '';
  await c.env.DB.prepare('INSERT INTO settings (key, value) VALUES (?, ?) ON CONFLICT (key) DO UPDATE SET value = excluded.value')
    .bind(SIGNUP_KEY, JSON.stringify({ code, updatedAt: now() })).run();
  return siteState(c, s);
}

export async function makeSiteAdmin(c: Context<App>, s: Session, userId: number) {
  mustBeAdmin(s);
  const r = await c.env.DB.prepare('UPDATE users SET site_admin = 1 WHERE id = ?').bind(userId).run();
  if (!r.meta.changes) throw new AuthError('There is no such account.');
  return siteState(c, s);
}

/** A link for anyone to set a new password, for when they've forgotten it and nobody in their household can help. */
export async function makeSiteResetLink(c: Context<App>, s: Session, userId: number) {
  mustBeAdmin(s);
  const db = c.env.DB;
  const home = await db.prepare('SELECT household_id FROM members WHERE user_id = ? ORDER BY joined_at LIMIT 1').bind(userId).first<{ household_id: number }>();
  if (!home) throw new AuthError('There is no such account.');
  const token = randomToken();
  await db.prepare("INSERT INTO links (id, kind, household_id, user_id, created_by, expires_at, created_at) VALUES (?, 'reset', ?, ?, ?, ?, ?)")
    .bind(await sha256(token), home.household_id, userId, s.user.id, Date.now() + LINK_DAYS * 86400000, now()).run();
  return { url: `${new URL(c.req.url).origin}/reset/${token}`, days: LINK_DAYS };
}

/** Deletes an account (a junk one, or someone who asked), with any household only they were in and its projects and receipts. */
export async function deleteAccount(c: Context<App>, s: Session, userId: number) {
  mustBeAdmin(s);
  if (userId === s.user.id) throw new AuthError("You can't delete your own account here.");
  const db = c.env.DB;
  const alone = (await db.prepare(`SELECT household_id AS id FROM members m WHERE user_id = ?
    AND (SELECT count(*) FROM members o WHERE o.household_id = m.household_id) = 1`).bind(userId).all<{ id: number }>()).results.map(r => r.id);
  await db.batch([
    ...alone.flatMap(id => [
      db.prepare('DELETE FROM projects WHERE household_id = ?').bind(id),
      db.prepare('DELETE FROM receipts WHERE household_id = ?').bind(id),
      db.prepare("DELETE FROM settings WHERE key = 'settings:' || ?").bind(id),
      db.prepare('DELETE FROM links WHERE household_id = ?').bind(id),
      db.prepare('DELETE FROM members WHERE household_id = ?').bind(id),
      db.prepare('DELETE FROM households WHERE id = ?').bind(id),
    ]),
    db.prepare('DELETE FROM sessions WHERE user_id = ?').bind(userId),
    db.prepare('DELETE FROM members WHERE user_id = ?').bind(userId),
    db.prepare('UPDATE links SET used_at = ? WHERE user_id = ? AND used_at IS NULL').bind(now(), userId),
    db.prepare('DELETE FROM users WHERE id = ?').bind(userId),
  ]);
  return siteState(c, s);
}

// ---------- invite and reset links ----------

interface LinkRow { id: string; kind: string; household_id: number; user_id: number | null; expires_at: number; used_at: string | null; household: string; by_name: string; for_name: string | null }

/** A link still good to use, with the household it's for and who made it; null if it isn't. */
export async function readLink(db: D1Database, token: string) {
  const row = await db.prepare(`SELECT l.*, h.name AS household, u.name AS by_name, f.name AS for_name
    FROM links l JOIN households h ON h.id = l.household_id JOIN users u ON u.id = l.created_by LEFT JOIN users f ON f.id = l.user_id
    WHERE l.id = ?`).bind(await sha256(token)).first<LinkRow>();
  return row && !row.used_at && row.expires_at > Date.now() ? row : null;
}

export async function makeLink(c: Context<App>, s: Session, kind: 'join' | 'reset', userId?: number) {
  const db = c.env.DB;
  if (kind === 'reset') {
    if (s.household.role !== 'owner') throw new AuthError('Only the household owner can make a password link.');
    if (!await db.prepare('SELECT 1 FROM members WHERE household_id = ? AND user_id = ?').bind(s.household.id, userId).first())
      throw new AuthError("That person isn't in this household.");
  }
  const token = randomToken();
  await db.prepare('INSERT INTO links (id, kind, household_id, user_id, created_by, expires_at, created_at) VALUES (?, ?, ?, ?, ?, ?, ?)')
    .bind(await sha256(token), kind, s.household.id, kind === 'reset' ? userId : null, s.user.id, Date.now() + LINK_DAYS * 86400000, now()).run();
  return { url: `${new URL(c.req.url).origin}/${kind === 'join' ? 'join' : 'reset'}/${token}`, days: LINK_DAYS };
}

// Marks a link used, but only if nobody else just used it.
async function useLink(db: D1Database, link: LinkRow) {
  const r = await db.prepare('UPDATE links SET used_at = ? WHERE id = ? AND used_at IS NULL').bind(now(), link.id).run();
  if (!r.meta.changes) throw new AuthError('That link has already been used.');
}

async function addMember(db: D1Database, householdId: number, userId: number) {
  await db.prepare("INSERT OR IGNORE INTO members (household_id, user_id, role, joined_at) VALUES (?, ?, 'member', ?)").bind(householdId, userId, now()).run();
}

/** Joins with a new account made from the invite page. */
export async function joinAsNewUser(c: Context<App>, token: string, form: Record<string, unknown>) {
  const db = c.env.DB, link = await readLink(db, token);
  if (!link || link.kind !== 'join') throw new AuthError('This invite link has run out or was already used. Ask for a new one.');
  const userId = await createUser(db, cleanName(form.name), cleanEmail(form.email), String(form.password ?? ''));
  await useLink(db, link);
  await addMember(db, link.household_id, userId);
  await startSession(c, userId, link.household_id);
}

/** Joins as someone already signed in. */
export async function joinAsSignedIn(c: Context<App>, s: Session, token: string) {
  const db = c.env.DB, link = await readLink(db, token);
  if (!link || link.kind !== 'join') throw new AuthError('This invite link has run out or was already used. Ask for a new one.');
  await useLink(db, link);
  await addMember(db, link.household_id, s.user.id);
  await switchHousehold(c, { ...s, households: [...s.households, { id: link.household_id, name: link.household, role: 'member' }] }, link.household_id);
}

/** Sets a new password from a reset link, signs out everywhere else, and signs in here. */
export async function resetPassword(c: Context<App>, token: string, password: string) {
  const db = c.env.DB, link = await readLink(db, token);
  if (!link || link.kind !== 'reset' || !link.user_id) throw new AuthError('This link has run out or was already used. Ask for a new one.');
  checkPassword(password);
  await useLink(db, link);
  await db.batch([
    db.prepare('UPDATE users SET password = ? WHERE id = ?').bind(await hashPassword(password), link.user_id),
    db.prepare('DELETE FROM sessions WHERE user_id = ?').bind(link.user_id),
  ]);
  await startSession(c, link.user_id, link.household_id);
}

// ---------- account and household settings ----------

export async function changePassword(c: Context<App>, s: Session, current: string, next: string) {
  const db = c.env.DB;
  const row = await db.prepare('SELECT password FROM users WHERE id = ?').bind(s.user.id).first<{ password: string }>();
  if (!row || !await passwordIs(row.password, current)) throw new AuthError("Your current password isn't right.");
  checkPassword(next);
  // Signs out every other device.
  await db.batch([
    db.prepare('UPDATE users SET password = ? WHERE id = ?').bind(await hashPassword(next), s.user.id),
    db.prepare('DELETE FROM sessions WHERE user_id = ? AND id != ?').bind(s.user.id, s.id),
  ]);
}

export async function updateProfile(db: D1Database, s: Session, nameIn: unknown, emailIn: unknown) {
  const name = cleanName(nameIn), email = cleanEmail(emailIn);
  if (!name) throw new AuthError('Add your name.');
  if (!/^[^\s@]+@[^\s@]+\.[^\s@]+$/.test(email)) throw new AuthError("That email address doesn't look right.");
  if (await db.prepare('SELECT 1 FROM users WHERE email = ? AND id != ?').bind(email, s.user.id).first())
    throw new AuthError('Someone else already uses that email.');
  await db.prepare('UPDATE users SET name = ?, email = ? WHERE id = ?').bind(name, email, s.user.id).run();
}

export const membersOf = async (db: D1Database, householdId: number) => (await db.prepare(`
  SELECT u.id, u.name, u.email, m.role, m.joined_at FROM members m JOIN users u ON u.id = m.user_id
  WHERE m.household_id = ? ORDER BY m.joined_at, u.id`).bind(householdId).all<Member>()).results;

export async function renameHousehold(db: D1Database, s: Session, name: unknown) {
  const clean = cleanName(name);
  if (!clean) throw new AuthError('Give the household a name.');
  await db.prepare('UPDATE households SET name = ? WHERE id = ?').bind(clean, s.household.id).run();
}

/** Takes someone out of the current household: an owner removing a member, or anyone leaving. */
export async function removeMember(db: D1Database, s: Session, userId: number) {
  const leaving = userId === s.user.id;
  if (!leaving && s.household.role !== 'owner') throw new AuthError('Only the household owner can remove people.');
  const members = await membersOf(db, s.household.id);
  const them = members.find(m => m.id === userId);
  if (!them) throw new AuthError("That person isn't in this household.");
  const owners = members.filter(m => m.role === 'owner');
  if (them.role === 'owner' && owners.length === 1 && members.length > 1)
    throw new AuthError('Make someone else an owner before you leave, so the household still has one.');
  if (members.length === 1) throw new AuthError("You're the only one here, so there's no one to leave the projects with.");
  await db.prepare('DELETE FROM members WHERE household_id = ? AND user_id = ?').bind(s.household.id, userId).run();
}

export async function makeOwner(db: D1Database, s: Session, userId: number) {
  if (s.household.role !== 'owner') throw new AuthError('Only an owner can make someone else an owner.');
  const r = await db.prepare("UPDATE members SET role = 'owner' WHERE household_id = ? AND user_id = ?").bind(s.household.id, userId).run();
  if (!r.meta.changes) throw new AuthError("That person isn't in this household.");
}
