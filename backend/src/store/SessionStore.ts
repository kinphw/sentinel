import type mysql from 'mysql2/promise';
import type Anthropic from '@anthropic-ai/sdk';
import { getPool } from '../db/connection.js';
import type {
  Issue, IssueStatus, Stage,
  StageSession, SessionStatus,
  AgentRun, RunStatus, StopReason,
  Artifact, Feedback, AuthorType,
  AgentMode,
} from '../models/types.js';

function newId(): string {
  return crypto.randomUUID();
}

export class SessionStore {
  private get pool(): mysql.Pool { return getPool(); }

  // ─── Issue ────────────────────────────────────────────────

  async createIssue(inputText: string): Promise<Issue> {
    const id = newId();
    await this.pool.query(
      'INSERT INTO issues (id, input_text) VALUES (?, ?)',
      [id, inputText],
    );
    return this.getIssue(id);
  }

  async getIssue(id: string): Promise<Issue> {
    const [rows] = await this.pool.query<mysql.RowDataPacket[]>(
      'SELECT * FROM issues WHERE id = ? LIMIT 1', [id],
    );
    if (rows.length === 0) throw new Error(`Issue not found: ${id}`);
    return rows[0] as unknown as Issue;
  }

  async updateIssueStatus(id: string, status: IssueStatus, currentStage?: Stage): Promise<void> {
    if (currentStage !== undefined) {
      await this.pool.query(
        'UPDATE issues SET status = ?, current_stage = ? WHERE id = ?',
        [status, currentStage, id],
      );
    } else {
      await this.pool.query('UPDATE issues SET status = ? WHERE id = ?', [status, id]);
    }
  }

  // ─── StageSession ─────────────────────────────────────────

  async createStageSession(
    issueId: string,
    stage: Stage,
    agentMode: AgentMode,
    inputArtifactId?: string,
  ): Promise<StageSession> {
    const id = newId();
    await this.pool.query(
      'INSERT INTO stage_sessions (id, issue_id, stage, agent_mode, input_artifact_id) VALUES (?, ?, ?, ?, ?)',
      [id, issueId, stage, agentMode, inputArtifactId ?? null],
    );
    return this.getStageSession(id);
  }

  async getStageSession(id: string): Promise<StageSession> {
    const [rows] = await this.pool.query<mysql.RowDataPacket[]>(
      'SELECT * FROM stage_sessions WHERE id = ? LIMIT 1', [id],
    );
    if (rows.length === 0) throw new Error(`StageSession not found: ${id}`);
    return rows[0] as unknown as StageSession;
  }

  async updateSessionStatus(id: string, status: SessionStatus): Promise<void> {
    await this.pool.query('UPDATE stage_sessions SET status = ? WHERE id = ?', [status, id]);
  }

  async markWaitingForHuman(sessionId: string, artifactId: string): Promise<void> {
    await this.pool.query(
      'UPDATE stage_sessions SET status = ?, latest_artifact_id = ? WHERE id = ?',
      ['WAITING_FOR_HUMAN', artifactId, sessionId],
    );
  }

  async confirmArtifact(sessionId: string, artifactId: string): Promise<void> {
    await this.pool.query(
      'UPDATE stage_sessions SET status = ?, confirmed_artifact_id = ? WHERE id = ?',
      ['CONFIRMED', artifactId, sessionId],
    );
    await this.pool.query(
      "UPDATE artifacts SET status = 'confirmed' WHERE id = ?",
      [artifactId],
    );
    await this.pool.query(
      "UPDATE artifacts SET status = 'superseded' WHERE stage_session_id = ? AND id != ? AND status = 'draft'",
      [sessionId, artifactId],
    );
  }

  async incrementRetryCount(id: string): Promise<void> {
    await this.pool.query(
      'UPDATE stage_sessions SET retry_count = retry_count + 1, last_feedback_at = NOW() WHERE id = ?',
      [id],
    );
  }

  // ─── AgentRun ─────────────────────────────────────────────

  async createAgentRun(sessionId: string, model: string): Promise<AgentRun> {
    const id = newId();
    await this.pool.query(
      'INSERT INTO agent_runs (id, stage_session_id, model, status, started_at) VALUES (?, ?, ?, ?, NOW())',
      [id, sessionId, model, 'RUNNING'],
    );
    return this.getAgentRun(id);
  }

  async getAgentRun(id: string): Promise<AgentRun> {
    const [rows] = await this.pool.query<mysql.RowDataPacket[]>(
      'SELECT * FROM agent_runs WHERE id = ? LIMIT 1', [id],
    );
    if (rows.length === 0) throw new Error(`AgentRun not found: ${id}`);
    return rows[0] as unknown as AgentRun;
  }

  async updateRunStatus(id: string, status: RunStatus, stopReason?: StopReason): Promise<void> {
    await this.pool.query(
      'UPDATE agent_runs SET status = ?, stop_reason = ?, ended_at = NOW() WHERE id = ?',
      [status, stopReason ?? null, id],
    );
  }

  // ─── Artifact ─────────────────────────────────────────────

  async createArtifact(sessionId: string, content: string, summary: string): Promise<Artifact> {
    const id = newId();
    const [rows] = await this.pool.query<mysql.RowDataPacket[]>(
      'SELECT COALESCE(MAX(version), 0) + 1 AS next_version FROM artifacts WHERE stage_session_id = ?',
      [sessionId],
    );
    const version = (rows[0] as { next_version: number }).next_version;
    await this.pool.query(
      'INSERT INTO artifacts (id, stage_session_id, version, content, summary) VALUES (?, ?, ?, ?, ?)',
      [id, sessionId, version, content, summary || null],
    );
    return this.getArtifact(id);
  }

  async getArtifact(id: string): Promise<Artifact> {
    const [rows] = await this.pool.query<mysql.RowDataPacket[]>(
      'SELECT * FROM artifacts WHERE id = ? LIMIT 1', [id],
    );
    if (rows.length === 0) throw new Error(`Artifact not found: ${id}`);
    return rows[0] as unknown as Artifact;
  }

  async getArtifactWithContext(id: string): Promise<Artifact> {
    const [rows] = await this.pool.query<mysql.RowDataPacket[]>(
      `SELECT a.*, ss.stage AS session_stage, ss.issue_id
       FROM artifacts a
       JOIN stage_sessions ss ON a.stage_session_id = ss.id
       WHERE a.id = ?
       LIMIT 1`,
      [id],
    );
    if (rows.length === 0) throw new Error(`Artifact not found: ${id}`);
    return rows[0] as unknown as Artifact;
  }

  async getArtifactsList(params: {
    stage?: string;
    status?: string;
    issueId?: string;
    limit?: number;
  } = {}): Promise<Artifact[]> {
    const conditions: string[] = [];
    const values: unknown[] = [];
    if (params.stage)   { conditions.push('ss.stage = ?');    values.push(params.stage); }
    if (params.status)  { conditions.push('a.status = ?');    values.push(params.status); }
    if (params.issueId) { conditions.push('ss.issue_id = ?'); values.push(params.issueId); }
    const where = conditions.length > 0 ? `WHERE ${conditions.join(' AND ')}` : '';
    const [rows] = await this.pool.query<mysql.RowDataPacket[]>(
      `SELECT a.*, ss.stage AS session_stage, ss.issue_id
       FROM artifacts a
       JOIN stage_sessions ss ON a.stage_session_id = ss.id
       ${where}
       ORDER BY a.created_at DESC
       LIMIT ?`,
      [...values, params.limit ?? 50],
    );
    return rows as unknown as Artifact[];
  }

  // ─── Feedback ─────────────────────────────────────────────

  async createFeedback(sessionId: string, content: string, authorType: AuthorType = 'user'): Promise<Feedback> {
    const id = newId();
    await this.pool.query(
      'INSERT INTO feedbacks (id, stage_session_id, author_type, content) VALUES (?, ?, ?, ?)',
      [id, sessionId, authorType, content],
    );
    return this.getFeedback(id);
  }

  async getFeedback(id: string): Promise<Feedback> {
    const [rows] = await this.pool.query<mysql.RowDataPacket[]>(
      'SELECT * FROM feedbacks WHERE id = ? LIMIT 1', [id],
    );
    if (rows.length === 0) throw new Error(`Feedback not found: ${id}`);
    return rows[0] as unknown as Feedback;
  }

  // ─── Message ──────────────────────────────────────────────

  async appendMessage(
    sessionId: string,
    runId: string | null,
    msg: Anthropic.MessageParam,
  ): Promise<void> {
    await this.pool.query(
      'INSERT INTO messages (id, stage_session_id, agent_run_id, role, api_message) VALUES (?, ?, ?, ?, ?)',
      [newId(), sessionId, runId, msg.role, JSON.stringify(msg)],
    );
  }

  async replaceLastMessage(sessionId: string, msg: Anthropic.MessageParam): Promise<void> {
    await this.pool.query(
      `UPDATE messages
       SET role = ?, api_message = ?
       WHERE id = (
         SELECT id FROM (
           SELECT id
           FROM messages
           WHERE stage_session_id = ?
           ORDER BY seq DESC
           LIMIT 1
         ) AS latest
       )`,
      [msg.role, JSON.stringify(msg), sessionId],
    );
  }

  async getApiMessages(sessionId: string): Promise<Anthropic.MessageParam[]> {
    const [rows] = await this.pool.query<mysql.RowDataPacket[]>(
      'SELECT api_message FROM messages WHERE stage_session_id = ? ORDER BY seq ASC',
      [sessionId],
    );
    return rows.map(r => JSON.parse(r.api_message as string) as Anthropic.MessageParam);
  }

  // ─── Admin ────────────────────────────────────────────────

  async getAdminIssues(params: {
    query?: string;
    stage?: string;
    onlyMock?: boolean;
    limit?: number;
  } = {}): Promise<Array<{
    id: string;
    input_text: string;
    status: IssueStatus;
    current_stage: Stage | null;
    created_at: Date;
    updated_at: Date;
    session_count: number;
    artifact_count: number;
    confirmed_artifact_count: number;
    latest_stage: Stage | null;
    latest_artifact_summary: string | null;
    latest_artifact_created_at: Date | null;
    is_mock: boolean;
  }>> {
    const conditions: string[] = [];
    const values: unknown[] = [];

    if (params.query?.trim()) {
      conditions.push(
        `(i.input_text LIKE ? OR EXISTS (
          SELECT 1
          FROM stage_sessions ssq
          JOIN artifacts aq ON aq.stage_session_id = ssq.id
          WHERE ssq.issue_id = i.id
            AND (aq.summary LIKE ? OR aq.content LIKE ?)
        ))`,
      );
      const keyword = `%${params.query.trim()}%`;
      values.push(keyword, keyword, keyword);
    }

    if (params.stage) {
      conditions.push('EXISTS (SELECT 1 FROM stage_sessions sst WHERE sst.issue_id = i.id AND sst.stage = ?)');
      values.push(params.stage);
    }

    if (params.onlyMock) {
      conditions.push(
        `EXISTS (SELECT 1 FROM stage_sessions ssm WHERE ssm.issue_id = i.id AND ssm.agent_mode = 'mock')`,
      );
    }

    const where = conditions.length > 0 ? `WHERE ${conditions.join(' AND ')}` : '';
    const [rows] = await this.pool.query<mysql.RowDataPacket[]>(
      `SELECT
         i.*,
         COUNT(DISTINCT ss.id) AS session_count,
         COUNT(a.id) AS artifact_count,
         SUM(CASE WHEN a.status = 'confirmed' THEN 1 ELSE 0 END) AS confirmed_artifact_count,
         MAX(CASE WHEN ss.agent_mode = 'mock' THEN 1 ELSE 0 END) AS has_mock_session,
         latest.stage AS latest_stage,
         latest.summary AS latest_artifact_summary,
         latest.created_at AS latest_artifact_created_at
       FROM issues i
       LEFT JOIN stage_sessions ss ON ss.issue_id = i.id
       LEFT JOIN artifacts a ON a.stage_session_id = ss.id
       LEFT JOIN (
         SELECT ss2.issue_id, ss2.stage, a2.summary, a2.created_at
         FROM artifacts a2
         JOIN stage_sessions ss2 ON ss2.id = a2.stage_session_id
         JOIN (
           SELECT ss3.issue_id, MAX(a3.created_at) AS latest_created_at
           FROM artifacts a3
           JOIN stage_sessions ss3 ON ss3.id = a3.stage_session_id
           GROUP BY ss3.issue_id
         ) latest_max
           ON latest_max.issue_id = ss2.issue_id
          AND latest_max.latest_created_at = a2.created_at
       ) latest ON latest.issue_id = i.id
       ${where}
       GROUP BY
         i.id, i.input_text, i.status, i.current_stage, i.created_at, i.updated_at,
         latest.stage, latest.summary, latest.created_at
       ORDER BY COALESCE(latest.created_at, i.created_at) DESC
       LIMIT ?`,
      [...values, params.limit ?? 100],
    );

    return rows.map((row) => ({
      ...(row as unknown as {
        id: string;
        input_text: string;
        status: IssueStatus;
        current_stage: Stage | null;
        created_at: Date;
        updated_at: Date;
        session_count: number;
        artifact_count: number;
        confirmed_artifact_count: number;
        latest_stage: Stage | null;
        latest_artifact_summary: string | null;
        latest_artifact_created_at: Date | null;
      }),
      is_mock: Number(row.has_mock_session ?? 0) > 0,
    }));
  }

  async getAdminIssueDetail(issueId: string): Promise<{
    issue: Issue & { is_mock: boolean };
    sessions: Array<StageSession & {
      artifacts: Artifact[];
      feedbacks: Feedback[];
      run_count: number;
      message_count: number;
    }>;
  }> {
    const issue = await this.getIssue(issueId);

    const [sessionRows] = await this.pool.query<mysql.RowDataPacket[]>(
      'SELECT * FROM stage_sessions WHERE issue_id = ? ORDER BY created_at DESC',
      [issueId],
    );

    const sessions = await Promise.all(sessionRows.map(async (sessionRow) => {
      const session = sessionRow as unknown as StageSession;
      const [artifactRows] = await this.pool.query<mysql.RowDataPacket[]>(
        'SELECT * FROM artifacts WHERE stage_session_id = ? ORDER BY version DESC, created_at DESC',
        [session.id],
      );
      const [feedbackRows] = await this.pool.query<mysql.RowDataPacket[]>(
        'SELECT * FROM feedbacks WHERE stage_session_id = ? ORDER BY created_at DESC',
        [session.id],
      );
      const [runRows] = await this.pool.query<mysql.RowDataPacket[]>(
        'SELECT COUNT(*) AS count FROM agent_runs WHERE stage_session_id = ?',
        [session.id],
      );
      const [messageRows] = await this.pool.query<mysql.RowDataPacket[]>(
        'SELECT COUNT(*) AS count FROM messages WHERE stage_session_id = ?',
        [session.id],
      );

      return {
        ...session,
        artifacts: artifactRows as unknown as Artifact[],
        feedbacks: feedbackRows as unknown as Feedback[],
        run_count: Number((runRows[0] as { count: number }).count ?? 0),
        message_count: Number((messageRows[0] as { count: number }).count ?? 0),
      };
    }));

    const isMock = sessions.some(session => session.agent_mode === 'mock');

    return {
      issue: { ...issue, is_mock: isMock },
      sessions,
    };
  }

  async deleteIssueCascade(issueId: string): Promise<{
    deletedIssueId: string;
    deletedSessionCount: number;
    deletedArtifactCount: number;
    deletedFeedbackCount: number;
    deletedRunCount: number;
    deletedMessageCount: number;
  }> {
    const conn = await this.pool.getConnection();

    try {
      await conn.beginTransaction();

      const [sessionRows] = await conn.query<mysql.RowDataPacket[]>(
        'SELECT id FROM stage_sessions WHERE issue_id = ?',
        [issueId],
      );
      const sessionIds = sessionRows.map(row => String(row.id));

      let deletedArtifactCount = 0;
      let deletedFeedbackCount = 0;
      let deletedRunCount = 0;
      let deletedMessageCount = 0;

      if (sessionIds.length > 0) {
        const placeholders = sessionIds.map(() => '?').join(', ');

        const [artifactResult] = await conn.query<mysql.ResultSetHeader>(
          `DELETE FROM artifacts WHERE stage_session_id IN (${placeholders})`,
          sessionIds,
        );
        deletedArtifactCount = artifactResult.affectedRows;

        const [feedbackResult] = await conn.query<mysql.ResultSetHeader>(
          `DELETE FROM feedbacks WHERE stage_session_id IN (${placeholders})`,
          sessionIds,
        );
        deletedFeedbackCount = feedbackResult.affectedRows;

        const [runResult] = await conn.query<mysql.ResultSetHeader>(
          `DELETE FROM agent_runs WHERE stage_session_id IN (${placeholders})`,
          sessionIds,
        );
        deletedRunCount = runResult.affectedRows;

        const [messageResult] = await conn.query<mysql.ResultSetHeader>(
          `DELETE FROM messages WHERE stage_session_id IN (${placeholders})`,
          sessionIds,
        );
        deletedMessageCount = messageResult.affectedRows;

        await conn.query(
          `DELETE FROM stage_sessions WHERE id IN (${placeholders})`,
          sessionIds,
        );
      }

      const [issueResult] = await conn.query<mysql.ResultSetHeader>(
        'DELETE FROM issues WHERE id = ?',
        [issueId],
      );

      if (issueResult.affectedRows === 0) {
        throw new Error(`Issue not found: ${issueId}`);
      }

      await conn.commit();

      return {
        deletedIssueId: issueId,
        deletedSessionCount: sessionIds.length,
        deletedArtifactCount,
        deletedFeedbackCount,
        deletedRunCount,
        deletedMessageCount,
      };
    } catch (error) {
      await conn.rollback();
      throw error;
    } finally {
      conn.release();
    }
  }
}
