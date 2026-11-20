// Bindings and secrets the Worker is given (see wrangler.jsonc).
export interface Env {
  DB: D1Database;        // projects, settings, receipts
  ASSETS: Fetcher;       // public/: the stylesheet and browser script
  AI?: Ai;               // Workers AI: reads receipt photos (src/lib/receipts.ts)
  APP_PASSWORD?: string; // secret: the password for signing in
}
export type App = { Bindings: Env };
