const { AsyncLocalStorage } = require("node:async_hooks");

const tenantStorage = new AsyncLocalStorage();
const integrationStorage = new AsyncLocalStorage();

const DEFAULT_TENANT_TABLES = [
  "orders",
  "order_status_logs",
  "products",
  "added_orders",
  "order_cost_daily",
  "bosta_sku_mappings",
  "bosta_unmapped_products",
  "employees",
];

const TENANT_TABLES = new Set(
  DEFAULT_TENANT_TABLES.map((name) => {
    const envKey = {
      orders: process.env.SUPABASE_ORDERS_TABLE,
      order_status_logs: process.env.SUPABASE_ORDER_STATUS_LOGS_TABLE,
      products: process.env.SUPABASE_PRODUCTS_TABLE,
      added_orders: process.env.SUPABASE_ADDED_ORDERS_TABLE,
      order_cost_daily: process.env.SUPABASE_ORDER_COST_DAILY_TABLE,
      bosta_sku_mappings: process.env.SUPABASE_BOSTA_SKU_MAPPINGS_TABLE,
      bosta_unmapped_products: process.env.SUPABASE_BOSTA_UNMAPPED_PRODUCTS_TABLE,
      employees: process.env.SUPABASE_EMPLOYEES_TABLE,
    }[name];
    return (envKey || name).trim();
  }),
);

const ON_CONFLICT_REWRITE = {
  orders: { order_id: "company_id,order_id" },
  products: { easyorder_id: "company_id,easyorder_id" },
  order_cost_daily: { cost_date: "company_id,cost_date" },
  bosta_unmapped_products: { product_id: "company_id,product_id" },
  bosta_sku_mappings: {
    "mapping_type,entity_id": "company_id,mapping_type,entity_id",
  },
};

function requireCompanyId(companyId) {
  const id = String(companyId || "").trim();
  if (!id) {
    const error = new Error("companyId is required");
    error.code = "TENANT_CONTEXT_MISSING";
    throw error;
  }
  return id;
}

function runWithCompanyId(companyId, fn) {
  return tenantStorage.run(requireCompanyId(companyId), fn);
}

function runWithIntegration(integration, fn) {
  return integrationStorage.run(integration || null, fn);
}

function runWithTenantContext({ companyId, integration }, fn) {
  return runWithCompanyId(companyId, () => runWithIntegration(integration, fn));
}

function getActiveCompanyId() {
  const id = tenantStorage.getStore();
  return id ? String(id) : null;
}

function getActiveIntegration() {
  return integrationStorage.getStore() || null;
}

function requireActiveCompanyId() {
  return requireCompanyId(getActiveCompanyId());
}

function isTenantTable(table) {
  return TENANT_TABLES.has(String(table || "").trim());
}

function withCompanyPayload(row, companyId) {
  if (Array.isArray(row)) {
    return row.map((item) => withCompanyPayload(item, companyId));
  }
  if (!row || typeof row !== "object") return row;
  return { ...row, company_id: companyId };
}

function rewriteOnConflict(table, onConflict) {
  if (!onConflict) return onConflict;
  const normalized = String(onConflict).replace(/\s+/g, "");
  if (normalized.split(",").includes("company_id")) {
    return normalized;
  }
  const tableRewrites = ON_CONFLICT_REWRITE[table] || {};
  return tableRewrites[normalized] || `company_id,${normalized}`;
}

function tenantFrom(client, table) {
  const companyId = requireActiveCompanyId();
  const base = client.from(table);

  return new Proxy(base, {
    get(target, prop, receiver) {
      if (prop === "select") {
        return (...args) => target[prop](...args).eq("company_id", companyId);
      }
      if (prop === "update") {
        return (row, ...rest) =>
          target
            .update(withCompanyPayload(row, companyId), ...rest)
            .eq("company_id", companyId);
      }
      if (prop === "delete") {
        return (...args) => target.delete(...args).eq("company_id", companyId);
      }
      if (prop === "insert") {
        return (row, opts) =>
          target.insert(withCompanyPayload(row, companyId), opts);
      }
      if (prop === "upsert") {
        return (row, opts = {}) =>
          target.upsert(withCompanyPayload(row, companyId), {
            ...opts,
            onConflict: rewriteOnConflict(table, opts.onConflict),
          });
      }
      const value = Reflect.get(target, prop, receiver);
      return typeof value === "function" ? value.bind(target) : value;
    },
  });
}

module.exports = {
  requireCompanyId,
  runWithCompanyId,
  runWithIntegration,
  runWithTenantContext,
  getActiveCompanyId,
  getActiveIntegration,
  requireActiveCompanyId,
  isTenantTable,
  tenantFrom,
  rewriteOnConflict,
  withCompanyPayload,
  TENANT_TABLES,
};
