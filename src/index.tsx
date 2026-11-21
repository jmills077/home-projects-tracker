// Home Projects Tracker on Cloudflare Workers.
//
//   GET  /                the app page, with the household's projects embedded (src/views/app.tsx)
//   /login, /setup        signing in; the first account is set up with the old site password
//   /join/:token          joining a household from an invite link; /reset/:token sets a new password
//   /api/*                JSON the browser script saves and reloads through
//   /api/receipts/scan    keeps a receipt photo and reads it into line items (Workers AI)
//   /api/receipts         every receipt kept (POST saves what one says; /:id/photo, /:id/delete)
//   /app.css, /app.js     static files from public/ (served by Workers Static Assets)
import { Hono } from 'hono';
import type { Context } from 'hono';
import { csrf } from 'hono/csrf';
import { HTTPException } from 'hono/http-exception';
import type { App } from './env';
import {
  AuthError, changePassword, cleanEmail, cleanName, createHousehold, currentSession, endSession, hasAnyUser, joinAsNewUser,
  joinAsSignedIn, makeLink, makeOwner, membersOf, readLink, removeMember, renameHousehold, resetPassword, setUpFirstAccount,
  signIn, switchHousehold, updateProfile, type Session,
} from './lib/auth';
import { BadRequest, createProject, getState, importBackup, saveChanges } from './lib/db';
import { deleteReceipt, keepPhoto, listReceipts, removePhoto, readPhoto, ReceiptError, saveReceipt, scanReceipt } from './lib/receipts';
import { AppPage } from './views/app';
import { DeadLinkPage, JoinPage, LoginPage, ResetPage, SetupPage } from './views/login';

const app = new Hono<App>();

// Everything the browser app starts from: the household's projects and settings, who's signed in,
// and who else is in the household.
const appState = async (db: D1Database, s: Session) => ({
  ...await getState(db, s.household.id),
  me: s.user,
  household: s.household,
  households: s.households,
  members: await membersOf(db, s.household.id),
});

// Only a path on this site, so a crafted link can't send someone elsewhere after signing in.
const safeNext = (v: unknown) => { const p = String(v ?? ''); return p.startsWith('/') && !p.startsWith('//') ? p : '/'; };
const form = async (c: Context<App>) => await c.req.parseBody() as Record<string, string>;

// Form posts must come from this site.
app.use(csrf());

// ---------- signing in ----------
const OPEN = /^\/(login|setup|logout|join\/[\w-]+|reset\/[\w-]+)$/;
app.use(async (c, next) => {
  const path = c.req.path;
  const session = await currentSession(c);
  if (session) { c.set('session', session); return next(); }
  if (OPEN.test(path)) return next();
  if (path.startsWith('/api/')) return c.json({ error: 'Signed out' }, 401);
  return c.redirect(await hasAnyUser(c.env.DB) ? '/login' : '/setup');
});

app.get('/login', async c => {
  if (c.get('session')) return c.redirect(safeNext(c.req.query('next')));
  if (!await hasAnyUser(c.env.DB)) return c.redirect('/setup');
  return c.html(<LoginPage next={c.req.query('next')} />);
});
app.post('/login', async c => {
  const f = await form(c);
  try { await signIn(c, f.email, String(f.password ?? '')); }
  catch (e) { if (e instanceof AuthError) return c.html(<LoginPage error={e.message} email={cleanEmail(f.email)} next={f.next} />, 401); throw e; }
  return c.redirect(safeNext(f.next));
});
app.post('/logout', async c => { await endSession(c); return c.redirect('/login'); });

app.get('/setup', async c => {
  if (await hasAnyUser(c.env.DB)) return c.redirect('/login');
  return c.html(<SetupPage noSitePassword={!c.env.APP_PASSWORD} />);
});
app.post('/setup', async c => {
  const f = await form(c);
  try { await setUpFirstAccount(c, f); }
  catch (e) { if (e instanceof AuthError) return c.html(<SetupPage error={e.message} name={cleanName(f.name)} email={cleanEmail(f.email)} />, 400); throw e; }
  return c.redirect('/');
});

// Invite links: a new person makes an account here; someone signed in just joins.
app.get('/join/:token', async c => {
  const link = await readLink(c.env.DB, c.req.param('token'));
  if (!link || link.kind !== 'join') return c.html(<DeadLinkPage />, 410);
  const s = c.get('session');
  if (s?.households.some(h => h.id === link.household_id)) { await switchHousehold(c, s, link.household_id); return c.redirect('/'); }
  return c.html(<JoinPage token={c.req.param('token')} household={link.household} by={link.by_name} signedInAs={s?.user.name} />);
});
app.post('/join/:token', async c => {
  const token = c.req.param('token'), s = c.get('session'), f = await form(c);
  try { s ? await joinAsSignedIn(c, s, token) : await joinAsNewUser(c, token, f); }
  catch (e) {
    if (!(e instanceof AuthError)) throw e;
    const link = await readLink(c.env.DB, token);
    if (!link) return c.html(<DeadLinkPage />, 410);
    return c.html(<JoinPage token={token} household={link.household} by={link.by_name} signedInAs={s?.user.name}
      error={e.message} name={cleanName(f.name)} email={cleanEmail(f.email)} />, 400);
  }
  return c.redirect('/');
});

app.get('/reset/:token', async c => {
  const link = await readLink(c.env.DB, c.req.param('token'));
  if (!link || link.kind !== 'reset') return c.html(<DeadLinkPage />, 410);
  return c.html(<ResetPage token={c.req.param('token')} name={link.for_name ?? ''} />);
});
app.post('/reset/:token', async c => {
  const token = c.req.param('token'), f = await form(c);
  try { await resetPassword(c, token, String(f.password ?? '')); }
  catch (e) {
    if (!(e instanceof AuthError)) throw e;
    const link = await readLink(c.env.DB, token);
    if (!link) return c.html(<DeadLinkPage />, 410);
    return c.html(<ResetPage token={token} name={link.for_name ?? ''} error={e.message} />, 400);
  }
  return c.redirect('/');
});

// ---------- the app ----------
app.get('/', async c => {
  c.header('Cache-Control', 'no-store');
  return c.html(<AppPage state={await appState(c.env.DB, c.get('session'))} />);
});

// ---------- data ----------
const hid = (c: Context<App>) => c.get('session').household.id;
app.get('/api/state', async c => c.json(await appState(c.env.DB, c.get('session'))));
app.post('/api/save', async c => { await saveChanges(c.env.DB, hid(c), await c.req.json()); return c.json({ ok: true }); });
app.post('/api/projects', async c => c.json(await createProject(c.env.DB, hid(c), await c.req.json())));
app.post('/api/import', async c => { await importBackup(c.env.DB, hid(c), await c.req.json()); return c.json(await appState(c.env.DB, c.get('session'))); });

// ---------- account and household ----------
// Each answers with the fresh state (or a link to share), or { error } saying what's wrong.
const accountRoute = (path: string, run: (c: Context<App>, s: Session, body: any) => Promise<unknown>) =>
  app.post(path, async c => {
    const s = c.get('session');
    try {
      const out = await run(c, s, await c.req.json().catch(() => ({})));
      return c.json(out ?? await appState(c.env.DB, (await currentSession(c))!));
    } catch (e) { if (e instanceof AuthError) return c.json({ error: e.message }, 400); throw e; }
  });
const memberId = (c: Context<App>) => Number(c.req.param('id'));

accountRoute('/api/account', (c, s, b) => updateProfile(c.env.DB, s, b.name, b.email).then(() => undefined));
accountRoute('/api/account/password', (c, s, b) => changePassword(c, s, String(b.current ?? ''), String(b.next ?? '')).then(() => ({ ok: true })));
accountRoute('/api/household/switch', (c, s, b) => switchHousehold(c, s, Number(b.id)).then(() => undefined));
accountRoute('/api/household/rename', (c, s, b) => renameHousehold(c.env.DB, s, b.name).then(() => undefined));
accountRoute('/api/household/new', async (c, s, b) => {
  const id = await createHousehold(c.env.DB, s.user.id, b.name);
  await switchHousehold(c, { ...s, households: [...s.households, { id, name: '', role: 'owner' }] }, id);
});
accountRoute('/api/invites', (c, s) => makeLink(c, s, 'join'));
accountRoute('/api/members/:id/reset-link', (c, s) => makeLink(c, s, 'reset', memberId(c)));
accountRoute('/api/members/:id/remove', (c, s) => removeMember(c.env.DB, s, memberId(c)).then(() => undefined));
accountRoute('/api/members/:id/owner', (c, s) => makeOwner(c.env.DB, s, memberId(c)).then(() => undefined));

// ---------- receipts ----------
// The browser sends a shrunken photo as a data URL with an id it made for the receipt. The photo is
// kept first (for taxes and audits, even if it can't be read), then the line items come back for
// checking over. The items picked are added to a project's purchases by the browser, which then
// saves the store, date and total here.
app.post('/api/receipts/scan', async c => {
  const { id, image } = await c.req.json<{ id?: string; image?: string }>();
  try {
    let kept = false;
    if (id !== undefined) {
      try { await keepPhoto(c.env.DB, hid(c), id, String(image ?? '')); kept = true; }
      catch (error) { if (error instanceof ReceiptError) throw error; console.error(`Keeping receipt photo failed: ${error}`); }
    }
    return c.json({ ...await scanReceipt(c.env, String(image ?? '')), kept });
  } catch (error) {
    if (error instanceof ReceiptError) return c.json({ error: error.message }, 400);
    console.error(`Receipt scan failed: ${error}`);
    return c.json({ error: "Couldn't read the receipt just now. Try again in a minute." }, 502);
  }
});
// A photo kept without reading it (when reading failed and the lines are typed in instead, it's already kept).
app.post('/api/receipts/photo', async c => {
  const { id, image } = await c.req.json<{ id?: string; image?: string }>();
  try { await keepPhoto(c.env.DB, hid(c), id, String(image ?? '')); return c.json({ ok: true }); }
  catch (error) { if (error instanceof ReceiptError) return c.json({ error: error.message }, 400); throw error; }
});
app.get('/api/receipts', async c => c.json({ receipts: await listReceipts(c.env.DB, hid(c)) }));
app.post('/api/receipts', async c => {
  try { await saveReceipt(c.env.DB, hid(c), await c.req.json()); return c.json({ ok: true }); }
  catch (error) { if (error instanceof ReceiptError) return c.json({ error: error.message }, 400); throw error; }
});
app.get('/api/receipts/:id/photo', async c => {
  const photo = await readPhoto(c.env.DB, hid(c), c.req.param('id'));
  if (!photo) return c.text('No photo was kept for this receipt.', 404);
  // A photo can be replaced, so the page asks for it with ?v= (its size) and only that address is kept for good.
  const cache = c.req.query('v') ? 'private, max-age=31536000, immutable' : 'private, no-cache';
  return c.body(photo.bytes, 200, { 'Content-Type': photo.mime, 'Cache-Control': cache });
});
app.post('/api/receipts/:id/photo/delete', async c => {
  try { await removePhoto(c.env.DB, hid(c), c.req.param('id')); return c.json({ ok: true }); }
  catch (error) { if (error instanceof ReceiptError) return c.json({ error: error.message }, 400); throw error; }
});
app.post('/api/receipts/:id/delete', async c => {
  try { await deleteReceipt(c.env.DB, hid(c), c.req.param('id')); return c.json({ ok: true }); }
  catch (error) { if (error instanceof ReceiptError) return c.json({ error: error.message }, 400); throw error; }
});

app.onError((err, c) => {
  if (err instanceof HTTPException) return err.getResponse();
  if (err instanceof BadRequest || err instanceof SyntaxError) return c.text(err.message, 400);
  console.error(err);
  return c.text('Something went wrong on the server.', 500);
});

export default app;
