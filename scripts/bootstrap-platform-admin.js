#!/usr/bin/env node
/**
 * One-time Platform Super Admin bootstrap (controlled ops only).
 *
 * Creates the FIRST platform_admins row using the service-role Supabase client.
 * Does NOT expose a public signup endpoint.
 * Never prints the password or service_role key.
 *
 * Usage:
 *   PLATFORM_ADMIN_EMAIL=ops@example.com \
 *   PLATFORM_ADMIN_PASSWORD='long-random-password' \
 *   PLATFORM_ADMIN_NAME='Platform Ops' \
 *   node scripts/bootstrap-platform-admin.js --confirm
 *
 * Optional:
 *   --force   update password/name if the email already exists
 *
 * Requires in environment:
 *   SUPABASE_URL
 *   SUPABASE_SERVICE_ROLE_KEY
 */

const path = require("path");
require("dotenv").config({
  path: path.resolve(__dirname, "../.env"),
});

const bcrypt = require("bcryptjs");
const { createClient } = require("@supabase/supabase-js");
const { assertPassword } = require("../src/utils/passwordPolicy");

function usage(exitCode = 1) {
  process.stderr.write(
    [
      "Usage:",
      "  PLATFORM_ADMIN_EMAIL=... PLATFORM_ADMIN_PASSWORD=... PLATFORM_ADMIN_NAME=... \\",
      "    node scripts/bootstrap-platform-admin.js --confirm [--force]",
      "",
    ].join("\n"),
  );
  process.exit(exitCode);
}

async function main() {
  const args = new Set(process.argv.slice(2));
  if (args.has("--help") || args.has("-h")) usage(0);
  if (!args.has("--confirm")) {
    process.stderr.write(
      "Refusing to run without --confirm (safety gate for production bootstrap).\n",
    );
    usage(1);
  }

  const email = String(process.env.PLATFORM_ADMIN_EMAIL || "")
    .trim()
    .toLowerCase();
  const password = String(process.env.PLATFORM_ADMIN_PASSWORD || "");
  const name = String(process.env.PLATFORM_ADMIN_NAME || "Platform Super Admin").trim();
  const force = args.has("--force");

  if (!email || !email.includes("@")) {
    process.stderr.write("PLATFORM_ADMIN_EMAIL is required.\n");
    process.exit(1);
  }
  try {
    assertPassword(password);
  } catch (error) {
    process.stderr.write(`${error.message}\n`);
    process.exit(1);
  }

  const supabaseUrl = String(process.env.SUPABASE_URL || "").trim();
  const serviceRole = String(process.env.SUPABASE_SERVICE_ROLE_KEY || "").trim();
  if (!supabaseUrl || !serviceRole) {
    process.stderr.write(
      "SUPABASE_URL and SUPABASE_SERVICE_ROLE_KEY are required.\n",
    );
    process.exit(1);
  }

  const supabase = createClient(supabaseUrl, serviceRole, {
    auth: { persistSession: false, autoRefreshToken: false },
  });

  const { data: existing, error: lookupError } = await supabase
    .from("platform_admins")
    .select("id,email,is_active")
    .eq("email", email)
    .maybeSingle();
  if (lookupError) {
    process.stderr.write(`Lookup failed: ${lookupError.message}\n`);
    process.exit(1);
  }

  const passwordHash = await bcrypt.hash(password, 10);

  if (existing?.id) {
    if (!force) {
      process.stderr.write(
        `Platform admin already exists for that email (id=${existing.id}). Re-run with --force to rotate password.\n`,
      );
      process.exit(2);
    }
    const { error: updateError } = await supabase
      .from("platform_admins")
      .update({
        name,
        password: passwordHash,
        is_active: true,
      })
      .eq("id", existing.id);
    if (updateError) {
      process.stderr.write(`Update failed: ${updateError.message}\n`);
      process.exit(1);
    }
    process.stdout.write(
      `Updated platform admin ${email} (id=${existing.id}). Password rotated.\n`,
    );
    return;
  }

  const { data: created, error: insertError } = await supabase
    .from("platform_admins")
    .insert({
      name,
      email,
      password: passwordHash,
      is_active: true,
    })
    .select("id,email")
    .single();
  if (insertError) {
    process.stderr.write(`Insert failed: ${insertError.message}\n`);
    process.exit(1);
  }

  process.stdout.write(
    `Created platform admin ${created.email} (id=${created.id}).\n`,
  );
  process.stdout.write(
    "Sign in via Super Admin → POST /api/platform/auth/login (never commit the password).\n",
  );
}

main().catch((error) => {
  process.stderr.write(`${error.message || error}\n`);
  process.exit(1);
});
