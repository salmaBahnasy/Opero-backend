/**
 * In-memory transactional catalog store for C1G writer tests.
 * Clones on begin, commits by replacing store contents, rolls back by discard.
 * Enforces Migration-013 uniqueness that the writer must respect.
 */

function cloneRows(rows) {
  return JSON.parse(JSON.stringify(rows || []));
}

function createMemoryCatalogStore(seed = {}) {
  return {
    products: cloneRows(seed.products),
    product_variants: cloneRows(seed.product_variants || seed.variants),
    product_options: cloneRows(seed.product_options || seed.options),
    product_option_values: cloneRows(
      seed.product_option_values || seed.option_values || seed.optionValues,
    ),
    variant_option_values: cloneRows(
      seed.variant_option_values || seed.links,
    ),
    catalog_source_mappings: cloneRows(
      seed.catalog_source_mappings || seed.source_mappings || seed.mappings,
    ),
    company_integrations: cloneRows(
      seed.company_integrations || seed.integrations,
    ),
  };
}

function matches(row, filters = {}) {
  return Object.entries(filters).every(([key, value]) => {
    if (value === undefined) return true;
    if (value === null) return row[key] == null;
    return String(row[key]) === String(value);
  });
}

function uniqueError(message) {
  const error = new Error(message);
  error.code = "CATALOG_WRITE_UNIQUE_VIOLATION";
  return error;
}

function assertUniques(table, rows, incoming) {
  if (table === "product_variants") {
    if (incoming.is_default) {
      const clash = rows.find(
        (row) =>
          String(row.company_id) === String(incoming.company_id) &&
          String(row.product_id) === String(incoming.product_id) &&
          row.is_default === true &&
          String(row.id) !== String(incoming.id),
      );
      if (clash) throw uniqueError("product_variants_one_default_uidx");
    }
    if (incoming.internal_sku != null && String(incoming.internal_sku).trim() !== "") {
      const clash = rows.find(
        (row) =>
          String(row.company_id) === String(incoming.company_id) &&
          row.internal_sku != null &&
          String(row.internal_sku) === String(incoming.internal_sku) &&
          String(row.id) !== String(incoming.id),
      );
      if (clash) throw uniqueError("product_variants_company_internal_sku_uidx");
    }
    if (incoming.barcode != null && String(incoming.barcode).trim() !== "") {
      const clash = rows.find(
        (row) =>
          String(row.company_id) === String(incoming.company_id) &&
          row.barcode != null &&
          String(row.barcode) === String(incoming.barcode) &&
          String(row.id) !== String(incoming.id),
      );
      if (clash) throw uniqueError("product_variants_company_barcode_uidx");
    }
  }
  if (table === "product_options") {
    const clash = rows.find(
      (row) =>
        String(row.company_id) === String(incoming.company_id) &&
        String(row.product_id) === String(incoming.product_id) &&
        String(row.name) === String(incoming.name) &&
        String(row.id) !== String(incoming.id),
    );
    if (clash) throw uniqueError("product_options_product_name_unique");
  }
  if (table === "product_option_values") {
    const clash = rows.find(
      (row) =>
        String(row.company_id) === String(incoming.company_id) &&
        String(row.option_id) === String(incoming.option_id) &&
        String(row.value) === String(incoming.value) &&
        String(row.id) !== String(incoming.id),
    );
    if (clash) throw uniqueError("product_option_values_option_value_unique");
  }
  if (table === "variant_option_values") {
    const clash = rows.find(
      (row) =>
        String(row.company_id) === String(incoming.company_id) &&
        String(row.variant_id) === String(incoming.variant_id) &&
        String(row.option_id) === String(incoming.option_id) &&
        String(row.id) !== String(incoming.id),
    );
    if (clash) throw uniqueError("variant_option_values_variant_option_unique");
  }
  if (table === "catalog_source_mappings") {
    const clash = rows.find(
      (row) =>
        String(row.company_id) === String(incoming.company_id) &&
        String(row.integration_id) === String(incoming.integration_id) &&
        String(row.external_product_id) === String(incoming.external_product_id) &&
        String(row.external_variant_id ?? "") === String(incoming.external_variant_id ?? "") &&
        String(row.id) !== String(incoming.id),
    );
    if (clash) throw uniqueError("catalog_source_mappings_identity_unique");
  }
}

function createMemoryCatalogTransaction(store, options = {}) {
  const stats = {
    begins: 0,
    commits: 0,
    rollbacks: 0,
    inserts: 0,
    updates: 0,
    deletes: 0,
    selects: 0,
  };
  let working = null;
  let failOn = options.failOn || null;

  function active() {
    if (!working) {
      const error = new Error("Catalog transaction is not active");
      error.code = "CATALOG_WRITE_TRANSACTION_INACTIVE";
      throw error;
    }
    return working;
  }

  function maybeFail(table, action) {
    if (!failOn) return;
    if (failOn.table && failOn.table !== table) return;
    if (failOn.action && failOn.action !== action) return;
    const error = new Error(failOn.message || `Injected failure on ${table}.${action}`);
    error.code = failOn.code || "INJECTED_FAILURE";
    failOn = null;
    throw error;
  }

  return {
    stats,
    failOn(next) {
      failOn = next;
    },
    async begin() {
      working = createMemoryCatalogStore(store);
      stats.begins += 1;
    },
    async commit() {
      const snapshot = active();
      for (const table of Object.keys(store)) {
        store[table].length = 0;
        store[table].push(...snapshot[table]);
      }
      working = null;
      stats.commits += 1;
    },
    async rollback() {
      working = null;
      stats.rollbacks += 1;
    },
    async select(table, filters = {}) {
      stats.selects += 1;
      const rows = active()[table] || [];
      return rows.filter((row) => matches(row, filters)).map((row) => ({ ...row }));
    },
    async insert(table, row) {
      maybeFail(table, "insert");
      const rows = active()[table];
      if (!rows) {
        throw new Error(`Unknown catalog table ${table}`);
      }
      const incoming = { ...row };
      assertUniques(table, rows, incoming);
      rows.push(incoming);
      stats.inserts += 1;
      return { ...incoming };
    },
    async update(table, id, patch, companyId) {
      maybeFail(table, "update");
      const rows = active()[table];
      const index = rows.findIndex(
        (row) =>
          String(row.id) === String(id) &&
          String(row.company_id) === String(companyId),
      );
      if (index < 0) {
        throw new Error(`No ${table} row ${id} for company ${companyId}`);
      }
      const next = { ...rows[index], ...patch, id: rows[index].id, company_id: rows[index].company_id };
      if (table === "product_variants" || table === "product_options") {
        next.product_id = rows[index].product_id;
      }
      assertUniques(table, rows, next);
      rows[index] = next;
      stats.updates += 1;
      return { ...next };
    },
    async delete() {
      stats.deletes += 1;
      throw new Error("C1G catalog writer tests forbid delete()");
    },
  };
}

function existingFromStore(store) {
  return {
    variants: [...store.product_variants],
    options: [...store.product_options],
    optionValues: [...store.product_option_values],
    sourceMappings: [...store.catalog_source_mappings],
  };
}

module.exports = {
  createMemoryCatalogStore,
  createMemoryCatalogTransaction,
  existingFromStore,
};
