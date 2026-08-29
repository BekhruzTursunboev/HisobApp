// Load local secrets for scripts run from your machine.
//
// Order matters: .env.local wins over .env, matching the convention Next.js
// and Vercel use. On Vercel itself neither file exists — the platform injects
// DATABASE_URL from the dashboard — and dotenv simply finds nothing, which is
// the correct outcome rather than an error.

import { config } from "dotenv";
import { existsSync } from "node:fs";

for (const file of [".env.local", ".env"]) {
  if (existsSync(file)) config({ path: file, override: false, quiet: true });
}
