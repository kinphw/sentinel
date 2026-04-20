import mysql from 'mysql2/promise';
import type { FssDocumentDetail, FssDocumentSummary } from '../types/index.js';

let pool: mysql.Pool | null = null;

function getPool(): mysql.Pool {
  if (!pool) {
    pool = mysql.createPool({
      host: process.env.MYSQL_HOST ?? 'localhost',
      port: Number(process.env.MYSQL_PORT ?? 3306),
      user: process.env.MYSQL_USER,
      password: process.env.MYSQL_PASSWORD,
      database: process.env.DB_NAME,
      waitForConnections: true,
      connectionLimit: 5,
    });
  }
  return pool;
}

function getTable(): string {
  return process.env.TABLE_NAME ?? 'documents';
}

function formatDateTime(value: Date | string | null): string {
  if (!value) return '';
  if (typeof value === 'string') return value;
  return value.toISOString().replace('T', ' ').slice(0, 19);
}

function joinPath(directory: string, filename: string): string {
  if (!directory) return filename;
  if (directory.endsWith('\\') || directory.endsWith('/')) return `${directory}${filename}`;
  return `${directory}\\${filename}`;
}

export async function searchFssDocuments(query: string, limit: number = 20): Promise<FssDocumentSummary[]> {
  const table = getTable();
  const keywords = query.split(/\s+/).map(keyword => keyword.trim()).filter(Boolean);
  if (keywords.length === 0) return [];

  const params: unknown[] = [];
  const whereClauses = keywords.map(keyword => {
    const like = `%${keyword}%`;
    params.push(like, like);
    return '(directory LIKE ? OR filename LIKE ?)';
  });

  params.push(limit);

  const sql = `
    SELECT id, directory, filename, extension, file_size, file_mtime, parsed_at
    FROM \`${table}\`
    WHERE parse_status = 'success'
      AND ${whereClauses.join(' AND ')}
    ORDER BY parsed_at DESC, id DESC
    LIMIT ?
  `;

  const [rows] = await getPool().query<mysql.RowDataPacket[]>(sql, params);
  return rows.map(row => ({
    id: row.id,
    path: joinPath(row.directory ?? '', row.filename ?? ''),
    directory: row.directory ?? '',
    filename: row.filename ?? '',
    extension: row.extension ?? '',
    file_size: Number(row.file_size ?? 0),
    file_mtime: row.file_mtime ?? '',
    parsed_at: formatDateTime(row.parsed_at ?? null),
  }));
}

export async function getFssDocument(id: number): Promise<FssDocumentDetail | null> {
  const table = getTable();
  const [rows] = await getPool().query<mysql.RowDataPacket[]>(
    `
      SELECT id, directory, filename, extension, file_size, file_mtime, body_text, parse_status, error_msg, parsed_at
      FROM \`${table}\`
      WHERE id = ?
      LIMIT 1
    `,
    [id],
  );

  if (rows.length === 0) return null;

  const row = rows[0];
  return {
    id: row.id,
    path: joinPath(row.directory ?? '', row.filename ?? ''),
    directory: row.directory ?? '',
    filename: row.filename ?? '',
    extension: row.extension ?? '',
    file_size: Number(row.file_size ?? 0),
    file_mtime: row.file_mtime ?? '',
    parsed_at: formatDateTime(row.parsed_at ?? null),
    parse_status: (row.parse_status ?? 'success') as 'success' | 'error' | 'skip',
    error_msg: row.error_msg ?? '',
    body_text: row.body_text ?? '',
  };
}
