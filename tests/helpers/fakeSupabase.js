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

function splitSelectParts(columns) {
  const parts = [];
  let buf = "";
  let depth = 0;
  for (const ch of String(columns || "")) {
    if (ch === "(") depth += 1;
    if (ch === ")") depth = Math.max(0, depth - 1);
    if (ch === "," && depth === 0) {
      if (buf.trim()) parts.push(buf.trim());
      buf = "";
    } else {
      buf += ch;
    }
  }
  if (buf.trim()) parts.push(buf.trim());
  return parts;
}

function parseAggregateSelect(columns) {
  const text = String(columns || "").trim();
  if (!text || text === "*") return null;
  if (!/\bcount\s*\(/i.test(text) && !/\.sum\s*\(/i.test(text)) return null;
  const groupBy = [];
  const aggregations = [];
  for (const part of splitSelectParts(text)) {
    const aliased = part.match(/^([A-Za-z_][\w]*)\s*:\s*(.+)$/);
    const alias = aliased ? aliased[1] : null;
    const expr = aliased ? aliased[2].trim() : part;
    if (/^count\s*\(\s*\)\s*$/i.test(expr)) {
      aggregations.push({ type: "count", alias: alias || "count" });
      continue;
    }
    const sum = expr.match(/^([A-Za-z_][\w]*)\s*\.\s*sum\s*\(\s*\)\s*$/i);
    if (sum) {
      aggregations.push({
        type: "sum",
        column: sum[1],
        alias: alias || `${sum[1]}_sum`,
      });
      continue;
    }
    groupBy.push(expr);
  }
  if (!aggregations.length) return null;
  return { groupBy, aggregations };
}

function aggregateMatchedRows(matched, spec) {
  const groups = new Map();
  for (const row of matched) {
    const key = spec.groupBy.map((column) => row[column] ?? null);
    const token = JSON.stringify(key);
    if (!groups.has(token)) {
      const seed = {};
      spec.groupBy.forEach((column, index) => {
        seed[column] = key[index];
      });
      for (const agg of spec.aggregations) {
        seed[agg.alias] = agg.type === "count" ? 0 : 0;
        if (agg.type === "sum") seed[`${agg.alias}__has`] = false;
      }
      groups.set(token, seed);
    }
    const out = groups.get(token);
    for (const agg of spec.aggregations) {
      if (agg.type === "count") {
        out[agg.alias] += 1;
      } else if (agg.type === "sum") {
        const n = Number(row[agg.column]);
        if (Number.isFinite(n)) {
          out[agg.alias] += n;
          out[`${agg.alias}__has`] = true;
        }
      }
    }
  }
  return [...groups.values()].map((row) => {
    const clean = { ...row };
    for (const agg of spec.aggregations) {
      if (agg.type === "sum") {
        if (!clean[`${agg.alias}__has`]) clean[agg.alias] = null;
        delete clean[`${agg.alias}__has`];
      }
    }
    return clean;
  });
}

function matchesFilters(row, filters) {
  return filters.every((filter) => {
    if (filter.type === "eq") {
      return String(row[filter.key]) === String(filter.value);
    }
    if (filter.type === "is") {
      if (filter.value === null) return row[filter.key] == null;
      return row[filter.key] === filter.value;
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
  bosta_cities = [],
  bosta_districts = [],
  platform_admins = [],
  company_integrations = [],
  features = [],
  company_features = [],
  catalog_source_mappings = [],
  fulfillment_item_mappings = [],
  order_items = [],
  product_variants = [],
  product_options = [],
  product_option_values = [],
  variant_option_values = [],
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
    bosta_cities: bosta_cities.map((row) => ({ ...row })),
    bosta_districts: bosta_districts.map((row) => ({ ...row })),
    platform_admins: platform_admins.map((row) => ({ ...row })),
    company_integrations: company_integrations.map((row) => ({ ...row })),
    features: features.map((row) => ({ ...row })),
    company_features: company_features.map((row) => ({ ...row })),
    catalog_source_mappings: catalog_source_mappings.map((row) => ({ ...row })),
    fulfillment_item_mappings: fulfillment_item_mappings.map((row) => ({ ...row })),
    order_items: order_items.map((row) => ({ ...row })),
    product_variants: product_variants.map((row) => ({ ...row })),
    product_options: product_options.map((row) => ({ ...row })),
    product_option_values: product_option_values.map((row) => ({ ...row })),
    variant_option_values: variant_option_values.map((row) => ({ ...row })),
  };

  const DEFAULT_TEST_FEATURE_KEYS = [
    "orders",
    "products",
    "employees",
    "analytics",
    "bosta",
    "imports",
  ];
  const autoEnableDefaultFeatures =
    features.length === 0 && company_features.length === 0;
  db.__autoEnableFeatures = autoEnableDefaultFeatures;
  if (autoEnableDefaultFeatures) {
    db.features = DEFAULT_TEST_FEATURE_KEYS.map((key) => ({
      id: `feat-default-${key}`,
      key,
      name: key,
      is_active: true,
      group: key === "bosta" || key === "imports" ? "operational" : "core",
    }));
  }

  function enableDefaultFeaturesForCompany(companyId) {
    if (!db.__autoEnableFeatures) return;
    if (!db.company_features) db.company_features = [];
    for (const feature of db.features || []) {
      const exists = db.company_features.some(
        (row) =>
          String(row.company_id) === String(companyId) &&
          String(row.feature_id) === String(feature.id),
      );
      if (exists) continue;
      db.company_features.push({
        id: randomUUID(),
        company_id: companyId,
        feature_id: feature.id,
        is_enabled: true,
      });
    }
  }

  if (autoEnableDefaultFeatures) {
    for (const company of db.companies) {
      enableDefaultFeaturesForCompany(company.id);
    }
  }

  const sequences = {};
  const rpcCalls = [];
  const queryLog = [];

  function signupRpcError(code, message) {
    return {
      data: null,
      error: { code: "P0001", hint: code, message: `${code}: ${message}` },
    };
  }

  function runSignupCompanyWorkspace(args = {}) {
    const companyName = String(args.p_company_name || "").trim();
    const slug = String(args.p_slug || "").trim().toLowerCase();
    const adminName = String(args.p_admin_name || "").trim();
    const adminEmail = String(args.p_admin_email || "").trim().toLowerCase();
    const passwordHash = String(args.p_password_hash || "").trim();
    const reserved = new Set([
      "admin",
      "api",
      "login",
      "signup",
      "settings",
      "dashboard",
      "platform",
      "www",
    ]);
    if (
      !companyName ||
      !/^[a-z0-9]+(?:-[a-z0-9]+)*$/.test(slug) ||
      slug.length < 2 ||
      slug.length > 63 ||
      reserved.has(slug) ||
      !adminName ||
      !adminEmail.includes("@") ||
      !/^[$]2[aby][$][0-9]{2}[$][A-Za-z0-9./]{53}$/.test(passwordHash)
    ) {
      return signupRpcError("SIGNUP_INVALID_INPUT", "invalid signup input");
    }
    if (db.companies.some((row) => String(row.slug) === slug)) {
      return signupRpcError("SIGNUP_SLUG_CONFLICT", "workspace slug already exists");
    }
    const company = {
      id: randomUUID(),
      name: companyName,
      slug,
      is_active: true,
      deleted_at: null,
    };
    db.companies.push(company);
    if (db.employees.some((row) => String(row.company_id) === String(company.id) && String(row.email) === adminEmail)) {
      db.companies = db.companies.filter((row) => row.id !== company.id);
      return signupRpcError("SIGNUP_EMPLOYEE_CONFLICT", "employee email already exists");
    }
    const employee = {
      id: randomUUID(),
      company_id: company.id,
      name: adminName,
      email: adminEmail,
      password: passwordHash,
      role: "company_admin",
      is_active: true,
    };
    db.employees.push(employee);
    if (!db.company_features) db.company_features = [];
    if (!db.company_order_sequences) db.company_order_sequences = [];
    for (const key of ["orders", "products", "employees", "analytics"]) {
      db.company_features.push({
        id: randomUUID(),
        company_id: company.id,
        feature_key: key,
        is_enabled: true,
      });
    }
    db.company_order_sequences.push({
      company_id: company.id,
      next_value: 1001,
      start_value: 1001,
    });
    return {
      data: {
        companyId: company.id,
        companySlug: company.slug,
        companyName: company.name,
        employeeId: employee.id,
        employeeEmail: employee.email,
        employeeName: employee.name,
        role: employee.role,
      },
      error: null,
    };
  }

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
      this.headOnly = false;
      this.orderColumn = null;
      this.orderAscending = true;
    }

    select(columns = "*", options = {}) {
      this.columns = columns;
      this.countExact = options?.count === "exact";
      this.headOnly = options?.head === true;
      return this;
    }

    head() {
      this.headOnly = true;
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

    is(key, value) {
      this.filters.push({ type: "is", key, value });
      return this;
    }

    not() {
      return this;
    }

    contains() {
      return this;
    }

    or(expression) {
      this.orExpression = expression;
      return this;
    }

    ilike() {
      return this;
    }

    ilikeAllOf() {
      return this;
    }

    order(column, options = {}) {
      this.orderColumn = column;
      this.orderAscending = options.ascending !== false;
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

    applyOrFilter(rows) {
      if (!this.orExpression) return rows;
      const clauses = String(this.orExpression)
        .split(",")
        .map((part) => part.trim())
        .filter(Boolean);
      const parsed = clauses.map((clause) => {
        const jsonEq = clause.match(/^raw_data->>"?([^"=]+)"?\.eq\.(.*)$/);
        if (jsonEq) {
          return (row) => {
            const raw =
              row.raw_data && typeof row.raw_data === "object" ? row.raw_data : {};
            return String(raw[jsonEq[1]] ?? "") === jsonEq[2];
          };
        }
        return null;
      });
      if (parsed.some((fn) => !fn)) return rows;
      return rows.filter((row) => parsed.some((fn) => fn(row)));
    }

    productsIdentityConflict(existing, incoming) {
      if (this.table !== "products") return false;
      if (String(existing.company_id) !== String(incoming.company_id)) return false;
      if (String(existing.easyorder_id) !== String(incoming.easyorder_id)) return false;
      const existingNull = existing.source_integration_id == null;
      const incomingNull = incoming.source_integration_id == null;
      if (existingNull && incomingNull) return true;
      if (
        !existingNull &&
        !incomingNull &&
        String(existing.source_integration_id) ===
          String(incoming.source_integration_id)
      ) {
        return true;
      }
      return false;
    }

    ordersIdentityConflict(existing, incoming) {
      if (this.table !== "orders") return false;
      if (String(existing.company_id) !== String(incoming.company_id)) return false;
      if (String(existing.order_id) !== String(incoming.order_id)) return false;
      const existingNull = existing.source_integration_id == null;
      const incomingNull = incoming.source_integration_id == null;
      if (existingNull && incomingNull) return true;
      if (
        !existingNull &&
        !incomingNull &&
        String(existing.source_integration_id) ===
          String(incoming.source_integration_id)
      ) {
        return true;
      }
      return false;
    }

    async execute(mode) {
      if (this.action === "select" && db.__selectError && this.table === "orders") {
        queryLog.push({
          table: this.table,
          action: "select",
          columns: this.columns,
          error: true,
        });
        return { data: null, error: { message: String(db.__selectError) } };
      }
      if (
        this.action === "select" &&
        db.__selectErrors &&
        db.__selectErrors[this.table]
      ) {
        return {
          data: null,
          error: { message: String(db.__selectErrors[this.table]) },
        };
      }
      const rows = this.rowsForTable();

      if (this.action === "insert") {
        const incoming = Array.isArray(this.payload)
          ? this.payload
          : [this.payload];
        for (const item of incoming) {
          if (
            rows.some(
              (row) =>
                this.ordersIdentityConflict(row, item) ||
                this.productsIdentityConflict(row, item),
            )
          ) {
            return {
              data: null,
              error: {
                code: "23505",
                message:
                  "duplicate key value violates unique constraint \"orders_identity\"",
              },
            };
          }
        }
        const created = incoming.map((item) => {
          const row = {
            id: randomUUID(),
            created_at: new Date().toISOString(),
            updated_at: new Date().toISOString(),
            ...item,
          };
          rows.push(row);
          if (this.table === "companies") {
            enableDefaultFeaturesForCompany(row.id);
          }
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

      let matched = this.applyOrFilter(
        rows.filter((row) => matchesFilters(row, this.filters)),
      );

      if (this.orderColumn) {
        const column = this.orderColumn;
        const direction = this.orderAscending ? 1 : -1;
        matched = [...matched].sort((left, right) => {
          const av = left[column] ?? "";
          const bv = right[column] ?? "";
          if (av < bv) return -1 * direction;
          if (av > bv) return 1 * direction;
          return 0;
        });
      }

      if (this.action === "update") {
        if (!matched.length) {
          if (mode === "maybe") {
            return { data: null, error: null };
          }
          return mode === "many"
            ? { data: [], error: null, count: 0 }
            : { data: null, error: { message: "not found" } };
        }
        const updated = matched.map((row) => {
          Object.assign(row, this.payload, {
            updated_at: new Date().toISOString(),
          });
          return pickColumns(row, this.columns);
        });
        if (mode === "single") {
          if (updated.length !== 1) {
            return {
              data: null,
              error: { code: "PGRST116", message: "multiple rows" },
            };
          }
          return { data: updated[0], error: null };
        }
        if (mode === "maybe") {
          return { data: updated[0] || null, error: null };
        }
        return { data: updated, error: null, count: updated.length };
      }

      if (this.action === "delete") {
        if (this.table === "company_integrations") {
          const inUse = matched.some((integration) =>
            (db.orders || []).some(
              (order) =>
                String(order.source_integration_id || "") ===
                String(integration.id),
            ),
          );
          if (inUse) {
            return {
              data: null,
              error: {
                code: "23503",
                message:
                  "update or delete on table \"company_integrations\" violates foreign key constraint \"orders_source_integration_id_fkey\"",
              },
            };
          }
        }
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

      const aggregateSpec = parseAggregateSelect(this.columns);
      let data;
      if (aggregateSpec) {
        data = aggregateMatchedRows(matched, aggregateSpec);
      } else {
        data = matched.map((row) => pickColumns(row, this.columns));
        if (this.rangeFrom != null && this.rangeTo != null) {
          data = data.slice(this.rangeFrom, this.rangeTo + 1);
        } else if (this.limitCount != null) {
          data = data.slice(0, this.limitCount);
        }
      }

      queryLog.push({
        table: this.table,
        action: this.action,
        columns: this.columns,
        head: this.headOnly,
        aggregate: Boolean(aggregateSpec),
        matched: matched.length,
        returned: this.headOnly ? 0 : data.length,
        filters: this.filters.map((filter) => ({ ...filter })),
      });

      if (mode === "single") {
        if (!data.length) {
          return { data: null, error: { message: "not found" } };
        }
        return { data: data[0], error: null };
      }
      if (mode === "maybe") {
        return { data: data[0] || null, error: null, count: matched.length };
      }
      if (this.headOnly) {
        return { data: null, error: null, count: matched.length };
      }
      return { data, error: null, count: matched.length };
    }
  }

  return {
    from(table) {
      return new Query(table);
    },
    rpc(name, args = {}) {
      rpcCalls.push({ name, args: { ...(args || {}) } });
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
      if (name === "signup_company_workspace") {
        return Promise.resolve(runSignupCompanyWorkspace(args));
      }
      return Promise.resolve({
        data: null,
        error: { message: `unknown rpc ${name}` },
      });
    },
    __db: db,
    __sequences: sequences,
    __rpcCalls: rpcCalls,
    __queryLog: queryLog,
  };
}

module.exports = { createFakeSupabase };
