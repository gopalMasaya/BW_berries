const sql = require("mssql");
const CFG = {
  server: "45.83.43.235", port: 14445, user: "gopal", password: "1a@S3d$F",
  database: "Tal_Irrigation",
  options: { encrypt: false, trustServerCertificate: true, requestTimeout: 30000, connectionTimeout: 15000 },
};
(async () => {
  const pool = await sql.connect(CFG);

  console.log("=== Controllers table (all columns) ===");
  const c = await pool.request().query(`SELECT * FROM dbo.Controllers`);
  for (const r of c.recordset) console.log(JSON.stringify(r));

  console.log("\n=== distinct Sensor_Label values across PCS_ID ===");
  const labels = await pool.request().query(`
    SELECT Sensor_Label, COUNT(*) c FROM dbo.PCS_ID GROUP BY Sensor_Label ORDER BY Sensor_Label`);
  for (const r of labels.recordset) console.log(`  ${r.Sensor_Label}  x${r.c}`);

  console.log("\n=== PCS_ID full column list ===");
  const cols = await pool.request().query(`
    SELECT COLUMN_NAME, DATA_TYPE FROM INFORMATION_SCHEMA.COLUMNS
    WHERE TABLE_NAME='PCS_ID' ORDER BY ORDINAL_POSITION`);
  console.log(cols.recordset.map(r=>r.COLUMN_NAME+"("+r.DATA_TYPE+")").join(", "));

  console.log("\n=== sample 8 PCS_ID rows ===");
  const s = await pool.request().query(`SELECT TOP 8 * FROM dbo.PCS_ID`);
  for (const r of s.recordset) console.log(JSON.stringify(r));

  await pool.close();
})().catch(e => { console.error("ERR:", e.message); process.exit(1); });
