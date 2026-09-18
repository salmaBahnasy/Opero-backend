#!/usr/bin/env node
/**
 * Hash a development password with bcrypt (cost 10).
 * Prints ONLY the hash — never log this from the running API.
 *
 * Usage:
 *   node scripts/hash-dev-password.js 'YourChosenDevPassword'
 *
 * Then put the hash in supabase/seeds/dev_enaya_admin.sql or:
 *   update public.employees
 *   set password = '<hash>'
 *   where email = 'admin@enaya.local'
 *     and company_id = (select id from public.companies where slug = 'enaya');
 */

const bcrypt = require("bcryptjs");

const password = process.argv.slice(2).join(" ").trim();

if (!password) {
  console.error("Usage: node scripts/hash-dev-password.js 'YourChosenDevPassword'");
  process.exit(1);
}

bcrypt.hash(password, 10).then((hash) => {
  process.stdout.write(`${hash}\n`);
});
