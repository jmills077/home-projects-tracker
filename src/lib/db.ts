// Reading and writing the projects and settings in D1. Projects travel to and from the browser
// whole, in the same shape a backup file keeps them in.
import type { Project, Settings } from '../shared/types';

interface ProjectRow {
  id: number; stream: string; status: string; stage: string;
  data: string; calc: string; history: string; created_at: string; updated_at: string;
}

const toProject = (r: ProjectRow): Project => ({
  id: r.id, stream: r.stream, status: r.status, stage: r.stage,
  data: JSON.parse(r.data), calc: JSON.parse(r.calc), history: JSON.parse(r.history),
  created_at: r.created_at, updated_at: r.updated_at,
});

// Home improvement or a shop build; anything else (an odd backup) is home improvement.
const STREAMS = ['home', 'shop'];
const streamOf = (p: Project) => STREAMS.includes(p.stream) ? p.stream : 'home';

/** Throws if `value` isn't a project the browser could have produced. */
export function checkProject(value: unknown, needId = true): asserts value is Project {
  const p = value as Project;
  const ok = p && typeof p === 'object'
    && (!needId || (Number.isInteger(p.id) && p.id > 0))
    && typeof p.status === 'string' && typeof p.created_at === 'string' && typeof p.updated_at === 'string'
    && p.data && typeof p.data === 'object' && Array.isArray(p.history);
  if (!ok) throw new BadRequest('Not a valid project.');
}
export class BadRequest extends Error {}

const json = (v: unknown, fallback: unknown) => JSON.stringify(v ?? fallback);

// Writes a project as given, keeping its id. Only replaces a stored copy that isn't newer.
const upsertProject = (db: D1Database, p: Project) => db.prepare(`
  INSERT INTO projects (id, stream, status, stage, data, calc, history, created_at, updated_at)
  VALUES (?, ?, ?, ?, ?, ?, ?, ?, ?)
  ON CONFLICT (id) DO UPDATE SET
    stream = excluded.stream, status = excluded.status, stage = excluded.stage, data = excluded.data,
    calc = excluded.calc, history = excluded.history, updated_at = excluded.updated_at
  WHERE excluded.updated_at >= projects.updated_at`)
  .bind(p.id, streamOf(p), p.status, p.stage || 'ideation',
    json(p.data, {}), json(p.calc, {}), json(p.history, []), p.created_at, p.updated_at);

// Settings are stored with the time they were last changed; an older copy never replaces a newer one.
const putSettings = (db: D1Database, settings: Settings, updatedAt: string) => db.prepare(`
  INSERT INTO settings (key, value) VALUES ('settings', ?)
  ON CONFLICT (key) DO UPDATE SET value = excluded.value
  WHERE json_extract(excluded.value, '$.updatedAt') >= json_extract(settings.value, '$.updatedAt')`)
  .bind(JSON.stringify({ settings, updatedAt: updatedAt || '' }));

async function getSetting<T>(db: D1Database, key: string): Promise<T | null> {
  const row = await db.prepare('SELECT value FROM settings WHERE key = ?').bind(key).first<{ value: string }>();
  return row ? JSON.parse(row.value) : null;
}

/** Everything the browser app starts from, apart from whether Shopify is connected. */
export async function getState(db: D1Database) {
  const [saved, projects] = await Promise.all([
    getSetting<{ settings: Settings; updatedAt: string }>(db, 'settings'),
    db.prepare('SELECT * FROM projects ORDER BY id').all<ProjectRow>(),
  ]);
  return {
    settings: saved?.settings ?? null,   // null until first saved: the browser fills in its defaults
    settingsUpdatedAt: saved?.updatedAt ?? '',
    projects: projects.results.map(toProject),
  };
}

export interface Changes { projects?: unknown[]; deleted?: unknown[]; settings?: Settings; settingsUpdatedAt?: string }

export async function saveChanges(db: D1Database, changes: Changes) {
  const projects = changes.projects ?? [], deleted = changes.deleted ?? [];
  if (!Array.isArray(projects) || !Array.isArray(deleted) || !deleted.every(Number.isInteger)) throw new BadRequest('Malformed changes.');
  projects.forEach(p => checkProject(p));
  const statements = [
    ...projects.map(p => upsertProject(db, p as Project)),
    ...deleted.map(id => db.prepare('DELETE FROM projects WHERE id = ?').bind(id)),
  ];
  if (changes.settings) {
    if (typeof changes.settings !== 'object' || !Array.isArray(changes.settings.species)) throw new BadRequest('Malformed settings.');
    statements.push(putSettings(db, changes.settings, changes.settingsUpdatedAt ?? ''));
  }
  if (statements.length) await db.batch(statements);
}

/** Saves a new project, giving it the next id. */
export async function createProject(db: D1Database, draft: unknown): Promise<Project> {
  checkProject(draft, false);
  const row = await db.prepare(`
    INSERT INTO projects (stream, status, stage, data, calc, history, created_at, updated_at)
    VALUES (?, ?, ?, ?, ?, ?, ?, ?) RETURNING id`)
    .bind(streamOf(draft), draft.status, draft.stage || 'ideation', json(draft.data, {}), json(draft.calc, {}),
      json(draft.history, []), draft.created_at, draft.updated_at)
    .first<{ id: number }>();
  const { stage, data, calc, history, created_at, updated_at, status } = draft;
  return { id: row!.id, stream: streamOf(draft), status, stage: stage || 'ideation', data, calc: calc ?? {}, history, created_at, updated_at };
}

/** Replaces every project and the settings with a backup file's (from this app or the original one). */
export async function importBackup(db: D1Database, backup: any) {
  if (!backup || !Array.isArray(backup.projects) || !backup.settings) throw new BadRequest('That file is not a Home Projects backup.');
  backup.projects.forEach((p: unknown) => checkProject(p));
  await db.batch([
    db.prepare('DELETE FROM projects'),
    db.prepare("DELETE FROM settings WHERE key = 'settings'"),
    ...backup.projects.map((p: Project) => upsertProject(db, p)),
    putSettings(db, backup.settings, backup.settingsUpdatedAt ?? ''),
  ]);
  return getState(db);
}
