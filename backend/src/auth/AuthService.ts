import { createHash, randomBytes, randomUUID } from 'crypto';
import type { ResultSetHeader, RowDataPacket } from 'mysql2';
import { getJdbPool } from '../db/jdb.js';
import { getPool } from '../db/connection.js';

export interface AuthenticatedUser {
  sentinelUserId: string;
  centralUserId: number;
  username: string;
  nickname: string;
  role: 'viewer' | 'operator' | 'admin';
}

export interface SessionIssueResult {
  rawToken: string;
  expiresAt: Date;
  redirectPath: string;
  user: AuthenticatedUser;
}

interface TicketRow extends RowDataPacket {
  id: number;
  central_user_id: number;
  redirect_path: string;
  username: string;
  nickname: string;
  role: 'user' | 'admin';
  is_approved: number;
}

interface SentinelUserRow extends RowDataPacket {
  id: string;
  central_user_id: number;
  username_snapshot: string;
  nickname_snapshot: string;
  sentinel_role: 'viewer' | 'operator' | 'admin';
  status: 'active' | 'disabled';
}

interface SessionLookupRow extends RowDataPacket {
  sentinel_user_id: string;
  expires_at: Date;
  central_user_id: number;
  username_snapshot: string;
  nickname_snapshot: string;
  sentinel_role: 'viewer' | 'operator' | 'admin';
  status: 'active' | 'disabled';
}

const SESSION_TTL_HOURS = Number(process.env.SESSION_TTL_HOURS ?? 12);

function sha256(value: string): string {
  return createHash('sha256').update(value).digest('hex');
}

/**
 * raw 티켓을 검증하고 1회 소비한다. 성공 시 nest 사용자 정보 + redirect_path 반환.
 * 실패 시 null. raw 티켓은 어떤 로그에도 남기지 말 것.
 */
async function consumeTicket(rawTicket: string): Promise<{
  centralUserId: number;
  username: string;
  nickname: string;
  centralRole: 'user' | 'admin';
  redirectPath: string;
} | null> {
  const ticketHash = sha256(rawTicket);
  const jdb = getJdbPool();

  const [rows] = await jdb.query<TicketRow[]>(
    `SELECT t.id, t.central_user_id, t.redirect_path,
            u.username, u.nickname, u.role, u.is_approved
       FROM sentinel_sso_tickets t
       JOIN users u ON u.id = t.central_user_id
      WHERE t.ticket_hash = ?
        AND t.consumed_at IS NULL
        AND t.expires_at > NOW()
      LIMIT 1`,
    [ticketHash],
  );

  if (rows.length === 0) return null;
  const ticket = rows[0];

  if (Number(ticket.is_approved) !== 1) return null;

  // 원자적 소비 — 0 row면 이미 소비된 티켓
  const [consumeResult] = await jdb.query<ResultSetHeader>(
    `UPDATE sentinel_sso_tickets
        SET consumed_at = NOW()
      WHERE id = ?
        AND consumed_at IS NULL`,
    [ticket.id],
  );

  if (consumeResult.affectedRows !== 1) return null;

  return {
    centralUserId: ticket.central_user_id,
    username: ticket.username,
    nickname: ticket.nickname,
    centralRole: ticket.role,
    redirectPath: ticket.redirect_path || '/',
  };
}

/**
 * sentinel_users에 upsert. 기존 행이 있으면 스냅샷·last_login만 갱신, sentinel_role은 보존.
 * 신규 행이면 nest role=admin → sentinel admin, 그 외엔 operator로 시드.
 */
async function upsertSentinelUser(opts: {
  centralUserId: number;
  username: string;
  nickname: string;
  centralRole: 'user' | 'admin';
}): Promise<AuthenticatedUser> {
  const sentinel = getPool();

  const [existing] = await sentinel.query<SentinelUserRow[]>(
    `SELECT id, central_user_id, username_snapshot, nickname_snapshot, sentinel_role, status
       FROM sentinel_users
      WHERE central_user_id = ?
      LIMIT 1`,
    [opts.centralUserId],
  );

  if (existing.length > 0) {
    const row = existing[0];
    if (row.status !== 'active') {
      throw new Error('Sentinel 계정이 비활성화 상태입니다.');
    }
    await sentinel.query(
      `UPDATE sentinel_users
          SET username_snapshot = ?,
              nickname_snapshot = ?,
              last_login_at = NOW()
        WHERE id = ?`,
      [opts.username, opts.nickname, row.id],
    );
    return {
      sentinelUserId: row.id,
      centralUserId: row.central_user_id,
      username: opts.username,
      nickname: opts.nickname,
      role: row.sentinel_role,
    };
  }

  const id = randomUUID();
  const sentinelRole: 'admin' | 'operator' = opts.centralRole === 'admin' ? 'admin' : 'operator';

  await sentinel.query(
    `INSERT INTO sentinel_users
       (id, central_user_id, username_snapshot, nickname_snapshot, sentinel_role, status, last_login_at)
     VALUES (?, ?, ?, ?, ?, 'active', NOW())`,
    [id, opts.centralUserId, opts.username, opts.nickname, sentinelRole],
  );

  return {
    sentinelUserId: id,
    centralUserId: opts.centralUserId,
    username: opts.username,
    nickname: opts.nickname,
    role: sentinelRole,
  };
}

async function issueSession(opts: {
  user: AuthenticatedUser;
  ipAddress: string | null;
  userAgent: string | null;
}): Promise<{ rawToken: string; expiresAt: Date }> {
  const sentinel = getPool();
  const rawToken = randomBytes(32).toString('base64url');
  const tokenHash = sha256(rawToken);
  const id = randomUUID();
  const expiresAt = new Date(Date.now() + SESSION_TTL_HOURS * 3600 * 1000);
  const userAgentHash = opts.userAgent ? sha256(opts.userAgent) : null;

  await sentinel.query(
    `INSERT INTO sentinel_web_sessions
       (id, sentinel_user_id, session_token_hash, expires_at, ip_address, user_agent_hash)
     VALUES (?, ?, ?, ?, ?, ?)`,
    [id, opts.user.sentinelUserId, tokenHash, expiresAt, opts.ipAddress, userAgentHash],
  );

  return { rawToken, expiresAt };
}

/**
 * 티켓 콜백 진입점: 티켓 검증·소비 → sentinel_users upsert → 세션 발급.
 * 실패하면 throw. 메시지는 사용자에게 노출돼도 안전한 수준으로 작성.
 */
export async function handleSsoCallback(opts: {
  rawTicket: string;
  ipAddress: string | null;
  userAgent: string | null;
}): Promise<SessionIssueResult> {
  if (!opts.rawTicket || opts.rawTicket.length < 32) {
    throw new Error('티켓 형식이 올바르지 않습니다.');
  }

  const ticket = await consumeTicket(opts.rawTicket);
  if (!ticket) {
    throw new Error('만료되었거나 이미 사용된 티켓입니다.');
  }

  const user = await upsertSentinelUser({
    centralUserId: ticket.centralUserId,
    username: ticket.username,
    nickname: ticket.nickname,
    centralRole: ticket.centralRole,
  });

  const session = await issueSession({
    user,
    ipAddress: opts.ipAddress,
    userAgent: opts.userAgent,
  });

  return {
    rawToken: session.rawToken,
    expiresAt: session.expiresAt,
    redirectPath: ticket.redirectPath,
    user,
  };
}

/**
 * 쿠키의 raw 토큰으로 활성 세션을 찾고 사용자 정보를 반환한다.
 * 만료/취소/비활성 사용자면 null. 호출자가 401 처리.
 */
export async function lookupSession(rawToken: string): Promise<AuthenticatedUser | null> {
  if (!rawToken) return null;
  const tokenHash = sha256(rawToken);
  const sentinel = getPool();

  const [rows] = await sentinel.query<SessionLookupRow[]>(
    `SELECT s.sentinel_user_id, s.expires_at,
            u.central_user_id, u.username_snapshot, u.nickname_snapshot, u.sentinel_role, u.status
       FROM sentinel_web_sessions s
       JOIN sentinel_users u ON u.id = s.sentinel_user_id
      WHERE s.session_token_hash = ?
        AND s.revoked_at IS NULL
        AND s.expires_at > NOW()
      LIMIT 1`,
    [tokenHash],
  );

  if (rows.length === 0) return null;
  const row = rows[0];
  if (row.status !== 'active') return null;

  // last_seen_at 갱신은 best-effort, 실패해도 무시
  sentinel
    .query(`UPDATE sentinel_web_sessions SET last_seen_at = NOW() WHERE session_token_hash = ?`, [tokenHash])
    .catch(() => {});

  return {
    sentinelUserId: row.sentinel_user_id,
    centralUserId: row.central_user_id,
    username: row.username_snapshot,
    nickname: row.nickname_snapshot,
    role: row.sentinel_role,
  };
}

/**
 * 로그아웃: 해당 세션 토큰만 폐기. 실패해도 클라이언트는 쿠키만 지우면 됨.
 */
export async function revokeSession(rawToken: string): Promise<void> {
  if (!rawToken) return;
  const tokenHash = sha256(rawToken);
  await getPool().query(
    `UPDATE sentinel_web_sessions SET revoked_at = NOW() WHERE session_token_hash = ? AND revoked_at IS NULL`,
    [tokenHash],
  );
}
