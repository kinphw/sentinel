import mysql from 'mysql2/promise';
import type { InterpretationSummary, InterpretationDetail, 구분Type } from '../types/index.js';

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
  const t = process.env.TABLE_NAME;
  if (!t) throw new Error('TABLE_NAME 환경변수가 설정되지 않았습니다.');
  return t;
}

function formatDate(d: Date | null): string {
  if (!d) return '';
  return d.toISOString().slice(0, 10);
}

export async function searchInterpretation(
  query: string,
  구분?: 구분Type,
  limit: number = 10,
): Promise<InterpretationSummary[]> {
  const table = getTable();
  // 공백으로 분리한 각 어절이 모두 포함된 결과만 반환 (lawquery UI와 동일)
  const keywords = query.split(/\s+/).filter(k => k.length > 0);
  const params: unknown[] = [];

  const whereClauses = keywords.map(kw => {
    const like = `%${kw}%`;
    params.push(like, like, like, like);
    return `(제목 LIKE ? OR 질의요지 LIKE ? OR 회답 LIKE ? OR 이유 LIKE ?)`;
  });

  let sql = `SELECT id, 구분, 분야, 제목, 회신일자, 일련번호
             FROM \`${table}\`
             WHERE (${whereClauses.join(' AND ')})`;
  if (구분) {
    sql += ' AND 구분 = ?';
    params.push(구분);
  }
  sql += ' ORDER BY 회신일자 DESC LIMIT ?';
  params.push(limit);

  const [rows] = await getPool().query<mysql.RowDataPacket[]>(sql, params);
  return rows.map(r => ({
    id: r.id,
    구분: r.구분 ?? '',
    분야: r.분야 ?? '',
    제목: r.제목 ?? '',
    회신일자: formatDate(r.회신일자),
    일련번호: r.일련번호 ?? '',
  }));
}

export async function getInterpretation(id: number): Promise<InterpretationDetail | null> {
  const table = getTable();
  const [rows] = await getPool().query<mysql.RowDataPacket[]>(
    `SELECT id, 구분, 분야, 제목, 회신부서, 회신일자, 일련번호, 질의요지, 회답, 이유
     FROM \`${table}\` WHERE id = ? LIMIT 1`,
    [id],
  );
  if (rows.length === 0) return null;
  const r = rows[0];
  return {
    id: r.id,
    구분: r.구분 ?? '',
    분야: r.분야 ?? '',
    제목: r.제목 ?? '',
    회신부서: r.회신부서 ?? '',
    회신일자: formatDate(r.회신일자),
    일련번호: r.일련번호 ?? '',
    질의요지: r.질의요지 ?? '',
    회답: r.회답 ?? '',
    이유: r.이유 ?? '',
  };
}
