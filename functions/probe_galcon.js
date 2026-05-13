const sql = require("mssql");

const config = {
  server: "45.83.43.235",
  port: 14445,
  user: "gopal",
  password: "1a@S3d$F",
  database: "Tal_Irrigation",
  options: {
    encrypt: false,
    trustServerCertificate: true,
    requestTimeout: 30000,
    connectionTimeout: 15000,
  },
};

(async () => {
  try {
    const pool = await sql.connect(config);

    const range = await pool.request().query(`
      SELECT
        MIN(DateTimeStartValve) AS minDate,
        MAX(DateTimeStartValve) AS maxDate,
        COUNT(*) AS totalRows
      FROM dbo.ValveData
    `);
    console.log("=== dbo.ValveData range ===");
    console.table(range.recordset);

    const recent = await pool.request().query(`
      SELECT TOP 15
        CAST(DateTimeStartValve AS DATE) AS day,
        COUNT(*) AS rows
      FROM dbo.ValveData
      GROUP BY CAST(DateTimeStartValve AS DATE)
      ORDER BY day DESC
    `);
    console.log("\n=== Most recent 15 days of valve events ===");
    console.table(recent.recordset);

    const perController = await pool.request().query(`
      SELECT c.ID, c.SerialNumber,
             MAX(v.DateTimeStartValve) AS lastValveEvent,
             COUNT(v.ID) AS totalEvents
      FROM dbo.Controllers c
      LEFT JOIN dbo.ValveData v ON v.ControllerID = c.ID
      GROUP BY c.ID, c.SerialNumber
      ORDER BY c.ID
    `);
    console.log("\n=== Last valve event per controller ===");
    console.table(perController.recordset);

    await pool.close();
    process.exit(0);
  } catch (err) {
    console.error("ERROR:", err.message);
    process.exit(1);
  }
})();
