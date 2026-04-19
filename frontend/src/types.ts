export type AgentEvent =
  | { type: 'api_start'; apiCount: number }
  | { type: 'text'; delta: string }
  | { type: 'response_end' }
  | { type: 'tool_call'; seq: number; name: string; argsStr: string }
  | { type: 'tool_result'; seq: number; isError: boolean; preview: string }
  | { type: 'submit' }
  | { type: 'artifact'; artifactId: string; version: number; summary: string }
  | { type: 'cost'; apiCount: number; inputTokens: number; outputTokens: number; totalIn: number; totalOut: number }
  | { type: 'done'; finalStatus: 'waiting_for_human' | 'failed'; apiCount: number; totalIn: number; totalOut: number }
  | { type: 'error'; message: string }
  | { type: 'rate_limit'; waitSec: number; attempt: number }
  | { type: 'compaction'; before: number; after: number }
  | { type: 'force_stop'; reason: 'consecutive_errors' | 'max_tool_calls' };

export interface Artifact {
  id: string;
  stage_session_id: string;
  version: number;
  status: 'draft' | 'confirmed' | 'superseded';
  content: string;
  summary: string | null;
  created_at: string;
  session_stage?: string;
  issue_id?: string;
}

export interface StageSession {
  id: string;
  issue_id: string;
  stage: 'STAGE_1' | 'STAGE_2' | 'STAGE_3';
  status: 'READY' | 'RUNNING' | 'WAITING_FOR_HUMAN' | 'CONFIRMED' | 'SUPERSEDED' | 'FAILED';
  latest_artifact_id: string | null;
  confirmed_artifact_id: string | null;
  retry_count: number;
}

export interface LogEntry {
  id: number;
  text: string;
  kind: 'info' | 'tool' | 'result' | 'error' | 'cost' | 'system';
}
