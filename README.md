# Home Projects Tracker

Planning and cost tracking for house projects and hobby woodworking builds. Each project is either
**Home improvement** (work on the house) or a **Shop build** (a piece built in the shop for the home),
and moves through four phases: **Ideation, Design, Build, Install**. Each one has its own to-do list,
shopping list, cut list, design notes, receipts and a budget to spend against.

It started as a copy of the J.M. Woodwork Shop Tracker, with the client work taken out (quotes,
pricing, Shopify, small-batch runs, tax set-asides). It runs on Cloudflare: a single
[Worker](https://developers.cloudflare.com/workers/) built with [Hono](https://hono.dev), with
[D1](https://developers.cloudflare.com/d1/) (SQLite) for storage. Everything is TypeScript.

## Run it locally

```sh
npm install
cp .dev.vars.example .dev.vars    # site password for setting up the first account (default: home)
npm run setup:local               # creates the local database
npm run dev                       # http://localhost:8787
```

The first visit asks you to set up an account, using the site password from `.dev.vars`. Local data lives in `.wrangler/state/`;
`npm run db:reset:local` wipes it and starts over. Receipt reading uses Workers AI, which runs on
Cloudflare even under `npm run dev`, so it needs `npx wrangler login`.

| Command | What it does |
| --- | --- |
| `npm run dev` | Local server with hot reload (rebuilds the browser script too) |
| `npm run setup:local` | Apply migrations to the local database |
| `npm run db:reset:local` | Delete local data and set it up again |
| `npm run typecheck` | Type-check the Worker and the browser script |
| `npm run deploy` | Apply migrations to the Cloudflare database, then deploy (see [DEPLOYMENT.md](DEPLOYMENT.md)) |

## Put it on your phone's home screen

- **iPhone or iPad:** open the site in Safari, tap Share, then **Add to Home Screen**.
- **Android:** open the site in Chrome, tap the ⋮ menu, then **Add to Home screen** (or **Install app**).

Sign in once from the home-screen icon; it keeps its own sign-in, which lasts 90 days and renews
whenever the app is used. The manifest and icons are in `public/`.

## How it fits together

```
src/
  index.tsx          Hono app: sign-in, the app page, the JSON API
  env.ts             Worker bindings (DB, ASSETS, AI) and secrets
  lib/auth.ts        Accounts, households, sessions, invite and password links
  lib/db.ts          D1 reads and writes
  lib/receipts.ts    Keeps receipt photos and reads them into line items (Workers AI)
  views/             Page templates (Hono JSX): the app page, sign-in
  client/app.ts      The app in the browser: every screen
  client/skp.ts      Reads a SketchUp model or OpenCutList CSV into a cut list
  client/xlsx.ts     Writes the Excel export
  shared/types.ts    Shapes shared by the server and the browser
public/app.css       Stylesheet (public/app.js is built from src/client)
migrations/          D1 schema
```

- **The app page** (`GET /`) is rendered with every project embedded in it, and the browser script
  draws each screen from that. Changes are sent to `POST /api/save` shortly after they're made (only
  what changed). When the tab comes back into view the latest data is fetched, so edits on another
  device show up. When two devices edit the same project, the most recent edit wins.
- **Projects** keep their details as JSON in `projects.data`: name, room or area, wood, budget,
  phase due dates (`stage_due`, with Install's as `due_date`), `todo` (to-do list, shopping list and
  a log), `cutlist`, `design` notes, `purchases`, `hours_worked`, and `frozen` while on hold.
- **Budget and costs.** Everything bought for a project (`data.purchases`, from scanned receipts or
  typed in) counts against its budget. The Details page shows spent and left to spend; the Costs tab
  lists every receipt with its photo, spending by month, and hours worked, and prints as a PDF.
- **Lumber to buy.** Board feet come from what's typed in, or else the cut list plus the waste
  allowance in Settings, and are turned into linear feet of whole boards for the width you can buy,
  with a rough cost from the species price in Settings. One tap adds it to the shopping list.
- **Tasks** (`#/tasks`): every active project's to-do list, in an order you can set by pressing and
  holding; **All to-dos** in one list; and the **Shopping list** for every project, by wood species or
  by project.
- **Receipts.** A photo is shrunk in the browser and sent to `POST /api/receipts/scan`, which keeps it
  (base64 JPEG in the `receipts` table) and reads it with a vision model on Workers AI. The lines come
  back to check over, then go to a project, or to the receipt itself as **Not for a project** (tools,
  supplies). **All receipts** (`#/receipts`) lists every receipt by year and downloads spending as Excel.
- **Frozen projects** leave the board and calendar until unfrozen, keeping their phase and dates.
- **Accounts and households.** Everyone signs in with their own email and password. Projects, receipts
  and settings belong to a household, and everyone in it sees and edits them all (a project's history
  says who moved it along). Settings → Household makes a one-use invite link (7 days) to send by text;
  the owner can also make a link for someone to set a new password. Someone can be in several
  households and switch between them. The first account is set up with the old site password
  (`APP_PASSWORD`) and takes over everything made before accounts, in household 1.
