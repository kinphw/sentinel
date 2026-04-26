import { useEffect, useRef, useState } from 'react';
import * as api from '../api';
import { useAgentMode } from '../AgentModeContext';
import type { AgentEvent, Artifact, LogEntry } from '../types';
import { fmtCost } from '../utils';
import EventLog from './EventLog';

type InputMode = 'new' | 'artifact';
type Phase = 'idle' | 'running' | 'waiting' | 'confirmed' | 'interrupted';

const ACTIVE_SESSION_KEY = 'sentinel.stage1.activeSessionId';

export default function Stage1Tab() {
  const { mode: agentMode } = useAgentMode();
  const [inputMode, setInputMode] = useState<InputMode>('new');
  const [issueText, setIssueText]   = useState('');
  const [artifacts, setArtifacts]   = useState<Artifact[]>([]);
  const [selectedArtifactId, setSelectedArtifactId] = useState('');
  const [developmentNote, setDevelopmentNote] = useState('');
  const [phase, setPhase]           = useState<Phase>('idle');
  const [logEntries, setLogEntries] = useState<LogEntry[]>([]);
  const [streamText, setStreamText] = useState('');
  const [awaiting, setAwaiting]     = useState(false);
  const [artifact, setArtifact]     = useState<Artifact | null>(null);
  const [feedbackText, setFeedbackText] = useState('');
  const [showFeedback, setShowFeedback] = useState(false);
  const [statusMsg, setStatusMsg]   = useState('');

  const sessionIdRef  = useRef<string | null>(null);
  const esRef         = useRef<EventSource | null>(null);
  const logIdRef      = useRef(0);
  const streamTextRef = useRef('');

  useEffect(() => {
    refreshArtifacts().catch(console.error);
    restoreSession().catch(console.error);
  }, []);

  async function restoreSession() {
    const saved = localStorage.getItem(ACTIVE_SESSION_KEY);
    if (!saved) return;

    try {
      const { session, artifact: a, running } = await api.getSession(saved);
      sessionIdRef.current = saved;

      if (['CONFIRMED', 'SUPERSEDED'].includes(session.status)) {
        localStorage.removeItem(ACTIVE_SESSION_KEY);
        return;
      }

      if (running) {
        setPhase('running');
        addLog('🔁 진행 중인 세션에 재연결합니다', 'system');
        esRef.current?.close();
        esRef.current = api.streamSession(saved, handleEvent);
        return;
      }

      if (session.status === 'WAITING_FOR_HUMAN' && a) {
        setArtifact(a);
        setPhase('waiting');
        addLog('🔁 confirm/feedback 대기 중인 세션 복원', 'system');
        return;
      }

      if (['READY', 'FAILED'].includes(session.status)) {
        setPhase('interrupted');
        addLog('🔁 중단된 세션 복원 — ▶ 재개로 이어서 실행할 수 있습니다', 'system');
        setStatusMsg('이전 세션이 일시 오류 등으로 중단되었습니다. 원인을 해결한 후 ▶ 재개를 눌러주세요.');
        return;
      }
    } catch {
      // 세션이 삭제되었거나 조회 실패 — localStorage 정리
      localStorage.removeItem(ACTIVE_SESSION_KEY);
    }
  }

  function addLog(text: string, kind: LogEntry['kind']) {
    setLogEntries(prev => [...prev, { id: logIdRef.current++, text, kind }]);
  }

  function handleEvent(event: AgentEvent) {
    switch (event.type) {
      case 'api_start':
        addLog(`🤔 [API #${event.apiCount}] Claude 추론 중...`, 'info');
        streamTextRef.current = '';
        setStreamText('');
        setAwaiting(true);
        break;
      case 'text':
        streamTextRef.current += event.delta;
        setStreamText(streamTextRef.current);
        setAwaiting(false);
        break;
      case 'response_end': {
        const finalThought = streamTextRef.current.trim();
        if (finalThought) addLog(`💭 ${finalThought}`, 'system');
        streamTextRef.current = '';
        setStreamText('');
        setAwaiting(false);
        break;
      }
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
      case 'cost': {
        const cacheStr = event.cacheReadTokens > 0 || event.cacheCreationTokens > 0
          ? `  [📦 cache: ${event.cacheReadTokens.toLocaleString()} read / ${event.cacheCreationTokens.toLocaleString()} write]`
          : '';
        addLog(
          `💰 API #${event.apiCount}: ${event.inputTokens.toLocaleString()}in / ${event.outputTokens.toLocaleString()}out  ${fmtCost(event.inputTokens, event.outputTokens, event.cacheReadTokens, event.cacheCreationTokens)}${cacheStr}`,
          'cost',
        );
        break;
      }
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
        addLog(
          event.recoverable
            ? `⚠️ 일시 오류(재개 가능): ${event.message}`
            : `❌ 오류: ${event.message}`,
          'error',
        );
        break;
      case 'done': {
        const cacheSummary = event.totalCacheRead > 0 || event.totalCacheCreation > 0
          ? ` | 📦 ${event.totalCacheRead.toLocaleString()} cached read / ${event.totalCacheCreation.toLocaleString()} write`
          : '';
        const total = `${event.totalIn.toLocaleString()}in / ${event.totalOut.toLocaleString()}out${cacheSummary}`;
        addLog(
          `✔ 종료 — API ${event.apiCount}회 | ${total} | ${fmtCost(event.totalIn, event.totalOut, event.totalCacheRead, event.totalCacheCreation)}`,
          'cost',
        );
        setAwaiting(false);
        esRef.current?.close();
        if (event.finalStatus === 'waiting_for_human') {
          fetchArtifact();
        } else if (event.finalStatus === 'interrupted') {
          setPhase('interrupted');
          setStatusMsg('일시적 오류(잔액·rate limit·네트워크 등)로 중단되었습니다. 원인을 해결한 후 ▶ 재개를 눌러주세요. 대화 이력은 모두 보존되어 있습니다.');
        } else {
          setPhase('idle');
          setStatusMsg('에이전트가 복구 불가 오류로 종료되었습니다.');
          localStorage.removeItem(ACTIVE_SESSION_KEY);
        }
        break;
      }
    }
  }

  async function handleResume() {
    if (!sessionIdRef.current) return;
    setPhase('running');
    setStatusMsg('');
    try {
      await api.resumeSession(sessionIdRef.current);
      esRef.current?.close();
      esRef.current = api.streamSession(sessionIdRef.current, handleEvent);
    } catch (e) {
      addLog(`❌ 재개 실패: ${(e as Error).message}`, 'error');
      setPhase('interrupted');
    }
  }

  async function fetchArtifact() {
    if (!sessionIdRef.current) return;
    const { artifact: a } = await api.getSession(sessionIdRef.current);
    setArtifact(a);
    setPhase('waiting');
    await refreshArtifacts();
  }

  async function refreshArtifacts() {
    const list = await api.getArtifacts({ stage: 'STAGE_1' });
    setArtifacts(list);
  }

  async function startRun() {
    setPhase('running');
    setLogEntries([]);
    setStreamText('');
    setArtifact(null);
    setStatusMsg('');
    setShowFeedback(false);

    try {
      let sessionId: string;

      if (inputMode === 'new') {
        if (!issueText.trim()) {
          setPhase('idle');
          setStatusMsg('이슈 내용을 입력하세요.');
          return;
        }
        const { id: issueId } = await api.createIssue(issueText);
        ({ id: sessionId } = await api.createSession({ issueId, stage: 'STAGE_1', agentMode }));
      } else {
        if (!selectedArtifactId) {
          setPhase('idle');
          setStatusMsg('기존 Stage 1 결과물을 선택하세요.');
          return;
        }
        const selected = artifacts.find(a => a.id === selectedArtifactId);
        if (!selected?.issue_id) {
          setPhase('idle');
          setStatusMsg('선택한 결과물의 이슈 정보를 찾지 못했습니다.');
          return;
        }
        ({
          id: sessionId,
        } = await api.createSession({
          issueId: selected.issue_id,
          stage: 'STAGE_1',
          agentMode,
          inputArtifactId: selectedArtifactId,
          developmentNote: developmentNote.trim() || undefined,
        }));
      }

      sessionIdRef.current = sessionId;
      localStorage.setItem(ACTIVE_SESSION_KEY, sessionId);

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
    localStorage.removeItem(ACTIVE_SESSION_KEY);
    setPhase('confirmed');
    setStatusMsg(`✅ 확정 완료 — Artifact ID: ${artifact.id}`);
    await refreshArtifacts();
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

      <div style={{ display: 'flex', gap: 12 }}>
        {(['new', 'artifact'] as InputMode[]).map(mode => (
          <label key={mode} style={{ display: 'flex', alignItems: 'center', gap: 6, cursor: 'pointer' }}>
            <input
              type="radio"
              checked={inputMode === mode}
              onChange={() => setInputMode(mode)}
              disabled={phase === 'running'}
            />
            <span style={{ fontSize: 13 }}>
              {mode === 'new' ? '새 이슈로 시작' : '기존 Stage 1 결과 발전'}
            </span>
          </label>
        ))}
      </div>

      {inputMode === 'new' ? (
        <div>
          <label style={{ display: 'block', marginBottom: 6, fontWeight: 600, fontSize: 13 }}>이슈 내용</label>
          <textarea
            value={issueText}
            onChange={e => setIssueText(e.target.value)}
            rows={6}
            placeholder="검토가 필요한 이슈를 입력하세요..."
            disabled={phase === 'running'}
          />
        </div>
      ) : (
        <>
          <div>
            <label style={{ display: 'block', marginBottom: 6, fontWeight: 600, fontSize: 13 }}>기존 Stage 1 결과물</label>
            <select
              value={selectedArtifactId}
              onChange={e => setSelectedArtifactId(e.target.value)}
              disabled={phase === 'running'}
            >
              <option value="">— 선택하세요 —</option>
              {artifacts.map(a => (
                <option key={a.id} value={a.id}>
                  {a.status} | v{a.version} | {a.created_at.slice(0, 16)} | {a.summary ?? '(요약 없음)'}
                </option>
              ))}
            </select>
            {selectedArtifactId && (() => {
              const selected = artifacts.find(a => a.id === selectedArtifactId);
              return selected ? (
                <pre style={{
                  marginTop: 8, background: '#f8fafc', borderRadius: 4, padding: 10,
                  fontSize: 12, lineHeight: 1.6, maxHeight: 160, overflowY: 'auto',
                  whiteSpace: 'pre-wrap', wordBreak: 'break-word', color: '#374151',
                }}>
                  {selected.content.slice(0, 700)}{selected.content.length > 700 ? '…' : ''}
                </pre>
              ) : null;
            })()}
          </div>

          <div>
            <label style={{ display: 'block', marginBottom: 6, fontWeight: 600, fontSize: 13 }}>
              추가 개발 요청
            </label>
            <textarea
              value={developmentNote}
              onChange={e => setDevelopmentNote(e.target.value)}
              rows={4}
              placeholder="예) 최근 논점 추가 반영, 표현 보수화, 특정 근거 보강 등"
              disabled={phase === 'running'}
            />
          </div>
        </>
      )}

      <div>
        <button
          onClick={startRun}
          disabled={phase === 'running' || (inputMode === 'new' ? !issueText.trim() : !selectedArtifactId)}
          style={{ background: '#2563eb', color: '#fff', padding: '8px 20px' }}
        >
          {phase === 'running' ? '⏳ 실행 중...' : inputMode === 'new' ? '검토 시작' : '선택 결과 발전'}
        </button>
      </div>

      {/* 이벤트 로그 */}
      <EventLog entries={logEntries} streamText={streamText} awaiting={awaiting} />

      {/* 재개 버튼 — 일시적 오류로 중단된 경우 */}
      {phase === 'interrupted' && (
        <div style={{ background: '#fef3c7', border: '1px solid #f59e0b', borderRadius: 8, padding: 14, display: 'flex', gap: 10, alignItems: 'center' }}>
          <div style={{ flex: 1, fontSize: 13, color: '#78350f' }}>
            대화 이력이 DB에 저장되어 있어 같은 지점에서 이어서 실행할 수 있습니다.
          </div>
          <button
            onClick={handleResume}
            style={{ background: '#2563eb', color: '#fff', padding: '8px 18px', whiteSpace: 'nowrap' }}
          >▶ 재개</button>
        </div>
      )}

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
