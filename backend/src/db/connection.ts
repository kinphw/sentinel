import mysql from 'mysql2/promise';

let pool: mysql.Pool | null = null;

export function getPool(): mysql.Pool {
  if (!pool) {
    pool = mysql.createPool({
      host:     process.env.MYSQL_HOST     ?? 'localhost',
      port:     Number(process.env.MYSQL_PORT ?? 3306),
      user:     process.env.MYSQL_USER     ?? 'ldbuser',
      password: process.env.MYSQL_PASSWORD ?? '1226',
      database: process.env.SENTINEL_DB_NAME ?? 'sentinel_db',
      waitForConnections: true,
      connectionLimit: 10,
      timezone: '+00:00',
    });
  }
  return pool;
}

export async function closePool(): Promise<void> {
  if (pool) {
    await pool.end();
    pool = null;
  }
}
