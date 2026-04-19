import type { AgentEvent, Artifact } from './types';

const BASE = '/api';

async function post<T>(path: string, body: unknown): Promise<T> {
  const res = await fetch(`${BASE}${path}`, {
    method: 'POST',
    headers: { 'Content-Type': 'application/json' },
    body: JSON.stringify(body),
  });
  if (!res.ok) {
    const err = await res.json().catch(() => ({ error: res.statusText }));
    throw new Error(err.error ?? res.statusText);
  }
  return res.json();
}

async function get<T>(path: string): Promise<T> {
  const res = await fetch(`${BASE}${path}`);
  if (!res.ok) throw new Error(res.statusText);
  return res.json();
}

export function createIssue(inputText: string) {
  return post<{ id: string; inputText: string }>('/issues', { inputText });
}

export function createSession(params: {
  issueId?: string;
  stage: 'STAGE_1' | 'STAGE_2';
  inputArtifactId?: string;
  manualInput?: string;
  customToc?: string;
}) {
  return post<{ id: string; issueId: string }>('/sessions', params);
}

export function getSession(sessionId: string) {
  return get<{ session: import('./types').StageSession; artifact: Artifact | null; running: boolean }>(
    `/sessions/${sessionId}`,
  );
}

export function confirmSession(sessionId: string, artifactId: string) {
  return post<{ ok: boolean }>(`/sessions/${sessionId}/confirm`, { artifactId });
}

export function submitFeedback(sessionId: string, text: string, customToc?: string) {
  return post<{ ok: boolean }>(`/sessions/${sessionId}/feedback`, { text, customToc });
}

export function getArtifacts(params: { stage?: string; status?: string } = {}) {
  const qs = new URLSearchParams(params as Record<string, string>).toString();
  return get<Artifact[]>(`/artifacts${qs ? `?${qs}` : ''}`);
}

export function streamSession(sessionId: string, onEvent: (e: AgentEvent) => void): EventSource {
  const es = new EventSource(`${BASE}/sessions/${sessionId}/stream`);
  es.onmessage = (e) => {
    try { onEvent(JSON.parse(e.data)); } catch { /* ignore */ }
  };
  return es;
}
