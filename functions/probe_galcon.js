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
      SELECT MIN(DateTimeStartValve) AS minDate,
             MAX(DateTimeStartValve) AS maxDate,
             COUNT(*) AS totalRows
      FROM dbo.ValveData
    `);
    console.log("=== dbo.ValveData ===");
    console.table(range.recordset);
    await pool.close();
    process.exit(0);
  } catch (err) {
    console.error("ERROR:", err.message);
    process.exit(1);
  }
})();
