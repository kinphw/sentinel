import mysql from 'mysql2/promise';

let pool: mysql.Pool | null = null;

export function getJdbPool(): mysql.Pool {
  if (!pool) {
    pool = mysql.createPool({
      host:     process.env.JDB_HOST     ?? 'localhost',
      port:     Number(process.env.JDB_PORT ?? 3306),
      user:     process.env.JDB_USER     ?? 'root',
      password: process.env.JDB_PASSWORD ?? '',
      database: process.env.JDB_NAME     ?? 'jdb',
      waitForConnections: true,
      connectionLimit: 4,
      timezone: '+00:00',
    });
  }
  return pool;
}

export async function closeJdbPool(): Promise<void> {
  if (pool) {
    await pool.end();
    pool = null;
  }
}
