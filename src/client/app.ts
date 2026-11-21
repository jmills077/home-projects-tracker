// Home Projects Tracker in the browser: every page is drawn here from the projects, which the server
// embeds in the page and saves to the database. See README.md for how the pieces fit together.
import { workbook, type Cell, type Sheet } from './xlsx';
import { readSkp, readCutCsv, readPieceLine, fmtInches, type Piece } from './skp';

// ---------- what a project is ----------
// Two streams of work: projects on the house, and pieces built in the shop for the home.
const STREAMS = [
  ['home', 'Home improvement', 'Work on the house: a remodel, a repair, an upgrade.'],
  ['shop', 'Shop builds', 'A piece built in the shop for the home: a dresser, a cabinet, a table.'],
];
const STREAM_NAME = Object.fromEntries(STREAMS);
// Shorter tab names for the Projects page on phones.
const STREAM_SHORT = { all: 'All', home: 'Home', shop: 'Shop' };
const streamOf = p => STREAM_NAME[p.stream] ? p.stream : 'home';
// Where the work is. A complete project leaves the board for the archive.
const STATUSES = [['planned', 'Planned'], ['in_progress', 'In progress'], ['complete', 'Complete']];
const STATUS_NAME = Object.fromEntries(STATUSES);
const archived = p => p.status === 'complete';
// A frozen project is on hold: waiting on a contractor, the weather or the budget. It keeps its status,
// phase and dates, but leaves the board and calendar for the Frozen list until it is unfrozen.
// data.frozen is { at, reason }.
const isFrozen = p => !!p.data?.frozen;
// The phase of the work itself, tracked separately from the status above. Every project goes through
// the same four. Each phase after Ideation has its own due date; Install's is the project's target date.
const STAGES = [['ideation', 'Ideation'], ['design', 'Design'], ['build', 'Build'], ['install', 'Install']];
const STAGE_NAME = Object.fromEntries(STAGES);
const stagesFor = _p => STAGES;
const lastPhase = _p => 'install';
const stageOf = p => STAGE_NAME[p.stage] ? p.stage : 'ideation';
const stageIndex = p => STAGES.findIndex(([key]) => key === stageOf(p));
const stageDue = (p, key) => (key === 'install' ? p.data.due_date : key === 'ideation' ? '' : p.data.stage_due?.[key]) || '';
const NEXT_STEP = { planned: ['in_progress', 'Start work'], in_progress: ['complete', 'Mark complete'] };
const DEFAULT_SETTINGS = {
  household_name: '',
  waste_pct: 20,   // extra lumber to buy over what the cut list adds up to, for defects and offcuts
  // A rough price per board foot, for the lumber estimate on a project. Edit them in Settings.
  species: [
    { name: 'Pine', price: 4 }, { name: 'Poplar', price: 5 }, { name: 'Red oak', price: 7 }, { name: 'White oak', price: 10 },
    { name: 'Ash', price: 7 }, { name: 'Cherry', price: 9 }, { name: 'Hard maple', price: 8 }, { name: 'Walnut', price: 14 },
    { name: 'Hickory', price: 7 },
  ],
};

const num = (v, d = 0) => { const n = parseFloat(v); return Number.isFinite(n) ? n : d; };
const pos = v => Math.max(num(v), 0);
const cents = n => Math.round(n * 100) / 100;
const findSpecies = name => store.settings.species.find(s => s.name === name) || { name: name || '', price: 0 };

// Totals the pages show, worked out from the project: its budget, what's been spent so far (every
// purchase on it, from receipts or typed in) and the lumber it needs. Kept on the project as `calc`.
function totals(p) {
  const budget = pos(p.data.budget), spent = spentOn(p);
  return { budget, spent, left: cents(budget - spent), board_feet: cutBoardFeet(p), hours: pos(p.data.hours_worked) };
}
// Board feet on the cut list, plus the waste allowance: what to buy if nothing else is typed in.
function cutBoardFeet(p) {
  const bf = (p.data.cutlist?.items || []).reduce((n, x) => n + bdFt(x), 0);
  return Math.round(bf * (1 + pos(store.settings.waste_pct) / 100) * 10) / 10;
}

// ---------- storage (the database, through the server) ----------
// The page arrives with the projects embedded in it; changes are sent back to the server.
// Who's signed in, the household they're looking at, the others in it, and their other households.
let account = { me: { id: 0, name: '', email: '' }, household: { id: 0, name: '', role: 'member' }, households: [], members: [] };
let store = loadStore(JSON.parse(document.getElementById('initialState').textContent));
const myName = () => account.me.name.split(' ')[0] || account.me.name;

function loadStore(saved: any) {
  if (saved.me) account = { me: saved.me, household: saved.household, households: saved.households || [], members: saved.members || [] };
  return {
    settings: { ...structuredClone(DEFAULT_SETTINGS), ...(saved.settings || {}) },
    projects: Array.isArray(saved.projects) ? saved.projects : [],
    settingsUpdatedAt: saved.settingsUpdatedAt || '',
  };
}
// Save a change.
let changeSeq = 0;
function persist() {
  changeSeq++;
  scheduleSave();
}
function settingsChanged() {
  store.settingsUpdatedAt = new Date().toISOString();
  persist();
}

// ---------- helpers ----------
const $ = (sel, el = document) => el.querySelector(sel);
const view = $('#view');
// The Reset button in an iPhone's date picker puts a date box back to the date it was drawn with (its
// value attribute), not to empty. So once a date box is on the page, its date is moved from the
// attribute to the box itself, leaving nothing for Reset to bring back.
function clearDateDefaults(root) {
  const boxes = root.matches?.('input[type=date][value]') ? [root] : [...(root.querySelectorAll?.('input[type=date][value]') || [])];
  for (const box of boxes) { const date = box.value; box.removeAttribute('value'); box.value = date; }
}
new MutationObserver(changes => changes.forEach(c => c.addedNodes.forEach(clearDateDefaults)))
  .observe(document.body, { childList: true, subtree: true });
const esc = s => String(s ?? '').replace(/[&<>"']/g, c => ({ '&': '&amp;', '<': '&lt;', '>': '&gt;', '"': '&quot;', "'": '&#39;' }[c]));
const money = n => new Intl.NumberFormat('en-US', { style: 'currency', currency: 'USD' }).format(n || 0);
const hrs = n => `${+num(n).toFixed(2)} h`;
const shortDay = iso => new Date(iso + 'T00:00').toLocaleDateString(undefined, { month: 'short', day: 'numeric' });
const fmtDate = iso => iso ? new Date(iso.length === 10 ? iso + 'T00:00' : iso).toLocaleDateString(undefined, { year: 'numeric', month: 'short', day: 'numeric' }) : '';
const getPath = (obj, path) => path.split('.').reduce((o, k) => o?.[k], obj);
function setPath(obj, path, value) {
  const keys = path.split('.'), last = keys.pop();
  keys.reduce((o, k) => o[k], obj)[last] = value;
}
const inputValue = el => el.type === 'number' ? (el.value === '' ? '' : num(el.value)) : el.value;
const projectName = p => p.data.title || 'Untitled project';
// The line under a project's name in lists: the room it's in, or the wood a shop build is made of.
const whereOf = p => [p.data.area, p.data.species].filter(Boolean).join(' \u00b7 ') || STREAM_NAME[streamOf(p)];

let toastTimer;
function toast(message) {
  const el = $('#toast');
  el.textContent = message;
  el.classList.add('show');
  clearTimeout(toastTimer);
  toastTimer = setTimeout(() => el.classList.remove('show'), 4000);
}

// ---------- saving to the server (shared by every device) ----------
// Only what changed is sent: each project on its own, and the settings if they changed. When two
// devices edit the same project, the most recently edited copy wins.
const unbusy = (key, value) => key === 'busy' ? undefined : value;
let saveTimer, saving = false, saveAgain = false, saveMessage = '';
let saved = snapshot();   // the data as the server last had it

function snapshot() {
  return {
    settings: JSON.stringify(store.settings),
    projects: new Map<number, string>(store.projects.map(p => [p.id, JSON.stringify(p, unbusy)])),
  };
}
function pendingChanges() {
  const now = snapshot();
  const projects = [...now.projects].filter(([id, text]) => saved.projects.get(id) !== text).map(([, text]) => JSON.parse(text));
  const deleted = [...saved.projects.keys()].filter(id => !now.projects.has(id));
  const settings = now.settings !== saved.settings;
  return { now, projects, deleted, settings, any: !!(projects.length || deleted.length || settings) };
}

function scheduleSave(ms = 800) {
  clearTimeout(saveTimer);
  saveTimer = setTimeout(save, ms);
}

function setSyncState(state, message = '') {
  saveMessage = message;
  const el = $('#syncState');
  el.className = state;
  el.title = message;
  el.textContent = { busy: 'Saving…', ok: 'Saved', offline: 'Offline · not saved yet', error: 'Not saved' }[state] || '';
}

async function api(path, body?, keepalive = false) {
  let res;
  try {
    res = await fetch(path, body === undefined ? { cache: 'no-store' }
      : { method: 'POST', headers: { 'Content-Type': 'application/json' }, body: JSON.stringify(body), keepalive });
  } catch {
    throw Object.assign(new Error('Could not reach the server.'), { offline: true });
  }
  if (res.status === 401) throw Object.assign(new Error('You have been signed out. Sign in again to save.'), { signedOut: true });
  if (!res.ok) throw new Error(`The server returned ${res.status}${res.status < 500 ? `: ${(await res.text()).slice(0, 200)}` : '.'}`);
  return res.json();
}

// keepalive lets a save finish while the page is closing.
async function save(keepalive = false) {
  if (saving) { saveAgain = true; return; }
  clearTimeout(saveTimer);
  const changes = pendingChanges();
  if (!changes.any) return;
  saving = true;
  setSyncState('busy');
  try {
    await api('/api/save', {
      projects: changes.projects, deleted: changes.deleted,
      ...(changes.settings ? { settings: store.settings, settingsUpdatedAt: store.settingsUpdatedAt } : {}),
    }, keepalive);
    saved = changes.now;
    setSyncState('ok');
  } catch (e) {
    if (e.message !== saveMessage) toast(`Not saved: ${e.message}`);
    setSyncState(e.offline ? 'offline' : 'error', e.message);
    saveTimer = setTimeout(save, 10000);   // keep trying; the changes stay on this page meanwhile
  }
  saving = false;
  if (saveAgain) { saveAgain = false; scheduleSave(200); }
}

// Pick up changes made on other devices.
async function refresh() {
  await save();
  const seq = changeSeq;
  let remote;
  try { remote = await api('/api/state'); } catch (e) {
    // Nothing is waiting to be saved, so go straight to sign-in. A home-screen app has no reload button.
    if (e.signedOut && !pendingChanges().any) location.assign('/login');
    return;
  }
  // This browser was switched to another household (in another tab): start over on that one.
  if (remote.household && remote.household.id !== account.household.id) return location.reload();
  // Something was edited while the request was out: leave it for the next refresh.
  if (seq !== changeSeq || saving || pendingChanges().any) return;
  const next = loadStore(remote);
  if (JSON.stringify([next.settings, next.projects], unbusy) === JSON.stringify([store.settings, store.projects], unbusy)) return;
  store = next;
  saved = snapshot();
  backfillTodos();
  // Redraw from the new data, unless a not-yet-saved project is being written.
  if (!(ed && !ed.project)) route();
}

// ---------- routing ----------
let ed = null;          // editor state: { project (null while new), data, dirty }
let currentHash = '';

// Section pages: the lists you open a project from. A project's pages lead back to the one you came from
// ("← Calendar"), and coming back puts you where you were on it.
function sectionOf(hash) {
  const parts = hash.replace(/^#\/?/, '').split('/');
  if (parts[0] === '' || parts[0] === 's') return 'Projects';
  if (parts[0] === 'calendar') return 'Calendar';
  if (parts[0] === 'frozen') return 'Frozen projects';
  if (parts[0] === 'receipts') return 'All receipts';
  if (parts[0] === 'tasks') return parts[1] === 'shopping' ? 'Shopping list' : parts[1] === 'todos' ? 'All to-dos' : parts[1] ? null : 'Tasks';
  return null;
}
const keep = (key, value?) => {
  try { if (value === undefined) return JSON.parse(sessionStorage.getItem(key) || 'null'); sessionStorage.setItem(key, JSON.stringify(value)); } catch {}
  return null;
};
let cameFrom = keep('cameFrom');                 // { hash, label }: the last section page shown
const scrollSpots = keep('scrollSpots') || {};   // section page -> how far down it was
/** The "← back" link for a page opened from a list: back to the list it was opened from, else `href`. */
function backLink(href, label) {
  const to = cameFrom && cameFrom.hash !== currentHash ? cameFrom : { hash: href, label };
  return `<a href="${esc(to.hash)}" class="back">&larr; ${esc(to.label)}</a>`;
}

let prevHash = '';
function route() {
  const before = currentHash;
  if (before !== (location.hash || '#/')) prevHash = before;
  currentHash = location.hash || '#/';
  if (before && sectionOf(before)) { scrollSpots[before] = window.scrollY; keep('scrollSpots', scrollSpots); }
  const section = sectionOf(currentHash);
  if (section) { cameFrom = { hash: currentHash, label: section }; keep('cameFrom', cameFrom); }
  ed = null;
  const parts = currentHash.replace(/^#\/?/, '').split('/');
  const project = parts[0] === 'p' ? store.projects.find(p => p.id === Number(parts[1])) : null;
  let nav = 'board';
  if (parts[0] === 'new') { nav = 'new'; STREAM_NAME[parts[1]] ? showEditor(null, parts[1]) : showNewPicker(); }
  else if (parts[0] === 's' && (STREAM_NAME[parts[1]] || parts[1] === 'all')) { boardStream = parts[1]; remember(); showBoard(); }
  else if (parts[0] === 'settings') { nav = 'settings'; showSettings(); }
  else if (parts[0] === 'calendar') { nav = 'calendar'; showCalendar(parts[1]); }
  else if (parts[0] === 'frozen') showFrozen();
  else if (parts[0] === 'receipt') { nav = 'receipts'; showReceipt(Number(parts[1]) || null); }
  else if (parts[0] === 'receipts') { nav = 'receipts'; showReceiptLog(/^\d{4}$/.test(parts[1]) ? parts[1] : ''); }
  else if (parts[0] === 'tasks') {
    nav = 'tasks';
    const listed = store.projects.find(p => p.id === Number(parts[1]));
    if (parts[1] === 'shopping') { nav = 'shopping'; showShopping(); } else if (parts[1] === 'todos') showAllTodos(); else if (listed) showTodo(listed); else showTasks();
  }
  else if (project && parts[2] === 'design') showDesign(project);
  else if (project && parts[2] === 'cuts') showCuts(project);
  else if (project && parts[2] === 'todo') showTodo(project);
  else if (project && parts[2] === 'dates') { phaseDatesOpen = true; showEditor(project); setTimeout(openPhaseDates, 80); }
  else if (project && parts[2] === 'summary') showSummary(project);
  else if (project) showEditor(project);
  else showBoard();
  document.querySelectorAll<HTMLElement>('[data-nav]').forEach(a => a.classList.toggle('on', a.dataset.nav.split(' ').includes(nav)));
  $('header.top .newbtn')?.setAttribute('href', newLink());   // + starts the kind of project the board is showing
  // Redrawing the same page (new data from another device) stays put; a section page you come back to
  // opens where you left it; anything else starts at the top.
  if (before === currentHash) return;
  const spot = section ? scrollSpots[currentHash] || 0 : 0;
  window.scrollTo(0, spot);
  if (spot) [60, 250, 700].forEach(ms => setTimeout(() => {   // pages that finish drawing a moment later
    if (currentHash === location.hash && window.scrollY < spot - 2) window.scrollTo(0, spot);
  }, ms));
}
window.addEventListener('hashchange', () => {
  if (ed && !ed.project && ed.dirty && !confirm('Discard this unsaved project?')) {
    history.replaceState(null, '', currentHash);
    return;
  }
  route();
});
// ---------- quick find ----------
// The magnifier in the header (or "/" on a computer) finds any project by its name, room or wood,
// frozen and finished ones too.
const finder = $('#finder'), findInput = $('#findInput') as HTMLInputElement, findResults = $('#findResults');
function findMatches(q) {
  const words = q.toLowerCase().split(/\s+/).filter(Boolean);
  const text = p => [projectName(p), p.data.area, STREAM_NAME[streamOf(p)], p.data.species].join(' ').toLowerCase();
  const rank = p => isFrozen(p) ? 1 : archived(p) ? 2 : 0;
  return store.projects.filter(p => words.every(w => text(p).includes(w)))
    .sort((a, b) => rank(a) - rank(b) || b.updated_at.localeCompare(a.updated_at)).slice(0, 12);
}
function drawFind() {
  const q = findInput.value.trim(), list = q ? findMatches(q) : prioritized().slice(0, 6);
  findResults.innerHTML = (q ? '' : '<li class="findhead muted">Active projects</li>') + (list.map((p, i) => `<li><a href="#/p/${p.id}" class="${i === 0 && q ? 'first' : ''}">
      <b>${esc(projectName(p))}</b><span class="muted">${esc(whereOf(p))}${isFrozen(p) ? ' \u00b7 frozen' : ''}</span>
      <span class="pill ${p.status}">${STATUS_NAME[p.status]}</span></a></li>`).join('') || '<li class="findnone muted">No project matches that.</li>');
}
function openFind(open = true) {
  finder.hidden = !open;
  document.body.classList.toggle('finding', open);
  if (!open) return;
  findInput.value = '';
  drawFind();
  findInput.focus();
}
$('#findBtn').addEventListener('click', () => openFind(finder.hidden));
findInput.addEventListener('input', drawFind);
findInput.addEventListener('keydown', e => {
  if (e.key === 'Escape') openFind(false);
  if (e.key === 'Enter') { const a = findResults.querySelector('a') as HTMLAnchorElement; if (a) { location.hash = a.getAttribute('href'); openFind(false); } }
});
finder.addEventListener('click', e => { if ((e.target as Element).closest('a') || e.target === finder) openFind(false); });
document.addEventListener('keydown', e => {
  const el = e.target as Element;
  if (e.key === '/' && finder.hidden && !el.closest('input, textarea, select, [contenteditable]')) { e.preventDefault(); openFind(); }
  if (e.key === 'Escape' && !finder.hidden) openFind(false);
});

// Tapping the menu or tab bar link for the page you're already on takes you to its top.
document.addEventListener('click', e => {
  const a = (e.target as Element).closest<HTMLAnchorElement>('header.top a, nav.tabbar a');
  if (a && a.getAttribute('href') === (location.hash || '#/')) { e.preventDefault(); window.scrollTo({ top: 0, behavior: 'smooth' }); }
});
// The tab bar steps aside while typing on a phone, so it doesn't sit on top of the keyboard.
document.addEventListener('focusin', e => { if ((e.target as Element).matches('input:not([type=checkbox]):not([type=radio]), textarea, select')) document.body.classList.add('typing'); });
document.addEventListener('focusout', () => setTimeout(() => {
  if (!document.activeElement?.matches('input:not([type=checkbox]):not([type=radio]), textarea, select')) document.body.classList.remove('typing');
}, 50));

// ---------- projects board ----------
// The board shows one stream at a time, or both; the choice is remembered on this device.
let boardStream = (() => { try { return localStorage.getItem('boardStream') || 'all'; } catch { return 'all'; } })();
if (!STREAM_NAME[boardStream]) boardStream = 'all';
function remember() { try { localStorage.setItem('boardStream', boardStream); } catch {} }
const boardLink = () => boardStream === 'all' ? '#/' : `#/s/${boardStream}`;
const newLink = () => STREAM_NAME[boardStream] ? `#/new/${boardStream}` : '#/new';
// What a card shows: what's been spent, and the budget if there is one.
const spentLine = p => { const t = totals(p); return t.budget ? `${money(t.spent)} of ${money(t.budget)}` : money(t.spent); };
const overBudget = p => { const t = totals(p); return t.budget > 0 && t.spent > t.budget; };

function showBoard() {
  const tab = STREAM_NAME[boardStream] ? boardStream : 'all';
  const shown = store.projects.filter(p => !isFrozen(p) && (tab === 'all' || streamOf(p) === tab));
  const frozenCount = store.projects.filter(isFrozen).length;
  const by = (...statuses) => shown.filter(p => statuses.includes(p.status)).sort((a, b) => b.updated_at.localeCompare(a.updated_at));
  const sum = (list, f) => list.reduce((total, p) => total + f(p), 0);
  // On phones the tabs are one row of pills with the short names.
  const tabs = `<nav class="tabs streams">${[['all', 'All projects'], ...STREAMS].map(([key, name]) =>
    `<a href="${key === 'all' ? '#/s/all' : `#/s/${key}`}" class="${key === tab ? 'on' : ''}"${key === tab ? ' aria-current="page"' : ''}><span class="tlong">${name}</span><span class="tshort">${STREAM_SHORT[key]}</span>
      <small>${store.projects.filter(p => key === 'all' || streamOf(p) === key).filter(p => !archived(p) && !isFrozen(p)).length}</small></a>`).join('')}
    <span class="spacer"></span><a href="#/frozen" class="frozenlink">Frozen <small>${frozenCount}</small></a></nav>`;
  const tabInView = () => {
    const nav = $('.tabs.streams'), on = nav?.querySelector('a.on');
    if (nav && on && nav.scrollWidth > nav.clientWidth) nav.scrollLeft = on.offsetLeft - (nav.clientWidth - on.offsetWidth) / 2;
  };
  const head = `<div class="pagehead"><h1>Projects</h1><span class="spacer"></span><a class="btn wideonly" href="#/receipt">Scan a receipt</a><a class="btn primary wideonly" href="${newLink()}">New project</a></div>${tabs}`;
  if (!shown.length) {
    view.innerHTML = `${head}<div class="card empty"><h1>Nothing here yet</h1>
      <p class="muted">${tab === 'all' ? 'Start with a project on the house, or something to build in the shop.' : esc(STREAMS.find(x => x[0] === tab)[2])}</p>
      <p><a class="btn primary" href="${newLink()}">New project</a></p></div>`;
    return;
  }
  const planned = by('planned'), active = by('in_progress'), done = by('complete');
  const statLists = [];
  const stat = (label, value, note, list = []) => {
    statLists.push({ label, list });
    return `<button type="button" class="card stat" data-stat="${statLists.length - 1}" aria-expanded="false" ${list.length ? '' : 'disabled'}><span class="muted">${label}</span><b>${value}</b><span class="muted">${note}</span></button>`;
  };
  const open = [...planned, ...active];
  const budgeted = sum(open, p => totals(p).budget), spentOpen = sum(open, p => totals(p).spent);
  const year = String(new Date().getFullYear());
  const spentThisYear = sum(shown, p => (p.data.purchases || []).filter(x => (x.date || '').startsWith(year)).reduce((n, x) => n + num(x.amount), 0));
  const stats = stat('Planned', String(planned.length), planned.length ? `${money(sum(planned, p => totals(p).budget))} budgeted` : 'none yet', planned)
    + stat('In progress', String(active.length), active.length ? `${money(sum(active, p => totals(p).spent))} spent so far` : 'nothing under way', active)
    + stat('Spent on open projects', money(spentOpen), budgeted ? `of ${money(budgeted)} budgeted` : 'no budgets set', open)
    + stat(`Spent in ${year}`, money(spentThisYear), `${done.length} project${done.length === 1 ? '' : 's'} finished`, done);
  const jobCard = p => `<a class="job" href="#/p/${p.id}" draggable="true" data-id="${p.id}">
      <b>${esc(projectName(p))}</b>
      <div class="row"><span>${esc(whereOf(p))}</span></div>
      <div class="row"><span>Spent</span><span class="amt ${overBudget(p) ? 'over' : ''}">${spentLine(p)}</span></div>
      <div class="row foot"><span class="pill ${p.status}">${STATUS_NAME[p.status]}</span>${stageDue(p, stageOf(p)) ? `<span>Phase due ${esc(fmtDate(stageDue(p, stageOf(p))))}</span>` : ''}</div>
    </a>`;
  const archive = shown.filter(archived).sort((a, b) => b.updated_at.localeCompare(a.updated_at));
  const inStage = (key, list = shown) => list.filter(p => !archived(p) && stageOf(p) === key).sort((a, b) => b.updated_at.localeCompare(a.updated_at));
  const boardHtml = (list = shown) => `<div class="board b-four">
      ${STAGES.map(([key, name]) => `<section class="col" data-stage="${key}">
        <h2><span>${name}</span><span>${inStage(key, list).length}</span></h2>${inStage(key, list).map(jobCard).join('')}</section>`).join('')}
    </div>`;
  // On a phone the board's columns show little, so it becomes a compact list instead: a strip of phase
  // counts, then one row per project, grouped by phase, with empty phases left out. CSS picks which of
  // the two layouts shows, so turning the phone or resizing a window needs no redraw.
  const today = ymd(new Date());
  const nextDue = p => stageDue(p, stageOf(p)) ? [`${STAGE_NAME[stageOf(p)]} due`, stageDue(p, stageOf(p))]
    : p.data.due_date ? ['Target', p.data.due_date] : null;
  const dueLine = p => {
    const due = nextDue(p);
    if (!due) return '<span class="muted">No date set</span>';
    const n = Math.round((+new Date(due[1] + 'T00:00') - +new Date(today + 'T00:00')) / 86400000);
    const left = n < 0 ? `${-n}d late` : n === 0 ? 'today' : `${n}d`;
    return `<span class="${n < 0 ? 'late' : n <= 7 ? 'soon' : ''}">${due[0]} ${esc(shortDay(due[1]))} &middot; ${left}</span>`;
  };
  const byDue = (a, b) => (nextDue(a)?.[1] || '9999').localeCompare(nextDue(b)?.[1] || '9999') || b.updated_at.localeCompare(a.updated_at);
  const listRow = p => `<a class="prow" href="#/p/${p.id}">
      <span class="pmain"><b>${esc(projectName(p))}</b><span class="muted">${esc(whereOf(p))}</span></span>
      <span class="pside"><span class="amt ${overBudget(p) ? 'over' : ''}">${money(totals(p).spent)}</span><span class="pill ${p.status}">${STATUS_NAME[p.status]}</span></span>
      <span class="pdue">${dueLine(p)}<span class="muted">${totals(p).budget ? `budget ${money(totals(p).budget)}` : ''}</span></span>
    </a>`;
  const listHtml = (list = shown) => {
    const counts = STAGES.map(([key, name]) => [key, name, inStage(key, list).length]);
    const open = counts.reduce((n, c) => n + c[2], 0);
    return `<div class="plist s-${tab}">
      <div class="pstrip">${counts.map(([key, name, n]) => `<span class="${n ? '' : 'zero'}"><i class="st-${key}"></i>${name} <b>${n}</b></span>`).join('')}</div>
      ${open ? counts.filter(c => c[2]).map(([key, name, n]) => `<div class="pgroup">
        <h3><i class="st-${key}"></i>${name} <span>${n}</span></h3>${inStage(key, list).sort(byDue).map(listRow).join('')}</div>`).join('')
        : '<p class="muted pnone">Nothing in the works.</p>'}
    </div>`;
  };
  // "All projects" shows each stream as its own section, one above the other. Every section keeps its
  // columns, even when empty, so a card can be dragged into the other stream.
  const lanes = () => STREAMS.map(([key, name]) => {
    const list = shown.filter(p => streamOf(p) === key), open = list.filter(p => !archived(p));
    return `<section class="lane ${key}" data-stream="${key}">
      <div class="lanehead"><h2>${name} <span>${open.length}</span></h2><a href="#/s/${key}">Open<span class="lopen"> ${name.toLowerCase()}</span> &rarr;</a></div>
      ${boardHtml(list)}${listHtml(list)}
    </section>`;
  }).join('');
  view.innerHTML = `
    ${head}
    <div class="stats">${stats}</div><div id="statList" hidden></div>
    <div class="boards">${tab === 'all' ? lanes() : boardHtml() + listHtml()}</div>
    ${archive.length ? `<div class="card" style="margin-top:20px"><h2>Finished</h2><table class="list">
      <tr><th>Project</th><th>${tab === 'all' ? 'Stream' : ''}</th><th>Spent</th><th>Budget</th><th>Finished</th></tr>
      ${archive.map(p => `<tr><td><a href="#/p/${p.id}">${esc(projectName(p))}</a></td>
        <td>${tab === 'all' ? STREAM_NAME[streamOf(p)] : ''}</td><td>${money(totals(p).spent)}</td><td>${totals(p).budget ? money(totals(p).budget) : ''}</td>
        <td>${esc(fmtDate(finishedAt(p)))}</td></tr>`).join('')}
      </table></div>` : ''}`;

  tabInView();
  requestAnimationFrame(markStuckBands);
  $('.stats').addEventListener('click', e => {
    const b = (e.target as Element).closest<HTMLElement>('[data-stat]');
    if (!b) return;
    const box = $('#statList'), was = b.getAttribute('aria-expanded') === 'true';
    view.querySelectorAll('[data-stat]').forEach(x => x.setAttribute('aria-expanded', 'false'));
    box.hidden = was;
    if (was) return;
    b.setAttribute('aria-expanded', 'true');
    const { label, list } = statLists[Number(b.dataset.stat)];
    box.innerHTML = `<div class="card statlist"><h2>${label} <span class="muted">${list.length}</span></h2><ul>${list.map(p => `<li><a href="#/p/${p.id}">${esc(projectName(p))}</a>
      <span class="muted">${STREAM_NAME[streamOf(p)]}</span><span class="amt">${spentLine(p)}</span><span class="pill ${p.status}">${STATUS_NAME[p.status]}</span></li>`).join('')}</ul></div>`;
  });
  // Drag a card to another column to change its phase, or (on "All projects") into the other stream's section.
  const board = $('.boards');
  let dragged = null;
  const clearOver = () => board.querySelectorAll('.col.over').forEach(c => c.classList.remove('over'));
  board.addEventListener('dragstart', e => {
    const card = e.target.closest('.job');
    if (!card) return;
    dragged = store.projects.find(p => p.id === Number(card.dataset.id));
    e.dataTransfer.effectAllowed = 'move';
    e.dataTransfer.setData('text/plain', projectName(dragged));
    card.classList.add('dragging');
  });
  board.addEventListener('dragend', e => {
    e.target.closest('.job')?.classList.remove('dragging');
    clearOver();
    dragged = null;
  });
  board.addEventListener('dragover', e => {
    const col = e.target.closest('.col');
    if (!dragged || !col) return;
    e.preventDefault();
    e.dataTransfer.dropEffect = 'move';
    if (!col.classList.contains('over')) { clearOver(); col.classList.add('over'); }
  });
  board.addEventListener('drop', e => {
    const col = e.target.closest('.col');
    if (!dragged || !col) return;
    e.preventDefault();
    const p = dragged, stream = col.closest('.lane')?.dataset.stream;
    const move = stream && stream !== streamOf(p);
    if (move && !confirm(`Move ${projectName(p)} to ${STREAM_NAME[stream]}?`)) { clearOver(); return; }
    if (move) setStream(p, stream, col.dataset.stage);
    else { setStage(p, col.dataset.stage); showBoard(); }
  });
}

// ---------- calendar of projects under way ----------
const ymd = d => `${d.getFullYear()}-${String(d.getMonth() + 1).padStart(2, '0')}-${String(d.getDate()).padStart(2, '0')}`;

function showCalendar(month) {
  const today = ymd(new Date());
  const [year, mon] = (/^\d{4}-\d{2}$/.test(month || '') ? month : today.slice(0, 7)).split('-').map(Number);
  const monthLink = offset => `#/calendar/${ymd(new Date(year, mon - 1 + offset, 1)).slice(0, 7)}`;

  // A project goes on the calendar once work starts (or, while still planned, once it has a date), and
  // comes off when it is complete.
  // Its bar is split at each phase's due date, one colored stretch per phase; phases already
  // finished are faded. With no phase dates it is one bar in the color of the current phase.
  const nextDay = date => { const d = new Date(date + 'T00:00'); d.setDate(d.getDate() + 1); return ymd(d); };
  const dated = p => !!(p.data.due_date || Object.values(p.data.stage_due || {}).some(Boolean));
  const jobs = store.projects.filter(p => !isFrozen(p) && (p.status === 'in_progress' || (p.status === 'planned' && dated(p)))).map(p => {
    const began = p.history.findLast(h => h.status === 'in_progress');
    const start = ymd(new Date(began?.at || p.created_at));
    const current = stageIndex(p);
    const dated = stagesFor(p).map(([key], i) => ({ key, i, due: stageDue(p, key) })).filter(x => x.due);
    let segs = [];
    if (dated.some(x => x.key !== lastPhase(p))) {
      let from = start;
      for (const x of dated) {
        if (x.due < from) continue;   // already past when the job started, or dated out of order
        segs.push({ key: x.key, from, to: x.due, past: x.i < current });
        from = nextDay(x.due);
      }
    }
    if (!segs.length) segs = [{ key: stageOf(p), from: start, to: p.data.due_date > start ? p.data.due_date : start, past: false }];
    return { p, segs, start, end: segs.at(-1).to };
  }).sort((a, b) => a.start.localeCompare(b.start));

  // What each job should be doing today going by its phase dates, the phase it's marked at on the
  // board, and the next phase change still to come.
  const plan = j => {
    const seg = j.segs.find(x => today >= x.from && today <= x.to);
    const expected = seg ? seg.key : today < j.start ? '' : j.segs.at(-1).key;
    const marked = stageOf(j.p);
    const order = stagesFor(j.p).map(([k]) => k);
    const behind = !!expected && order.indexOf(marked) < order.indexOf(expected);
    const next = j.segs.find(x => x.from > today);
    return { expected, marked, behind, next, late: today > j.end };
  };
  const shortDate = date => new Date(date + 'T00:00').toLocaleDateString(undefined, { weekday: 'short', month: 'short', day: 'numeric' });

  if (calView === 'timeline') return showTimeline({ year, mon, today, jobs, plan, shortDate, monthLink });

  let cells = '';
  const day = new Date(year, mon - 1, 1);
  day.setDate(1 - day.getDay());   // back up to the Sunday that starts the first week
  do {
    const week = Array.from({ length: 7 }, (_, i) => new Date(day.getFullYear(), day.getMonth(), day.getDate() + i));
    // Jobs keep the same row all week so their bars line up from day to day.
    const active = jobs.filter(j => j.start <= ymd(week[6]) && j.end >= ymd(week[0]));
    for (const d of week) {
      const key = ymd(d);
      cells += `<div class="day ${d.getMonth() === mon - 1 ? '' : 'other'} ${key === today ? 'today' : ''}"><span class="num">${d.getDate()}</span>${active.map(j => {
        if (key < j.start || key > j.end) return '<span class="bar gap"></span>';
        const seg = j.segs.find(x => key >= x.from && key <= x.to);
        const named = key === seg.from || d.getDay() === 0, due = key === stageDue(j.p, seg.key) || key === j.p.data.due_date;
        const text = key === seg.from && key !== j.start ? `\u25b8 ${STAGE_NAME[seg.key]} starts \u00b7 ${projectName(j.p)}` : named ? `${projectName(j.p)} \u00b7 ${STAGE_NAME[seg.key]}${due ? ' (due)' : ''}` : due ? 'Due' : '';
        const turn = key === seg.from && key !== j.start;
        return `<a class="bar st-${seg.key} ${seg.past ? 'past' : ''} ${named ? 'label' : ''} ${turn ? 'turn' : ''} ${key === j.start ? 's' : ''} ${key === j.end ? 'e' : ''}" href="#/p/${j.p.id}"
          title="${esc(projectName(j.p))} \u2013 ${esc(STREAM_NAME[streamOf(j.p)])}">${esc(text)}</a>`;
      }).join('')}</div>`;
    }
    day.setDate(day.getDate() + 7);
  } while (day.getMonth() === mon - 1 && day.getFullYear() === year);

  const daysLeft = due => Math.round((+new Date(due + 'T00:00') - +new Date(today + 'T00:00')) / 86400000);
  const dueText = (j, due) => {
    if (!due) return `<a href="#/p/${j.p.id}/dates">Set a date</a>`;
    const n = daysLeft(due);
    return `${esc(fmtDate(due))} <span class="${n < 0 ? 'late' : 'muted'}">(${n < 0 ? `${-n} day${n === -1 ? '' : 's'} overdue` : n === 0 ? 'today' : `${n} day${n === 1 ? '' : 's'} left`})</span>`;
  };
  view.innerHTML = `
    <div class="pagehead">
      <h1>${new Date(year, mon - 1, 1).toLocaleDateString(undefined, { month: 'long', year: 'numeric' })}</h1><span class="spacer"></span>
      ${calHeadButtons(monthLink)}
    </div>
    <div class="cal">${['Sun', 'Mon', 'Tue', 'Wed', 'Thu', 'Fri', 'Sat'].map(n => `<div class="dow">${n}</div>`).join('')}${cells}</div>
    <div class="legend">${calLegend(jobs)}</div>
    <div class="card" style="margin-top:16px"><h2>Scheduled projects</h2>
      ${jobs.length ? `<table class="list"><tr><th>Project</th><th>Stream</th><th>Should be in</th><th>Marked</th><th>Phase due</th><th>Target completion</th></tr>
        ${jobs.map(j => `<tr><td><span class="swatch st-${plan(j).expected || stageOf(j.p)}"></span><a href="#/p/${j.p.id}">${esc(projectName(j.p))}</a></td>
          <td>${STREAM_NAME[streamOf(j.p)]}</td><td>${shouldBe(plan(j))}</td><td>${STAGE_NAME[stageOf(j.p)]}</td><td>${dueText(j, stageDue(j.p, stageOf(j.p)))}</td><td>${dueText(j, j.p.data.due_date)}</td></tr>`).join('')}</table>`
        : '<p class="muted" style="margin:0">Nothing is scheduled. A project appears here once work starts on it, or once a planned project has a due date, up to its target date.</p>'}
    </div>`;
}

// The calendar opens on the timeline (one row per project) unless Month was picked last time.
let calView = (() => { try { return localStorage.getItem('calView') || 'timeline'; } catch { return 'timeline'; } })();
document.addEventListener('click', e => {
  if ((e.target as Element).closest('[data-caltoday]')) { tlScrollDate = ''; if (currentHash === '#/calendar') route(); }
  const b = (e.target as Element).closest('[data-calview]') as HTMLElement | null;
  if (!b) return;
  calView = b.dataset.calview;
  try { localStorage.setItem('calView', calView); } catch {}
  route();
});
const calHeadButtons = monthLink => `
      <span class="seg" role="group" aria-label="Calendar view">
        <button type="button" class="${calView === 'timeline' ? 'on' : ''}" data-calview="timeline">Timeline</button><button type="button" class="${calView === 'month' ? 'on' : ''}" data-calview="month">Month</button>
      </span>
      ${monthLink ? `<a class="btn" href="${monthLink(-1)}" aria-label="Previous month">&larr;</a>` : ''}
      <a class="btn" href="#/calendar" data-caltoday>Today</a>
      ${monthLink ? `<a class="btn" href="${monthLink(1)}" aria-label="Next month">&rarr;</a>` : ''}`;
// The calendar's color key: one color per phase.
const calLegend = _jobs => STAGES.map(([key, name]) => `<span><span class="swatch st-${key}"></span>${name}</span>`).join('');
// "Build", or "Build — still marked Design" in red when the board is behind the dates.
const shouldBe = pl => !pl.expected ? '<span class="muted">Not started yet</span>'
  : `<span class="stagechip st-${pl.expected}">${STAGE_NAME[pl.expected]}</span>${pl.late ? ' <span class="late">past target date</span>' : pl.behind ? ` <span class="late">still marked ${STAGE_NAME[pl.marked]}</span>` : ''}`;

// Timeline: each project on its own row across the month, its bar split into one chevron per phase,
// so a phase change shows as a step from one color to the next with the new phase's start date. A
// line marks today, and each row says which phase the project should be in now and what comes next.
// On a phone the timeline isn't cut into months: it runs from the earliest active project's start to
// the furthest-out finish, and you swipe through it, with a little rebound past either end.
const phoneTimeline = () => window.matchMedia('(max-width: 600px)').matches;
let tlScrollDate = '';   // the date at the left edge of the phone timeline, kept when the page redraws
window.matchMedia('(max-width: 600px)').addEventListener('change', () => { if (currentHash.startsWith('#/calendar')) route(); });

function showTimeline({ year, mon, today, jobs: all, plan, shortDate, monthLink }) {
  // Projects with no dates yet get a short "Needs dates" list under the timeline instead of a one-day bar.
  const undated = all.filter(j => !j.p.data.due_date && !Object.values(j.p.data.stage_due || {}).some(Boolean));
  const jobs = all.filter(j => !undated.includes(j));
  const swipe = phoneTimeline() && jobs.length > 0;
  const addDays = (date, n) => { const d = new Date(date + 'T00:00'); d.setDate(d.getDate() + n); return ymd(d); };
  const between = (a, b) => Math.round((+new Date(b + 'T00:00') - +new Date(a + 'T00:00')) / 86400000);
  const first = swipe ? jobs.reduce((m, j) => j.start < m ? j.start : m, jobs[0].start) : ymd(new Date(year, mon - 1, 1));
  const last = swipe ? jobs.reduce((m, j) => j.end > m ? j.end : m, jobs[0].end) : ymd(new Date(year, mon, 0));
  const days = between(first, last) + 1;
  const col = date => between(first, date) + 1;   // column of a date, 1 = first
  const dateAt = n => addDays(first, n - 1);
  const dows = Array.from({ length: days }, (_, i) => new Date(dateAt(i + 1) + 'T00:00').getDay());
  const shown = jobs.filter(j => j.start <= last && j.end >= first);
  const todayCol = today >= first && today <= last ? col(today) : 0;
  const todayLine = todayCol ? `<span class="tl-today" style="left:calc(${todayCol - 1} * 100% / ${days});width:calc(100% / ${days})"></span>` : '';
  const weekends = dows.map((wk, i) => wk % 6 === 0 ? `<span class="tl-wkend" style="grid-column:${i + 1}"></span>` : '').join('');
  const weekLines = dows.map((wk, i) => i > 0 && wk === 0 ? `<span class="tl-wkline" style="grid-column:${i + 1}"></span>` : '').join('');

  const row = j => {
    const pl = plan(j);
    const segs = j.segs.filter(x => x.from <= last && x.to >= first);
    const bars = segs.map(x => {
      const a = x.from < first ? 1 : col(x.from), b = x.to > last ? days : col(x.to);
      const cls = [`st-${x.key}`, x.past ? 'past' : '', x === j.segs[0] && x.from >= first ? 'first' : '', x === j.segs.at(-1) && x.to <= last ? 'last' : '',
        today >= x.from && today <= x.to ? 'now' : ''].join(' ');
      return `<a class="tl-seg ${cls}" href="#/p/${j.p.id}/dates" style="grid-column:${a} / ${b + 1}"
        title="${esc(STAGE_NAME[x.key])}: ${esc(fmtDate(x.from))} \u2013 ${esc(fmtDate(x.to))}"><span>${STAGE_NAME[x.key]}</span></a>`;
    }).join('');
    const marks = segs.filter(x => x !== j.segs[0] && x.from >= first)
      // A label near the end sits to the left of its line so it stays on the page.
      .map(x => { const c = col(x.from), text = `${STAGE_NAME[x.key]} from ${esc(shortDate(x.from).replace(/,.*$/, ''))} ${Number(x.from.slice(8))}`;
        return c > days - 6 ? `<span class="tl-mark end" style="grid-column:${Math.max(1, c - 7)} / ${c}">${text}</span>`
          : `<span class="tl-mark" style="grid-column:${c} / span 7">${text}</span>`; }).join('');
    const nextText = pl.next ? `${STAGE_NAME[pl.next.key]} from ${esc(shortDate(pl.next.from))}`
      : `Due ${esc(shortDate(j.end))}`;
    return `<div class="tl-row">
      <div class="tl-name"><a href="#/p/${j.p.id}/dates">${esc(projectName(j.p))}</a>
        <span class="tl-now">${pl.expected ? 'Now:' : ''} ${shouldBe(pl)} <span class="muted">\u00b7 ${pl.expected || !pl.next ? nextText : `Starts ${esc(shortDate(j.start))}`}</span></span></div>
      <div class="tl-track">${weekends}${weekLines}${bars}${todayLine}</div>
      ${marks ? `<div class="tl-marks">${marks}</div>` : ''}
    </div>`;
  };

  const dayNums = dows.map((wk, i) => `<span class="${i + 1 === todayCol ? 'today' : ''} ${wk % 6 === 0 ? 'wkend' : ''}">${Number(dateAt(i + 1).slice(8))}<small>${'SMTWTFS'[wk]}</small></span>`).join('');
  // Above the days: each week labeled by the date it starts ("Nov 8"), and a "Today" tag over today.
  const weekStarts = dows.map((wk, i) => i === 0 || wk === 0 ? i + 1 : 0).filter(Boolean);
  const weekLabels = weekStarts.map((n, i) => {
    const end = weekStarts[i + 1] || days + 1, date = new Date(dateAt(n) + 'T00:00');   // a stub of a week just gets the number
    return `<span style="grid-column:${n} / ${end}">${end - n < 3 ? date.getDate() : date.toLocaleDateString(undefined, { month: 'short', day: 'numeric' })}</span>`;
  }).join('');
  const todayTag = todayCol ? `<span class="tl-todaytag" style="left:calc(${todayCol - 0.5} * 100% / ${days})">Today</span>` : '';
  const monthTitle = date => new Date(date + 'T00:00').toLocaleDateString(undefined, { month: 'long', year: 'numeric' });

  view.innerHTML = `
    <div class="pagehead">
      <h1 id="tlTitle">${monthTitle(swipe ? (todayCol ? today : first) : first)}</h1><span class="spacer"></span>
      ${swipe ? calHeadButtons(null) : calHeadButtons(monthLink)}
    </div>
    <div class="tl card ${swipe ? 'swipe' : ''}">
      <div class="tl-scroll"><div class="tl-canvas">
      <div class="tl-head">${todayTag}<div class="tl-weeks">${weekLabels}</div>
      <div class="tl-days">${dayNums}</div></div>
      ${shown.length ? shown.map(row).join('') : '<p class="muted" style="margin:12px 0 0">Nothing is scheduled this month. A project appears once work starts on it, or once a planned project has a due date, up to its target date.</p>'}
      </div></div>
    </div>
    <div class="legend">${calLegend(jobs)}<span><span class="swatch tl-todaykey"></span>Today</span></div>
    ${undated.length ? `<div class="card needdates"><h2>Needs dates <span class="muted">${undated.length}</span></h2>
      <p class="muted">Under way, but with no phase or install dates yet, so they can't go on the timeline.</p>
      <ul>${undated.map(j => `<li><span><b>${esc(projectName(j.p))}</b> <span class="muted">${STREAM_NAME[streamOf(j.p)]} &middot; ${STAGE_NAME[stageOf(j.p)]}</span></span>
        <a class="btn small" href="#/p/${j.p.id}/dates">Set dates</a></li>`).join('')}</ul></div>` : ''}`;
  view.querySelector('.tl-canvas').style.setProperty('--days', days);
  if (swipe) swipeTimeline({ days, first, dateAt, col, todayCol, monthTitle });
}

// Sizes the phone timeline so about a month shows at once, starts it at today (or where it was before
// the page redrew), keeps the title on the month in view, and adds the rebound at the ends.
function swipeTimeline({ days, first, dateAt, col, todayCol, monthTitle }) {
  const scroller = view.querySelector('.tl-scroll'), canvas = view.querySelector('.tl-canvas'), title = $('#tlTitle');
  const width = scroller.clientWidth, dayPx = width / 30;
  canvas.style.width = `${Math.max(width, days * dayPx)}px`;
  canvas.style.setProperty('--view', `${width}px`);
  const max = () => scroller.scrollWidth - scroller.clientWidth;
  const saved = tlScrollDate && tlScrollDate >= first ? col(tlScrollDate) : 0;
  scroller.scrollLeft = saved ? (saved - 1) * dayPx : todayCol ? (todayCol - 1) * dayPx - width / 3 : 0;
  const onScroll = () => {
    const leftCol = Math.min(days, Math.max(1, Math.round(scroller.scrollLeft / dayPx) + 1));
    tlScrollDate = dateAt(leftCol);
    title.textContent = monthTitle(dateAt(Math.min(days, leftCol + 15)));
  };
  onScroll();

  // Pulling past an end stretches the timeline a little (less the further you pull), and it springs
  // back when you let go. A fling that runs into an end gets a small bump instead.
  let x0 = 0, y0 = 0, s0 = 0, pull = 0, touching = false, edge = scroller.scrollLeft <= 0 ? 'l' : scroller.scrollLeft >= max() - 1 ? 'r' : '';
  const stretch = px => { canvas.style.transform = px ? `translateX(${px}px)` : ''; };
  scroller.addEventListener('touchstart', e => {
    touching = true; x0 = e.touches[0].clientX; y0 = e.touches[0].clientY; s0 = scroller.scrollLeft; pull = 0;
    canvas.style.transition = 'none';
  }, { passive: true });
  scroller.addEventListener('touchmove', e => {
    const dx = e.touches[0].clientX - x0;
    if (Math.abs(dx) < Math.abs(e.touches[0].clientY - y0)) return;   // scrolling the page up or down
    const want = s0 - dx, over = want < 0 ? -want : want > max() ? max() - want : 0;
    pull = Math.sign(over) * Math.min(70, Math.abs(over) * 0.35);
    stretch(pull);
  }, { passive: true });
  const release = () => {
    touching = false;
    if (!pull) return;
    canvas.style.transition = 'transform .45s cubic-bezier(.25, 1.6, .45, 1)';   // overshoots a touch, then settles
    stretch(0); pull = 0;
  };
  scroller.addEventListener('touchend', release);
  scroller.addEventListener('touchcancel', release);
  scroller.addEventListener('scroll', () => {
    onScroll();
    const now = scroller.scrollLeft <= 0 ? 'l' : scroller.scrollLeft >= max() - 1 ? 'r' : '';
    if (now && now !== edge && !touching) {
      canvas.classList.remove('bump-l', 'bump-r');
      void canvas.offsetWidth;   // restart the animation
      canvas.classList.add(`bump-${now}`);
    }
    edge = now;
  }, { passive: true });
}

// ---------- type-ahead dropdowns ----------
// Replaces a <select> with a box you can type in to narrow the choices. The select stays in the
// page, hidden, as the value the form reads, and gets an "input" event when the choice changes.
// While open, the list sits on the page body (so a scrolling table can't clip it), placed in page
// coordinates right under the box. On a phone the keyboard shrinks the visible area without changing
// the layout, so the room around the box is measured against what's actually on screen, and the list
// follows the box when the page scrolls or the keyboard moves things. Scrolling a table closes it.
let comboCount = 0, closeOpenCombo = null, placeOpenCombo = null;
window.addEventListener('scroll', e => {
  if (!closeOpenCombo) return;
  if (e.target === document || e.target === document.documentElement) placeOpenCombo?.();
  else if (!(e.target instanceof Element && e.target.closest('.combo-list'))) closeOpenCombo();
}, true);
window.addEventListener('resize', () => placeOpenCombo?.());
window.visualViewport?.addEventListener('resize', () => placeOpenCombo?.());
window.visualViewport?.addEventListener('scroll', () => placeOpenCombo?.());

function typeAhead(select, minWidth = 0) {
  const id = `combo${++comboCount}`;
  const wrap = document.createElement('div');
  wrap.className = 'combo';
  wrap.innerHTML = `<input type="text" role="combobox" aria-autocomplete="list" aria-expanded="false" aria-controls="${id}" autocomplete="off" spellcheck="false"><ul id="${id}" class="combo-list" role="listbox" hidden></ul>`;
  wrap.style.minWidth = select.style.minWidth;
  select.hidden = true;
  select.before(wrap);
  const input = wrap.firstChild as HTMLInputElement, list = wrap.lastChild as HTMLUListElement;
  const options = [...select.options].map(o => ({ value: o.value, label: o.textContent }));
  const current = () => options.find(o => o.value === select.value) || options[0];
  let shown = [], active = -1;

  const setActive = i => {
    active = i;
    list.querySelectorAll('li[data-i]').forEach((li, n) => li.classList.toggle('active', n === i));
    const li = list.querySelector(`li[data-i="${i}"]`);
    if (li) { input.setAttribute('aria-activedescendant', li.id); li.scrollIntoView({ block: 'nearest' }); }
    else input.removeAttribute('aria-activedescendant');
  };
  const open = query => {
    const q = query.trim().toLowerCase(), words = q.split(/\s+/);
    // A choice matches if it contains every word typed, in any order ("walnut 8/4").
    // Choices that start with what was typed come first.
    const matches = options.filter(o => words.every(word => o.label.toLowerCase().includes(word)));
    const starts = o => o.label.toLowerCase().startsWith(words[0]);
    shown = q ? [...matches.filter(starts), ...matches.filter(o => !starts(o))] : options;
    list.innerHTML = shown.length
      ? shown.map((o, i) => `<li role="option" id="${id}-${i}" data-i="${i}" aria-selected="${o.value === select.value}">${esc(o.label)}</li>`).join('')
      : '<li class="none">No matches</li>';
    if (list.parentNode !== document.body) document.body.append(list);
    list.hidden = false;
    input.setAttribute('aria-expanded', 'true');
    closeOpenCombo = close;
    placeOpenCombo = place;
    place();
    setActive(q ? (shown.length ? 0 : -1) : shown.indexOf(current()));
  };
  // Line the list up under the box, or above it when there's more room there, sized to fit on screen.
  const place = () => {
    if (!input.isConnected) return close();
    const vv = window.visualViewport;
    const viewTop = vv ? vv.offsetTop : 0, viewLeft = vv ? vv.offsetLeft : 0;
    const viewHeight = vv ? vv.height : window.innerHeight, viewWidth = vv ? vv.width : window.innerWidth;
    const box = input.getBoundingClientRect(), width = Math.min(Math.max(box.width, minWidth), viewWidth - 16);
    const below = viewTop + viewHeight - box.bottom - 11, above = box.top - viewTop - 11;
    const want = Math.min(list.scrollHeight, 264);
    const flip = below < Math.min(want, 120) && above > below;
    const height = Math.max(Math.min(want, flip ? above : below), 44);
    const left = Math.max(viewLeft + 8, Math.min(box.left, viewLeft + viewWidth - width - 8));
    const top = flip ? box.top - 3 - height : box.bottom + 3;
    Object.assign(list.style, {
      width: `${width}px`,
      maxHeight: `${height}px`,
      left: `${left + window.scrollX}px`,
      top: `${top + window.scrollY}px`,
    });
  };
  const close = () => {
    if (closeOpenCombo === close) closeOpenCombo = placeOpenCombo = null;
    list.hidden = true;
    if (list.parentNode !== wrap) wrap.append(list);
    input.setAttribute('aria-expanded', 'false');
    input.removeAttribute('aria-activedescendant');
  };
  const pick = option => {
    input.value = option.label;
    close();
    if (option.value === select.value) return;
    select.value = option.value;
    select.dispatchEvent(new Event('input', { bubbles: true }));
  };

  input.value = current().label;
  input.addEventListener('focus', () => { input.select(); open(''); });
  input.addEventListener('click', () => { if (list.hidden) open(''); });
  input.addEventListener('input', () => open(input.value));
  input.addEventListener('keydown', (e: KeyboardEvent) => {
    if (e.key === 'ArrowDown' || e.key === 'ArrowUp') {
      e.preventDefault();
      if (list.hidden) open('');
      else if (shown.length) setActive((active + (e.key === 'ArrowDown' ? 1 : -1) + shown.length) % shown.length);
    } else if (e.key === 'Enter') {
      e.preventDefault();
      if (!list.hidden && shown[active]) pick(shown[active]);
    } else if (e.key === 'Tab') {
      // Tabbing away after typing takes the highlighted match.
      if (!list.hidden && shown[active] && input.value !== current().label) pick(shown[active]);
    } else if (e.key === 'Escape') {
      input.value = current().label;
      close();
    }
  });
  input.addEventListener('blur', () => { input.value = current().label; close(); });
  list.addEventListener('mousedown', e => {
    e.preventDefault();   // keep focus in the box
    const li = (e.target as Element).closest<HTMLElement>('li[data-i]');
    if (li) pick(shown[li.dataset.i]);
  });
}

// ---------- choosing a stream for a new project ----------
function showNewPicker() {
  view.innerHTML = `<a href="${boardLink()}" class="back">&larr; Projects</a><div class="pagehead"><h1>New project</h1></div>
    <p class="muted">Which kind of project is this?</p>
    <div class="picker">${STREAMS.map(([key, name, about]) => `<a class="card pick" href="#/new/${key}"><b>${name}</b><span class="muted">${about}</span></a>`).join('')}</div>`;
}

// ---------- project page ----------
function blankData(stream) {
  return { title: '', description: '', area: '', species: stream === 'shop' ? 'Walnut' : '', budget: '', notes: '', due_date: '', lumber: { bf: '', quarters: '', width: '' } };
}

// Heading and tabs shared by a project's pages.
function projectHeader(p, tab, side) {
  return `<div class="noprint projheadwrap">
    ${backLink(boardLink(), 'Projects')}
    <div class="projhead">
      <div class="name"><h1 id="projTitle">${esc(projectName(p))}</h1><span class="pill ${p.status}" id="statusPill">${STATUS_NAME[p.status]}</span></div>
      <div class="sub">${STREAM_NAME[streamOf(p)]}${p.data.area ? ` &middot; ${esc(p.data.area)}` : ''}</div>
    </div>
    ${isFrozen(p) ? `<div class="note frozen"><span><b>Frozen since ${esc(fmtDate(p.data.frozen.at))}</b>${p.data.frozen.reason ? `: ${esc(p.data.frozen.reason)}` : ''}.
      It's off the board and calendar until you unfreeze it.</span><button type="button" class="btn small" data-unfreeze="${p.id}">Unfreeze</button></div>` : ''}
    <nav class="tabs projtabs">
      <a href="#/p/${p.id}" class="${tab === 'details' ? 'on' : ''}">Details</a>
      <a href="#/p/${p.id}/todo" class="${tab === 'todo' ? 'on' : ''}">To-do list${todoLeft(p) ? ` <small>${todoLeft(p)}</small>` : ''}</a>
      <a href="#/p/${p.id}/cuts" class="${tab === 'cuts' ? 'on' : ''}">Cut list${cutsLeft(p) ? ` <small title="pieces left to cut">${cutsLeft(p)}</small>` : ''}</a>
      <a href="#/p/${p.id}/design" class="${tab === 'design' ? 'on' : ''}">Design notes</a>
      <a href="#/p/${p.id}/summary" class="${tab === 'summary' ? 'on' : ''}">Costs</a>
      <span class="spacer"></span><span class="side">${side}</span>
    </nav>
    ${/<button/.test(side) ? `<div class="sidem">${side}</div>` : ''}
  </div>`;
}
const todoLeft = p => (p.data.todo?.items || []).filter(t => !t.done_at).length;
const cutsLeft = p => (p.data.cutlist?.items || []).filter(t => !t.done_at).reduce((n, t) => n + (t.qty || 1), 0);

// ---------- the Now strip ----------
// At the top of a project that's under way (or planned): the next status step, the next date it's due,
// its next few to-dos (tick them right there) and quick ways to scan a receipt or add to its shopping list.
const showsNow = p => !archived(p);
const nextStepOf = p => NEXT_STEP[p.status];
// The next date coming up: the current phase's due date, else the next phase that has one.
function nextDue(p) {
  const stages = stagesFor(p), i = Math.max(0, stageIndex(p));
  for (const [key] of stages.slice(i)) {
    const due = stageDue(p, key);
    if (due) return { key, due, last: key === lastPhase(p) };
  }
  return null;
}
let focusShopping = false;   // the to-do tab opens with the shopping list's add box ready
function renderNow(p) {
  const el = $('#nowStrip');
  if (!el) return;
  if (!showsNow(p)) { el.innerHTML = ''; el.hidden = true; return; }
  el.hidden = false;
  const today = ymd(new Date()), next = nextStepOf(p), due = nextDue(p);
  const left = due ? Math.round((+new Date(due.due + 'T00:00') - +new Date(today + 'T00:00')) / 86400000) : 0;
  const dueLabel = due ? (due.last ? 'Install due' : `${STAGE_NAME[due.key]} due`) : '';
  const open = (p.data.todo?.items || []).filter(t => !t.done_at), firstFew = open.slice(0, 3);
  el.innerHTML = `<div class="card now">
    <div class="nowtop">
      <div class="nowdue ${due ? left < 0 ? 'late' : left <= 7 ? 'soon' : '' : ''}">${due
        ? `<span class="muted">${dueLabel}</span><b>${esc(new Date(due.due + 'T00:00').toLocaleDateString(undefined, { weekday: 'short', month: 'short', day: 'numeric' }))}</b>
           <span>${left < 0 ? `${-left} day${left === -1 ? '' : 's'} late` : left === 0 ? 'today' : `${left} day${left === 1 ? '' : 's'} left`}</span>`
        : `<span class="muted">No due dates yet</span><button type="button" class="link" data-setdates>Set dates</button>`}</div>
      <div class="actions">${next ? `<button type="button" class="btn primary" data-status="${next[0]}">${next[1]}</button>` : ''}
        ${isFrozen(p) ? '' : `<button type="button" class="btn" data-freeze="${p.id}">Freeze</button>`}</div>
    </div>
    ${firstFew.length ? `<ul class="tasks nowtasks">${firstFew.map(t => `<li class="task" data-id="${esc(t.id)}">
      <input type="checkbox" aria-label="${esc(t.text)}"><span class="text">${esc(t.text)}</span></li>`).join('')}</ul>` : '<p class="muted nownone">Nothing left on the to-do list.</p>'}
    <div class="nowlinks">
      <a href="#/p/${p.id}/todo">${open.length > firstFew.length ? `All ${open.length} to-dos` : 'To-do list'} &rarr;</a>
      <span class="spacer"></span>
      <a class="btn small" href="#/receipt/${p.id}">Scan a receipt</a>
      <a class="btn small" href="#/p/${p.id}/todo" data-addshop>Add to shopping list</a>
    </div>
  </div>`;
  el.querySelector('[data-status]')?.addEventListener('click', e => setStatus(p, (e.currentTarget as HTMLElement).dataset.status));
  el.querySelector('[data-addshop]')?.addEventListener('click', () => { focusShopping = true; });
  el.querySelector('[data-setdates]')?.addEventListener('click', () => openPhaseDates());
  (el.querySelectorAll("li.task") as NodeListOf<HTMLElement>).forEach(li => li.addEventListener('click', e => {
    e.preventDefault();
    const t = p.data.todo.items.find(x => x.id === li.dataset.id);
    if (!t) return;
    t.done_at = new Date().toISOString();
    todoChanged(p, { what: 'done', text: t.text, list: 'items' });
    li.classList.add('done');
    (li.querySelector('input') as HTMLInputElement).checked = true;
    setTimeout(() => renderNow(p), 450);   // a moment to see it ticked before the next one moves up
    toast(`Done: ${t.text}`);
  }));
}
// Opens the phase dates (folded away on a phone) and brings them into view.
function openPhaseDates() {
  phaseDatesOpen = true;
  const d = $('#stages details') as HTMLDetailsElement | null;
  if (d) d.open = true;
  const el = $('#stages');
  if (!el) return;
  el.scrollIntoView({ behavior: 'smooth', block: 'center' });
  el.classList.add('flash');
  setTimeout(() => el.classList.remove('flash'), 1600);
}

function showEditor(project, newStream = 'home') {
  const stream = project ? streamOf(project) : newStream;
  ed = { project, stream, data: project ? project.data : blankData(stream), dirty: false };
  const d = ed.data;
  d.lumber ??= { bf: '', quarters: '', width: '' };
  const inp = (label, path, type = 'text', cls = '', attrs = '') =>
    `<label class="f ${cls}"><span>${label}</span><input data-path="${path}" type="${type}" value="${esc(getPath(d, path) ?? '')}" ${attrs}></label>`;
  const speciesNames = ['', ...store.settings.species.map(s => s.name)];
  if (d.species && !speciesNames.includes(d.species)) speciesNames.push(d.species);
  // Once work starts the details fold up, so the page leads with what's needed day to day. They open
  // with a tap, and stay open for that project until you leave.
  const foldable = !!project && project.status !== 'planned';
  const folded = foldable && !detailsOpen.has(project.id);

  view.innerHTML = `
    ${project ? projectHeader(project, 'details', '<span class="muted">Changes save automatically</span>')
      : `<a href="${boardLink()}" class="back">&larr; Projects</a><div class="pagehead"><h1>New ${stream === 'shop' ? 'shop build' : 'home project'}</h1>
        <span class="spacer"></span><a href="#/new">Change kind of project</a></div>`}
    ${project ? '<div id="nowStrip" hidden></div><div class="stages" id="stages" role="group" aria-label="Project phase"></div>' : ''}
    <div class="cols ${folded ? 'folded' : ''}" id="cols">
      <form class="card" id="form" autocomplete="off">
        ${foldable ? `<button type="button" class="foldbar" id="foldBar" aria-expanded="${!folded}" aria-controls="form">
          <span><b>Project details</b><span class="muted" id="foldSum"></span></span><span class="foldword">${folded ? 'Show' : 'Hide'}</span></button>` : ''}
        <fieldset><h2>What it is</h2><div class="grid">
          ${inp('Project name', 'title', 'text', 'w6', `placeholder="${stream === 'shop' ? 'e.g. Walnut dresser' : 'e.g. Kitchen backsplash'}"`)}
          ${stream === 'shop'
            ? `<label class="f w3"><span>Wood</span><select data-path="species">${speciesNames.map(n => `<option value="${esc(n)}" ${n === (d.species || '') ? 'selected' : ''}>${esc(n || 'Not chosen yet')}</option>`).join('')}</select></label>
               ${inp('Where it goes', 'area', 'text', 'w3', 'placeholder="e.g. Bedroom"')}`
            : inp('Room or area', 'area', 'text', 'w3', 'placeholder="e.g. Kitchen"')}
          <label class="f w6"><span>Description</span><textarea data-path="description" placeholder="What you're doing and why, sizes, the look you're after">${esc(d.description || '')}</textarea></label>
        </div></fieldset>
        <fieldset><h2>Budget</h2><div class="grid">
          ${inp('Budget ($)', 'budget', 'number', 'w3', 'min="0" step="any" inputmode="decimal" placeholder="Leave blank if there isn\'t one"')}
        </div><p class="muted" style="margin:6px 0 0;font-size:13px">Everything bought for the project counts against it: scanned receipts and purchases typed in.</p></fieldset>
        <fieldset><h2>Notes</h2><div class="grid">
          <label class="f w6"><span>Notes</span><textarea data-path="notes">${esc(d.notes || '')}</textarea></label>
        </div></fieldset>
        ${project ? '' : `<button type="button" class="btn primary" id="create" style="width:100%">Save project</button>`}
      </form>
      <aside>
        ${project ? '<div class="card" id="budgetCard"></div>' : ''}
        <div class="card" id="lumberCard">
          <h2>Lumber to buy</h2>
          <div class="grid">
            <label class="f"><span>Board feet needed</span><input type="number" min="0" step="any" data-lumber="bf" value="${esc(d.lumber.bf)}"></label>
            <label class="f"><span>Board thickness</span><select data-lumber="quarters">
              ${[4, 5, 6, 8, 10, 12, 16].map(q => `<option value="${q}" ${q === lumberNeeds(d, 0).quarters ? 'selected' : ''}>${q}/4 (${q / 4}")</option>`).join('')}</select></label>
            <label class="f"><span>Board width (in)</span><input type="number" min="0" step="any" data-lumber="width" value="${esc(d.lumber.width)}"></label>
          </div>
          <p id="lumberOut" style="margin:12px 0 0"></p>
          ${project ? `<div class="shopmini"><h3>Shopping list</h3><ul class="tasks" id="shopMini"></ul>
            <form class="addtask" id="shopAdd" autocomplete="off"><input placeholder="Add something to buy" aria-label="Add to this project's shopping list"><button class="btn small">Add</button></form>
            <p class="muted hint">Also on the To-do list tab and the Shopping list for every project.</p></div>` : ''}
        </div>
        ${project ? '<div class="card" id="purchasesCard"></div><div class="card" id="statusCard"></div>' : ''}
        ${project ? '<p class="noprint" style="text-align:right"><button class="link" id="delete" style="color:var(--bad)">Delete this project</button></p>' : ''}
      </aside>
    </div>`;

  const form = $('#form');
  form.querySelectorAll('select').forEach(typeAhead);
  form.addEventListener('submit', e => e.preventDefault());
  form.addEventListener('input', e => {
    const el = e.target;
    if (!el.dataset.path) return;
    setPath(d, el.dataset.path, inputValue(el));
    changed();
  });
  $('#create')?.addEventListener('click', () => createProject());

  $('#lumberCard').addEventListener('input', e => {
    if (!e.target.dataset.lumber) return;
    d.lumber[e.target.dataset.lumber] = inputValue(e.target);
    changed();
  });
  $('#lumberCard').addEventListener('click', e => {
    if (!(e.target as Element).closest('[data-addlumber]') || !ed.project) return;
    const p = ed.project, text = lumberSummary(d, lumberNeeds(d, cutBoardFeet(p)));
    p.data.todo ??= defaultTodo(p);
    p.data.todo.lumber.push(newTask(text));
    todoChanged(p, { what: 'added', text, list: 'lumber' });
    renderShopMini(p);
    toast('Added to the shopping list.');
  });
  if (project) {
    $('#delete').addEventListener('click', () => {
      if (!confirm(`Delete ${projectName(project)}? This cannot be undone.`)) return;
      store.projects = store.projects.filter(p => p !== project);
      persist();
      location.hash = boardLink();
    });
    renderStages();
    renderStatusCard();
    $('#foldBar')?.addEventListener('click', () => {
      const open = $('#cols').classList.toggle('folded') === false;
      if (open) detailsOpen.add(project.id); else detailsOpen.delete(project.id);
      $('#foldBar').setAttribute('aria-expanded', String(open));
      $('#foldBar .foldword').textContent = open ? 'Hide' : 'Show';
    });
    const shopForm = $('#shopAdd');
    shopForm.addEventListener('submit', e => {
      e.preventDefault();
      const input = shopForm.querySelector('input'), text = input.value.trim();
      if (!text) return;
      project.data.todo ??= defaultTodo(project);
      project.data.todo.lumber.push(newTask(text));
      todoChanged(project, { what: 'added', text, list: 'lumber' });
      input.value = '';
      renderShopMini(project);
    });
    $('#shopMini').addEventListener('click', e => {
      const li = (e.target as Element).closest<HTMLElement>('li.task'), t = li && project.data.todo?.lumber.find(x => x.id === li.dataset.id);
      if (!t) return;
      if ((e.target as Element).matches('input[type=checkbox]')) e.preventDefault();
      t.done_at = t.done_at ? null : new Date().toISOString();
      todoChanged(project, { what: t.done_at ? 'done' : 'undone', text: t.text, list: 'lumber' });
      renderShopMini(project);
    });
  }
  renderPanel();
  if (project) { renderPurchasesCard(project); renderNow(project); }
}
const detailsOpen = new Set();   // projects whose folded details were opened

// The project's own shopping list, under the lumber card: what's left to buy, plus what was bought this week.
function renderShopMini(p) {
  const ul = $('#shopMini');
  if (!ul) return;
  const since = new Date(Date.now() - SHOPPING_KEEP_DAYS * 86400000).toISOString();
  const shown = (p.data.todo?.lumber || []).filter(t => !t.done_at || t.done_at >= since);
  ul.innerHTML = shown.map(t => `<li class="task ${t.done_at ? 'done' : ''}" data-id="${esc(t.id)}">
      <input type="checkbox" ${t.done_at ? 'checked' : ''} aria-label="${esc(t.text)}"><span class="text">${esc(t.text)}</span>
      ${t.done_at ? `<span class="when">Bought ${esc(fmtDate(t.done_at))}</span>` : ''}</li>`).join('')
    || '<li class="none muted">Nothing to buy.</li>';
}

function changed() {
  ed.dirty = true;
  renderPanel();
  if (ed.project) {
    $('#projTitle').textContent = projectName(ed.project);
    ed.project.updated_at = new Date().toISOString();
    persist();
  }
}

// The budget card and the lumber card, from the project as it stands.
function renderPanel() {
  const p = ed.project;
  if (p) {
    const t = totals(p);
    p.calc = t;
    const card = $('#budgetCard');
    card.innerHTML = `<h2>Budget</h2>
      <div class="tot"><span>Spent so far <small>${(p.data.purchases || []).length} item${(p.data.purchases || []).length === 1 ? '' : 's'}</small></span><b>${money(t.spent)}</b></div>
      ${t.budget ? `<div class="tot"><span class="muted">Budget</span><span class="muted">${money(t.budget)}</span></div>
        <div class="meter ${t.spent > t.budget ? 'over' : ''}" aria-hidden="true"><span style="width:${Math.min(100, Math.round(t.spent / t.budget * 100))}%"></span></div>
        <div class="tot grand ${t.spent > t.budget ? 'loss' : 'profit'}"><span>${t.spent > t.budget ? 'Over budget' : 'Left to spend'}</span><span>${money(Math.abs(t.left))}</span></div>`
        : '<p class="muted" style="margin:6px 0 0;font-size:13px">No budget set. Add one under Project details to see what\'s left.</p>'}`;
  }
  renderLumber();
}

// ---------- lumber to buy: board feet to linear feet ----------
// A board foot is 1" thick x 12" wide x 1 ft long, so linear feet = board feet x 12 / (thickness x width).
// The yard sells whole boards, so linear feet are rounded up to full board lengths. Board feet come from
// what's typed in, else the cut list plus the waste allowance.
const BOARD_LENGTH_FT = 10;

function lumberNeeds(data, estimatedBf) {
  const l = data.lumber || {};
  const bf = l.bf === '' || l.bf == null ? estimatedBf : pos(l.bf);
  const quarters = pos(l.quarters) || 4;
  const width = pos(l.width);
  if (!width) return { bf, quarters, width, feet: 0, boards: 0, buyBf: bf };
  const exactFeet = bf * 12 / (quarters / 4 * width);
  const boards = Math.ceil(exactFeet / BOARD_LENGTH_FT - 1e-9), feet = boards * BOARD_LENGTH_FT;
  return { bf, quarters, width, exactFeet, feet, boards, buyBf: Math.round(feet * (quarters / 4) * width / 12 * 10) / 10 };
}

const lumberSummary = (data, n) => n.feet
  ? `${n.feet} linear ft of ${n.quarters}/4 ${data.species || 'lumber'}, ${+n.width}" wide (${n.boards} × ${BOARD_LENGTH_FT} ft board${n.boards === 1 ? '' : 's'})`
  : `About ${+n.bf} board feet of ${n.quarters}/4 ${data.species || 'lumber'}`;

function renderLumber() {
  const d = ed.data, est = ed.project ? cutBoardFeet(ed.project) : 0, n = lumberNeeds(d, est);
  const sum = $('#foldSum');
  if (sum && ed.project) {
    const t = totals(ed.project);
    sum.textContent = [d.area, d.species, t.budget ? `budget ${money(t.budget)}` : ''].filter(Boolean).join(' · ');
  }
  if (ed.project) renderShopMini(ed.project);
  $('[data-lumber="bf"]').placeholder = est ? `Cut list: ${est}` : 'e.g. 40';
  $('[data-lumber="quarters"]').value = n.quarters;
  const price = pos(findSpecies(d.species).price), cost = n.buyBf && price ? ` That's about ${money(n.buyBf * price)} at ${money(price)} a board foot.` : '';
  $('#lumberOut').innerHTML = !n.bf
    ? `<span class="muted">Type the board feet you need, or fill in the Cut list tab and it's worked out from that (plus ${+pos(store.settings.waste_pct)}% for waste).</span>`
    : n.feet
      ? `<b>About ${esc(lumberSummary(d, n))}</b><br><span class="muted" style="font-size:13px">${+n.bf} board feet &times; 12 &divide; (${n.quarters / 4}" &times; ${+n.width}") = ${+n.exactFeet.toFixed(1)} ft,
        rounded up to full ${BOARD_LENGTH_FT} ft boards: ${+n.buyBf} board feet to buy.${esc(cost)}</span>
        ${ed.project ? '<br><button type="button" class="btn small" data-addlumber style="margin-top:8px">Add to shopping list</button>' : ''}`
      : `<span class="muted">${+n.bf} board feet.${esc(cost)} Enter the width of the boards available to see how many linear feet to buy, in full ${BOARD_LENGTH_FT} ft boards.</span>
        ${ed.project ? '<br><button type="button" class="btn small" data-addlumber style="margin-top:8px">Add to shopping list</button>' : ''}`;
}

async function createProject() {
  if (ed.creating) return;
  if (!String(ed.data.title || '').trim()) { toast('Give the project a name first.'); ($('[data-path="title"]') as HTMLElement)?.focus(); return; }
  const stamp = new Date().toISOString(), stream = ed.stream, status = 'planned';
  const draft: any = { stream, status, stage: 'ideation', data: ed.data, calc: {}, history: [{ status, by: myName(), at: stamp }], created_at: stamp, updated_at: stamp };
  // Every project gets its to-do list the moment it is created.
  draft.data.todo = defaultTodo(draft);
  draft.calc = totals(draft);
  // The server gives the project its id.
  let project;
  ed.creating = true;
  try { project = await api('/api/projects', draft); }
  catch (e) { ed.creating = false; return toast(`Not saved: ${e.message}`); }
  store.projects.push(project);
  saved.projects.set(project.id, JSON.stringify(project, unbusy));
  ed.dirty = false;
  toast('Project saved');
  location.hash = `#/p/${project.id}`;
}

function renderStatusCard() {
  const p = ed.project, next = nextStepOf(p);
  $('#statusPill').className = `pill ${p.status}`;
  $('#statusPill').textContent = STATUS_NAME[p.status];
  const card = $('#statusCard');
  card.innerHTML = `
    <h2>Status</h2>
    <div class="actions">
      ${next ? `<button class="btn primary" data-status="${next[0]}">${next[1]}</button>` : ''}
      <select id="statusSelect" style="width:auto" aria-label="Change status">
        ${STATUSES.map(([k, n]) => `<option value="${k}" ${k === p.status ? 'selected' : ''}>${n}</option>`).join('')}
      </select>
    </div>
    <div class="actions" style="margin-top:10px">${isFrozen(p)
      ? `<button class="btn" data-unfreeze="${p.id}">Unfreeze</button><span class="muted" style="font-size:13px">Frozen since ${esc(fmtDate(p.data.frozen.at))}</span>`
      : archived(p) ? '' : `<button class="btn" data-freeze="${p.id}">Freeze project</button><span class="muted" style="font-size:13px">For a project on hold: waiting on a contractor, the weather or the budget</span>`}</div>
    <label class="f" style="margin-top:12px"><span>Kind of project</span><select id="streamSelect">
      ${STREAMS.map(([k, n]) => `<option value="${k}" ${k === streamOf(p) ? 'selected' : ''}>${n}</option>`).join('')}</select></label>
    <ul class="history">${p.history.map(h => `<li><span>${'frozen' in h ? (h.frozen ? `Frozen${h.note ? `: ${esc(h.note)}` : ''}` : 'Unfrozen') : h.stage ? `Phase: ${STAGE_NAME[h.stage] || esc(h.stage)}` : STATUS_NAME[h.status] || esc(h.status)}</span><span>${h.by ? `${esc(h.by)} · ` : ''}${esc(fmtDate(h.at))}</span></li>`).join('')}</ul>`;
  card.querySelectorAll('[data-status]').forEach(b => b.addEventListener('click', () => setStatus(p, b.dataset.status)));
  renderNow(p);
  $('#statusSelect').addEventListener('change', e => setStatus(p, e.target.value));
  $('#streamSelect').addEventListener('change', e => setStream(p, e.target.value));
}

// Moves a project to the other stream. A board drop also names the phase it lands in.
function setStream(p, stream, stage = '') {
  if (stream === streamOf(p)) return;
  p.stream = stream;
  if (stage && stage !== p.stage) { p.stage = stage; p.history.push({ stage, by: myName(), at: new Date().toISOString() }); }
  p.updated_at = new Date().toISOString();
  persist();
  toast(`Moved to ${STREAM_NAME[stream]}`);
  route();
}

const STAGE_SHORT = { ideation: 'Idea', design: 'Design', build: 'Build', install: 'Install' };
let phaseDatesOpen = false;

function renderStages() {
  const p = ed.project, current = stageIndex(p), today = ymd(new Date()), stages = stagesFor(p), last = lastPhase(p);
  const undated = key => key === 'ideation';
  const el = $('#stages');
  const late = (key, i) => i === current && stageDue(p, key) && stageDue(p, key) < today;
  // Desktop: one button per phase with its due date under it.
  const grid = stages.map(([key, name], i) => {
    const due = stageDue(p, key);
    return `<div>
      <button type="button" data-stage="${key}" class="${i < current ? 'done' : i === current ? 'on' : ''}" ${i === current ? 'aria-current="step"' : ''}>${i < current ? '&#10003; ' : ''}${name}</button>
      ${undated(key) ? '' : `<label class="due ${late(key, i) ? 'late' : ''}"><span>${late(key, i) ? 'Overdue' : 'Due'}</span>
        <input type="date" data-due="${key}" value="${esc(due)}" aria-label="${name} due date"></label>`}
    </div>`;
  }).join('');
  // Phone: a tap-to-set stepper, then the current phase's due date and delivery, other dates tucked away.
  const dateRow = (key, i, label) => `<label class="pdate ${late(key, i) ? 'late' : ''}"><span>${label}${late(key, i) ? ' <b>Overdue</b>' : ''}</span>
    <input type="date" data-due="${key}" value="${esc(stageDue(p, key))}" aria-label="${STAGE_NAME[key]} due date"></label>`;
  const main = stages.map(([key], i) => ({ key, i })).filter(({ key, i }) => !undated(key) && (i === current || key === last));
  const rest = stages.map(([key], i) => ({ key, i })).filter(({ key }) => !undated(key) && !main.some(m => m.key === key));
  const phone = `<ol class="stepper" style="--steps:${stages.length}">${stages.map(([key, name], i) => `<li class="${i < current ? 'done' : i === current ? 'on' : ''}">
      <button type="button" data-stage="${key}" ${i === current ? 'aria-current="step"' : ''} aria-label="${name}"><span class="dot">${i < current ? '&#10003;' : i + 1}</span><span class="lbl">${STAGE_SHORT[key]}</span></button></li>`).join('')}</ol>
    <div class="pdates">
      ${main.map(({ key, i }) => dateRow(key, i, i === current && key !== last ? `${STAGE_NAME[key]} due` : 'Install due')).join('')}
      ${rest.length ? `<details ${phaseDatesOpen ? 'open' : ''}><summary>Other phase dates${rest.some(({ key }) => stageDue(p, key)) ? '' : ' (none set)'}</summary>
        ${rest.map(({ key, i }) => dateRow(key, i, STAGE_NAME[key])).join('')}</details>` : ''}
    </div>`;
  el.innerHTML = `<div class="stagegrid" style="--steps:${stages.length}">${grid}</div><div class="phasem">${phone}</div>
    ${phaseDateError.p === p ? `<p class="phase-err" role="alert">${esc(phaseDateError.text)}</p>` : ''}`;
  // Each date box only offers days that keep the phases in order.
  el.querySelectorAll('input[data-due]').forEach(input => {
    const { min, max } = phaseDateBounds(p, input.dataset.due);
    if (min) input.min = min;
    if (max) input.max = max;
  });
  el.querySelector('details')?.addEventListener('toggle', e => { phaseDatesOpen = e.target.open; });
  el.querySelectorAll('button[data-stage]').forEach(b => b.addEventListener('click', () => {
    setStage(p, b.dataset.stage);
    renderStages();
    renderStatusCard();
  }));
  el.querySelectorAll('input').forEach(input => onDatePicked(input, () => {
    const key = input.dataset.due;
    if (!setPhaseDue(p, key, input.value)) { input.value = stageDue(p, key); renderStages(); return; }
    p.updated_at = new Date().toISOString();
    persist();
    renderStages();
    renderNow(p);
    el.dispatchEvent(new Event('phasedate'));
  }));
}

// An iPhone fills an empty date box with today's date, and says it changed, the moment its calendar
// opens. Acting on that straight away (redrawing the box) would close the calendar before a day is
// picked, so on touch screens wait until the calendar is closed and act on the day it ends up on.
const touchScreen = () => window.matchMedia('(pointer: coarse)').matches;
function onDatePicked(input, done) {
  let waiting = false;
  const picked = e => {
    if (!touchScreen() || document.activeElement !== input) return e.type === 'change' && done();
    if (waiting) return;
    waiting = true;
    input.addEventListener('blur', () => { waiting = false; done(); }, { once: true });
  };
  input.addEventListener('change', picked);
  // A phone's Reset button can clear the box without a change event, so listen for that too.
  input.addEventListener('input', picked);
}

// Phase due dates run in order: a phase can't be due before the one ahead of it, or after the one
// that follows. Two phases due the same day is fine.
const datedPhases = p => stagesFor(p).map(([key]) => key).filter(key => key !== 'ideation');
const dueLabelOf = (p, key) => key === lastPhase(p) ? 'Install due' : `${STAGE_NAME[key]} due`;
function phaseDateBounds(p, key) {
  const keys = datedPhases(p), i = keys.indexOf(key);
  const before = keys.slice(0, i).map(k => ({ key: k, due: stageDue(p, k) })).filter(x => x.due);
  const after = keys.slice(i + 1).map(k => ({ key: k, due: stageDue(p, k) })).filter(x => x.due);
  const lo = before.reduce((a, x) => (!a || x.due > a.due ? x : a), null);
  const hi = after.reduce((a, x) => (!a || x.due < a.due ? x : a), null);
  return { min: lo?.due || '', max: hi?.due || '', lo, hi };
}
let phaseDateError = { p: null, text: '' };
// Sets a phase's due date (the last phase's is the project's due date) unless it would put the phases
// out of order. Says why when it won't.
function setPhaseDue(p, key, value) {
  const { lo, hi } = phaseDateBounds(p, key);
  const clash = value && lo && value < lo.due ? `can't be before ${dueLabelOf(p, lo.key)} (${fmtDate(lo.due)})`
    : value && hi && value > hi.due ? `can't be after ${dueLabelOf(p, hi.key)} (${fmtDate(hi.due)})` : '';
  if (clash) {
    phaseDateError = { p, text: `${dueLabelOf(p, key)} ${clash}. Pick another day, or move that date first.` };
    return false;
  }
  phaseDateError = { p: null, text: '' };
  if (key === lastPhase(p)) p.data.due_date = value;
  else (p.data.stage_due ??= {})[key] = value;
  return true;
}

function setStage(p, stage) {
  if (stage === stageOf(p)) return;
  p.stage = stage;
  p.updated_at = new Date().toISOString();
  p.history.push({ stage, by: myName(), at: p.updated_at });
  // Moving a planned project past Ideation means work has started.
  if (p.status === 'planned' && stage !== 'ideation') { p.status = 'in_progress'; p.history.push({ status: 'in_progress', by: myName(), at: p.updated_at }); }
  persist();
}

async function setStatus(p, status) {
  if (status === p.status) return;
  p.status = status;
  p.updated_at = new Date().toISOString();
  p.history.push({ status, by: myName(), at: p.updated_at });
  if (isFinished(p)) finishTodo(p);
  persist();
  if (ed?.project === p) renderStatusCard();
  else showBoard();
}

// ---------- frozen projects ----------
function freezeProject(p) {
  const reason = prompt(`Freeze ${projectName(p)}? It leaves the board and calendar until you unfreeze it.\n\nWhy is it on hold? (optional)`, '');
  if (reason === null) return;
  const at = new Date().toISOString();
  p.data.frozen = { at, reason: reason.trim() };
  p.updated_at = at;
  p.history.push({ frozen: true, by: myName(), at, ...(reason.trim() ? { note: reason.trim() } : {}) });
  persist();
  toast(`${projectName(p)} is frozen. It's under Frozen on the Projects page.`);
  route();
}

// Puts a frozen project back where it left off. The time it spent frozen can be added to its due dates.
function unfreezeProject(p) {
  const f = p.data.frozen;
  if (!f) return;
  const days = Math.round((+new Date(ymd(new Date()) + 'T00:00') - +new Date(ymd(new Date(f.at)) + 'T00:00')) / 86400000);
  const dated = [['due_date', p.data.due_date], ...Object.entries(p.data.stage_due || {})].filter(([, d]) => d);
  if (days > 0 && dated.length && confirm(`${projectName(p)} was frozen for ${days} day${days === 1 ? '' : 's'}. Push its due dates back ${days} day${days === 1 ? '' : 's'} as well?`)) {
    const later = d => { const x = new Date(d + 'T00:00'); x.setDate(x.getDate() + days); return ymd(x); };
    if (p.data.due_date) p.data.due_date = later(p.data.due_date);
    for (const [k, d] of Object.entries(p.data.stage_due || {})) if (d) p.data.stage_due[k] = later(d);
  }
  delete p.data.frozen;
  const at = new Date().toISOString();
  p.updated_at = at;
  p.history.push({ frozen: false, by: myName(), at });
  persist();
  toast(`${projectName(p)} is back on the board.`);
  route();
}

// Every frozen project, to look over and unfreeze.
function showFrozen() {
  const list = store.projects.filter(isFrozen).sort((a, b) => b.data.frozen.at.localeCompare(a.data.frozen.at));
  const today = new Date(ymd(new Date()) + 'T00:00');
  const since = p => {
    const n = Math.round((+today - +new Date(ymd(new Date(p.data.frozen.at)) + 'T00:00')) / 86400000);
    return `${esc(fmtDate(p.data.frozen.at))} <span class="muted">(${n === 0 ? 'today' : `${n} day${n === 1 ? '' : 's'}`})</span>`;
  };
  view.innerHTML = `<a href="${boardLink()}" class="back">&larr; Projects</a>
    <div class="pagehead"><h1>Frozen projects</h1></div>
    <p class="muted">Projects on hold: waiting on a contractor, the weather, the budget or a free weekend. They stay off the board and calendar.
      Unfreezing one puts it back on the board where it left off.</p>
    ${list.length ? `<div class="card"><table class="list frozenlist">
      <tr><th>Project</th><th>Stream</th><th>Where it was</th><th>Frozen since</th><th>Why</th><th></th></tr>
      ${list.map(p => `<tr><td><a href="#/p/${p.id}">${esc(projectName(p))}</a></td>
        <td>${STREAM_NAME[streamOf(p)]}</td>
        <td><span class="pill ${p.status}">${STATUS_NAME[p.status]}</span> <span class="muted">${STAGE_NAME[stageOf(p)]}</span></td>
        <td>${since(p)}</td><td>${esc(p.data.frozen.reason)}</td>
        <td><button class="btn small" data-unfreeze="${p.id}">Unfreeze</button></td></tr>`).join('')}
    </table></div>`
    : '<div class="card empty"><p class="muted" style="margin:0">Nothing is frozen. To put a project on hold, open it and choose <b>Freeze project</b> in its Status box.</p></div>'}`;
}

// The Freeze and Unfreeze buttons, wherever they are on the page.
view.addEventListener('click', e => {
  const el = (e.target as Element).closest<HTMLElement>('[data-freeze], [data-unfreeze]');
  const p = el && store.projects.find(x => x.id === Number(el.dataset.freeze ?? el.dataset.unfreeze));
  if (!p) return;
  if (el.dataset.freeze !== undefined) freezeProject(p);
  else unfreezeProject(p);
});

// ---------- to-do lists ----------
// Every project has its own to-do list and shopping list, made when the project is created and kept in
// its data as data.todo = { items, lumber, log } (`lumber` is the shopping list: it started out as the
// lumber store list). Each entry is { id, text, done_at } (done_at is null while open); the log records
// every task added, checked off, unchecked or removed. Checked-off tasks stay where they are, struck
// through, so they can be unchecked later. When a project is marked Complete everything is checked off.
const TODO_LISTS = { items: 'To-do list', lumber: 'Shopping list' };
let taskSeq = 0;
const newTask = (text, extra = {}) => ({ id: `t${Date.now().toString(36)}${(taskSeq++).toString(36)}`, text, done_at: null, ...extra });
const isFinished = p => p.status === 'complete';

// The starting list for a project: the usual steps for its kind, which are easy to change or remove.
const STARTER_TODOS = {
  home: ['Measure the space', 'Pick materials and finishes', 'Check whether a permit is needed', 'Get quotes for any work we won\'t do ourselves',
    'Buy materials', 'Prep the area', 'Do the work', 'Patch, paint and touch up', 'Clean up'],
  shop: ['Sketch the design', 'Make the cut list', 'Buy lumber and hardware', 'Mill the stock', 'Cut the joinery', 'Glue up',
    'Sand', 'Finish', 'Install or move it into place'],
};
function defaultTodo(p) {
  return {
    items: STARTER_TODOS[streamOf(p)].map(text => newTask(text)),
    lumber: [],
    log: [{ at: new Date().toISOString(), what: 'created' }],
  };
}

// Projects from before to-do lists existed get one, checked off as far as the project has got.
function backfillTodos() {
  let any = false;
  for (const p of store.projects) {
    if (p.data.todo) continue;
    const todo = defaultTodo(p);
    if (isFinished(p) || archived(p)) {
      const at = p.history.findLast(h => h.status)?.at || p.updated_at;
      for (const t of [...todo.items, ...todo.lumber]) t.done_at ??= at;
    }
    p.data.todo = todo;
    any = true;
  }
  if (any) persist();
}

function todoChanged(p, entry?) {
  if (entry) p.data.todo.log.push({ at: new Date().toISOString(), ...entry });
  p.updated_at = new Date().toISOString();
  persist();
}

// A finished project has nothing left to do: everything still open is checked off.
function finishTodo(p) {
  const todo = p.data.todo;
  if (!todo) return;
  const at = new Date().toISOString(), open = [...todo.items, ...todo.lumber].filter(t => !t.done_at);
  if (!open.length) return;
  for (const t of open) t.done_at = at;
  todo.log.push({ at, what: 'finished', count: open.length });
}

const todoCounts = p => {
  const items = p.data.todo?.items || [];
  return { done: items.filter(t => t.done_at).length, total: items.length, next: items.find(t => !t.done_at) };
};

// The Tasks page: active projects first, then frozen ones, then finished ones (most recently finished
// first; the older ones are behind a "Show all" button so the page stays short).
let showAllFinished = false;
const finishedAt = p => [...p.history].reverse().find(h => h.status === p.status)?.at || p.updated_at;

// Active projects in priority order. By default the nearest due date comes first. Once projects have
// been moved by hand that order is kept (in the settings, so every device shares it), and a project
// that isn't in it yet (new, or back from frozen) slots in by its due date.
const dueKey = p => p.data.due_date || '9999';
function prioritized() {
  const active = store.projects.filter(p => !archived(p) && !isFrozen(p))
    .sort((a, b) => dueKey(a).localeCompare(dueKey(b)) || a.id - b.id);
  const saved = Array.isArray(store.settings.task_order) ? store.settings.task_order : [];
  const ranked = saved.map(id => active.find(p => p.id === id)).filter(Boolean);
  for (const p of active) {
    if (ranked.includes(p)) continue;
    const i = ranked.findIndex(q => dueKey(q) > dueKey(p));
    ranked.splice(i < 0 ? ranked.length : i, 0, p);
  }
  return ranked;
}
const manualOrder = () => Array.isArray(store.settings.task_order) && store.settings.task_order.length > 0;
function setTaskOrder(ids) {
  store.settings.task_order = ids;
  settingsChanged();
}

function showTasks() {
  const active = prioritized();
  const frozen = store.projects.filter(isFrozen).sort((a, b) => b.data.frozen.at.localeCompare(a.data.frozen.at));
  const finished = store.projects.filter(p => archived(p) && !isFrozen(p)).sort((a, b) => finishedAt(b).localeCompare(finishedAt(a)));
  const today = ymd(new Date()), FINISHED_SHOWN = 9;
  const card = (p, kind = 'active') => {
    const c = todoCounts(p), due = p.data.due_date;
    const note = kind === 'frozen' ? `frozen since ${esc(fmtDate(p.data.frozen.at))}`
      : kind === 'finished' ? `${p.status === 'declined' ? 'declined' : 'finished'} ${esc(fmtDate(finishedAt(p)))}`
      : due ? `<span class="${due < today ? 'late' : ''}">due ${esc(fmtDate(due))}</span>` : '';
    return `<a class="card taskproj ${kind}" href="#/tasks/${p.id}"${kind === 'active' ? ` data-id="${p.id}" draggable="false"` : ''}>
      <div class="name"><b>${esc(projectName(p))}</b><span class="pill ${p.status}">${STATUS_NAME[p.status]}</span></div>
      <span class="muted" style="font-size:13px">${esc(whereOf(p))}${note ? ` &middot; ${note}` : ''}</span>
      <div class="progress" aria-hidden="true"><span style="width:${c.total ? Math.round(c.done / c.total * 100) : 0}%"></span></div>
      <span style="font-size:13px">${c.total ? `${c.done} of ${c.total} done` : 'No tasks yet'}${c.next && kind !== 'finished' ? `<br><span class="muted">Next: ${esc(c.next.text)}</span>` : ''}</span>
    </a>`;
  };
  const shownFinished = showAllFinished ? finished : finished.slice(0, FINISHED_SHOWN);
  view.innerHTML = `<div class="pagehead"><h1>Tasks</h1></div>${tasksTabs('projects')}
    ${active.length ? `<div class="taskgrid reorder" id="activeTasks">${active.map(p => card(p)).join('')}</div>
      <p class="muted hint orderhint">${active.length > 1 ? 'Press and hold a project to move it up or down. ' : ''}${manualOrder()
        ? 'In your own order; new projects slot in by due date. <button type="button" class="link" id="orderByDue">Sort by due date</button>'
        : 'Nearest due date first.'}</p>`
      : `<div class="card empty"><p class="muted" style="margin:0">No active projects. Every new project gets its own to-do list as soon as it's created.</p></div>`}
    ${frozen.length ? `<section class="tasksection"><h2>Frozen projects <span>${frozen.length}</span></h2>
      <div class="taskgrid">${frozen.map(p => card(p, 'frozen')).join('')}</div></section>` : ''}
    ${finished.length ? `<section class="tasksection"><h2>Finished projects <span>${finished.length}</span></h2>
      <div class="taskgrid">${shownFinished.map(p => card(p, 'finished')).join('')}</div>
      ${finished.length > FINISHED_SHOWN ? `<p><button type="button" class="link" id="allFinished">${showAllFinished ? 'Show fewer' : `Show all ${finished.length}`}</button></p>` : ''}</section>` : ''}`;
  $('#allFinished')?.addEventListener('click', () => { showAllFinished = !showAllFinished; showTasks(); });
  $('#orderByDue')?.addEventListener('click', () => { setTaskOrder([]); showTasks(); });
  const grid = $('#activeTasks');
  if (!grid) return;
  const press = longPressReorder(grid, ids => { setTaskOrder(ids.map(Number)); showTasks(); }, 'a.taskproj');
  // Letting go after a move is not a tap that opens the project.
  grid.addEventListener('click', e => { if (press.justMoved()) e.preventDefault(); }, true);
  // From the keyboard: Alt + up / down arrow moves the focused project.
  grid.addEventListener('keydown', e => {
    const a = (e.target as Element).closest<HTMLElement>('a.taskproj');
    if (!a || !e.altKey || !['ArrowUp', 'ArrowDown'].includes(e.key)) return;
    e.preventDefault();
    const ids = active.map(p => p.id), i = ids.indexOf(Number(a.dataset.id)), j = i + (e.key === 'ArrowUp' ? -1 : 1);
    if (i < 0 || j < 0 || j >= ids.length) return;
    [ids[i], ids[j]] = [ids[j], ids[i]];
    setTaskOrder(ids);
    showTasks();
    ($(`#activeTasks a[data-id="${ids[j]}"]`) as HTMLElement)?.focus();
  });
}

// Every open item on every active project's to-do list, as one list in the same order as the
// Projects tab (highest priority first), each project's items in its own list's order. Checking an
// item here checks it off on the project's list. Items checked this week stay, struck through, so a
// mis-tap can be undone. Projects with nothing left to do are left out.
const TODOS_KEEP_DAYS = 7;
function showAllTodos() {
  const since = new Date(Date.now() - TODOS_KEEP_DAYS * 86400000).toISOString(), today = ymd(new Date());
  const shown = t => !t.done_at || t.done_at >= since;
  const draw = () => {
    let open = 0;
    const groups = prioritized().map(p => {
      const all = p.data.todo?.items || [], items = all.filter(shown), left = all.filter(t => !t.done_at).length;
      if (!left) return '';
      open += left;
      const due = p.data.due_date;
      return `<section class="card todogroup" data-project="${p.id}">
        <div class="shophead"><a href="#/tasks/${p.id}"><b>${esc(projectName(p))}</b></a>
          <span class="muted">${esc(whereOf(p))}${due ? ` &middot; <span class="${due < today ? 'late' : ''}">due ${esc(fmtDate(due))}</span>` : ''} &middot; ${left} to do</span></div>
        <ul class="tasks">${items.map(t => `<li class="task ${t.done_at ? 'done' : ''}" data-id="${esc(t.id)}">
          <input type="checkbox" ${t.done_at ? 'checked' : ''} aria-label="${esc(t.text)}"><span class="text">${esc(t.text)}</span>
          ${t.done_at ? `<span class="when">Done ${esc(fmtDate(t.done_at))}</span>` : ''}</li>`).join('')}</ul>
      </section>`;
    }).filter(Boolean);
    box.innerHTML = `<div class="pagehead"><h1>Tasks</h1></div>${tasksTabs('todos')}
      <p class="muted shopsum">${open ? `${open} thing${open === 1 ? '' : 's'} to do across ${groups.length} project${groups.length === 1 ? '' : 's'}, in the order of the Projects tab.` : 'Nothing left to do.'}
        Checking an item off here checks it off on that project's list too.</p>
      ${groups.length ? `<div class="todoall">${groups.join('')}</div>`
        : '<div class="card empty"><p class="muted" style="margin:0">Every active project\'s to-do list is done.</p></div>'}`;
  };
  view.innerHTML = '<div id="alltodos"></div>';
  const box = $('#alltodos');
  draw();
  box.addEventListener('click', e => {
    const li = (e.target as Element).closest<HTMLElement>('li.task');
    const p = li && store.projects.find(x => x.id === Number(li.closest<HTMLElement>('[data-project]')?.dataset.project));
    const t = p?.data.todo?.items.find(x => x.id === li.dataset.id);
    if (!t) return;
    if ((e.target as Element).matches('input[type=checkbox]')) e.preventDefault();
    t.done_at = t.done_at ? null : new Date().toISOString();
    todoChanged(p, { what: t.done_at ? 'done' : 'undone', text: t.text, list: 'items' });
    draw();
  });
}

// One project's to-do list, its shopping list and the log of everything done.
function showTodo(p) {
  if (!p.data.todo) { p.data.todo = defaultTodo(p); todoChanged(p); }
  const todo = p.data.todo;
  view.innerHTML = `${projectHeader(p, 'todo', '')}
    <div class="cols">
      <div class="card">
        <h2>To-do list</h2>
        <form class="addtask" data-list="items" autocomplete="off"><textarea rows="1" enterkeyhint="done" placeholder="Add a task, or paste a list" aria-label="New task"></textarea><button class="btn primary">Add</button></form>
        <ul class="tasks" data-list="items"></ul>
        <p class="muted hint">Paste a block of tasks (one per line) to add each line as its own task. Press and hold a task to move it up or down the list.</p>
      </div>
      <aside>
        <div class="card">
          <h2>Shopping list</h2>
          <form class="addtask" data-list="lumber" id="lumberAdd" autocomplete="off"><textarea rows="1" enterkeyhint="done" placeholder="Add something to buy" aria-label="New shopping list item"></textarea><button class="btn primary">Add</button></form>
          <ul class="tasks" data-list="lumber"></ul>
          <p class="muted hint">Paste a list (one item per line) to add every item at once.</p>
        </div>
        <div class="card"><h2>Task log</h2><ul class="history tasklog" id="todoLog"></ul></div>
      </aside>
    </div>`;

  const draw = list => {
    const ul = $(`ul[data-list="${list}"]`);
    // The lumber line follows the project's estimate until it is checked off or edited.
    ul.innerHTML = todo[list].length ? todo[list].map(t => `<li class="task ${t.done_at ? 'done' : ''}" data-id="${esc(t.id)}">
        <input type="checkbox" ${t.done_at ? 'checked' : ''} aria-label="${esc(t.text)}">
        <span class="text">${esc(t.text)}</span>
        ${t.done_at ? `<span class="when">Done ${esc(fmtDate(t.done_at))}</span>` : ''}
        <button type="button" class="x" aria-label="Remove ${esc(t.text)}" title="Remove">&times;</button>
      </li>`).join('')
      : `<li class="none muted">${list === 'lumber' ? 'Nothing to buy yet.' : 'Nothing on the list yet.'}</li>`;
  };
  const drawLog = () => {
    const what = e => ({
      created: 'List made', finished: `Project finished: ${e.count} open item${e.count === 1 ? '' : 's'} checked off`,
      done: `Done: ${esc(e.text)}`, undone: `Unchecked: ${esc(e.text)}`, added: `Added: ${esc(e.text)}`, removed: `Removed: ${esc(e.text)}`,
    }[e.what] || esc(e.what)) + (e.list === 'lumber' ? ' <small>(shopping list)</small>' : '');
    $('#todoLog').innerHTML = [...todo.log].reverse().map(e => `<li><span>${what(e)}</span><span>${esc(fmtDate(e.at))}</span></li>`).join('');
  };
  const redraw = () => { draw('items'); draw('lumber'); drawLog(); };

  const find = (list, id) => todo[list].find(t => t.id === id);
  const toggle = (list, id) => {
    const t = find(list, id);
    if (!t) return;
    t.done_at = t.done_at ? null : new Date().toISOString();
    todoChanged(p, { what: t.done_at ? 'done' : 'undone', text: t.text, list });
    redraw();
  };

  // Adds each line of a pasted or typed block as its own item, without the bullets, numbers or checkboxes
  // it was written with. A single typed line is added just as it was typed.
  const linesOf = text => /\n/.test(text) ? splitPasted(text) : [text.replace(/\s+/g, ' ').trim()].filter(Boolean);
  const addLines = (list, items) => {
    if (!items.length) return 0;
    for (const t of items) {
      todo[list].push(newTask(t));
      todo.log.push({ at: new Date().toISOString(), what: 'added', text: t, list });
    }
    todoChanged(p);
    redraw();
    if (items.length > 1) toast(`Added ${items.length} items to the ${TODO_LISTS[list].toLowerCase()}.`);
    return items.length;
  };
  // The add box grows with what's in it, so a pasted block shows every line until it's added.
  const fit = box => { box.style.height = 'auto'; box.style.height = `${box.scrollHeight + 2}px`; };

  view.querySelectorAll('form.addtask').forEach(form => {
    const box = form.querySelector('textarea'), list = form.dataset.list;
    // Pasting a block (a list from Notes, a text message, an email) adds each line straight away.
    // What's already typed in the box is kept and added first.
    box.addEventListener('paste', e => {
      const pasted = e.clipboardData?.getData('text/plain') || '';
      if (splitPasted(pasted).length < 2) return;   // one item: paste it into the box as usual
      e.preventDefault();
      const before = box.value.slice(0, box.selectionStart), after = box.value.slice(box.selectionEnd);
      addLines(list, [...linesOf(before), ...splitPasted(pasted), ...linesOf(after)]);
      box.value = '';
      fit(box);
    });
    box.addEventListener('input', () => fit(box));
    // Return adds what's in the box (Shift+Return starts a new line, to type several tasks at once).
    box.addEventListener('keydown', e => {
      if (e.key === 'Enter' && !e.shiftKey && !e.isComposing) { e.preventDefault(); form.requestSubmit(); }
    });
    form.addEventListener('submit', e => {
      e.preventDefault();
      if (!addLines(list, linesOf(box.value))) return box.focus();
      box.value = '';
      fit(box);
      box.focus();
    });
  });

  view.querySelectorAll('ul.tasks').forEach(ul => {
    const list = ul.dataset.list;
    const reorder = ids => {
      todo[list].sort((a, b) => ids.indexOf(a.id) - ids.indexOf(b.id));
      todoChanged(p);
    };
    const press = longPressReorder(ul, reorder);
    ul.addEventListener('click', e => {
      const li = (e.target as Element).closest<HTMLElement>('li.task');
      if (!li) return;
      if (press.justMoved()) { e.preventDefault(); return; }
      if ((e.target as Element).closest('.x')) {
        const t = find(list, li.dataset.id);
        if (!t || !confirm(`Remove "${t.text}" from the ${TODO_LISTS[list].toLowerCase()}?`)) return;
        todo[list] = todo[list].filter(x => x !== t);
        todoChanged(p, { what: 'removed', text: t.text, list });
        redraw();
        return;
      }
      // Tapping the checkbox or the task's text checks it off (or back on).
      if ((e.target as Element).matches('input[type=checkbox]')) e.preventDefault();
      toggle(list, li.dataset.id);
      refreshTabCount();
    });
    // From the keyboard: Alt + up / down arrow moves the focused task.
    ul.addEventListener('keydown', e => {
      const li = (e.target as Element).closest<HTMLElement>('li.task');
      if (!li || !e.altKey || !['ArrowUp', 'ArrowDown'].includes(e.key)) return;
      e.preventDefault();
      const i = todo[list].findIndex(t => t.id === li.dataset.id), j = i + (e.key === 'ArrowUp' ? -1 : 1);
      if (i < 0 || j < 0 || j >= todo[list].length) return;
      [todo[list][i], todo[list][j]] = [todo[list][j], todo[list][i]];
      todoChanged(p);
      draw(list);
      ($(`li[data-id="${li.dataset.id}"] input`, ul) as HTMLElement)?.focus();
    });
  });
  // The count on the To-do list tab follows what's ticked or added.
  const refreshTabCount = () => { const tab = $('.projtabs a.on small'), n = todoLeft(p); if (tab) tab.textContent = n ? String(n) : ''; };
  view.addEventListener('submit', () => setTimeout(refreshTabCount));
  redraw();
  if (focusShopping) { focusShopping = false; setTimeout(() => { const box = $('#lumberAdd textarea') as HTMLElement; box?.scrollIntoView({ block: 'center' }); box?.focus(); }, 50); }
}

// The two tabs at the top of the Tasks page.
const tasksTabs = on => `<nav class="tabs">
  <a href="#/tasks" class="${on === 'projects' ? 'on' : ''}">Projects</a>
  <a href="#/tasks/todos" class="${on === 'todos' ? 'on' : ''}">All to-dos <small>${
    store.projects.filter(p => !archived(p) && !isFrozen(p)).reduce((n, p) => n + (p.data.todo?.items || []).filter(t => !t.done_at).length, 0) || ''}</small></a>
  <a href="#/tasks/shopping" class="${on === 'shopping' ? 'on' : ''}">Shopping list <small>${
    store.projects.filter(p => !archived(p) && !isFrozen(p)).reduce((n, p) => n + (p.data.todo?.lumber || []).filter(t => !t.done_at).length, 0) || ''}</small></a>
</nav>`;

// Every active project's shopping list in one place, to take to the store and check off.
// It opens sorted by wood species, as a clean checklist of thickness, width, length and how many (read
// from each item's wording, see readLumber); "By project" shows each project's list as written. Checking an item here checks it off on the project's own list (and logs it there).
// Items checked in the last week stay visible, struck through, so a mis-tap can be undone; older ones
// are only on the project's own page. Frozen and finished projects are left out.
const SHOPPING_KEEP_DAYS = 7;
let shoppingBy = 'species';   // opens by species every time
function showShopping() {
  const since = new Date(Date.now() - SHOPPING_KEEP_DAYS * 86400000).toISOString();
  const projects = prioritized();
  const shown = t => !t.done_at || t.done_at >= since;
  const draw = () => {
    let open = 0, withItems = 0;
    const groups = projects.map(p => {
      const lumber = p.data.todo?.lumber || [];
      const items = lumber.filter(shown), left = lumber.filter(t => !t.done_at).length;
      open += left;
      if (left) withItems++;
      return `<section class="card shopgroup" data-project="${p.id}">
        <div class="shophead"><a href="#/tasks/${p.id}"><b>${esc(projectName(p))}</b></a>
          <span class="muted">${esc(whereOf(p))}${left ? ` &middot; ${left} to buy` : ''}</span></div>
        <ul class="tasks">${items.map(t => `<li class="task ${t.done_at ? 'done' : ''}" data-id="${esc(t.id)}">
          <input type="checkbox" ${t.done_at ? 'checked' : ''} aria-label="${esc(t.text)}"><span class="text">${esc(t.text)}</span>
          ${t.done_at ? `<span class="when">Done ${esc(fmtDate(t.done_at))}</span>` : ''}</li>`).join('')
          || '<li class="none muted">Nothing to buy.</li>'}</ul>
        <form class="addtask" autocomplete="off"><input placeholder="Add something to buy" aria-label="Add to ${esc(projectName(p))}'s shopping list"><button class="btn small">Add</button></form>
      </section>`;
    });
    const toggle = `<div class="seg" role="tablist" aria-label="Sort the shopping list">
      <button type="button" data-by="species" class="${shoppingBy === 'species' ? 'on' : ''}" aria-selected="${shoppingBy === 'species'}">By species</button>
      <button type="button" data-by="project" class="${shoppingBy === 'project' ? 'on' : ''}" aria-selected="${shoppingBy === 'project'}">By project</button></div>`;
    box.innerHTML = `<div class="pagehead"><h1>Tasks</h1></div>${tasksTabs('shopping')}
      <div class="shoptop">${toggle}<p class="muted shopsum">${open ? `${open} item${open === 1 ? '' : 's'} to buy for ${withItems} project${withItems === 1 ? '' : 's'}.` : 'Nothing left to buy.'}
        Checking an item off here checks it off on that project's list too.${shoppingBy === 'project' ? ' Paste a list into a box to add several items at once.' : ''}</p></div>
      ${!projects.length ? '<div class="card empty"><p class="muted" style="margin:0">No active projects.</p></div>'
        : shoppingBy === 'species' ? bySpecies() : `<div class="shopgrid">${groups.join('')}</div>`}`;
  };
  // Every item still to buy (and any checked this week), as one checklist per species, thickest first.
  const bySpecies = () => {
    const rows = projects.flatMap(p => (p.data.todo?.lumber || []).filter(shown).map(t => ({ p, t, l: readLumber(t.text) })));
    const groups = new Map();
    for (const r of rows) {
      const key = r.l.species || (r.l.lumber ? 'Species not given' : 'Other supplies');
      groups.set(key, [...(groups.get(key) || []), r]);
    }
    const order = k => k === 'Other supplies' ? 2 : k === 'Species not given' ? 1 : 0;
    const keys = [...groups.keys()].sort((a, b) => order(a) - order(b) || a.localeCompare(b));
    if (!keys.length) return '<div class="card empty"><p class="muted" style="margin:0">Nothing on any shopping list. Add items from a project\'s list, or switch to By project.</p></div>';
    const dash = '<span class="muted">&ndash;</span>';
    return `<div class="species">${keys.map(k => {
      const list = groups.get(k).sort((a, b) => (+!!a.t.done_at - +!!b.t.done_at) || (b.l.q || 0) - (a.l.q || 0) || (b.l.w || 0) - (a.l.w || 0));
      const left = list.filter(r => !r.t.done_at).length, other = k === 'Other supplies';
      return `<section class="card spgroup">
        <h3>${esc(k)} <span class="muted">${left ? `${left} to buy` : 'all bought'}</span></h3>
        ${other ? '' : '<div class="sphead" aria-hidden="true"><span></span><span>Thickness</span><span>Width</span><span>Length</span><span>How many</span></div>'}
        <ul class="tasks sprows">${list.map(({ p, t, l }) => `<li class="task ${t.done_at ? 'done' : ''} ${other ? 'other' : ''}" data-id="${esc(t.id)}" data-project="${p.id}">
          <input type="checkbox" ${t.done_at ? 'checked' : ''} aria-label="${esc(t.text)}">
          ${other ? `<span class="text">${esc(t.text)}</span>`
            : `<span class="dim">${l.thick ? esc(l.thick) : l.thickMissing ? '<span class="need" title="Thickness not given">?</span>' : dash}</span><span class="dim">${l.width ? esc(l.width) : dash}</span>
               <span class="dim">${l.length ? esc(l.length) : dash}</span><span class="dim">${l.count ? esc(l.count) : dash}</span>`}
          <span class="for muted"><a href="#/tasks/${p.id}">${esc(projectName(p))}</a>${!other && l.note ? ` &middot; ${esc(l.note)}` : ''}${!other && l.thickMissing && !t.done_at ? ' &middot; <span class="need">thickness not given</span>' : ''}${t.done_at ? ` &middot; bought ${esc(fmtDate(t.done_at))}` : ''}</span>
        </li>`).join('')}</ul>
      </section>`;
    }).join('')}</div>
    <p class="muted hint">Species and sizes are read from how each item is written, such as "2 &times; 8/4 walnut, 7&quot; wide, 10 ft" or "2 sheets 3/4&quot; birch ply, 4x8". To add items, use By project or the project's own list.</p>`;
  };
  // The page is drawn into its own box, so its handlers go away with it when another page is shown.
  view.innerHTML = '<div id="shopping"></div><div id="scanNudge" class="scannudge" hidden></div>';
  const box = $('#shopping');
  // Ticking things off at the store brings up a button to scan the receipt for them, with the project picked.
  const boughtFor = new Set<number>();
  const nudge = () => {
    const el = $('#scanNudge'), ids = [...boughtFor].filter(id => store.projects.some(x => x.id === id));
    el.hidden = !ids.length;
    if (!ids.length) return;
    const names = ids.map(id => projectName(store.projects.find(x => x.id === id)));
    el.innerHTML = `<span>Bought ${names.length === 1 ? `for <b>${esc(names[0])}</b>` : `for ${names.length} projects`}?</span>
      <a class="btn primary small" href="#/receipt/${ids.at(-1)}">Scan the receipt</a>`;
  };
  box.addEventListener('click', () => setTimeout(nudge));
  draw();
  const projectOf = el => store.projects.find(p => p.id === Number(el.closest('[data-project]')?.dataset.project));
  const add = (p, texts) => {
    p.data.todo ??= defaultTodo(p);
    for (const text of texts) {
      p.data.todo.lumber.push(newTask(text));
      p.data.todo.log.push({ at: new Date().toISOString(), what: 'added', text, list: 'lumber' });
    }
    todoChanged(p);
    draw();
    $(`[data-project="${p.id}"] form input`, box)?.focus();
  };
  box.addEventListener('click', e => {
    const by = (e.target as Element).closest<HTMLElement>('[data-by]');
    if (by) { shoppingBy = by.dataset.by; draw(); return; }
    if ((e.target as Element).closest('a')) return;   // a project's name opens its own list
    const li = (e.target as Element).closest<HTMLElement>('li.task'), p = li && projectOf(li);
    if (!p) return;
    if ((e.target as Element).matches('input[type=checkbox]')) e.preventDefault();
    const t = p.data.todo.lumber.find(x => x.id === li.dataset.id);
    if (!t) return;
    t.done_at = t.done_at ? null : new Date().toISOString();
    if (t.done_at) boughtFor.add(p.id);
    todoChanged(p, { what: t.done_at ? 'done' : 'undone', text: t.text, list: 'lumber' });
    draw();
  });
  box.addEventListener('submit', e => {
    e.preventDefault();
    const form = e.target as HTMLFormElement, input = form.querySelector('input'), p = projectOf(form), text = input.value.trim();
    if (p && text) add(p, [text]);
  });
  box.addEventListener('paste', (e: ClipboardEvent) => {
    const input = (e.target as Element).closest?.('form.addtask input'), p = input && projectOf(input);
    const items = p ? splitPasted(e.clipboardData?.getData('text/plain') || '') : [];
    if (items.length < 2) return;
    e.preventDefault();
    add(p, items);
    toast(`Added ${items.length} items to ${projectName(p)}'s shopping list.`);
  });
}

// Reads a shopping-list line for what the lumber store needs: species, thickness, width, length and how
// many. It understands the wording the lumber pickup line uses ("90 linear ft of 8/4 Walnut, 7" wide (9 ×
// 10 ft boards)") and the usual shorthand ("2x 8/4 walnut 7\" wide 10'", "3/4\" maple ply", "20 bf cherry").
// Anything it can't read is left blank, and a line with no wood in it counts as other supplies.
const EXTRA_SPECIES = ['Black walnut:Walnut', 'Walnut', 'Cherry', 'Maple:Hard maple', 'Soft maple', 'White oak', 'Red oak', 'Oak',
  'Baltic birch:Birch', 'Ash', 'Poplar', 'Pine', 'Hickory', 'Teak', 'Mahogany', 'Sapele', 'Padauk', 'Purpleheart', 'Birch', 'Beech', 'Alder', 'Cedar',
  'Douglas fir', 'Fir', 'Basswood', 'Butternut', 'Wenge', 'Zebrawood', 'Bubinga', 'Jatoba', 'Cypress', 'Spruce'];
// Sheet goods that aren't plywood keep their own name; [pattern, group name].
const SHEET_KINDS = [['mdf', 'MDF'], ['osb', 'OSB'], ['melamine', 'Melamine'], ['hardboard', 'Hardboard'], ['masonite', 'Hardboard'],
  ['particle ?board', 'Particleboard']];
// Thicknesses written out in words on sheet goods. "three quarter" is checked before "quarter".
const THICK_WORDS = [['three[- ]?quarters?', '3/4'], ['half', '1/2'], ['quarter', '1/4']];
// Typed fractions (¾) become 3/4 so they read like everything else; inches() turns "1 1/4", "3/4" or ".75" into a number.
const VULGAR = { '¼': '1/4', '½': '1/2', '¾': '3/4', '⅛': '1/8', '⅜': '3/8', '⅝': '5/8', '⅞': '7/8' };
const inches = v => {
  const m = String(v).trim().match(/^(?:(\d+)\s+)?(\d+)\/(\d+)$/);
  return m ? (+(m[1] || 0) + +m[2] / +m[3]) || 0 : parseFloat(v) || 0;
};
function readLumber(text, fallbackSpecies = '') {
  const s = ` ${String(text).replace(/[\u201c\u201d\u2033]/g, '"').replace(/[\u2018\u2019\u2032]/g, "'")
    .replace(/(\d?)\s*([\u00bc\u00bd\u00be\u215b\u215c\u215d\u215e])/g, (_, w, f) => `${w ? `${w} ` : ' '}${VULGAR[f]}`)} `, low = s.toLowerCase();
  const names = [...store.settings.species.map(x => [x.name, x.name]), ...EXTRA_SPECIES.map(x => { const [a, b] = x.split(':'); return [a, b || a]; })]
    .sort((a, b) => b[0].length - a[0].length);
  const hit = names.find(([n]) => new RegExp(`[^a-z]${n.toLowerCase().replace(/[.*+?^${}()|[\]\\]/g, '\\$&')}s?[^a-z]`).test(low));
  // Sheet goods are grouped as "<species> plywood" (or "Plywood", "MDF", "OSB" and so on), apart from solid boards.
  // Baltic birch only comes in sheets, so it counts as one even when the line doesn't say ply.
  const kind = SHEET_KINDS.find(([k]) => new RegExp(`[^a-z]${k}s?[^a-z]`).test(low));
  const sheet = !!kind || /[^a-z](?:ply|plywood|sheets?|baltic)[^a-z]/.test(low);
  let species = hit ? hit[1] : fallbackSpecies || '';
  if (sheet) species = kind && !hit ? kind[1] : hit ? `${hit[0]} plywood` : 'Plywood';
  species = species ? species[0].toUpperCase() + species.slice(1) : '';
  const num = '(\\d+(?:\\.\\d+)?(?:\\s+\\d+\\/\\d+)?|\\d+\\/\\d+)';
  const m = re => s.match(new RegExp(re, 'i'));
  const quarters = m('(\\d{1,2})\\/4(?![\\d"])(?!\\s*(?:"|in\\b|inch))');
  const thickIn = m(`${num}\\s*(?:"|in\\b|inch(?:es)?)\\s*thick`) || (sheet ? m(`${num}\\s*(?:"|in\\b|inch(?:es)?)(?!\\s*(?:wide|long|w\\b|l\\b))`) : null);
  const width = m(`${num}\\s*(?:"|in\\b|inch(?:es)?)\\s*(?:wide|w\\b)`) || m(`(?:wide|width)\\s*:?\\s*${num}\\s*(?:"|in\\b)?`);
  const boards = m(`(\\d+)\\s*(?:\\u00d7|x)\\s*${num}\\s*(?:ft|feet|foot|')\\s*boards?`);
  const linear = m(`${num}\\s*(?:linear|lin\\.?)\\s*(?:ft|feet)`);
  const len = m(`${num}\\s*(?:ft|feet|foot|')(?![a-z])`) || m(`${num}\\s*(?:"|in\\b)\\s*(?:long|l\\b)`);
  const bf = m(`${num}\\s*(?:board\\s*f(?:ee|oo)t|bd\\.?\\s*ft|bf)\\b`);
  const count = m('^\\s*(\\d+)\\s*(?:\\u00d7|x(?=\\s)|pcs?\\b|pieces?\\b|boards?\\b|sheets?\\b)') || m('(?:\\u00d7|\\bx)\\s*(\\d+)\\s*$');
  const r: any = { species, sheet };
  if (sheet) {
    // Sheet goods are bought by thickness, so it is read however it's written: 3/4", 3/4 in, 3/4-inch, a bare
    // 3/4 or ½, .75", or 18mm. "1/2 sheet" is half a sheet, not a thickness. "2 3/4" ply" is two sheets of 3/4".
    const mm = m('(\\d+(?:\\.\\d+)?)\\s*mm\\b');
    const inch = m(`(\\d+\\s+\\d+\\/\\d+|\\d+\\/\\d+|\\d*\\.\\d+|\\d+)[\\s-]*(?:"|in\\b\\.?|inch(?:es)?)(?![\\s-]*(?:wide|long|w\\b|l\\b))`);
    const bare = m('(?<![\\d/.])(\\d{1,2}\\/\\d{1,2})(?![\\d/]|\\s*(?:\'|ft\\b|feet|foot|wide|long|sheets?\\b))');
    if (mm) { r.thick = `${mm[1]} mm`; r.q = parseFloat(mm[1]) / 25.4 * 4; }
    else if (inch || bare) {
      let t = (inch || bare)[1].trim();
      const mixed = t.match(/^(\d+)\s+(\d+\/\d+)$/);
      if (mixed && +mixed[1] >= 2) { r.count = mixed[1]; t = mixed[2]; }   // "2 3/4" ply": a count, then the thickness
      r.thick = `${t}"`; r.q = inches(t) * 4;
    } else {
      const word = THICK_WORDS.find(([w]) => new RegExp(`[^a-z]${w}[- ]?inch`).test(low));
      if (word) { r.thick = `${word[1]}"`; r.q = inches(word[1]) * 4; }
      else r.thickMissing = true;
    }
    // A sheet size such as 4x8, 4' x 8', 4 by 8 or 5×5 fills the width and length columns.
    const size = m('(?<![\\d/.])(\\d{1,2})\\s*\'?\\s*(?:[x\\u00d7]|by)\\s*(\\d{1,2})\\s*\'?(?![\\d/x\\u00d7"])');
    if (size) { r.width = `${size[1]} ft`; r.length = `${size[2]} ft`; }
    const part = m('(?<![\\d/.])(\\d{1,2}\\/\\d{1,2})\\s*sheet');
    if (part && !r.count) r.count = `${part[1]} sheet`;
  }
  else if (quarters) { r.thick = `${quarters[1]}/4`; r.q = +quarters[1]; }
  else if (thickIn) { r.thick = `${thickIn[1]}"`; r.q = inches(thickIn[1]) * 4; }
  if (width) { r.width = `${width[1]}"`; r.w = inches(width[1]); }
  if (boards) { r.length = `${boards[2]} ft`; r.count = `${boards[1]} board${boards[1] === '1' ? '' : 's'}`; if (linear) r.note = `${linear[1]} linear ft`; }
  else if (linear) r.length = `${linear[1]} linear ft`;
  else if (len && !r.length) r.length = len[0].trim().replace(/\s*(feet|foot|')$/i, ' ft').replace(/\s*(?:"|in)\s*(?:long|l)$/i, '"');
  if (!r.count && count) r.count = count[1];
  if (bf) r.count = r.count ? `${r.count} (${bf[1]} bf)` : `${bf[1]} bf`;
  r.lumber = !!(hit || sheet || r.thick || r.width || bf || boards || linear);
  if (!r.lumber) r.species = '';
  return r;
}

// Turns pasted text into list items: one per line (or per semicolon, or per bullet when they all came
// on one line), without the bullets, numbers or checkboxes the list was written with. Commas are left
// alone, since they turn up inside items ("8/4 walnut, 7\" wide").
function splitPasted(text) {
  let parts = text.split(/\r?\n/);
  if (parts.filter(x => x.trim()).length < 2) parts = text.split(/;|\s[\u2022\u00b7\u25aa\u25e6\u2023\u2043]\s/);
  return parts
    .map(x => x.replace(/^\s*(?:[-*+\u2022\u00b7\u25aa\u25e6\u2023\u2043\u2013\u2014]|\d{1,3}[.)]|[a-z][.)](?=\s)|\[[ xX]?\]|[\u2610\u2611\u2612\u2713\u2714])\s*/, '').replace(/\s+/g, ' ').trim())
    .filter(Boolean);
}

// Press and hold an item to pick it up, then drag it up or down the list and let go. A quick swipe
// still scrolls the page; only a steady press lifts the item. `drop` gets the new order of ids (each
// item's data-id). Works for a single column and for a grid of cards (left to right, then down).
function longPressReorder(ul, drop, item = 'li.task') {
  let timer = null, lifted = null, startX = 0, startY = 0, movedUntil = 0, pointer = null, order = '';
  const cancelPress = () => { clearTimeout(timer); timer = null; };
  ul.addEventListener('contextmenu', e => { if (e.target.closest(item)) e.preventDefault(); });
  // While an item is lifted, a finger moving on the screen drags it instead of scrolling the page.
  ul.addEventListener('touchmove', e => { if (lifted) e.preventDefault(); }, { passive: false });
  ul.addEventListener('pointerdown', e => {
    const li = e.target.closest(item);
    if (!li || e.button > 0 || e.target.closest('.x')) return;
    startX = e.clientX; startY = e.clientY; pointer = e.pointerId;
    cancelPress();
    timer = setTimeout(() => {
      timer = null;
      lifted = li;
      order = [...ul.querySelectorAll(item)].map(x => x.dataset.id).join();
      li.classList.add('lifted');
      try { li.setPointerCapture(pointer); } catch {}
      navigator.vibrate?.(15);
    }, 450);
  });
  ul.addEventListener('pointermove', e => {
    if (!lifted) {
      if (timer && Math.hypot(e.clientX - startX, e.clientY - startY) > 8) cancelPress();
      return;
    }
    e.preventDefault();
    const others = [...ul.querySelectorAll(item)].filter(x => x !== lifted);
    const rects = others.map(x => x.getBoundingClientRect()), oneColumn = rects.every(r => r.left === rects[0]?.left);
    const before = others.find((x, i) => {
      const r = rects[i];
      return oneColumn ? e.clientY < r.top + r.height / 2 : e.clientY < r.top || (e.clientY <= r.bottom && e.clientX < r.left + r.width / 2);
    });
    if ((before || null) !== lifted.nextElementSibling) ul.insertBefore(lifted, before || null);
  });
  const end = () => {
    cancelPress();
    if (!lifted) return;
    lifted.classList.remove('lifted');
    lifted = null;
    movedUntil = Date.now() + 400;   // the click that follows letting go is not a tap on the task
    const ids = [...ul.querySelectorAll(item)].map(x => x.dataset.id);
    if (ids.join() !== order) drop(ids);
  };
  ul.addEventListener('pointerup', end);
  ul.addEventListener('pointercancel', end);
  return { justMoved: () => Date.now() < movedUntil };
}

// ---------- receipts: material purchases ----------
// A photo of a store receipt is sent to the server, which keeps it (the receipts table, for returns and
// warranties) and reads it (Workers AI, see src/lib/receipts.ts) into line items. They're shown here to
// check over: fix a description or price, untick what isn't for this job, pick the project, and the
// ticked items are added to that project's material purchases
// (data.purchases: [{ id, date, store, item, qty, amount, receipt }], `receipt` being the receipt's id).
// Items left over can then go to another project from the same receipt. A receipt that can't be read
// keeps its photo and the lines are typed in; a purchase with no receipt at all can be typed in too.
const SCAN_MAX_SIDE = 1600;   // long side of the photo sent to the server, in pixels: plenty to read a receipt
const PHOTO_MAX_CHARS = 1_400_000;   // what the server will keep (a D1 row); photos are made smaller until they fit
let scan = null;              // the receipt being checked over: { id, store, date, total, tax, image, kept, lines: [{ description, qty, amount, on, added }] }
let scanFailed = null;        // a photo that couldn't be read: { id, image, kept, message }
let scanGeneral = false;      // the ticked items aren't for any one project (tools, general supplies)
let scanProjectId = null;     // the project picked to add items to
let purchaseSeq = 0;

const purchasesOf = p => (p.data.purchases ||= []);
const spentOn = p => cents((p.data.purchases || []).reduce((n, x) => n + num(x.amount), 0));
const budgetFor = p => pos(p.data.budget);
// Projects that can take purchases, most recently touched first.
const purchaseProjects = () => store.projects.filter(p => !archived(p) || p.id === scanProjectId).sort((a, b) => b.updated_at.localeCompare(a.updated_at));
const receiptId = () => `r${Date.now().toString(36)}${Math.random().toString(36).slice(2, 6)}`;
// A photo can be replaced, so its address carries a version (its size) and the browser keeps each version.
const photoUrl = (id, v?) => `/api/receipts/${encodeURIComponent(id)}/photo${v ? `?v=${v}` : ''}`;

// Shrinks a phone photo (often 4000+ px) to a JPEG data URL small enough to send quickly and keep.
async function shrinkPhoto(file: File) {
  // createImageBitmap turns the photo upright from its camera orientation, as it's shown on screen.
  const img = await createImageBitmap(file, { imageOrientation: 'from-image' }).catch(() => { throw new Error("That file couldn't be opened as a photo."); });
  let side = SCAN_MAX_SIDE, quality = 0.85, url = '';
  for (let tries = 0; tries < 6; tries++) {
    const scale = Math.min(1, side / Math.max(img.width, img.height));
    const canvas = document.createElement('canvas');
    canvas.width = Math.round(img.width * scale);
    canvas.height = Math.round(img.height * scale);
    const g = canvas.getContext('2d');
    g.fillStyle = '#fff';   // a transparent PNG would otherwise turn black as a JPEG
    g.fillRect(0, 0, canvas.width, canvas.height);
    g.drawImage(img, 0, 0, canvas.width, canvas.height);
    url = canvas.toDataURL('image/jpeg', quality);
    if (url.length <= PHOTO_MAX_CHARS) break;
    quality = Math.max(0.6, quality - 0.1);
    if (quality === 0.6) side = Math.round(side * 0.85);
  }
  img.close();
  return url;
}

// The server's own explanation reads better than "The server returned 400: {...}".
const serverSaid = error => String(error.message).match(/"error":"([^"]+)"/)?.[1] || error.message;

async function readReceipt(file: File) {
  const box = $('#scanBox');
  scan = null;
  scanFailed = null;
  scanGeneral = false;
  box.innerHTML = '<p class="scanning">Reading the receipt&hellip; <span class="muted">this takes a few seconds</span></p>';
  let image = '', id = receiptId(), kept = false;
  try {
    image = await shrinkPhoto(file);
    box.insertAdjacentHTML('afterbegin', `<img class="receiptimg" src="${image}" alt="The receipt photo">`);
    const r = await api('/api/receipts/scan', { id, image });
    kept = !!r.kept;
    if (r.error) throw new Error(r.error);
    if (!r.items.length) throw new Error("No items could be read from that photo. Try again with the whole receipt flat, in good light, or type the items in.");
    scan = {
      id, image, kept, store: r.store, date: r.date || ymd(new Date()), total: r.total, tax: r.tax, notes: '', general: [],
      lines: [...r.items.map(i => ({ description: i.description, qty: i.quantity, amount: i.amount, on: true })),
        ...(r.tax ? [{ description: 'Sales tax', qty: 1, amount: r.tax, on: true, tax: true }] : [])],
    };
    renderScan();
  } catch (error) {
    scanFailed = image ? { id, image, kept, message: serverSaid(error) } : null;
    if (scanFailed) renderScanFailed();
    else box.innerHTML = `<p class="note err">${esc(serverSaid(error))}</p>`;
  }
}

// Reading failed: the photo is still kept, and the lines can be typed in from it.
function renderScanFailed() {
  const box = $('#scanBox');
  if (!box || !scanFailed) return;
  box.innerHTML = `<img class="receiptimg" src="${scanFailed.image}" alt="The receipt photo">
    <p class="note err" style="margin-top:12px">${esc(scanFailed.message)}</p>
    <div class="actions"><button type="button" class="btn" data-byhand>Type the items in from this photo</button></div>`;
}

// Starts a receipt to type in: from a photo that couldn't be read, or with no photo at all.
function startByHand(from = null) {
  scan = { id: from?.id || receiptId(), image: from?.image || '', kept: !!from?.kept, store: '', date: ymd(new Date()), total: 0, tax: 0,
    notes: '', general: [], lines: [{ description: '', qty: 1, amount: '', on: true }] };
  scanFailed = null;
  scanGeneral = false;
  renderScan();
  $('#scanBox [data-scan="store"]')?.focus();
}

function showReceipt(projectId) {
  if (projectId) scanProjectId = projectId;
  const from = store.projects.find(p => p.id === projectId);
  view.innerHTML = `
    ${from && !sectionOf(prevHash) ? `<a href="#/p/${from.id}/summary" class="back">&larr; ${esc(projectName(from))}</a>` : backLink(boardLink(), 'Projects')}
    <div class="pagehead"><h1>Scan a receipt</h1><span class="spacer"></span><a class="btn small" href="#/receipts">All receipts</a></div>
    <div class="card receipt">
      <div class="actions">
        <label class="btn primary">Take a photo<input type="file" accept="image/*" capture="environment" data-photo hidden></label>
        <label class="btn">Choose a photo<input type="file" accept="image/*" data-photo hidden></label>
        <span class="muted" style="font-size:13px">Lay the receipt flat in good light, with the whole thing in the picture. The photo is kept with the receipt.</span>
      </div>
      <p style="margin:10px 0 0;font-size:13px"><button type="button" class="link" data-nophoto>No receipt? Type a purchase in by hand</button></p>
      <div id="scanBox"></div>
    </div>`;
  view.querySelectorAll('[data-photo]').forEach((input: HTMLInputElement) => input.addEventListener('change', () => {
    const file = input.files?.[0];
    input.value = '';
    if (file) readReceipt(file);
  }));
  if (scan) renderScan(); else if (scanFailed) renderScanFailed();
}

function renderScan() {
  const box = $('#scanBox');
  if (!box || !scan) return;
  const picked = scan.lines.filter(l => l.on && !l.added);
  const pickedSum = cents(picked.reduce((n, l) => n + num(l.amount), 0));
  const allSum = cents(scan.lines.reduce((n, l) => n + num(l.amount), 0));
  const left = scan.lines.filter(l => !l.added);
  const projects = purchaseProjects();
  if (!projects.some(p => p.id === scanProjectId)) scanProjectId = projects[0]?.id ?? null;
  box.innerHTML = `${scan.image ? `<img class="receiptimg" src="${scan.image}" alt="The receipt photo">` : ''}
    <div class="grid" style="margin-top:14px">
      <label class="f w3"><span>Store</span><input data-scan="store" value="${esc(scan.store)}"></label>
      <label class="f"><span>Date</span><input type="date" data-scan="date" value="${esc(scan.date)}"></label>
      <label class="f w6"><span>Notes <small class="muted" style="font-weight:400">what you bought and why</small></span><textarea data-scan="notes" rows="2" placeholder="e.g. Glue and hinges for the stool lid; spare blade for the table saw">${esc(scan.notes || '')}</textarea></label>
    </div>
    <div class="scanhead">
      <h2>Items ${scan.image ? 'on the receipt' : 'bought'}</h2>
      ${left.length > 1 ? `<span class="muted" style="font-size:13px"><button type="button" class="link" data-all="1">Tick all</button> &middot; <button type="button" class="link" data-all="0">Untick all</button></span>` : ''}
    </div>
    <ul class="scanlines">${scan.lines.map((l, i) => `<li class="${l.added ? 'added' : l.on ? '' : 'off'}">
      <input type="checkbox" data-i="${i}" data-k="on" ${l.on && !l.added ? 'checked' : ''} ${l.added ? 'disabled' : ''} aria-label="Include ${esc(l.description)}">
      <input data-i="${i}" data-k="description" value="${esc(l.description)}" ${l.added ? 'disabled' : ''} placeholder="What was bought" aria-label="Item">
      <input type="number" step="any" inputmode="decimal" data-i="${i}" data-k="amount" value="${esc(l.amount)}" ${l.added ? 'disabled' : ''} placeholder="$" aria-label="Price ($)">
      ${l.added ? `<span class="addedto">Added to ${esc(l.added)}</span>` : `<button type="button" class="link" data-remove="${i}" aria-label="Remove this line">&times;</button>`}
    </li>`).join('')}</ul>
    <button type="button" class="link" data-addline>+ Add ${scan.image ? 'a line that was missed' : 'another line'}</button>
    <hr class="rule">
    ${scan.total && Math.abs(allSum - scan.total) >= 0.01 ? `<p class="note">The lines add up to ${money(allSum)}, but the receipt total reads ${money(scan.total)}. Check for a missed or misread line.</p>` : ''}
    ${left.length ? `<label class="checkline"><input type="checkbox" id="scanGeneral" ${scanGeneral ? 'checked' : ''}> <span><b>Not for a project</b>
      <small class="muted">tools, shop supplies, things for the house in general&hellip;</small></span></label>
    ${scanGeneral ? '' : `<div class="grid">
      <label class="f w4"><span>Add the ticked items to</span><select id="scanProject">${projects.map(p =>
        `<option value="${p.id}" ${p.id === scanProjectId ? 'selected' : ''}>${esc(projectName(p))}</option>`).join('')}</select></label>
    </div>`}
    <div class="actions" style="margin-top:12px">
      <button type="button" class="btn primary" id="scanAdd" ${picked.length && (scanGeneral || scanProjectId) ? '' : 'disabled'}>Add ${picked.length} item${picked.length === 1 ? '' : 's'} (${money(pickedSum)}) to ${scanGeneral ? 'other purchases' : 'the project'}</button>
    </div>` : `<p class="note ok">Every item on this receipt has been added.</p>`}
    <p style="margin-top:14px"><button type="button" class="link" data-new>Done with this receipt &middot; ${scan.image ? 'scan another' : 'start another'}</button></p>`;
  const sel = $('#scanProject', box);
  if (sel) typeAhead(sel);
}

// One listener on the page for the whole check-over form, so redraws don't stack up handlers.
function scanEvents(e: Event) {
  const el = e.target as any;
  if (e.type === 'click' && el.closest?.('[data-nophoto]')) {
    if (scan?.lines.some(l => l.on && !l.added) && !confirm('Some ticked items haven\'t been added to a project yet. Start over anyway?')) return;
    return startByHand();
  }
  if (e.type === 'click' && el.closest?.('[data-byhand]')) return startByHand(scanFailed);
  if (!scan || !el.closest?.('#scanBox')) return;
  if (e.type === 'input' || e.type === 'change') {
    if (el.dataset.scan) {
      scan[el.dataset.scan] = el.value;
      // Once filed, a change to the store, date or notes is saved straight away.
      if (e.type === 'change' && scan.filed) fileReceipt(scan).catch(error => toast(`Not saved: ${serverSaid(error)}`));
      return;
    }
    if (el.id === 'scanGeneral') { if (e.type === 'change') { scanGeneral = el.checked; renderScan(); } return; }
    if (el.id === 'scanProject') { scanProjectId = Number(el.value); if (e.type === 'change') renderScan(); return; }
    const line = scan.lines[el.dataset.i];
    if (!line) return;
    if (el.dataset.k === 'on') line.on = el.checked;
    else if (el.dataset.k === 'amount') line.amount = el.value === '' ? '' : cents(num(el.value));
    else line.description = el.value;
    if (e.type !== 'change') return;
    if (el.dataset.k === 'on') return renderScan();
    // Redraw once focus has moved on, then put it back where it went (as the labor panel does).
    setTimeout(() => {
      const f = (document.activeElement as HTMLElement)?.dataset;
      renderScan();
      if (f?.i !== undefined && f.k) $(`#scanBox [data-i="${f.i}"][data-k="${f.k}"]`)?.focus();
    });
    return;
  }
  const btn = el.closest('button');
  if (!btn) return;
  if (btn.dataset.all) scan.lines.forEach(l => { if (!l.added) l.on = btn.dataset.all === '1'; });
  else if (btn.dataset.remove) scan.lines.splice(Number(btn.dataset.remove), 1);
  else if (btn.dataset.addline !== undefined) {
    scan.lines.push({ description: '', qty: 1, amount: '', on: true });
    renderScan();
    $(`#scanBox [data-i="${scan.lines.length - 1}"][data-k="description"]`)?.focus();
    return;
  } else if (btn.dataset.new !== undefined) {
    if (scan.lines.some(l => l.on && !l.added) && !confirm('Some ticked items haven\'t been added to a project yet. Start over anyway?')) return;
    scan = null;
    $('#scanBox').innerHTML = '';
    return;
  } else if (btn.id === 'scanAdd') { addScanned(); return; }
  renderScan();
}
view.addEventListener('click', scanEvents);
view.addEventListener('input', scanEvents);
view.addEventListener('change', scanEvents);

// Files the receipt (its photo, if not kept yet, then store, date and total) before its lines go on
// the project, so every purchase on a project has its receipt on file.
async function fileReceipt(r) {
  if (r.image && !r.kept) {
    await api('/api/receipts/photo', { id: r.id, image: r.image });
    r.kept = true;
  }
  const lineSum = cents(r.lines.reduce((n, l) => n + num(l.amount), 0));
  const tax = cents(r.lines.filter(l => l.tax || /^sales tax$/i.test(String(l.description).trim())).reduce((n, l) => n + num(l.amount), 0)) || num(r.tax);
  await api('/api/receipts', { id: r.id, store: r.store, date: r.date, total: r.total || lineSum, tax, notes: r.notes || '', general: r.general || [] });
  r.filed = true;
  receiptLog = null;   // the list is out of date now
}

let filing = false;
const lineId = () => `m${Date.now().toString(36)}${(purchaseSeq++).toString(36)}`;
async function addScanned() {
  const general = scanGeneral;
  const p = general ? null : store.projects.find(x => x.id === scanProjectId);
  const lines = scan.lines.filter(l => l.on && !l.added && String(l.description).trim());
  if ((!general && !p) || !lines.length || filing) return;
  const r = scan;
  filing = true;
  const btn = $('#scanAdd');
  if (btn) { btn.disabled = true; btn.textContent = 'Saving the receipt…'; }
  // Lines not for a project are kept with the receipt itself, so they're saved with it.
  const before = r.general || [];
  if (general) r.general = [...before, ...lines.map(l => ({ id: lineId(), item: String(l.description).trim(), qty: l.qty || 1, amount: cents(num(l.amount)) }))];
  try { await fileReceipt(r); }
  catch (error) {
    filing = false;
    r.general = before;
    toast(`The receipt couldn't be saved, so nothing was added: ${serverSaid(error)}`);
    renderScan();
    return;
  }
  filing = false;
  if (general) {
    for (const l of lines) { l.added = 'other purchases'; l.on = false; }
    toast(`Added ${lines.length} item${lines.length === 1 ? '' : 's'} to other purchases.`);
    if (scan === r) renderScan();
    return;
  }
  for (const l of lines) {
    purchasesOf(p).push({ id: lineId(), date: r.date, store: String(r.store).trim(),
      item: String(l.description).trim(), qty: l.qty || 1, amount: cents(num(l.amount)), receipt: r.id });
    l.added = projectName(p);
    l.on = false;
  }
  p.updated_at = new Date().toISOString();
  persist();
  toast(`Added ${lines.length} item${lines.length === 1 ? '' : 's'} to ${projectName(p)}. Spent so far: ${money(spentOn(p))}${budgetFor(p) ? ` of ${money(budgetFor(p))}` : ''}`);
  if (scan === r) renderScan();
}

// The "Material purchases" card on a project's page.
function renderPurchasesCard(p) {
  const card = $('#purchasesCard');
  if (!card) return;
  const list = [...(p.data.purchases || [])].sort((a, b) => (b.date || '').localeCompare(a.date || ''));
  const spent = spentOn(p), budget = budgetFor(p);
  card.innerHTML = `<h2>Purchases</h2>
    ${list.length ? `<ul class="purchases">${list.map(x => `<li>
      <span>${esc(x.item)}<br><small class="muted">${[x.store, x.date && shortDay(x.date)].filter(Boolean).map(esc).join(' &middot; ')}</small></span>
      <span class="amt">${money(x.amount)}</span>
      <button type="button" class="link" data-unpurchase="${esc(x.id)}" aria-label="Remove ${esc(x.item)}">&times;</button>
    </li>`).join('')}</ul>
    <hr class="rule">
    <div class="tot"><b>Spent so far</b><b>${money(spent)}</b></div>
    ${budget ? `<div class="tot"><span class="${spent > budget ? 'over' : 'muted'}">${spent > budget ? 'Over budget' : 'Left in the budget'}</span><span class="${spent > budget ? 'over' : 'muted'}">${money(Math.abs(budget - spent))}</span></div>` : ''}`
    : '<p class="muted" style="margin:0 0 10px;font-size:14px">Nothing bought for this project yet.</p>'}
    <div class="actions" style="margin-top:10px"><a class="btn small" href="#/receipt/${p.id}">Scan a receipt</a><a class="btn small" href="#/p/${p.id}/summary">Costs and receipts</a></div>`;
}
view.addEventListener('click', e => {
  const btn = (e.target as HTMLElement).closest<HTMLElement>('[data-unpurchase]');
  const p = ed?.project;
  if (!btn || !p) return;
  const item = (p.data.purchases || []).find(x => x.id === btn.dataset.unpurchase);
  if (!item || !confirm(`Remove ${item.item} (${money(item.amount)}) from this project's purchases?${item.receipt ? ' The receipt photo stays on file under All receipts.' : ''}`)) return;
  p.data.purchases = p.data.purchases.filter(x => x !== item);
  p.updated_at = new Date().toISOString();
  persist();
  if (ed.redraw && $('#summary')) ed.redraw(); else { renderPurchasesCard(p); renderPanel(); }
});

// ---------- every receipt kept ----------
let receiptLog = null;   // [{ id, store, date, total, tax, has_photo, created_at }] from the server, newest first
async function loadReceipts() {
  if (!receiptLog) receiptLog = (await api('/api/receipts')).receipts;
  return receiptLog;
}
// Where each receipt's lines went: receipt id -> [{ p, lines }].
function receiptUses() {
  const uses = new Map();
  for (const p of store.projects) for (const x of p.data.purchases || []) {
    if (!x.receipt) continue;
    const list = uses.get(x.receipt) || [];
    let use = list.find(u => u.p === p);
    if (!use) list.push(use = { p, lines: [] });
    use.lines.push(x);
    uses.set(x.receipt, list);
  }
  return uses;
}

// A photo, full screen. Tap anywhere (or press Escape) to close it.
function showPhoto(src, caption = '', id = '') {
  const box = document.createElement('div');
  box.className = 'photoview';
  box.innerHTML = `<img src="${esc(src)}" alt="${esc(caption || 'Receipt photo')}"><div class="cap">${esc(caption)} <a href="${esc(src)}" target="_blank" rel="noopener">Open on its own</a> &middot; tap to close</div>
    ${id ? '<div class="photoacts"><button type="button" class="btn small" data-act="replace">Replace photo</button><button type="button" class="btn small" data-act="remove">Remove photo</button></div>' : ''}`;
  const close = () => { box.remove(); document.removeEventListener('keydown', onKey); };
  const onKey = (e: KeyboardEvent) => { if (e.key === 'Escape') close(); };
  box.addEventListener('click', e => {
    const t = e.target as HTMLElement;
    if (t.closest('a')) return;
    const act = t.closest<HTMLElement>('[data-act]')?.dataset.act;
    if (act === 'replace') {
      // The wrong photo was kept: pick (or take) the right one, and it takes this one's place.
      pickPhoto(file => { close(); addReceiptPhoto(id, file); });
      return;
    }
    if (act === 'remove') {
      if (!confirm('Remove this photo from the receipt? The receipt and its lines stay; you can add another photo after.')) return;
      close();
      removeReceiptPhoto(id);
      return;
    }
    close();
  });
  document.addEventListener('keydown', onKey);
  document.body.append(box);
}
view.addEventListener('click', e => {
  const t = (e.target as HTMLElement).closest<HTMLElement>('[data-photo-id]');
  if (!t) return;
  e.preventDefault();
  showPhoto((t as HTMLAnchorElement).getAttribute('href') || photoUrl(t.dataset.photoId), t.dataset.caption, t.dataset.photoId);
});
// A receipt from before photos were kept has none: show a note in its place.
view.addEventListener('error', e => {
  const img = e.target as HTMLElement;
  if (img.tagName !== 'IMG' || !img.classList.contains('rthumb')) return;
  const holder = img.closest('[data-photo-id]');
  const id = (holder as HTMLElement)?.dataset.photoId;
  const box = document.createElement(id ? 'button' : 'span');
  box.className = id ? 'nophoto addphoto' : 'nophoto';
  box.innerHTML = id ? ADD_PHOTO_INNER : 'No photo kept';
  if (id) Object.assign(box, { type: 'button', title: ADD_PHOTO_TITLE }).dataset.addphoto = id;
  (holder || img).replaceWith(box);
}, true);

// The box shown in place of a missing receipt photo: a camera and "Add photo" (dragging one in is in the tooltip).
const ADD_PHOTO_TITLE = 'No photo kept. Tap to add one, or drag a photo here.';
const ADD_PHOTO_INNER = '<svg viewBox="0 0 24 24" width="22" height="22" fill="none" stroke="currentColor" stroke-width="1.8" stroke-linecap="round" stroke-linejoin="round" aria-hidden="true"><path d="M4 8h3l2-3h6l2 3h3v11H4z"/><circle cx="12" cy="13" r="3.5"/></svg><span>Add photo</span>';
const addPhotoButton = (id: string) => `<button type="button" class="nophoto addphoto" data-addphoto="${esc(id)}" title="${ADD_PHOTO_TITLE}" aria-label="Add a photo of this receipt">${ADD_PHOTO_INNER}</button>`;

// A receipt with no photo (scanned before photos were kept, or typed in): tap its box to pick one from the
// phone's photos (or take one), or drag a photo onto it on a computer.
async function addReceiptPhoto(id: string, file: File, btn?: HTMLElement) {
  if (!file.type.startsWith('image/') && !/\.(jpe?g|png|webp|heic)$/i.test(file.name)) { toast('That file isn\'t a photo. Use a JPG or PNG.'); return; }
  if (btn) btn.innerHTML = 'Saving&hellip;'; else toast('Saving the photo…');
  try {
    const image = await shrinkPhoto(file);
    // What's known about the receipt (from its lines, for one scanned before receipts were kept), so it's listed properly.
    const r = withOldReceipts([...await loadReceipts()], receiptUses()).find(x => x.id === id);
    await api('/api/receipts/photo', { id, image });
    if (r) await api('/api/receipts', { id, store: r.store, date: r.date, total: r.total, tax: r.tax, notes: r.notes || '' });
    receiptLog = null;
    toast('Photo saved with the receipt.');
  } catch (error) {
    toast(`The photo couldn't be saved: ${serverSaid(error)}`);
  }
  redrawReceipts();
}
// Redraw where we are (All receipts, or a project's Summary), without jumping back to the top.
function redrawReceipts() {
  if (currentHash.startsWith('#/receipts')) showReceiptLog(currentHash.split('/')[2] || '');
  else if (ed?.redraw && $('#summary')) loadReceipts().then(() => ed?.redraw?.()).catch(() => {});
}
async function removeReceiptPhoto(id: string) {
  try {
    await api(`/api/receipts/${encodeURIComponent(id)}/photo/delete`, {});
    receiptLog = null;
    toast('Photo removed. Tap Add photo to put the right one on.');
  } catch (error) {
    toast(`The photo couldn't be removed: ${serverSaid(error)}`);
  }
  redrawReceipts();
}
// The phone's photo picker (or camera); a file chooser on a computer.
function pickPhoto(then: (file: File) => void) {
  const input = Object.assign(document.createElement('input'), { type: 'file', accept: 'image/*' });
  input.addEventListener('change', () => { const file = input.files?.[0]; if (file) then(file); });
  input.click();
}
view.addEventListener('click', e => {
  const btn = (e.target as HTMLElement).closest<HTMLElement>('[data-addphoto]');
  if (!btn) return;
  pickPhoto(file => addReceiptPhoto(btn.dataset.addphoto, file, btn));
});
const dropTarget = (e: DragEvent) => (e.target as HTMLElement).closest?.<HTMLElement>('[data-addphoto]');
view.addEventListener('dragover', (e: DragEvent) => {
  const btn = dropTarget(e);
  if (!btn) return;
  e.preventDefault();
  e.dataTransfer.dropEffect = 'copy';
  btn.classList.add('over');
});
view.addEventListener('dragleave', (e: DragEvent) => dropTarget(e)?.classList.remove('over'));
view.addEventListener('drop', (e: DragEvent) => {
  const btn = dropTarget(e);
  if (!btn) return;
  e.preventDefault();
  btn.classList.remove('over');
  const file = e.dataTransfer.files?.[0];
  if (file) addReceiptPhoto(btn.dataset.addphoto, file, btn);
});

const yearOf = r => (r.date || r.created_at || '').slice(0, 4);

// The receipts kept, plus ones scanned before photos were kept (only named by their lines on projects).
function withOldReceipts(log, uses) {
  const filed = new Set(log.map(r => r.id));
  return [...log, ...[...uses].filter(([id]) => !filed.has(id)).map(([id, used]) => {
    const first = used[0].lines[0];
    return { id, store: first.store, date: first.date, has_photo: false, created_at: '', notes: '', general: [], old: true,
      total: cents(used.reduce((n, u) => n + u.lines.reduce((m, x) => m + num(x.amount), 0), 0)),
      tax: cents(used.reduce((n, u) => n + u.lines.filter(x => /^sales tax$/i.test(x.item)).reduce((m, x) => m + num(x.amount), 0), 0)) };
  })].sort((a, b) => (b.date || '').localeCompare(a.date || ''));
}

async function showReceiptLog(year) {
  view.innerHTML = `<a href="#/receipt" class="back">&larr; Scan a receipt</a>
    <div class="pagehead"><h1>All receipts</h1></div><div class="card"><p class="muted">Loading&hellip;</p></div>`;
  let log;
  try { log = [...await loadReceipts()]; }
  catch (error) { $('.card', view).innerHTML = `<p class="note err">${esc(serverSaid(error))}</p>`; return; }
  if (!currentHash.startsWith('#/receipts')) return;   // moved on while loading
  const uses = receiptUses();
  log = withOldReceipts(log, uses);
  const years = [...new Set(log.map(yearOf).filter(Boolean))].sort().reverse();
  const shown = year ? log.filter(r => yearOf(r) === year) : log;
  const sum = (list, f) => cents(list.reduce((n, x) => n + num(f(x)), 0));
  const generalSum = list => sum(list, r => sum(r.general || [], l => l.amount));
  view.innerHTML = `<a href="#/receipt" class="back">&larr; Scan a receipt</a>
    <div class="pagehead"><h1>All receipts</h1></div>
    <div class="card" id="exportCard"></div>
    <nav class="tabs"><a href="#/receipts" class="${year ? '' : 'on'}">All</a>${years.map(y => `<a href="#/receipts/${y}" class="${y === year ? 'on' : ''}">${y}</a>`).join('')}</nav>
    <div class="card">
      ${shown.length ? `<div class="tot grand" style="margin-top:0;border-top:0;padding-top:0"><span>${shown.length} receipt${shown.length === 1 ? '' : 's'}${year ? ` in ${year}` : ''}</span><span>${money(sum(shown, r => r.total))}</span></div>
      <div class="tot"><span class="muted">Sales tax paid</span><span class="muted">${money(sum(shown, r => r.tax))}</span></div>
      ${generalSum(shown) ? `<div class="tot"><span class="muted">Not for a project</span><span class="muted">${money(generalSum(shown))}</span></div>` : ''}
      <ul class="rlog">${shown.map(r => {
        const used = uses.get(r.id) || [];
        return `<li>
          ${r.has_photo ? `<a href="${photoUrl(r.id, r.photo_v)}" class="thumb" data-photo-id="${esc(r.id)}" data-caption="${esc([r.store, r.date && fmtDate(r.date)].filter(Boolean).join(', '))}"><img class="rthumb" loading="lazy" src="${photoUrl(r.id, r.photo_v)}" alt="Receipt photo"></a>` : addPhotoButton(r.id)}
          <div class="rinfo"><b>${esc(r.store || 'Store not given')}</b> <span class="muted">${esc(r.date ? fmtDate(r.date) : '')}</span>
            ${r.notes ? `<div class="rnote">${esc(r.notes)}</div>` : ''}
            <div class="rprojects">${used.map(u => `<a href="#/p/${u.p.id}/summary">${esc(projectName(u.p))}</a> ${money(sum(u.lines, x => x.amount))}`).join(' &middot; ')}
              ${!used.length && !(r.general || []).length ? `<span class="muted">Not on any project.</span> <button type="button" class="link" data-delreceipt="${esc(r.id)}" style="color:var(--bad)">Delete</button>` : ''}</div>
            ${(r.general || []).length ? `<div class="rgeneral"><b>Not for a project</b><ul class="purchases">${r.general.map(l => `<li><span>${esc(l.item)}</span><span class="amt">${money(l.amount)}</span>
              <button type="button" class="link" data-ungeneral="${esc(r.id)}:${esc(l.id)}" aria-label="Remove ${esc(l.item)}">&times;</button></li>`).join('')}</ul></div>` : ''}
            ${r.old ? '' : `<button type="button" class="link rnotebtn" data-renote="${esc(r.id)}">${r.notes ? 'Edit notes' : 'Add notes'}</button>`}</div>
          <span class="amt">${money(r.total)}</span>
        </li>`;
      }).join('')}</ul>` : '<p class="muted" style="margin:0">No receipts kept yet. Scan one and its photo is kept here.</p>'}
    </div>
    <p class="muted" style="font-size:13px">Every receipt photo scanned is kept, even ones with no lines added to a project, for returns and warranties.</p>`;
  renderExportCard();
  // Notes and lines not for a project are saved on the receipt itself.
  const resave = async (r, change) => {
    try { await api('/api/receipts', { ...r, ...change }); }
    catch (error) { toast(`Not saved: ${serverSaid(error)}`); return; }
    receiptLog = null;
    showReceiptLog(year);
  };
  view.querySelectorAll('[data-renote]').forEach(b => b.addEventListener('click', () => {
    const r = log.find(x => x.id === b.dataset.renote);
    const notes = r && prompt('Notes: what was bought and why', r.notes || '');
    if (notes != null && r) resave(r, { notes });
  }));
  view.querySelectorAll('[data-ungeneral]').forEach(b => b.addEventListener('click', () => {
    const [id, lineId] = b.dataset.ungeneral.split(':');
    const r = log.find(x => x.id === id), line = r?.general.find(l => l.id === lineId);
    if (!line || !confirm(`Remove ${line.item} (${money(line.amount)}) from this receipt's other purchases? The receipt stays on file.`)) return;
    resave(r, { general: r.general.filter(l => l !== line) });
  }));
  view.querySelectorAll('[data-delreceipt]').forEach(b => b.addEventListener('click', async () => {
    if (!confirm('Delete this receipt and its photo? This cannot be undone.')) return;
    try { await api(`/api/receipts/${encodeURIComponent(b.dataset.delreceipt)}/delete`, {}); }
    catch (error) { toast(serverSaid(error)); return; }
    receiptLog = null;
    showReceiptLog(year);
  }));
}

// ---------- Excel export of what's been spent ----------
// Everything bought in a span of dates, in one workbook: each project's budget and spending, each
// receipt, and each line with the project it went to.
const day = iso => String(iso || '').slice(0, 10);
const $c = (v, s): Cell => (v === '' || v == null ? null : { v, s });

async function exportCosts(from, to) {
  const inRange = d => !!d && d >= from && d <= to;
  const uses = receiptUses();
  const log = withOldReceipts([...await loadReceipts()], uses);
  const photo = r => r.has_photo ? { link: `${location.origin}${photoUrl(r.id)}`, text: 'Photo' } : 'No photo';
  // A project is in the export if something was bought for it in the span, or it was being worked on then.
  const projects = store.projects.filter(p => (p.data.purchases || []).some(x => inRange(x.date))
    || (day(p.created_at) <= to && (!archived(p) || day(finishedAt(p)) >= from))).sort((a, b) => a.created_at.localeCompare(b.created_at));

  const summary: Cell[][] = [['Project', 'Stream', 'Room or area', 'Status', 'Started', 'Finished', 'Budget', 'Spent (all time)', 'Spent in these dates', 'Left in budget', 'Hours worked', 'Link']];
  const all = { budget: 0, spent: 0, inSpan: 0, hours: 0 };
  for (const p of projects) {
    const t = totals(p), inSpan = cents((p.data.purchases || []).filter(x => inRange(x.date)).reduce((n, x) => n + num(x.amount), 0));
    summary.push([projectName(p), STREAM_NAME[streamOf(p)], p.data.area || '', STATUS_NAME[p.status] || p.status,
      $c(day(p.created_at), 'date'), $c(archived(p) ? day(finishedAt(p)) : '', 'date'), t.budget ? $c(t.budget, 'money') : null,
      $c(t.spent, 'money'), $c(inSpan, 'money'), t.budget ? $c(t.left, 'money') : null, t.hours ? $c(t.hours, 'hours') : null,
      { link: `${location.origin}/#/p/${p.id}/summary`, text: 'Costs' }]);
    all.budget += t.budget; all.spent += t.spent; all.inSpan += inSpan; all.hours += t.hours;
  }
  if (projects.length) summary.push([{ v: 'Total', s: 'bold' }, null, null, null, null, null, $c(cents(all.budget), 'boldmoney'),
    $c(cents(all.spent), 'boldmoney'), $c(cents(all.inSpan), 'boldmoney'), null, all.hours ? $c(all.hours, 'hours') : null]);

  const receipts: Cell[][] = [['Date', 'Store', 'Total', 'Sales tax', 'Project', 'Items', 'Notes', 'Photo']];
  for (const r of [...log].reverse().filter(r => inRange(r.date))) {
    const used = uses.get(r.id) || [], general = r.general || [];
    const items = [...used.flatMap(u => u.lines.map(l => l.item)), ...general.map(l => l.item)].filter(i => !/^sales tax$/i.test(i));
    const where = used.length + (general.length ? 1 : 0) > 1 ? 'Split: see Lines' : used.length ? projectName(used[0].p) : general.length ? 'Not for a project' : '';
    receipts.push([$c(r.date, 'date'), r.store, $c(r.total, 'money'), $c(r.tax, 'money'), where, items.join('; ').slice(0, 1000), r.notes || '', photo(r)]);
  }

  const known = new Map(log.map(r => [r.id, r]));
  const lines: Cell[][] = [['Date', 'Store', 'Item', 'Amount', 'Project', 'Stream', 'Receipt notes', 'Photo']];
  const allLines = [
    ...store.projects.flatMap(p => (p.data.purchases || []).filter(x => inRange(x.date)).map(x => ({ p, x }))),
    ...log.filter(r => inRange(r.date)).flatMap(r => (r.general || []).map(l => ({ p: null, x: { ...l, date: r.date, store: r.store, receipt: r.id } }))),
  ].sort((a, b) => a.x.date.localeCompare(b.x.date) || String(a.x.receipt).localeCompare(String(b.x.receipt)));
  for (const { p, x } of allLines) {
    const r = known.get(x.receipt);
    lines.push([$c(x.date, 'date'), x.store, x.item, $c(num(x.amount), 'money'), p ? projectName(p) : 'Not for a project',
      p ? STREAM_NAME[streamOf(p)] : '', r?.notes || '', r ? photo(r) : 'Typed in']);
  }

  const sheets: Sheet[] = [
    { name: 'Projects', rows: summary, widths: [30, 18, 18, 12, 11, 11, 12, 14, 14, 13, 10, 10] },
    { name: 'Receipts', rows: receipts, widths: [11, 28, 12, 11, 30, 60, 50, 10] },
    { name: 'Lines', rows: lines, widths: [11, 28, 44, 12, 30, 18, 50, 10] },
  ];
  const a = Object.assign(document.createElement('a'), { href: URL.createObjectURL(workbook(sheets)), download: `home-projects-costs-${from}-to-${to}.xlsx` });
  document.body.append(a);
  a.click();
  a.remove();
  setTimeout(() => URL.revokeObjectURL(a.href), 1000);
  return { projects: projects.length, receipts: receipts.length - 1 };
}

// The export's card on the All receipts page: a span of dates, with quick picks for this year and last.
let exFrom = '', exTo = '';
function renderExportCard() {
  const card = $('#exportCard');
  if (!card) return;
  const now = new Date(), y = now.getFullYear();
  exFrom ||= `${y}-01-01`;
  exTo ||= ymd(now);
  card.innerHTML = `<h2>Download spending as Excel</h2>
    <p class="muted" style="margin:0 0 10px;font-size:14px">Each project's budget and spending, every receipt, and every line with the project it went to, for the dates you pick.</p>
    <div class="qbrange">
      <label class="f"><span>From</span><input type="date" id="exFrom" value="${esc(exFrom)}"></label>
      <label class="f"><span>To</span><input type="date" id="exTo" value="${esc(exTo)}"></label>
    </div>
    <p style="margin:8px 0 0;font-size:13px"><button type="button" class="link" data-span="${y}">This year</button> &middot;
      <button type="button" class="link" data-span="${y - 1}">Last year</button></p>
    <div class="actions" style="margin-top:12px"><button type="button" class="btn primary" id="exGo">Download Excel file</button><span class="muted" id="exSaid" style="font-size:13px"></span></div>`;
  card.addEventListener('change', e => {
    const el = e.target as HTMLInputElement;
    if (el.id === 'exFrom') exFrom = el.value; else if (el.id === 'exTo') exTo = el.value;
  });
  card.addEventListener('click', async e => {
    const btn = (e.target as HTMLElement).closest('button');
    if (!btn) return;
    if (btn.dataset.span) {
      exFrom = `${btn.dataset.span}-01-01`; exTo = `${btn.dataset.span}-12-31`;
      ($('#exFrom') as HTMLInputElement).value = exFrom;
      ($('#exTo') as HTMLInputElement).value = exTo;
      return;
    }
    if (btn.id !== 'exGo') return;
    const said = $('#exSaid');
    if (!exFrom || !exTo || exFrom > exTo) { said.textContent = 'Pick a From date on or before the To date.'; return; }
    btn.disabled = true;
    said.textContent = 'Making the file…';
    try {
      const n = await exportCosts(exFrom, exTo);
      said.textContent = `Downloaded: ${n.projects} project${n.projects === 1 ? '' : 's'}, ${n.receipts} receipt${n.receipts === 1 ? '' : 's'}.`;
    } catch (error) { said.textContent = `Couldn't make the file: ${serverSaid(error)}`; }
    btn.disabled = false;
  });
}

// ---------- project costs: budget against what was spent ----------
// What the project has cost so far against its budget, receipt by receipt, and the hours put in (typed
// in: data.hours_worked).
function showSummary(p) {
  ed = { project: p, stream: streamOf(p), data: p.data, dirty: false };
  view.innerHTML = `${projectHeader(p, 'summary', '<button class="btn small" onclick="window.print()">Print / save as PDF</button>')}
    <div class="printhead"><h1>${esc(projectName(p))}</h1><div class="muted">${STREAM_NAME[streamOf(p)]}${p.data.area ? ` &middot; ${esc(p.data.area)}` : ''} &middot; Costs as of ${esc(fmtDate(new Date().toISOString()))}</div></div>
    <div class="cols" id="summary">
      <div><div class="card" id="pnl"></div></div>
      <aside><div class="card" id="receiptsCard"></div></aside>
    </div>`;
  const touch = () => { p.updated_at = new Date().toISOString(); persist(); };
  const pnl = $('#pnl');
  const renderPnl = () => {
    const t = totals(p);
    p.calc = t;
    const receipts = new Set((p.data.purchases || []).map(x => x.receipt || x.id)).size, lines = (p.data.purchases || []).length;
    // Spending by month, so a long project shows where the money went when.
    const months = new Map();
    for (const x of p.data.purchases || []) { const m = (x.date || '').slice(0, 7) || 'No date'; months.set(m, (months.get(m) || 0) + num(x.amount)); }
    const monthRows = [...months].sort((a, b) => a[0].localeCompare(b[0]));
    pnl.innerHTML = `<h2>Budget and spending</h2>
      <div class="tot"><span>Spent so far <small>${lines} item${lines === 1 ? '' : 's'} from ${receipts} receipt${receipts === 1 ? '' : 's'}, tax included</small></span><b>${money(t.spent)}</b></div>
      ${t.budget ? `<div class="tot"><span class="muted">Budget</span><span class="muted">${money(t.budget)}</span></div>
        <div class="meter ${t.spent > t.budget ? 'over' : ''}" aria-hidden="true"><span style="width:${Math.min(100, Math.round(t.spent / t.budget * 100))}%"></span></div>
        <div class="tot grand ${t.spent > t.budget ? 'loss' : 'profit'}"><span>${t.spent > t.budget ? 'Over budget' : 'Left to spend'}</span><span>${money(Math.abs(t.left))}</span></div>
        <div class="tot"><span class="muted">Used</span><span class="muted">${Math.round(t.spent / t.budget * 100)}%</span></div>` : ''}
      ${monthRows.length > 1 ? `<div class="pl-sec">By month</div>${monthRows.map(([m, n]) => `<div class="tot"><span>${m === 'No date' ? m : esc(new Date(m + '-01T00:00').toLocaleDateString(undefined, { month: 'long', year: 'numeric' }))}</span><span>${money(n)}</span></div>`).join('')}` : ''}
      <div class="pl-sec">Time</div>
      <div class="tot"><span>Hours worked</span><b>${t.hours ? hrs(t.hours) : '<span class="muted">not entered</span>'}</b></div>
      <hr class="rule">
      <div class="grid noprint">
        <label class="f w3"><span>Budget ($)</span><input type="number" min="0" step="any" inputmode="decimal" id="budget" value="${esc(p.data.budget ?? '')}" placeholder="No budget set"></label>
        <label class="f w3"><span>Total hours worked</span><input type="number" min="0" step="0.25" inputmode="decimal" id="hoursWorked" value="${esc(p.data.hours_worked ?? '')}" placeholder="e.g. 12.5"></label>
      </div>`;
  };
  pnl.addEventListener('change', e => {
    const el = e.target as HTMLInputElement;
    if (el.id === 'hoursWorked') p.data.hours_worked = el.value === '' ? '' : pos(el.value);
    else if (el.id === 'budget') p.data.budget = el.value === '' ? '' : cents(pos(el.value));
    else return;
    touch();
    renderPnl();
  });

  const renderReceipts = () => {
    const card = $('#receiptsCard');
    const groups = new Map();
    for (const x of p.data.purchases || []) {
      const key = x.receipt || `hand:${x.id}`;
      if (!groups.has(key)) groups.set(key, { id: x.receipt, store: x.store, date: x.date, lines: [] });
      groups.get(key).lines.push(x);
    }
    const list = [...groups.values()].sort((a, b) => (b.date || '').localeCompare(a.date || ''));
    const known = new Map<string, any>((receiptLog || []).map(r => [r.id, r]));
    card.innerHTML = `<h2>Receipts</h2>
      ${list.length ? `<ul class="rgroups">${list.map(g => {
        const r = known.get(g.id), mine = cents(g.lines.reduce((n, x) => n + num(x.amount), 0));
        const caption = [g.store, g.date && fmtDate(g.date)].filter(Boolean).join(', ');
        const photo = g.id && (!receiptLog || r?.has_photo)
          ? `<a href="${photoUrl(g.id, r?.photo_v)}" class="thumb" data-photo-id="${esc(g.id)}" data-caption="${esc(caption)}"><img class="rthumb" loading="lazy" src="${photoUrl(g.id, r?.photo_v)}" alt="Receipt photo"></a>`
          : g.id ? addPhotoButton(g.id) : '<span class="nophoto">Typed in</span>';
        return `<li>${photo}<div class="rinfo">
          <div class="rtop"><b>${esc(g.store || 'Store not given')}</b><span class="muted">${esc(g.date ? fmtDate(g.date) : '')}</span></div>
          <ul class="purchases">${g.lines.map(x => `<li><span>${esc(x.item)}</span><span class="amt">${money(x.amount)}</span>
            <button type="button" class="link noprint" data-unpurchase="${esc(x.id)}" aria-label="Remove ${esc(x.item)}">&times;</button></li>`).join('')}</ul>
          ${r?.notes ? `<div class="rnote">${esc(r.notes)}</div>` : ''}
          ${r && r.total && Math.abs(r.total - mine) >= 0.01 ? `<small class="muted">Receipt total ${money(r.total)}; ${money(mine)} of it is on this project.</small>` : ''}
        </div></li>`;
      }).join('')}</ul>
      <div class="tot grand"><span>Total spent</span><span>${money(spentOn(p))}</span></div>`
      : '<p class="muted" style="margin:0 0 10px;font-size:14px">No receipts on this project yet.</p>'}
      <div class="actions noprint" style="margin-top:10px"><a class="btn small primary" href="#/receipt/${p.id}">Scan a receipt</a><a class="btn small" href="#/receipts">All receipts</a></div>`;
  };
  ed.redraw = () => { renderPnl(); renderReceipts(); };
  ed.redraw();
  // Which receipts have photos (and their printed totals) come from the server.
  loadReceipts().then(() => { if (ed?.project === p && $('#summary')) renderReceipts(); }).catch(() => {});
}

// ---------- design notes ----------
const NOTE_KINDS = ['Idea', 'Measurements', 'Store visit', 'Contractor or quote', 'Research', 'Other'];

// Web addresses typed into a note, as links that open in a new tab.
const linksHtml = text => (String(text).match(/https?:\/\/[^\s<>"]+/g) || [])
  .map(url => url.replace(/[.,;:!?)\]]+$/, ''))
  .map(url => `<a href="${esc(url)}" target="_blank" rel="noopener">${esc(url)}</a>`).join('');

function showDesign(p) {
  const design = p.data.design ??= { brief: '', notes: [] };
  const touch = () => { p.updated_at = new Date().toISOString(); persist(); };
  const render = () => {
    // Newest first; entries added on the same day keep the latest on top.
    const order = design.notes.map((_, i) => i).sort((a, b) => design.notes[b].date.localeCompare(design.notes[a].date) || b - a);
    view.innerHTML = `
      ${projectHeader(p, 'design', '<span class="muted">Changes save automatically</span>')}
      <div class="design">
        <div class="card"><h2>Design brief</h2>
          <textarea class="brief" id="brief" placeholder="The current picture of what you want: how it will be used, the look and inspiration, the space it's going into, must-haves, budget and timing.">${esc(design.brief)}</textarea>
          <div class="links" id="briefLinks">${linksHtml(design.brief)}</div>
        </div>
        <div class="card" id="entries">
          <div class="actions"><h2 style="margin:0">Ideas &amp; research</h2><span class="spacer" style="flex:1"></span>
            <button class="btn primary small" data-act="add">+ Add note</button></div>
          ${order.length ? '' : '<p class="muted" style="margin:12px 0 0">No notes yet. Add ideas, measurements, quotes and links as you go.</p>'}
          <div style="margin-top:12px">${order.map(i => `<div class="entry">
            <div class="actions">
              <input type="date" data-i="${i}" data-k="date" value="${esc(design.notes[i].date)}" aria-label="Date">
              <select data-i="${i}" data-k="kind" aria-label="Type of note">${[...new Set([...NOTE_KINDS, design.notes[i].kind])].map(k =>
                `<option ${k === design.notes[i].kind ? 'selected' : ''}>${esc(k)}</option>`).join('')}</select>
              <span class="spacer"></span><button class="link" data-act="remove" data-i="${i}">remove</button>
            </div>
            <textarea data-i="${i}" data-k="text" placeholder="What was discussed, decided or found. Paste links to photos or files and they become clickable below." aria-label="Note">${esc(design.notes[i].text)}</textarea>
            <div class="links" data-links="${i}">${linksHtml(design.notes[i].text)}</div>
          </div>`).join('')}</div>
        </div>
      </div>`;
    $('#brief').addEventListener('input', e => { design.brief = e.target.value; $('#briefLinks').innerHTML = linksHtml(design.brief); touch(); });
    const entries = $('#entries');
    entries.addEventListener('input', e => {
      const { i, k } = e.target.dataset;
      if (i === undefined) return;
      design.notes[i][k] = e.target.value;
      if (k === 'text') $(`[data-links="${i}"]`).innerHTML = linksHtml(e.target.value);
      touch();
    });
    entries.addEventListener('click', e => {
      const act = e.target.dataset.act;
      if (act === 'add') {
        design.notes.push({ date: ymd(new Date()), kind: NOTE_KINDS[0], text: '' });
      } else if (act === 'remove') {
        const note = design.notes[e.target.dataset.i];
        if (note.text.trim() && !confirm('Remove this note?')) return;
        design.notes.splice(e.target.dataset.i, 1);
      } else return;
      touch();
      render();
      if (act === 'add') $(`textarea[data-i="${design.notes.length - 1}"]`).focus();
    });
  };
  render();
}

// ---------- cut list ----------
// The pieces of lumber to cut for a project, as a checklist on its own Cut list tab (#/p/<id>/cuts), kept in its data as
// data.cutlist = { items, source }. Each item is { id, part, qty, t, w, l, species, done_at } with sizes
// in inches (thickness <= width <= length), or just a part with no sizes for a line typed without them.
// The list can be filled from a SketchUp model (.skp) or an OpenCutList CSV dropped onto the card: the
// file is read here in the browser (see skp.ts), shown for a check, then added. Pieces can also be typed.
const cutListCard = () => `<div class="card cutlist" id="cutlist">
  <div class="actions"><h2 style="margin:0">Cut list</h2><span class="spacer" style="flex:1"></span><span class="muted cutsum" id="cutSum"></span></div>
  <label class="cutdrop" id="cutDrop"><input type="file" id="cutFile" hidden>
    <b>Add from SketchUp</b><span class="muted">Drop a .skp model here, or tap to pick one. An OpenCutList CSV works too.</span></label>
  <div id="cutReview"></div>
  <form class="addtask" id="cutAdd" autocomplete="off"><textarea rows="1" enterkeyhint="done" placeholder="Add a piece, e.g. Shelf 3/4 x 10 x 30 (2)" aria-label="New piece to cut"></textarea><button class="btn primary">Add</button></form>
  <ul class="tasks cuts" id="cutItems"></ul>
  <p class="muted hint">Sizes are thickness &times; width &times; length in inches, as cut. Tap a piece once it's cut. Paste several lines to add them all.</p>
</div>`;

function showCuts(p) {
  view.innerHTML = `${projectHeader(p, 'cuts', '<span class="muted">Changes save automatically</span>')}
    <div class="design">${cutListCard()}</div>`;
  wireCutList(p);
}

const bdFt = x => x.t && x.w && x.l ? x.t * x.w * x.l * (x.qty || 1) / 144 : 0;
const cutDims = x => x.l ? `${fmtInches(x.t)} × ${fmtInches(x.w)} × ${fmtInches(x.l)}` : '';
// Thickest stock first, then widest and longest, so a board can be milled once for every piece from it.
const cutOrder = (a, b) => (b.l ? 1 : 0) - (a.l ? 1 : 0) || (b.t || 0) - (a.t || 0) || (b.w || 0) - (a.w || 0) || (b.l || 0) - (a.l || 0);

function wireCutList(p) {
  const list = () => (p.data.cutlist ??= { items: [], source: null });
  const species = p.data.species || '';
  const touch = () => { p.updated_at = new Date().toISOString(); persist(); };
  const tabCount = () => { const tab = $('.projtabs a.on'); if (tab) tab.innerHTML = `Cut list${cutsLeft(p) ? ` <small title="pieces left to cut">${cutsLeft(p)}</small>` : ''}`; };
  const toItem = (x: Piece) => ({ id: newTask('').id, part: x.part, qty: x.qty || 1, t: x.t, w: x.w, l: x.l, species: x.species || '', done_at: null });

  const draw = () => {
    const items = [...(p.data.cutlist?.items || [])].sort(cutOrder);
    let last = null;
    $('#cutItems').innerHTML = items.length ? items.map(x => {
      const group = x.l ? `${fmtInches(x.t)}″ thick` : 'Other';
      const head = group !== last ? `<li class="cuthead">${esc(group)}</li>` : '';
      last = group;
      const sp = x.species || species;
      return `${head}<li class="task cut ${x.done_at ? 'done' : ''}" data-id="${esc(x.id)}">
        <input type="checkbox" ${x.done_at ? 'checked' : ''} aria-label="${esc(`${x.qty} ${x.part}`)}">
        <span class="text"><b class="qty">${x.qty}×</b> ${esc(x.part)}${x.l ? ` <span class="dims">${cutDims(x)}${sp ? ` <small class="sp">${esc(sp)}</small>` : ''}</span>` : ''}</span>
        ${x.done_at ? `<span class="when">Cut ${esc(fmtDate(x.done_at))}</span>` : ''}
        <button type="button" class="x" aria-label="Remove ${esc(x.part)}" title="Remove">&times;</button>
      </li>`;
    }).join('') : '<li class="none muted">No pieces yet. Drop in a SketchUp model or type one above.</li>';
    const all = p.data.cutlist?.items || [], pieces = all.reduce((n, x) => n + (x.qty || 1), 0);
    const cut = all.filter(x => x.done_at).reduce((n, x) => n + (x.qty || 1), 0);
    const bf = all.filter(x => !x.done_at).reduce((n, x) => n + bdFt(x), 0);
    $('#cutSum').textContent = pieces ? `${cut} of ${pieces} cut${bf ? ` · ${bf.toFixed(1)} bd ft to go` : ''}` : '';
    tabCount();
  };

  // A model or CSV that's been read, waiting to be checked and added.
  let review = null;
  // "Named parts only" (remembered on this device): parts SketchUp named itself (Component#12, or anything with "Component" in it) are left
  // out, so a model full of extra bits gives just the parts that were named.
  const shownPieces = () => review.pieces.map((x, i) => ({ x, i })).filter(({ x }) => !review.namedOnly || x.named);
  const reviewTotal = () => shownPieces().filter(({ x }) => x.on).reduce((q, { x }) => q + (x.qty || 0), 0);
  const drawReview = () => {
    const box = $('#cutReview');
    if (!review) { box.innerHTML = ''; return; }
    const n = reviewTotal(), has = list().items.length, shown = shownPieces();
    const unnamed = review.pieces.filter(x => !x.named).reduce((q, x) => q + x.qty, 0);
    box.innerHTML = `<div class="cutcheck">
      <p><b>${esc(review.file)}</b>: ${esc(review.note)} Untick anything that isn't cut from lumber, and fix any counts (a copy kept off to the side in the model counts too).${review.pieces.some(x => !x.on) ? ' Flat shapes with no thickness start unticked.' : ''}</p>
      ${unnamed ? `<label class="cutnamed"><input type="checkbox" data-named ${review.namedOnly ? 'checked' : ''}>
        <span><b>Only include parts I named</b> <span class="muted">${review.namedOnly ? `${unnamed} unnamed piece${unnamed === 1 ? '' : 's'} (names with &ldquo;Component&rdquo;, Group#&hellip;) left out` : `leaves out ${unnamed} unnamed piece${unnamed === 1 ? '' : 's'} (names with &ldquo;Component&rdquo;, Group#&hellip;)`}</span></span></label>` : ''}
      <ul>${shown.map(({ x, i }) => `<li class="${x.on ? '' : 'off'}">
        <input type="checkbox" data-i="${i}" ${x.on ? 'checked' : ''} aria-label="Include ${esc(x.part)}">
        <input type="number" min="0" step="1" inputmode="numeric" data-q="${i}" value="${x.qty}" aria-label="How many ${esc(x.part)}">
        <span class="nm">${esc(x.part)}${x.species ? ` <small class="sp">${esc(x.species)}</small>` : ''}</span><span class="dims">${cutDims(x)}</span></li>`).join('')
        || '<li class="none muted">No parts in this model have names of their own. Untick the box above to see them all, or name the parts in SketchUp (Entity Info &gt; Definition) and drop it in again.</li>'}</ul>
      <div class="actions"><button type="button" class="btn primary" data-cut="add" ${n ? '' : 'disabled'}>Add ${n} piece${n === 1 ? '' : 's'}</button>
        ${has ? `<button type="button" class="btn" data-cut="replace" ${n ? '' : 'disabled'}>Replace the list</button>` : ''}
        <button type="button" class="link" data-cut="cancel">Cancel</button></div></div>`;
  };
  $('#cutReview').addEventListener('change', e => {
    const el = e.target as HTMLInputElement, i = el.dataset.i ?? el.dataset.q;
    if (review && el.dataset.named !== undefined) {
      review.namedOnly = el.checked;
      try { localStorage.setItem('cutNamedOnly', el.checked ? '1' : ''); } catch {}
      drawReview();
      return;
    }
    if (!review || i === undefined) return;
    const x = review.pieces[i];
    if (el.dataset.i !== undefined) x.on = el.checked;
    else { x.qty = Math.max(0, Math.round(+el.value || 0)); x.on = x.qty > 0; ($(`#cutReview [data-i="${i}"]`) as HTMLInputElement).checked = x.on; }
    // Only the row and the buttons change, so the count box being typed in stays put.
    el.closest('li').classList.toggle('off', !x.on);
    const n = reviewTotal();
    $('#cutReview [data-cut="add"]').textContent = `Add ${n} piece${n === 1 ? '' : 's'}`;
    $('#cutReview').querySelectorAll('[data-cut="add"], [data-cut="replace"]').forEach(b => { (b as HTMLButtonElement).disabled = !n; });
  });
  $('#cutReview').addEventListener('click', e => {
    const act = (e.target as HTMLElement).dataset?.cut;
    if (!act || !review) return;
    if (act !== 'cancel') {
      const items = shownPieces().map(({ x }) => x).filter(x => x.on && x.qty > 0).map(toItem);
      const cl = list();
      if (act === 'replace') {
        if (cl.items.some(x => x.done_at) && !confirm('Replace the whole cut list, including pieces already checked off?')) return;
        cl.items = items;
      } else cl.items.push(...items);
      cl.source = { file: review.file, at: new Date().toISOString() };
      touch();
      toast(`Added ${items.reduce((q, x) => q + x.qty, 0)} pieces to the cut list.`);
    }
    review = null;
    drawReview();
    draw();
  });

  const readFile = async (file: File) => {
    try {
      const isCsv = /\.(csv|txt|tsv)$/i.test(file.name) || /^text\//.test(file.type);
      const got = isCsv ? readCutCsv(await file.text()) : await readSkp(await file.arrayBuffer());
      // A SketchUp material counts as the species only when it names one from Settings (models are often
      // coloured by section instead); pieces then come together by name and size.
      const known = store.settings.species.map(sp => sp.name);
      const speciesOf = m => known.find(k => m && m.toLowerCase().replace(/[_\s]+/g, ' ').includes(k.toLowerCase())) || '';
      const merged = new Map();
      for (const x of got.pieces) {
        const sp = x.species || speciesOf(x.material), key = [x.part, x.t, x.w, x.l, sp].join('|');
        if (merged.has(key)) merged.get(key).qty += x.qty;
        else merged.set(key, { part: x.part, qty: x.qty, t: x.t, w: x.w, l: x.l, species: sp });
      }
      // Left unticked: flat shapes with no thickness (glass, panels drawn as a face, the floor) and
      // anything that looks like a scale figure.
      let namedOnly = false;
      try { namedOnly = !!localStorage.getItem('cutNamedOnly'); } catch {}
      review = { file: file.name, note: got.note, namedOnly, pieces: [...merged.values()].sort(cutOrder)
        .map(x => ({ ...x, named: isCsv || x.part !== 'Part', on: !(x.l && x.t < 1 / 32) && !/^(chris|susan|steve|sumele|bryce|person|scale figure)\b/i.test(x.part) })) };
      drawReview();
      $('#cutReview').scrollIntoView({ block: 'nearest', behavior: 'smooth' });
    } catch (err) {
      review = null;
      $('#cutReview').innerHTML = `<div class="cutcheck bad"><p><b>${esc(file.name)}</b>: ${esc(err.message || String(err))}</p>
        <div class="actions"><button type="button" class="link" data-cut="cancel">OK</button></div></div>`;
      $('#cutReview [data-cut]').addEventListener('click', () => { $('#cutReview').innerHTML = ''; });
    }
  };
  const drop = $('#cutDrop'), picker = $('#cutFile') as HTMLInputElement;
  picker.addEventListener('change', () => { if (picker.files?.[0]) readFile(picker.files[0]); picker.value = ''; });
  drop.addEventListener('dragover', e => { e.preventDefault(); drop.classList.add('over'); });
  drop.addEventListener('dragleave', () => drop.classList.remove('over'));
  drop.addEventListener('drop', e => {
    e.preventDefault();
    drop.classList.remove('over');
    const file = e.dataTransfer?.files?.[0];
    if (file) readFile(file);
  });

  // Typed or pasted pieces: one per line.
  const form = $('#cutAdd'), box = form.querySelector('textarea');
  const fit = () => { box.style.height = 'auto'; box.style.height = `${box.scrollHeight + 2}px`; };
  const addLines = lines => {
    const items = lines.map(readPieceLine).map(x => toItem({ ...x, species: '' }));
    if (!items.length) return false;
    list().items.push(...items);
    touch();
    draw();
    if (items.length > 1) toast(`Added ${items.length} lines to the cut list.`);
    return true;
  };
  box.addEventListener('paste', e => {
    const lines = splitPasted(e.clipboardData?.getData('text/plain') || '');
    if (lines.length < 2) return;
    e.preventDefault();
    addLines(lines);
  });
  box.addEventListener('input', fit);
  box.addEventListener('keydown', e => { if (e.key === 'Enter' && !e.shiftKey && !e.isComposing) { e.preventDefault(); form.requestSubmit(); } });
  form.addEventListener('submit', e => {
    e.preventDefault();
    const lines = /\n/.test(box.value) ? splitPasted(box.value) : [box.value.replace(/\s+/g, ' ').trim()].filter(Boolean);
    if (!addLines(lines)) return box.focus();
    box.value = '';
    fit();
    box.focus();
  });

  $('#cutItems').addEventListener('click', e => {
    const li = (e.target as Element).closest<HTMLElement>('li.cut'), cl = p.data.cutlist;
    const x = li && cl?.items.find(t => t.id === li.dataset.id);
    if (!x) return;
    if ((e.target as Element).closest('.x')) {
      if (!confirm(`Remove ${x.qty} × ${x.part} from the cut list?`)) return;
      cl.items = cl.items.filter(t => t !== x);
    } else {
      if ((e.target as Element).matches('input[type=checkbox]')) e.preventDefault();
      x.done_at = x.done_at ? null : new Date().toISOString();
    }
    touch();
    draw();
  });
  draw();
}

// ---------- account and household ----------
// The household's people, inviting someone, switching households, and your own name and password.
// These save straight away (not with the projects), and each answers with the fresh account state.
async function accountCall(path, body = {}) {
  const res = await fetch(path, { method: 'POST', headers: { 'Content-Type': 'application/json' }, body: JSON.stringify(body) });
  if (res.status === 401) { location.assign('/login'); throw new Error('Signed out'); }
  const out = await res.json().catch(() => ({ error: `The server returned ${res.status}.` }));
  if (out.error) { toast(out.error); throw new Error(out.error); }
  return out;
}
// Starts the app over on whichever household the server now says (after a switch, a new one, or leaving).
const reloadHome = () => { location.hash = '#/'; location.reload(); };

function householdCards() {
  const owner = account.household.role === 'owner', me = account.me;
  const others = account.households.filter(h => h.id !== account.household.id);
  return `
    <div class="card" id="householdCard"><h2>Household</h2>
      <p class="muted" style="margin-top:0">Everyone here sees and changes the same projects, lists and receipts.</p>
      <div class="grid"><label class="f w6"><span>Household name</span><input id="hhName" value="${esc(account.household.name)}"></label></div>
      <ul class="people">${account.members.map(m => `<li data-id="${m.id}">
        <span class="who"><b>${esc(m.name)}</b>${m.id === me.id ? ' (you)' : ''}<small>${esc(m.email)} · ${m.role === 'owner' ? 'Owner' : 'Member'} · joined ${esc(fmtDate(m.joined_at))}</small></span>
        <span class="acts">${m.id === me.id ? '' : owner ? `
          <button class="link" data-reset="${m.id}">Password link</button>
          ${m.role === 'owner' ? '' : `<button class="link" data-owner="${m.id}">Make owner</button>`}
          <button class="link danger" data-remove="${m.id}">Remove</button>` : ''}</span></li>`).join('')}</ul>
      <div class="actions"><button class="btn primary" id="invite">Invite someone</button></div>
      <div id="linkBox" hidden></div>
      ${account.members.length > 1 ? `<p class="muted small" style="margin-bottom:0"><button class="link danger" id="leave">Leave ${esc(account.household.name)}</button></p>` : ''}
    </div>
    <div class="card" id="householdsCard"><h2>Your households</h2>
      ${others.length ? `<p class="muted" style="margin-top:0">You're looking at <b>${esc(account.household.name)}</b>. Switch to:</p>
        <div class="actions">${others.map(h => `<button class="btn" data-switch="${h.id}">${esc(h.name)}</button>`).join('')}</div>`
        : `<p class="muted" style="margin-top:0">You're only in <b>${esc(account.household.name)}</b>. To share projects with someone else's home too, ask them for an invite link.</p>`}
      <p class="muted small" style="margin-bottom:0"><button class="link" id="newHousehold">+ Start a separate household</button> (for projects you don't want shared with this one)</p>
    </div>
    <div class="card" id="accountCard"><h2>Your account</h2>
      <div class="grid">
        <label class="f w3"><span>Name</span><input id="meName" value="${esc(me.name)}" autocomplete="name"></label>
        <label class="f w3"><span>Email (you sign in with it)</span><input id="meEmail" type="email" value="${esc(me.email)}" autocomplete="username"></label>
      </div>
      <div class="actions"><button class="btn" id="saveMe">Save name and email</button></div>
      <form id="pwForm" class="grid" style="margin-top:14px">
        <label class="f w3"><span>Current password</span><input name="current" type="password" autocomplete="current-password" required></label>
        <label class="f w3"><span>New password</span><input name="next" type="password" autocomplete="new-password" minlength="8" required></label>
        <div class="actions"><button class="btn">Change password</button></div>
      </form>
      <p class="muted small">Changing your password signs you out on your other devices.</p>
      <form method="post" action="/logout"><button class="btn">Sign out on this device</button></form>
    </div>`;
}

function showLink(title, out, note) {
  const box = $('#linkBox');
  box.hidden = false;
  box.innerHTML = `<div class="note ok linkshare"><b>${esc(title)}</b>
    <input readonly value="${esc(out.url)}" aria-label="Link">
    <div class="actions">${navigator.share ? '<button class="btn small primary" data-share>Share…</button>' : ''}<button class="btn small" data-copy>Copy link</button></div>
    <small>${esc(note)} It works once and lasts ${out.days} days.</small></div>`;
  const input = box.querySelector('input');
  input.addEventListener('focus', () => input.select());
  box.querySelector('[data-copy]').addEventListener('click', async () => {
    try { await navigator.clipboard.writeText(out.url); toast('Link copied'); } catch { input.focus(); input.select(); }
  });
  box.querySelector('[data-share]')?.addEventListener('click', () => navigator.share({ title, url: out.url }).catch(() => {}));
}

function wireHouseholdCards() {
  const redraw = out => { loadStore(out); showSettings(); };
  const hhName = $('#hhName');
  hhName.addEventListener('change', async () => redraw(await accountCall('/api/household/rename', { name: hhName.value })));
  $('#invite').addEventListener('click', async () => {
    showLink(`Join ${account.household.name}`, await accountCall('/api/invites'),
      'Send this by text or email to the person you want to add. They make an account (or sign in) and join.');
  });
  $('#householdCard').addEventListener('click', async e => {
    const b = (e.target as Element).closest<HTMLElement>('button');
    if (!b) return;
    const m = account.members.find(x => String(x.id) === (b.dataset.reset || b.dataset.owner || b.dataset.remove));
    if (b.dataset.reset) showLink(`New password for ${m.name}`, await accountCall(`/api/members/${m.id}/reset-link`),
      `Send this to ${m.name.split(' ')[0]}. Opening it lets them set a new password.`);
    if (b.dataset.owner && confirm(`Make ${m.name} an owner too? Owners can remove people and make password links.`))
      redraw(await accountCall(`/api/members/${m.id}/owner`));
    if (b.dataset.remove && confirm(`Take ${m.name} out of ${account.household.name}? They won't see its projects any more.`))
      redraw(await accountCall(`/api/members/${m.id}/remove`));
  });
  $('#leave')?.addEventListener('click', async () => {
    if (!confirm(`Leave ${account.household.name}? Its projects stay with the others, and you won't see them any more.`)) return;
    await save();
    await accountCall(`/api/members/${account.me.id}/remove`);
    reloadHome();
  });
  $('#householdsCard').addEventListener('click', async e => {
    const b = (e.target as Element).closest<HTMLElement>('button');
    if (!b) return;
    if (b.dataset.switch) { await save(); await accountCall('/api/household/switch', { id: Number(b.dataset.switch) }); reloadHome(); }
    if (b.id === 'newHousehold') {
      const name = prompt('Name for the new household', `${myName()}'s workshop`);
      if (!name?.trim()) return;
      await save();
      await accountCall('/api/household/new', { name });
      reloadHome();
    }
  });
  $('#saveMe').addEventListener('click', async () => {
    redraw(await accountCall('/api/account', { name: $('#meName').value, email: $('#meEmail').value }));
    toast('Saved');
  });
  $('#pwForm').addEventListener('submit', async e => {
    e.preventDefault();
    const f = e.target as HTMLFormElement;
    await accountCall('/api/account/password', { current: f.current.value, next: f.next.value });
    f.reset();
    toast('Password changed');
  });
}

// ---------- settings ----------
function showSettings() {
  const s = store.settings;
  const inp = (label, key, type = 'text', cls = '') =>
    `<label class="f ${cls}"><span>${label}</span><input data-path="${key}" type="${type}" ${type === 'number' ? 'min="0" step="any"' : ''} value="${esc(s[key])}"></label>`;
  view.innerHTML = `
    <div class="pagehead"><h1>Settings</h1><span class="spacer"></span><span class="muted">Changes save automatically</span></div>
    ${householdCards()}
    <div class="card" id="general">
      <fieldset><h2>Lumber</h2><div class="grid">
        ${inp('Waste allowance (%)', 'waste_pct', 'number', 'w3')}
      </div><p class="muted" style="margin-bottom:0">Added on top of a cut list's board feet when working out how much lumber to buy, for knots, checks and offcuts.</p></fieldset>
    </div>
    <div class="card"><h2>Wood species</h2>
      <p class="muted" style="margin-top:0">The woods a shop build can be made of, with a rough price per board foot from where you buy lumber, for the lumber cost on a project.</p>
      <div style="overflow-x:auto"><table class="list" id="species"></table></div>
      <p><button class="link" id="addSpecies">+ Add species</button></p>
    </div>
    <div class="card"><h2>Backup</h2>
      <p class="muted">Projects and settings are stored on the server and shared by everyone in the household, on every device. Export a backup now and then to keep a copy of your own. Importing one replaces this household's projects.</p>
      <div class="actions"><button class="btn" id="export">Export backup</button>
        <button class="btn" id="import">Import backup&hellip;</button><input type="file" id="importFile" accept="application/json,.json" hidden></div>
    </div>
`;
  wireHouseholdCards();

  $('#general').addEventListener('input', e => {
    if (!e.target.dataset.path) return;
    s[e.target.dataset.path] = inputValue(e.target);
    settingsChanged();
  });

  const speciesTable = $('#species');
  const renderSpecies = () => {
    speciesTable.innerHTML = `<tr><th>Name</th><th>$ / board foot</th><th></th></tr>` + s.species.map((sp, i) => `<tr>
      <td><input data-i="${i}" data-k="name" value="${esc(sp.name)}" aria-label="Species name" style="min-width:140px"></td>
      <td><input data-i="${i}" data-k="price" type="number" min="0" step="any" value="${esc(sp.price)}" aria-label="Price per board foot" style="min-width:80px"></td>
      <td><button class="link" data-remove="${i}">remove</button></td></tr>`).join('');
  };
  renderSpecies();
  speciesTable.addEventListener('input', e => {
    const { i, k } = e.target.dataset;
    if (i === undefined) return;
    s.species[i][k] = inputValue(e.target);
    settingsChanged();
  });
  speciesTable.addEventListener('click', e => {
    if (e.target.dataset.remove === undefined) return;
    s.species.splice(Number(e.target.dataset.remove), 1);
    settingsChanged();
    renderSpecies();
  });
  $('#addSpecies').addEventListener('click', () => {
    s.species.push({ name: '', price: 0 });
    settingsChanged();
    renderSpecies();
    speciesTable.querySelector('tr:last-child input').focus();
  });

  $('#export').addEventListener('click', () => {
    const a = document.createElement('a');
    a.href = URL.createObjectURL(new Blob([JSON.stringify(store, null, 2)], { type: 'application/json' }));
    a.download = `home-projects-backup-${new Date().toISOString().slice(0, 10)}.json`;
    a.click();
    URL.revokeObjectURL(a.href);
  });
  $('#import').addEventListener('click', () => $('#importFile').click());
  $('#importFile').addEventListener('change', async e => {
    const file = e.target.files[0];
    e.target.value = '';
    if (!file) return;
    let backup;
    try { backup = JSON.parse(await file.text()); } catch { backup = null; }
    if (!backup || !Array.isArray(backup.projects) || !backup.settings) return toast('That file is not a Home Projects backup.');
    if (!confirm(`Replace the ${store.projects.length} project(s) here with the ${backup.projects.length} in this backup?`)) return;
    try {
      await save();
      store = loadStore(await api('/api/import', backup));
    } catch (e) {
      return toast(`Import failed: ${e.message}`);
    }
    saved = snapshot();
    backfillTodos();
    settingsChanged();
    route();
    toast('Backup imported.');
  });
}

// On a phone app the stream band on the Projects page pins just under the status bar. A fixed bar
// behind the status bar takes the color of the stream at the top of the screen (the page background
// in the gap between streams), so cards and the outgoing band slide under it rather than showing
// behind the clock, and it switches color right as the next band takes over. Pinned bands also get
// the "stuck" class for a stronger shadow.
let stuckFrame = 0;
const statusCover = document.createElement('div');
statusCover.id = 'statusCover';
document.body.append(statusCover);
const markStuckBands = () => {
  stuckFrame = 0;
  const lanes = [...document.querySelectorAll<HTMLElement>('.lane')];
  const head = lanes[0]?.querySelector<HTMLElement>('.lanehead');
  const top = head ? parseFloat(getComputedStyle(head).top) || 0 : 0;
  let color = '';
  if (top > 0 && lanes.length && lanes[0].getBoundingClientRect().top < top) {
    const current = lanes.find(l => { const r = l.getBoundingClientRect(); return r.top <= top + 0.5 && r.bottom > top + 0.5; });
    color = current ? getComputedStyle(current).getPropertyValue('--lane') : getComputedStyle(document.body).backgroundColor;
  }
  statusCover.style.background = color;
  lanes.forEach(l => {
    const h = l.querySelector<HTMLElement>('.lanehead');
    h?.classList.toggle('stuck', top > 0 && h.getBoundingClientRect().top <= top + 0.5);
  });
};
window.addEventListener('scroll', () => { if (!stuckFrame) stuckFrame = requestAnimationFrame(markStuckBands); }, { passive: true });
window.addEventListener('hashchange', () => requestAnimationFrame(markStuckBands));

backfillTodos();
route();
// Pick up other devices' changes when coming back to this tab, and send pending ones when leaving it.
document.addEventListener('visibilitychange', () => document.visibilityState === 'hidden' ? save(true) : refresh());
window.addEventListener('pagehide', () => save(true));
window.addEventListener('online', () => save());
