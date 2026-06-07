const sql = require("mssql");
const CFG = {
  server: "45.83.43.235", port: 14445, user: "gopal", password: "1a@S3d$F",
  database: "Tal_Irrigation",
  options: { encrypt: false, trustServerCertificate: true, requestTimeout: 30000, connectionTimeout: 15000 },
};
(async () => {
  const pool = await sql.connect(CFG);
  const t = await pool.request().query(`
    SELECT t.name AS tbl,
           (SELECT SUM(p.rows) FROM sys.partitions p WHERE p.object_id=t.object_id AND p.index_id IN (0,1)) AS rows
    FROM sys.tables t
    ORDER BY t.name
  `);
  console.log("=== TABLES (" + t.recordset.length + ") ===");
  for (const r of t.recordset) console.log(`  ${r.tbl}  (rows=${r.rows})`);

  // Highlight anything fert/tank/recirc/dose/ec/ph/level related
  const cols = await pool.request().query(`
    SELECT c.TABLE_NAME, c.COLUMN_NAME, c.DATA_TYPE
    FROM INFORMATION_SCHEMA.COLUMNS c
    WHERE c.COLUMN_NAME LIKE '%fert%' OR c.COLUMN_NAME LIKE '%tank%'
       OR c.COLUMN_NAME LIKE '%recirc%' OR c.COLUMN_NAME LIKE '%dose%'
       OR c.COLUMN_NAME LIKE '%dish%' OR c.COLUMN_NAME LIKE '%level%'
       OR c.TABLE_NAME LIKE '%fert%' OR c.TABLE_NAME LIKE '%tank%'
       OR c.TABLE_NAME LIKE '%recirc%' OR c.TABLE_NAME LIKE '%dose%'
    ORDER BY c.TABLE_NAME, c.ORDINAL_POSITION
  `);
  console.log("\n=== fert/tank/recirc/dose/level COLUMNS ===");
  for (const r of cols.recordset) console.log(`  ${r.TABLE_NAME}.${r.COLUMN_NAME} (${r.DATA_TYPE})`);
  await pool.close();
})().catch(e => { console.error("ERR:", e.message); process.exit(1); });
