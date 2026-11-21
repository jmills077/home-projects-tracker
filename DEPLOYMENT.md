# Deploying to Cloudflare

The site runs as the `home-projects-tracker` Worker with the `home-projects` D1 database, in the
jmwood.work Cloudflare account. Cloudflare's Workers Builds deploys it from this repo's `main` branch.

## First time

1. **Connect the repo.** In the Cloudflare dashboard: **Workers & Pages → Create → Import a
   repository**, pick `home-projects-tracker`, and keep the Worker name `home-projects-tracker`
   (it has to match `name` in `wrangler.jsonc`). Set the deploy command to `npm run deploy`, so new
   migrations are applied before each deploy.
2. **Set the site password.** Worker → **Settings → Variables and Secrets → Add**, type *Secret*, name
   `APP_PASSWORD`. Or from a terminal: `npx wrangler secret put APP_PASSWORD`. It's used once, on
   the first visit, to set up the first account (everyone after joins by invite link).
3. **Create the tables** if the first deploy didn't: `npm run db:migrate:remote`.

The site is then at `https://home-projects-tracker.<your-subdomain>.workers.dev`.
The live site: https://home-projects-tracker.jonathan-a83.workers.dev

If a merge to main doesn't start a build, check the Worker's **Settings → Build** for a "disconnected from
your Git account" banner: the Cloudflare GitHub app needs this repo under its Repository access.

## Updating

Merging to `main` deploys. By hand: `npm run deploy` applies any new files in `migrations/`, then
deploys (`wrangler deploy` rebuilds the browser script itself).

## Receipt scanning

Reading receipt photos uses Workers AI through the `ai` binding. Nothing to set up: no secret, and
it's billed to the Cloudflare account within the daily free allowance for normal use. Photos are kept
in D1, about 0.3 to 1 MB each.

## Backups of the database

D1 keeps 30 days of point-in-time history ([Time Travel](https://developers.cloudflare.com/d1/reference/time-travel/)):

```sh
npx wrangler d1 time-travel info home-projects
npx wrangler d1 export home-projects --remote --output=home-projects.sql   # a full SQL dump
```

**Settings → Backup → Export backup** in the app also downloads the projects and settings as JSON.

## Custom domain (optional)

Buy the domain in Cloudflare (**Domain Registration → Register Domains**), then **Workers & Pages →
home-projects-tracker → Settings → Domains & Routes → Add → Custom domain**.
