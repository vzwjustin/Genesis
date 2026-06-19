function Database() {
  if (globalThis.__nineRouterMockSqliteThrow) {
    throw new Error("SQLITE_CANTOPEN");
  }
  return globalThis.__nineRouterMockSqliteDb;
}
module.exports = Database;
module.exports.default = Database;
