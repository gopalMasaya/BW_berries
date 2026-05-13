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

    // Check AllIrrigation
    try {
      const cols = await pool.request().query(`
        SELECT COLUMN_NAME, DATA_TYPE
        FROM INFORMATION_SCHEMA.COLUMNS
        WHERE TABLE_NAME = 'AllIrrigation'
        ORDER BY ORDINAL_POSITION
      `);
      console.log("=== AllIrrigation columns ===");
      console.table(cols.recordset);

      // Try to find a date column
      const dateCol = cols.recordset.find(c =>
        /date|time/i.test(c.COLUMN_NAME) && /date|time/i.test(c.DATA_TYPE)
      );
      if (dateCol) {
        const range = await pool.request().query(`
          SELECT MIN([${dateCol.COLUMN_NAME}]) AS minDate,
                 MAX([${dateCol.COLUMN_NAME}]) AS maxDate,
                 COUNT(*) AS totalRows
          FROM dbo.AllIrrigation
        `);
        console.log(`AllIrrigation range (by ${dateCol.COLUMN_NAME}):`);
        console.table(range.recordset);
      }
    } catch (e) { console.log("AllIrrigation error:", e.message); }

    // Check vIrrigation (probably a view)
    try {
      const cols = await pool.request().query(`
        SELECT COLUMN_NAME, DATA_TYPE
        FROM INFORMATION_SCHEMA.COLUMNS
        WHERE TABLE_NAME = 'vIrrigation'
        ORDER BY ORDINAL_POSITION
      `);
      console.log("\n=== vIrrigation columns ===");
      console.table(cols.recordset);

      const dateCol = cols.recordset.find(c =>
        /date|time/i.test(c.COLUMN_NAME) && /date|time/i.test(c.DATA_TYPE)
      );
      if (dateCol) {
        const range = await pool.request().query(`
          SELECT MIN([${dateCol.COLUMN_NAME}]) AS minDate,
                 MAX([${dateCol.COLUMN_NAME}]) AS maxDate,
                 COUNT(*) AS totalRows
          FROM dbo.vIrrigation
        `);
        console.log(`vIrrigation range (by ${dateCol.COLUMN_NAME}):`);
        console.table(range.recordset);
      }
    } catch (e) { console.log("vIrrigation error:", e.message); }

    // List ALL tables in case something else is collecting valve data
    const allTables = await pool.request().query(`
      SELECT TABLE_SCHEMA, TABLE_NAME, TABLE_TYPE
      FROM INFORMATION_SCHEMA.TABLES
      ORDER BY TABLE_NAME
    `);
    console.log("\n=== All tables/views in database ===");
    console.table(allTables.recordset);

    await pool.close();
    process.exit(0);
  } catch (err) {
    console.error("ERROR:", err.message);
    process.exit(1);
  }
})();
