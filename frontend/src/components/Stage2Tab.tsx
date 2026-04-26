import { useState, useRef, useEffect } from 'react';
import * as api from '../api';
import { useAgentMode } from '../AgentModeContext';
import type { AgentEvent, Artifact, LogEntry } from '../types';
import { fmtCost } from '../utils';
import EventLog from './EventLog';

type InputMode = 'db' | 'manual';
type Phase = 'idle' | 'running' | 'waiting' | 'confirmed' | 'interrupted';

const ACTIVE_SESSION_KEY = 'sentinel.stage2.activeSessionId';

export default function Stage2Tab() {
  const { mode: agentMode } = useAgentMode();
  const [inputMode, setInputMode]       = useState<InputMode | 'stage2'>('db');
  const [stage1Artifacts, setStage1Artifacts] = useState<Artifact[]>([]);
  const [stage2Artifacts, setStage2Artifacts] = useState<Artifact[]>([]);
  const [selectedArtifactId, setSelectedArtifactId] = useState('');
  const [selectedStage2ArtifactId, setSelectedStage2ArtifactId] = useState('');
  const [selectedInputText, setSelectedInputText] = useState('');
  const [manualInput, setManualInput]   = useState('');
  const [customToc, setCustomToc]       = useState('');
  const [showCustomToc, setShowCustomToc] = useState(false);
  const [phase, setPhase]               = useState<Phase>('idle');
  const [logEntries, setLogEntries]     = useState<LogEntry[]>([]);
  const [streamText, setStreamText]     = useState('');
  const [awaiting, setAwaiting]         = useState(false);
  const [report, setReport]             = useState<Artifact | null>(null);
  const [feedbackText, setFeedbackText] = useState('');
  const [showFeedback, setShowFeedback] = useState(false);
  const [statusMsg, setStatusMsg]       = useState('');

  const sessionIdRef = useRef<string | null>(null);
  const esRef        = useRef<EventSource | null>(null);
  const logIdRef     = useRef(0);
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
        setReport(a);
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
          event.isError ? `❌ [#${event.seq}] ${event.preview}` : `✅ [#${event.seq}] ${event.preview}`,
          event.isError ? 'error' : 'result',
        );
        break;
      case 'submit':
        addLog('📤 submit_for_review 호출', 'info');
        break;
      case 'artifact':
        addLog(`📝 보고서 초안 v${event.version} 생성 완료`, 'info');
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
        addLog(`⏳ Rate limit — ${event.waitSec}초 대기`, 'system');
        break;
      case 'force_stop':
        addLog(
          event.reason === 'consecutive_errors' ? '⛔ 연속 오류 강제 중단' : '⚠️ 최대 도구 호출 도달',
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
          fetchReport();
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

  async function fetchReport() {
    if (!sessionIdRef.current) return;
    const { artifact: a } = await api.getSession(sessionIdRef.current);
    setReport(a);
    setPhase('waiting');
    await refreshArtifacts();
  }

  async function refreshArtifacts() {
    const [stage1, stage2] = await Promise.all([
      api.getArtifacts({ stage: 'STAGE_1', status: 'confirmed' }),
      api.getArtifacts({ stage: 'STAGE_2' }),
    ]);
    setStage1Artifacts(stage1);
    setStage2Artifacts(stage2);
  }

  async function startRun() {
    setPhase('running');
    setLogEntries([]);
    setStreamText('');
    setReport(null);
    setStatusMsg('');
    setShowFeedback(false);

    try {
      let params: Parameters<typeof api.createSession>[0];

      if (inputMode === 'db') {
        if (!selectedArtifactId) { setPhase('idle'); setStatusMsg('검토 결론을 선택하세요.'); return; }
        const selected = stage1Artifacts.find(a => a.id === selectedArtifactId)!;
        if (!selectedInputText.trim()) { setPhase('idle'); setStatusMsg('선택한 검토 결론 내용을 확인하거나 수정하세요.'); return; }
        params = {
          issueId: selected.issue_id,
          stage: 'STAGE_2',
          agentMode,
          inputArtifactId: selectedArtifactId,
          manualInput: selectedInputText.trim(),
          customToc: customToc.trim() || undefined,
        };
      } else if (inputMode === 'stage2') {
        if (!selectedStage2ArtifactId) { setPhase('idle'); setStatusMsg('기존 Stage 2 결과물을 선택하세요.'); return; }
        const selected = stage2Artifacts.find(a => a.id === selectedStage2ArtifactId)!;
        if (!selectedInputText.trim()) { setPhase('idle'); setStatusMsg('선택한 Stage 2 결과 내용을 확인하거나 수정하세요.'); return; }
        params = {
          issueId: selected.issue_id,
          stage: 'STAGE_2',
          agentMode,
          inputArtifactId: selectedStage2ArtifactId,
          manualInput: selectedInputText.trim(),
          customToc: customToc.trim() || undefined,
        };
      } else {
        if (!manualInput.trim()) { setPhase('idle'); setStatusMsg('검토 결론을 입력하세요.'); return; }
        params = {
          stage: 'STAGE_2',
          agentMode,
          manualInput: manualInput.trim(),
          customToc: customToc.trim() || undefined,
        };
      }

      const { id: sessionId } = await api.createSession(params);
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
    if (!sessionIdRef.current || !report) return;
    await api.confirmSession(sessionIdRef.current, report.id);
    localStorage.removeItem(ACTIVE_SESSION_KEY);
    setPhase('confirmed');
    setStatusMsg(`✅ 보고서 확정 완료 — Artifact ID: ${report.id}`);
    await refreshArtifacts();
  }

  async function handleFeedback() {
    if (!sessionIdRef.current || !feedbackText.trim()) return;
    setShowFeedback(false);
    setPhase('running');
    setReport(null);
    setStatusMsg('');

    await api.submitFeedback(sessionIdRef.current, feedbackText, customToc.trim() || undefined);
    setFeedbackText('');

    esRef.current?.close();
    esRef.current = api.streamSession(sessionIdRef.current!, handleEvent);
  }

  const isRunning = phase === 'running';
  const canSubmit = inputMode === 'db'
    ? Boolean(selectedArtifactId && selectedInputText.trim())
    : inputMode === 'stage2'
      ? Boolean(selectedStage2ArtifactId && selectedInputText.trim())
      : Boolean(manualInput.trim());

  function handleSelectStage1Artifact(artifactId: string) {
    setSelectedArtifactId(artifactId);
    const selected = stage1Artifacts.find(a => a.id === artifactId);
    setSelectedInputText(selected?.content ?? '');
  }

  function handleSelectStage2Artifact(artifactId: string) {
    setSelectedStage2ArtifactId(artifactId);
    const selected = stage2Artifacts.find(a => a.id === artifactId);
    setSelectedInputText(selected?.content ?? '');
  }

  return (
    <div style={{ display: 'flex', flexDirection: 'column', gap: 16 }}>
      <h2 style={{ fontSize: 16, fontWeight: 700, color: '#1e3a5f' }}>Stage 2 — 보고서 초안</h2>

      {/* 입력 방식 선택 */}
      <div style={{ display: 'flex', gap: 12 }}>
        {(['db', 'stage2', 'manual'] as Array<InputMode | 'stage2'>).map(mode => (
          <label key={mode} style={{ display: 'flex', alignItems: 'center', gap: 6, cursor: 'pointer' }}>
            <input
              type="radio"
              value={mode}
              checked={inputMode === mode}
              onChange={() => setInputMode(mode)}
              disabled={isRunning}
            />
            <span style={{ fontSize: 13 }}>
              {mode === 'db' ? 'Stage 1 확정 결론에서 선택' : mode === 'stage2' ? '기존 Stage 2 결과 발전' : '직접 입력'}
            </span>
          </label>
        ))}
      </div>

      {/* DB 선택 */}
      {inputMode === 'db' && (
        <div>
          <label style={{ display: 'block', marginBottom: 6, fontWeight: 600, fontSize: 13 }}>확정된 검토 결론</label>
          <select
            value={selectedArtifactId}
            onChange={e => handleSelectStage1Artifact(e.target.value)}
            disabled={isRunning}
          >
            <option value="">— 선택하세요 —</option>
            {stage1Artifacts.map(a => (
              <option key={a.id} value={a.id}>
                v{a.version} | {a.created_at.slice(0, 16)} | {a.summary ?? '(요약 없음)'}
              </option>
            ))}
          </select>
          {selectedArtifactId && (
            <>
              <p style={{ margin: '8px 0 6px', fontSize: 12, color: '#64748b', lineHeight: 1.6 }}>
                선택한 검토 결론 전문이 아래에 그대로 표시됩니다. 필요한 부분은 바로 수정한 뒤 그 내용을 Stage 2 입력으로 사용합니다.
              </p>
              <textarea
                value={selectedInputText}
                onChange={e => setSelectedInputText(e.target.value)}
                rows={12}
                disabled={isRunning}
                style={{ fontSize: 12, lineHeight: 1.6 }}
              />
            </>
          )}
        </div>
      )}

      {inputMode === 'stage2' && (
        <div>
          <label style={{ display: 'block', marginBottom: 6, fontWeight: 600, fontSize: 13 }}>기존 Stage 2 결과물</label>
          <select
            value={selectedStage2ArtifactId}
            onChange={e => handleSelectStage2Artifact(e.target.value)}
            disabled={isRunning}
          >
            <option value="">— 선택하세요 —</option>
            {stage2Artifacts.map(a => (
              <option key={a.id} value={a.id}>
                {a.status} | v{a.version} | {a.created_at.slice(0, 16)} | {a.summary ?? '(요약 없음)'}
              </option>
            ))}
          </select>
          {selectedStage2ArtifactId && (
            <>
              <p style={{ margin: '8px 0 6px', fontSize: 12, color: '#64748b', lineHeight: 1.6 }}>
                선택한 Stage 2 결과 전문이 아래에 그대로 표시됩니다. 초안을 직접 다듬은 뒤 그 수정본으로 다음 보고서 초안을 생성합니다.
              </p>
              <textarea
                value={selectedInputText}
                onChange={e => setSelectedInputText(e.target.value)}
                rows={12}
                disabled={isRunning}
                style={{ fontSize: 12, lineHeight: 1.6 }}
              />
            </>
          )}
        </div>
      )}

      {/* 직접 입력 */}
      {inputMode === 'manual' && (
        <div>
          <label style={{ display: 'block', marginBottom: 6, fontWeight: 600, fontSize: 13 }}>검토 결론 내용</label>
          <textarea
            value={manualInput}
            onChange={e => setManualInput(e.target.value)}
            rows={8}
            placeholder="검토 결론을 직접 입력하세요..."
            disabled={isRunning}
          />
        </div>
      )}

      {/* 목차 커스터마이징 */}
      <div>
        <label style={{ display: 'flex', alignItems: 'center', gap: 6, cursor: 'pointer', fontSize: 13 }}>
          <input
            type="checkbox"
            checked={showCustomToc}
            onChange={e => setShowCustomToc(e.target.checked)}
            disabled={isRunning}
          />
          보고서 목차 직접 지정 (기본: 현황 / 이슈 / 검토의견 / 향후계획)
        </label>
        <p style={{ margin: '6px 0 0 24px', fontSize: 12, lineHeight: 1.6, color: '#64748b' }}>
          이 기능은 세부 문장까지 고정하는 입력이 아니라, 보고서의 큰 흐름과 개략적인 목차를 잡아주는 가이드입니다.
        </p>
        {showCustomToc && (
          <textarea
            value={customToc}
            onChange={e => setCustomToc(e.target.value)}
            rows={3}
            placeholder="예) 1. 배경&#10;2. 핵심 쟁점&#10;3. 검토 방향&#10;4. 향후 조치"
            disabled={isRunning}
            style={{ marginTop: 8 }}
          />
        )}
      </div>

      <div>
        <button
          onClick={startRun}
          disabled={isRunning || !canSubmit}
          style={{ background: '#7c3aed', color: '#fff', padding: '8px 20px' }}
        >
          {isRunning ? '⏳ 보고서 작성 중...' : inputMode === 'stage2' ? '선택 결과 발전' : '보고서 작성'}
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
            style={{ background: '#7c3aed', color: '#fff', padding: '8px 18px', whiteSpace: 'nowrap' }}
          >▶ 재개</button>
        </div>
      )}

      {/* 보고서 초안 */}
      {report && (
        <div style={{ background: '#fff', border: '1px solid #e5e7eb', borderRadius: 8, padding: 16 }}>
          <div style={{ display: 'flex', justifyContent: 'space-between', alignItems: 'center', marginBottom: 10 }}>
            <h3 style={{ fontSize: 14, fontWeight: 700 }}>
              보고서 초안 v{report.version}
              {report.summary && (
                <span style={{ fontWeight: 400, color: '#6b7280', marginLeft: 8 }}>— {report.summary}</span>
              )}
            </h3>
            {phase === 'waiting' && (
              <div style={{ display: 'flex', gap: 8 }}>
                <button onClick={handleConfirm} style={{ background: '#16a34a', color: '#fff' }}>확정</button>
                <button onClick={() => setShowFeedback(v => !v)} style={{ background: '#f59e0b', color: '#fff' }}>피드백</button>
              </div>
            )}
          </div>
          <pre style={{
            whiteSpace: 'pre-wrap', wordBreak: 'break-word',
            fontSize: 13, lineHeight: 1.8, color: '#1e293b',
            background: '#f8fafc', borderRadius: 4, padding: 12,
          }}>
            {report.content}
          </pre>
        </div>
      )}

      {/* 피드백 */}
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

      {statusMsg && (
        <p style={{ fontSize: 13, color: '#16a34a', fontWeight: 600 }}>{statusMsg}</p>
      )}
    </div>
  );
}
