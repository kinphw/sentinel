import { useState, useRef } from 'react';
import * as api from '../api';
import type { AgentEvent, Artifact, LogEntry } from '../types';
import EventLog from './EventLog';

type Phase = 'idle' | 'running' | 'waiting' | 'confirmed';

export default function Stage1Tab() {
  const [issueText, setIssueText]   = useState('');
  const [phase, setPhase]           = useState<Phase>('idle');
  const [logEntries, setLogEntries] = useState<LogEntry[]>([]);
  const [streamText, setStreamText] = useState('');
  const [artifact, setArtifact]     = useState<Artifact | null>(null);
  const [feedbackText, setFeedbackText] = useState('');
  const [showFeedback, setShowFeedback] = useState(false);
  const [statusMsg, setStatusMsg]   = useState('');

  const sessionIdRef  = useRef<string | null>(null);
  const esRef         = useRef<EventSource | null>(null);
  const logIdRef      = useRef(0);

  function addLog(text: string, kind: LogEntry['kind']) {
    setLogEntries(prev => [...prev, { id: logIdRef.current++, text, kind }]);
  }

  function handleEvent(event: AgentEvent) {
    switch (event.type) {
      case 'api_start':
        addLog(`🤔 [API #${event.apiCount}] Claude 추론 중...`, 'info');
        setStreamText('');
        break;
      case 'text':
        setStreamText(prev => prev + event.delta);
        break;
      case 'response_end':
        setStreamText('');
        break;
      case 'tool_call':
        addLog(`🔧 [#${event.seq}] ${event.name}(${event.argsStr})`, 'tool');
        break;
      case 'tool_result':
        addLog(
          event.isError
            ? `❌ [#${event.seq}] ${event.preview}`
            : `✅ [#${event.seq}] ${event.preview}`,
          event.isError ? 'error' : 'result',
        );
        break;
      case 'submit':
        addLog('📤 submit_for_review 호출', 'info');
        break;
      case 'artifact':
        addLog(`📝 초안 v${event.version} 생성 완료`, 'info');
        // artifact 내용은 done 이후 별도 조회
        break;
      case 'cost':
        addLog(
          `💰 API #${event.apiCount}: ${event.inputTokens.toLocaleString()}in / ${event.outputTokens.toLocaleString()}out`,
          'cost',
        );
        break;
      case 'compaction':
        addLog(`🗜 컨텍스트 압축: ${event.before} → ${event.after}`, 'system');
        break;
      case 'rate_limit':
        addLog(`⏳ Rate limit — ${event.waitSec}초 대기 (${event.attempt}/3)`, 'system');
        break;
      case 'force_stop':
        addLog(
          event.reason === 'consecutive_errors'
            ? '⛔ 연속 도구 오류 3회 → 강제 중단'
            : '⚠️ 최대 도구 호출 수 도달 → 강제 중단',
          'error',
        );
        break;
      case 'error':
        addLog(`❌ 오류: ${event.message}`, 'error');
        break;
      case 'done': {
        const total = `${event.totalIn.toLocaleString()}in / ${event.totalOut.toLocaleString()}out`;
        addLog(`✔ 완료 — API ${event.apiCount}회 | ${total}`, 'cost');
        esRef.current?.close();
        if (event.finalStatus === 'waiting_for_human') {
          fetchArtifact();
        } else {
          setPhase('idle');
          setStatusMsg('에이전트가 오류로 종료되었습니다.');
        }
        break;
      }
    }
  }

  async function fetchArtifact() {
    if (!sessionIdRef.current) return;
    const { artifact: a } = await api.getSession(sessionIdRef.current);
    setArtifact(a);
    setPhase('waiting');
  }

  async function startRun() {
    if (!issueText.trim()) return;
    setPhase('running');
    setLogEntries([]);
    setStreamText('');
    setArtifact(null);
    setStatusMsg('');
    setShowFeedback(false);

    try {
      const { id: issueId } = await api.createIssue(issueText);
      const { id: sessionId } = await api.createSession({ issueId, stage: 'STAGE_1' });
      sessionIdRef.current = sessionId;

      esRef.current?.close();
      esRef.current = api.streamSession(sessionId, handleEvent);
    } catch (e) {
      addLog(`❌ ${(e as Error).message}`, 'error');
      setPhase('idle');
    }
  }

  async function handleConfirm() {
    if (!sessionIdRef.current || !artifact) return;
    await api.confirmSession(sessionIdRef.current, artifact.id);
    setPhase('confirmed');
    setStatusMsg(`✅ 확정 완료 — Artifact ID: ${artifact.id}`);
  }

  async function handleFeedback() {
    if (!sessionIdRef.current || !feedbackText.trim()) return;
    setShowFeedback(false);
    setPhase('running');
    setArtifact(null);
    setStatusMsg('');

    await api.submitFeedback(sessionIdRef.current, feedbackText);
    setFeedbackText('');

    esRef.current?.close();
    esRef.current = api.streamSession(sessionIdRef.current!, handleEvent);
  }

  return (
    <div style={{ display: 'flex', flexDirection: 'column', gap: 16 }}>
      <h2 style={{ fontSize: 16, fontWeight: 700, color: '#1e3a5f' }}>Stage 1 — 검토 결론</h2>

      {/* 이슈 입력 */}
      <div>
        <label style={{ display: 'block', marginBottom: 6, fontWeight: 600, fontSize: 13 }}>이슈 내용</label>
        <textarea
          value={issueText}
          onChange={e => setIssueText(e.target.value)}
          rows={6}
          placeholder="검토가 필요한 이슈를 입력하세요..."
          disabled={phase === 'running' || phase === 'confirmed'}
        />
      </div>

      <div>
        <button
          onClick={startRun}
          disabled={phase === 'running' || !issueText.trim()}
          style={{ background: '#2563eb', color: '#fff', padding: '8px 20px' }}
        >
          {phase === 'running' ? '⏳ 실행 중...' : '검토 시작'}
        </button>
      </div>

      {/* 이벤트 로그 */}
      <EventLog entries={logEntries} streamText={streamText} />

      {/* 초안 표시 */}
      {artifact && (
        <div style={{ background: '#fff', border: '1px solid #e5e7eb', borderRadius: 8, padding: 16 }}>
          <div style={{ display: 'flex', justifyContent: 'space-between', alignItems: 'center', marginBottom: 10 }}>
            <h3 style={{ fontSize: 14, fontWeight: 700 }}>
              검토 결론 초안 v{artifact.version}
              {artifact.summary && (
                <span style={{ fontWeight: 400, color: '#6b7280', marginLeft: 8 }}>— {artifact.summary}</span>
              )}
            </h3>
            {phase === 'waiting' && (
              <div style={{ display: 'flex', gap: 8 }}>
                <button
                  onClick={handleConfirm}
                  style={{ background: '#16a34a', color: '#fff' }}
                >확정</button>
                <button
                  onClick={() => setShowFeedback(v => !v)}
                  style={{ background: '#f59e0b', color: '#fff' }}
                >피드백</button>
              </div>
            )}
          </div>
          <pre style={{
            whiteSpace: 'pre-wrap',
            wordBreak: 'break-word',
            fontSize: 13,
            lineHeight: 1.7,
            color: '#1e293b',
            background: '#f8fafc',
            borderRadius: 4,
            padding: 12,
          }}>
            {artifact.content}
          </pre>
        </div>
      )}

      {/* 피드백 입력 */}
      {showFeedback && (
        <div style={{ background: '#fffbeb', border: '1px solid #fbbf24', borderRadius: 8, padding: 14 }}>
          <label style={{ display: 'block', marginBottom: 6, fontWeight: 600, fontSize: 13 }}>피드백</label>
          <textarea
            value={feedbackText}
            onChange={e => setFeedbackText(e.target.value)}
            rows={4}
            placeholder="수정 요청 내용을 입력하세요..."
          />
          <div style={{ marginTop: 8, display: 'flex', gap: 8 }}>
            <button
              onClick={handleFeedback}
              disabled={!feedbackText.trim()}
              style={{ background: '#f59e0b', color: '#fff' }}
            >피드백 제출</button>
            <button onClick={() => setShowFeedback(false)} style={{ background: '#e5e7eb' }}>취소</button>
          </div>
        </div>
      )}

      {/* 상태 메시지 */}
      {statusMsg && (
        <p style={{ fontSize: 13, color: '#16a34a', fontWeight: 600 }}>{statusMsg}</p>
      )}
    </div>
  );
}
