// The shapes the server stores and the browser app works with. The browser owns the details of
// a project's `data` and the settings; the server only needs the parts named here.

export interface Settings { species: unknown[]; [key: string]: unknown }

export interface Project {
  id: number;
  stream: string;                     // 'home' (home improvement) or 'shop' (a shop build)
  status: string; stage: string;
  data: Record<string, unknown>;      // name, budget, lumber, design notes, lists, purchases, due dates; `frozen` while on hold
  calc: Record<string, unknown>;      // totals as of the last save
  history: { status?: string; stage?: string; at: string }[];
  created_at: string; updated_at: string;
}


/** What a receipt photo was read as (src/lib/receipts.ts). The browser lets you check items over before saving. */
export interface ScannedReceipt {
  store: string; date: string;        // date as YYYY-MM-DD, '' if it couldn't be read
  items: { description: string; quantity: number; amount: number }[];
  tax: number; total: number;
}
