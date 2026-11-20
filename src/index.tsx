// Home Projects Tracker on Cloudflare Workers.
//
//   GET  /                the app page, with the projects embedded (src/views/app.tsx)
//   /api/*                JSON the browser script saves and reloads through
//   /api/receipts/scan    keeps a receipt photo and reads it into line items (Workers AI)
//   /api/receipts         every receipt kept (POST saves what one says; /:id/photo, /:id/delete)
//   /app.css, /app.js     static files from public/ (served by Workers Static Assets)
import { Hono } from 'hono';
import { csrf } from 'hono/csrf';
import { HTTPException } from 'hono/http-exception';
import type { App, Env } from './env';
import { endSession, isSignedIn, passwordMatches, startSession } from './lib/auth';
import { BadRequest, createProject, getState, importBackup, saveChanges } from './lib/db';
import { deleteReceipt, keepPhoto, listReceipts, removePhoto, readPhoto, ReceiptError, saveReceipt, scanReceipt } from './lib/receipts';
import { AppPage } from './views/app';
import { LoginPage, SetupPage } from './views/login';

const app = new Hono<App>();

// Everything the browser app starts from.
const appState = async (env: Env) => getState(env.DB);

// Form posts must come from this site.
app.use(csrf());

// ---------- signing in ----------
app.use(async (c, next) => {
  if (!c.env.APP_PASSWORD) return c.html(<SetupPage />, 503);
  const path = c.req.path;
  if (path === '/login' || await isSignedIn(c)) return next();
  return path.startsWith('/api/') ? c.json({ error: 'Signed out' }, 401) : c.redirect('/login');
});

app.get('/login', c => c.html(<LoginPage />));
app.post('/login', async c => {
  const form = await c.req.parseBody();
  if (!await passwordMatches(c.env.APP_PASSWORD!, String(form.password ?? ''))) return c.html(<LoginPage error="That password isn't right." />, 401);
  await startSession(c);
  return c.redirect('/');
});
app.post('/logout', c => { endSession(c); return c.redirect('/login'); });

// ---------- the app ----------
app.get('/', async c => {
  c.header('Cache-Control', 'no-store');
  return c.html(<AppPage state={await appState(c.env)} />);
});

// ---------- data ----------
app.get('/api/state', async c => c.json(await appState(c.env)));
app.post('/api/save', async c => { await saveChanges(c.env.DB, await c.req.json()); return c.json({ ok: true }); });
app.post('/api/projects', async c => c.json(await createProject(c.env.DB, await c.req.json())));
app.post('/api/import', async c => { await importBackup(c.env.DB, await c.req.json()); return c.json(await appState(c.env)); });

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
      try { await keepPhoto(c.env.DB, id, String(image ?? '')); kept = true; }
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
  try { await keepPhoto(c.env.DB, id, String(image ?? '')); return c.json({ ok: true }); }
  catch (error) { if (error instanceof ReceiptError) return c.json({ error: error.message }, 400); throw error; }
});
app.get('/api/receipts', async c => c.json({ receipts: await listReceipts(c.env.DB) }));
app.post('/api/receipts', async c => {
  try { await saveReceipt(c.env.DB, await c.req.json()); return c.json({ ok: true }); }
  catch (error) { if (error instanceof ReceiptError) return c.json({ error: error.message }, 400); throw error; }
});
app.get('/api/receipts/:id/photo', async c => {
  const photo = await readPhoto(c.env.DB, c.req.param('id'));
  if (!photo) return c.text('No photo was kept for this receipt.', 404);
  // A photo can be replaced, so the page asks for it with ?v= (its size) and only that address is kept for good.
  const cache = c.req.query('v') ? 'private, max-age=31536000, immutable' : 'private, no-cache';
  return c.body(photo.bytes, 200, { 'Content-Type': photo.mime, 'Cache-Control': cache });
});
app.post('/api/receipts/:id/photo/delete', async c => {
  try { await removePhoto(c.env.DB, c.req.param('id')); return c.json({ ok: true }); }
  catch (error) { if (error instanceof ReceiptError) return c.json({ error: error.message }, 400); throw error; }
});
app.post('/api/receipts/:id/delete', async c => {
  try { await deleteReceipt(c.env.DB, c.req.param('id')); return c.json({ ok: true }); }
  catch (error) { if (error instanceof ReceiptError) return c.json({ error: error.message }, 400); throw error; }
});

app.onError((err, c) => {
  if (err instanceof HTTPException) return err.getResponse();
  if (err instanceof BadRequest || err instanceof SyntaxError) return c.text(err.message, 400);
  console.error(err);
  return c.text('Something went wrong on the server.', 500);
});

export default app;
