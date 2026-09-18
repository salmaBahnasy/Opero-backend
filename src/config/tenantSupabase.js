const supabase = require("./supabase");
const { isTenantTable, tenantFrom } = require("../utils/tenantScope");

/**
 * Supabase client for tenant-owned tables.
 * When a companyId is bound (bindTenantScope / runWithCompanyId), reads and
 * writes on tenant tables are forced to that company. Global tables pass through.
 */
const tenantSupabase = {
  from(table) {
    if (isTenantTable(table)) {
      return tenantFrom(supabase, table);
    }
    return supabase.from(table);
  },
  rpc(...args) {
    return supabase.rpc(...args);
  },
};

module.exports = tenantSupabase;
