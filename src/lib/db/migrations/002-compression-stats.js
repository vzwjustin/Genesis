// Add per-request compression statistics table.
// Stores individual compression records (RTK, Headroom, Caveman) per request.
import { TABLES, buildCreateTableSql } from "../schema.js";

export default {
  version: 2,
  name: "compression-stats",
  up(db) {
    db.exec(buildCreateTableSql("compressionStats", TABLES.compressionStats));
    for (const idx of TABLES.compressionStats.indexes || []) {
      db.exec(idx);
    }
  },
};
