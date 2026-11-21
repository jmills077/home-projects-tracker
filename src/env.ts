// Bindings and secrets the Worker is given (see wrangler.jsonc).
import type { Session } from './lib/auth';

export interface Env {
  DB: D1Database;        // accounts, households, projects, settings, receipts
  ASSETS: Fetcher;       // public/: the stylesheet and browser script
  AI?: Ai;               // Workers AI: reads receipt photos (src/lib/receipts.ts)
  APP_PASSWORD?: string; // secret: the old site-wide password, used once to set up the first account
}
export type App = { Bindings: Env; Variables: { session: Session } };
