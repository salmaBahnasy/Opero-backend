const { randomUUID } = require("crypto");

function pickColumns(row, columns) {
  if (!columns || columns === "*") {
    return { ...row };
  }
  const keys = String(columns)
    .split(",")
    .map((part) => part.trim())
    .filter(Boolean);
  const out = {};
  for (const key of keys) {
    out[key] = row[key];
  }
  return out;
}

function matchesFilters(row, filters) {
  return filters.every((filter) => {
    if (filter.type === "eq") {
      return String(row[filter.key]) === String(filter.value);
    }
    if (filter.type === "neq") {
      return String(row[filter.key]) !== String(filter.value);
    }
    if (filter.type === "gte") {
      return String(row[filter.key] || "") >= String(filter.value);
    }
    if (filter.type === "lte") {
      return String(row[filter.key] || "") <= String(filter.value);
    }
    if (filter.type === "in") {
      return (filter.value || []).map(String).includes(String(row[filter.key]));
    }
    return true;
  });
}

function createFakeSupabase({
  companies = [],
  employees = [],
  orders = [],
  products = [],
  added_orders = [],
  order_status_logs = [],
  order_cost_daily = [],
  bosta_sku_mappings = [],
  bosta_unmapped_products = [],
  platform_admins = [],
  company_integrations = [],
  features = [],
  company_features = [],
} = {}) {
  const db = {
    companies: companies.map((row) => ({ ...row })),
    employees: employees.map((row) => ({ ...row })),
    orders: orders.map((row) => ({ ...row })),
    products: products.map((row) => ({ ...row })),
    added_orders: added_orders.map((row) => ({ ...row })),
    order_status_logs: order_status_logs.map((row) => ({ ...row })),
    order_cost_daily: order_cost_daily.map((row) => ({ ...row })),
    bosta_sku_mappings: bosta_sku_mappings.map((row) => ({ ...row })),
    bosta_unmapped_products: bosta_unmapped_products.map((row) => ({ ...row })),
    platform_admins: platform_admins.map((row) => ({ ...row })),
    company_integrations: company_integrations.map((row) => ({ ...row })),
    features: features.map((row) => ({ ...row })),
    company_features: company_features.map((row) => ({ ...row })),
  };

  const sequences = {};

  class Query {
    constructor(table) {
      this.table = table;
      this.filters = [];
      this.action = "select";
      this.payload = null;
      this.columns = "*";
      this.onConflict = null;
      this.limitCount = null;
      this.rangeFrom = null;
      this.rangeTo = null;
      this.countExact = false;
    }

    select(columns = "*", options = {}) {
      this.columns = columns;
      this.countExact = options?.count === "exact";
      return this;
    }

    eq(key, value) {
      this.filters.push({ type: "eq", key, value });
      return this;
    }

    neq(key, value) {
      this.filters.push({ type: "neq", key, value });
      return this;
    }

    gte(key, value) {
      this.filters.push({ type: "gte", key, value });
      return this;
    }

    lte(key, value) {
      this.filters.push({ type: "lte", key, value });
      return this;
    }

    in(key, value) {
      this.filters.push({ type: "in", key, value });
      return this;
    }

    not() {
      return this;
    }

    contains() {
      return this;
    }

    or() {
      return this;
    }

    ilike() {
      return this;
    }

    ilikeAllOf() {
      return this;
    }

    order() {
      return this;
    }

    limit(count) {
      this.limitCount = count;
      return this;
    }

    range(from, to) {
      this.rangeFrom = from;
      this.rangeTo = to;
      return this;
    }

    insert(payload) {
      this.action = "insert";
      this.payload = payload;
      return this;
    }

    update(payload) {
      this.action = "update";
      this.payload = payload;
      return this;
    }

    upsert(payload, opts = {}) {
      this.action = "upsert";
      this.payload = payload;
      this.onConflict = opts.onConflict;
      return this;
    }

    delete() {
      this.action = "delete";
      return this;
    }

    single() {
      return this.execute("single");
    }

    maybeSingle() {
      return this.execute("maybe");
    }

    then(resolve, reject) {
      return this.execute("many").then(resolve, reject);
    }

    rowsForTable() {
      if (!db[this.table]) db[this.table] = [];
      return db[this.table];
    }

    applyConflictMatch(row, incoming) {
      const keys = String(this.onConflict || "")
        .split(",")
        .map((part) => part.trim())
        .filter(Boolean);
      if (!keys.length) return false;
      return keys.every((key) => String(row[key]) === String(incoming[key]));
    }

    async execute(mode) {
      const rows = this.rowsForTable();

      if (this.action === "insert") {
        const incoming = Array.isArray(this.payload)
          ? this.payload
          : [this.payload];
        const created = incoming.map((item) => {
          const row = {
            id: randomUUID(),
            created_at: new Date().toISOString(),
            updated_at: new Date().toISOString(),
            ...item,
          };
          rows.push(row);
          return pickColumns(row, this.columns);
        });
        const data = Array.isArray(this.payload) ? created : created[0];
        return { data: mode === "many" ? created : data, error: null };
      }

      if (this.action === "upsert") {
        const incoming = Array.isArray(this.payload)
          ? this.payload
          : [this.payload];
        const result = incoming.map((item) => {
          const existing = rows.find((row) => this.applyConflictMatch(row, item));
          if (existing) {
            Object.assign(existing, item, { updated_at: new Date().toISOString() });
            return pickColumns(existing, this.columns);
          }
          const row = {
            id: randomUUID(),
            created_at: new Date().toISOString(),
            updated_at: new Date().toISOString(),
            ...item,
          };
          rows.push(row);
          return pickColumns(row, this.columns);
        });
        const data = Array.isArray(this.payload) ? result : result[0];
        return { data: mode === "many" ? result : data, error: null };
      }

      const matched = rows.filter((row) => matchesFilters(row, this.filters));

      if (this.action === "update") {
        if (!matched.length) {
          if (mode === "maybe") {
            return { data: null, error: null };
          }
          return mode === "many"
            ? { data: [], error: null, count: 0 }
            : { data: null, error: { message: "not found" } };
        }
        Object.assign(matched[0], this.payload);
        const data = pickColumns(matched[0], this.columns);
        return { data: mode === "many" ? [data] : data, error: null };
      }

      if (this.action === "delete") {
        if (!matched.length) {
          return mode === "many"
            ? { data: [], error: null }
            : { data: null, error: { message: "not found" } };
        }
        for (const row of matched) {
          const index = rows.indexOf(row);
          if (index >= 0) rows.splice(index, 1);
        }
        const data = pickColumns(matched[0], this.columns);
        return { data: mode === "many" ? matched.map((row) => pickColumns(row, this.columns)) : data, error: null };
      }

      let data = matched.map((row) => pickColumns(row, this.columns));
      if (this.rangeFrom != null && this.rangeTo != null) {
        data = data.slice(this.rangeFrom, this.rangeTo + 1);
      } else if (this.limitCount != null) {
        data = data.slice(0, this.limitCount);
      }

      if (mode === "single") {
        if (!data.length) {
          return { data: null, error: { message: "not found" } };
        }
        return { data: data[0], error: null };
      }
      if (mode === "maybe") {
        return { data: data[0] || null, error: null };
      }
      return { data, error: null, count: matched.length };
    }
  }

  return {
    from(table) {
      return new Query(table);
    },
    rpc(name, args = {}) {
      if (name === "next_company_order_reference") {
        const companyId = String(args.p_company_id || "");
        if (!companyId) {
          return Promise.resolve({
            data: null,
            error: { message: "company_id is required" },
          });
        }
        if (!sequences[companyId]) sequences[companyId] = 1001;
        const issued = sequences[companyId];
        sequences[companyId] += 1;
        return Promise.resolve({ data: issued, error: null });
      }
      return Promise.resolve({
        data: null,
        error: { message: `unknown rpc ${name}` },
      });
    },
    __db: db,
    __sequences: sequences,
  };
}

module.exports = { createFakeSupabase };
