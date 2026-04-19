import { useState, useRef, useEffect } from 'react';
import * as api from '../api';
import type { AgentEvent, Artifact, LogEntry } from '../types';
import EventLog from './EventLog';

type InputMode = 'db' | 'manual';
type Phase = 'idle' | 'running' | 'waiting' | 'confirmed';

export default function Stage2Tab() {
  const [inputMode, setInputMode]       = useState<InputMode | 'stage2'>('db');
  const [stage1Artifacts, setStage1Artifacts] = useState<Artifact[]>([]);
  const [stage2Artifacts, setStage2Artifacts] = useState<Artifact[]>([]);
  const [selectedArtifactId, setSelectedArtifactId] = useState('');
  const [selectedStage2ArtifactId, setSelectedStage2ArtifactId] = useState('');
  const [manualInput, setManualInput]   = useState('');
  const [developmentNote, setDevelopmentNote] = useState('');
  const [customToc, setCustomToc]       = useState('');
  const [showCustomToc, setShowCustomToc] = useState(false);
  const [phase, setPhase]               = useState<Phase>('idle');
  const [logEntries, setLogEntries]     = useState<LogEntry[]>([]);
  const [streamText, setStreamText]     = useState('');
  const [report, setReport]             = useState<Artifact | null>(null);
  const [feedbackText, setFeedbackText] = useState('');
  const [showFeedback, setShowFeedback] = useState(false);
  const [statusMsg, setStatusMsg]       = useState('');

  const sessionIdRef = useRef<string | null>(null);
  const esRef        = useRef<EventSource | null>(null);
  const logIdRef     = useRef(0);

  useEffect(() => {
    refreshArtifacts().catch(console.error);
  }, []);

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
        addLog(`⏳ Rate limit — ${event.waitSec}초 대기`, 'system');
        break;
      case 'force_stop':
        addLog(
          event.reason === 'consecutive_errors' ? '⛔ 연속 오류 강제 중단' : '⚠️ 최대 도구 호출 도달',
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
          fetchReport();
        } else {
          setPhase('idle');
          setStatusMsg('에이전트가 오류로 종료되었습니다.');
        }
        break;
      }
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
        params = {
          issueId: selected.issue_id,
          stage: 'STAGE_2',
          inputArtifactId: selectedArtifactId,
          customToc: customToc.trim() || undefined,
          developmentNote: developmentNote.trim() || undefined,
        };
      } else if (inputMode === 'stage2') {
        if (!selectedStage2ArtifactId) { setPhase('idle'); setStatusMsg('기존 Stage 2 결과물을 선택하세요.'); return; }
        const selected = stage2Artifacts.find(a => a.id === selectedStage2ArtifactId)!;
        params = {
          issueId: selected.issue_id,
          stage: 'STAGE_2',
          inputArtifactId: selectedStage2ArtifactId,
          customToc: customToc.trim() || undefined,
          developmentNote: developmentNote.trim() || undefined,
        };
      } else {
        if (!manualInput.trim()) { setPhase('idle'); setStatusMsg('검토 결론을 입력하세요.'); return; }
        params = {
          stage: 'STAGE_2',
          manualInput: manualInput.trim(),
          customToc: customToc.trim() || undefined,
          developmentNote: developmentNote.trim() || undefined,
        };
      }

      const { id: sessionId } = await api.createSession(params);
      sessionIdRef.current = sessionId;

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
            onChange={e => setSelectedArtifactId(e.target.value)}
            disabled={isRunning}
          >
            <option value="">— 선택하세요 —</option>
            {stage1Artifacts.map(a => (
              <option key={a.id} value={a.id}>
                v{a.version} | {a.created_at.slice(0, 16)} | {a.summary ?? '(요약 없음)'}
              </option>
            ))}
          </select>
          {selectedArtifactId && (() => {
            const a = stage1Artifacts.find(x => x.id === selectedArtifactId);
            return a ? (
              <pre style={{
                marginTop: 8, background: '#f8fafc', borderRadius: 4, padding: 10,
                fontSize: 12, lineHeight: 1.6, maxHeight: 160, overflowY: 'auto',
                whiteSpace: 'pre-wrap', wordBreak: 'break-word', color: '#374151',
              }}>
                {a.content.slice(0, 600)}{a.content.length > 600 ? '…' : ''}
              </pre>
            ) : null;
          })()}
        </div>
      )}

      {inputMode === 'stage2' && (
        <div>
          <label style={{ display: 'block', marginBottom: 6, fontWeight: 600, fontSize: 13 }}>기존 Stage 2 결과물</label>
          <select
            value={selectedStage2ArtifactId}
            onChange={e => setSelectedStage2ArtifactId(e.target.value)}
            disabled={isRunning}
          >
            <option value="">— 선택하세요 —</option>
            {stage2Artifacts.map(a => (
              <option key={a.id} value={a.id}>
                {a.status} | v{a.version} | {a.created_at.slice(0, 16)} | {a.summary ?? '(요약 없음)'}
              </option>
            ))}
          </select>
          {selectedStage2ArtifactId && (() => {
            const a = stage2Artifacts.find(x => x.id === selectedStage2ArtifactId);
            return a ? (
              <pre style={{
                marginTop: 8, background: '#f8fafc', borderRadius: 4, padding: 10,
                fontSize: 12, lineHeight: 1.6, maxHeight: 160, overflowY: 'auto',
                whiteSpace: 'pre-wrap', wordBreak: 'break-word', color: '#374151',
              }}>
                {a.content.slice(0, 600)}{a.content.length > 600 ? '…' : ''}
              </pre>
            ) : null;
          })()}
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

      {inputMode !== 'manual' && (
        <div>
          <label style={{ display: 'block', marginBottom: 6, fontWeight: 600, fontSize: 13 }}>추가 개발 요청</label>
          <textarea
            value={developmentNote}
            onChange={e => setDevelopmentNote(e.target.value)}
            rows={3}
            placeholder="예) 목차 재정리, 임원 보고용 톤으로 수정, 특정 파트 간결화 등"
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
        {showCustomToc && (
          <textarea
            value={customToc}
            onChange={e => setCustomToc(e.target.value)}
            rows={3}
            placeholder="예) 1. 배경&#10;2. 이슈&#10;3. 처리방향&#10;4. 향후조치"
            disabled={isRunning}
            style={{ marginTop: 8 }}
          />
        )}
      </div>

      <div>
        <button
          onClick={startRun}
          disabled={isRunning || (inputMode === 'db' ? !selectedArtifactId : inputMode === 'stage2' ? !selectedStage2ArtifactId : !manualInput.trim())}
          style={{ background: '#7c3aed', color: '#fff', padding: '8px 20px' }}
        >
          {isRunning ? '⏳ 보고서 작성 중...' : inputMode === 'stage2' ? '선택 결과 발전' : '보고서 작성'}
        </button>
      </div>

      {/* 이벤트 로그 */}
      <EventLog entries={logEntries} streamText={streamText} />

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
