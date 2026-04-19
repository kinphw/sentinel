import type mysql from 'mysql2/promise';
import type Anthropic from '@anthropic-ai/sdk';
import { getPool } from '../db/connection.js';
import type {
  Issue, IssueStatus, Stage,
  StageSession, SessionStatus,
  AgentRun, RunStatus, StopReason,
  Artifact, Feedback, AuthorType,
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

  async createStageSession(issueId: string, stage: Stage, inputArtifactId?: string): Promise<StageSession> {
    const id = newId();
    await this.pool.query(
      'INSERT INTO stage_sessions (id, issue_id, stage, input_artifact_id) VALUES (?, ?, ?, ?)',
      [id, issueId, stage, inputArtifactId ?? null],
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
}
