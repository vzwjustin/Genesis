function getDb(env) {
  const db = env?.DB;
  if (!db) throw new Error("Cloud DB binding is not configured");
  return db;
}

async function ensureSchema(db) {
  const sql = `CREATE TABLE IF NOT EXISTS machineData (
    machineId TEXT PRIMARY KEY,
    data TEXT NOT NULL,
    updatedAt TEXT NOT NULL
  )`;
  if (typeof db.exec === "function") {
    await db.exec(sql);
    return;
  }
  await db.prepare(sql).run();
}

export async function getMachineData(env, machineId) {
  if (!machineId) return null;
  const db = getDb(env);
  await ensureSchema(db);
  const row = await db
    .prepare("SELECT data FROM machineData WHERE machineId = ?")
    .bind(machineId)
    .first();
  if (!row?.data) return null;
  return JSON.parse(row.data);
}

export async function saveMachineData(env, machineId, data) {
  if (!machineId) throw new Error("machineId is required");
  const db = getDb(env);
  await ensureSchema(db);
  await db
    .prepare("INSERT INTO machineData(machineId, data, updatedAt) VALUES(?, ?, ?) ON CONFLICT(machineId) DO UPDATE SET data = excluded.data, updatedAt = excluded.updatedAt")
    .bind(machineId, JSON.stringify(data || {}), new Date().toISOString())
    .run();
}
