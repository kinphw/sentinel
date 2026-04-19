import type Anthropic from '@anthropic-ai/sdk';

export type IssueStatus    = 'OPEN' | 'IN_PROGRESS' | 'WAITING_CONFIRM' | 'COMPLETED' | 'FAILED';
export type Stage          = 'STAGE_1' | 'STAGE_2' | 'STAGE_3';
export type SessionStatus  = 'READY' | 'RUNNING' | 'WAITING_FOR_HUMAN' | 'CONFIRMED' | 'SUPERSEDED' | 'FAILED';
export type RunStatus      = 'QUEUED' | 'RUNNING' | 'PAUSED_FOR_TOOL' | 'PAUSED_FOR_HUMAN' | 'COMPLETED' | 'FAILED';
export type StopReason     = 'tool' | 'human' | 'completed' | 'error';
export type ArtifactStatus = 'draft' | 'confirmed' | 'superseded';
export type AuthorType     = 'user' | 'reviewer';
export type MessageRole    = 'system' | 'user' | 'assistant';

export interface Issue {
  id: string;
  input_text: string;
  status: IssueStatus;
  current_stage: Stage | null;
  created_at: Date;
  updated_at: Date;
}

export interface StageSession {
  id: string;
  issue_id: string;
  stage: Stage;
  status: SessionStatus;
  input_artifact_id: string | null;
  latest_artifact_id: string | null;
  confirmed_artifact_id: string | null;
  retry_count: number;
  last_feedback_at: Date | null;
  created_at: Date;
  updated_at: Date;
}

export interface AgentRun {
  id: string;
  stage_session_id: string;
  status: RunStatus;
  model: string;
  started_at: Date | null;
  ended_at: Date | null;
  stop_reason: StopReason | null;
}

export interface Artifact {
  id: string;
  stage_session_id: string;
  version: number;
  status: ArtifactStatus;
  content: string;
  summary: string | null;
  created_at: Date;
}

export interface Feedback {
  id: string;
  stage_session_id: string;
  author_type: AuthorType;
  content: string;
  created_at: Date;
}

export interface Message {
  id: string;
  stage_session_id: string;
  agent_run_id: string | null;
  role: MessageRole;
  api_message: Anthropic.MessageParam;
  created_at: Date;
}
