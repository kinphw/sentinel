const mysql = require('mysql2/promise');
const dotenv = require('dotenv');
const path = require('path');

dotenv.config({ path: path.resolve(__dirname, '../.env') });

async function main() {
  const conn = await mysql.createConnection({
    host: process.env.MYSQL_HOST,
    port: Number(process.env.MYSQL_PORT),
    user: process.env.MYSQL_USER,
    password: process.env.MYSQL_PASSWORD,
    database: process.env.DB_NAME,
  });

  // 1. 스키마
  console.log('=== SCHEMA ===');
  const [cols] = await conn.query(`DESCRIBE ${process.env.TABLE_NAME}`);
  console.table(cols);

  // 2. 전체 행 수
  const [[{ cnt }]] = await conn.query(`SELECT COUNT(*) AS cnt FROM ${process.env.TABLE_NAME}`);
  console.log(`\n=== 전체 행 수: ${cnt} ===\n`);

  // 3. 샘플 3건
  console.log('=== SAMPLE 3 rows ===');
  const [rows] = await conn.query(`SELECT * FROM ${process.env.TABLE_NAME} LIMIT 3`);
  console.log(JSON.stringify(rows, null, 2));

  await conn.end();
}

main().catch(console.error);
