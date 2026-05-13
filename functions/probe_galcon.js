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
    console.log("Connecting...");
    const pool = await sql.connect(config);
    console.log("Connected.\n");

    const valveRange = await pool.request().query(`
      SELECT
        MIN(DateTimeStartValve) AS minDate,
        MAX(DateTimeStartValve) AS maxDate,
        COUNT(*) AS totalRows
      FROM dbo.ValveData
    `);
    console.log("=== dbo.ValveData ===");
    console.table(valveRange.recordset);

    const sensorRange = await pool.request().query(`
      SELECT
        MIN([Time]) AS minDate,
        MAX([Time]) AS maxDate,
        COUNT(*) AS totalRows
      FROM dbo.PCS_Value
    `);
    console.log("\n=== dbo.PCS_Value ===");
    console.table(sensorRange.recordset);

    const drainRange = await pool.request().query(`
      SELECT
        MIN([Time]) AS minDate,
        MAX([Time]) AS maxDate,
        COUNT(*) AS totalRows
      FROM dbo.PCS_Value_Drain_Percent
    `);
    console.log("\n=== dbo.PCS_Value_Drain_Percent ===");
    console.table(drainRange.recordset);

    const valveByDay = await pool.request().query(`
      SELECT TOP 35
        CAST(DateTimeStartValve AS DATE) AS day,
        COUNT(*) AS rows
      FROM dbo.ValveData
      GROUP BY CAST(DateTimeStartValve AS DATE)
      ORDER BY day ASC
    `);
    console.log("\n=== Valve rows per day (oldest 35) ===");
    console.table(valveByDay.recordset);

    const sensorByDay = await pool.request().query(`
      SELECT TOP 35
        CAST([Time] AS DATE) AS day,
        COUNT(*) AS rows
      FROM dbo.PCS_Value
      GROUP BY CAST([Time] AS DATE)
      ORDER BY day ASC
    `);
    console.log("\n=== Sensor rows per day (oldest 35) ===");
    console.table(sensorByDay.recordset);

    await pool.close();
    process.exit(0);
  } catch (err) {
    console.error("ERROR:", err.message);
    if (err.originalError) console.error("Inner:", err.originalError.message);
    process.exit(1);
  }
})();
