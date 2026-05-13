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

    // Last 35 days of valve events to see the cliff
    const valveTail = await pool.request().query(`
      SELECT TOP 35
        CAST(DateTimeStartValve AS DATE) AS day,
        COUNT(*) AS rows
      FROM dbo.ValveData
      GROUP BY CAST(DateTimeStartValve AS DATE)
      ORDER BY day DESC
    `);
    console.log("=== Valve rows per day (most recent 35) ===");
    console.table(valveTail.recordset);

    // Per controller — did they all stop, or just some?
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

    // List all tables containing 'valve' to see if data went elsewhere
    const tables = await pool.request().query(`
      SELECT TABLE_SCHEMA, TABLE_NAME
      FROM INFORMATION_SCHEMA.TABLES
      WHERE TABLE_NAME LIKE '%alve%' OR TABLE_NAME LIKE '%rrig%'
      ORDER BY TABLE_NAME
    `);
    console.log("\n=== Tables related to valves/irrigation ===");
    console.table(tables.recordset);

    await pool.close();
    process.exit(0);
  } catch (err) {
    console.error("ERROR:", err.message);
    process.exit(1);
  }
})();
