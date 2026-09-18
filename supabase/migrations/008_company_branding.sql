-- =============================================================================
-- 008_company_branding.sql
-- ADDITIVE. Do NOT edit 001–007. Do NOT run this against the old ERP project.
-- This file is NOT executed by the backend. Apply it manually in the SaaS
-- Supabase SQL editor after review.
-- =============================================================================
-- Phase 1 companies already store:
--   name, logo_url, primary_color, secondary_color
-- White-label login still needs a login image/background and a favicon.
-- Image binaries are NOT stored here — URLs/paths only.
-- =============================================================================

alter table public.companies
  add column if not exists login_image_url text,
  add column if not exists favicon_url text;

comment on column public.companies.logo_url is
  'Public logo URL/path. Not a binary. Used on login and in the company dashboard.';

comment on column public.companies.login_image_url is
  'Public login-page image/background URL/path. Shown before employee authentication.';

comment on column public.companies.favicon_url is
  'Public favicon URL/path for the white-label company frontend.';

comment on column public.companies.primary_color is
  'Brand primary color (CSS color string, e.g. #0f6b57).';

comment on column public.companies.secondary_color is
  'Brand secondary color (CSS color string).';
