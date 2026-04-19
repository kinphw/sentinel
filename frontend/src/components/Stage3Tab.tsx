import { useEffect, useRef, useState } from 'react';
import * as api from '../api';
import type { AgentEvent, Artifact, LogEntry } from '../types';
import EventLog from './EventLog';

type InputMode = 'stage2' | 'stage3';
type Phase = 'idle' | 'running' | 'waiting' | 'confirmed';

export default function Stage3Tab() {
  const [inputMode, setInputMode] = useState<InputMode>('stage2');
  const [stage2Artifacts, setStage2Artifacts] = useState<Artifact[]>([]);
  const [stage3Artifacts, setStage3Artifacts] = useState<Artifact[]>([]);
  const [selectedStage2ArtifactId, setSelectedStage2ArtifactId] = useState('');
  const [selectedStage3ArtifactId, setSelectedStage3ArtifactId] = useState('');
  const [developmentNote, setDevelopmentNote] = useState('');
  const [phase, setPhase] = useState<Phase>('idle');
  const [logEntries, setLogEntries] = useState<LogEntry[]>([]);
  const [streamText, setStreamText] = useState('');
  const [artifact, setArtifact] = useState<Artifact | null>(null);
  const [feedbackText, setFeedbackText] = useState('');
  const [showFeedback, setShowFeedback] = useState(false);
  const [statusMsg, setStatusMsg] = useState('');

  const sessionIdRef = useRef<string | null>(null);
  const esRef = useRef<EventSource | null>(null);
  const logIdRef = useRef(0);

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
        addLog(`📝 편집 초안 v${event.version} 생성 완료`, 'info');
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
          fetchArtifact().catch(console.error);
        } else {
          setPhase('idle');
          setStatusMsg('에이전트가 오류로 종료되었습니다.');
        }
        break;
      }
    }
  }

  async function refreshArtifacts() {
    const [stage2, stage3] = await Promise.all([
      api.getArtifacts({ stage: 'STAGE_2', status: 'confirmed' }),
      api.getArtifacts({ stage: 'STAGE_3' }),
    ]);
    setStage2Artifacts(stage2);
    setStage3Artifacts(stage3);
  }

  async function fetchArtifact() {
    if (!sessionIdRef.current) return;
    const { artifact: nextArtifact } = await api.getSession(sessionIdRef.current);
    setArtifact(nextArtifact);
    setPhase('waiting');
    await refreshArtifacts();
  }

  async function startRun() {
    setPhase('running');
    setLogEntries([]);
    setStreamText('');
    setArtifact(null);
    setStatusMsg('');
    setShowFeedback(false);

    try {
      const selected = inputMode === 'stage2'
        ? stage2Artifacts.find(a => a.id === selectedStage2ArtifactId)
        : stage3Artifacts.find(a => a.id === selectedStage3ArtifactId);

      if (!selected?.issue_id) {
        setPhase('idle');
        setStatusMsg(inputMode === 'stage2' ? 'Stage 2 결과물을 선택하세요.' : 'Stage 3 결과물을 선택하세요.');
        return;
      }

      const { id: sessionId } = await api.createSession({
        issueId: selected.issue_id,
        stage: 'STAGE_3',
        inputArtifactId: selected.id,
        developmentNote: developmentNote.trim() || undefined,
      });

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
    setStatusMsg(`✅ Stage 3 결과 확정 완료 — Artifact ID: ${artifact.id}`);
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
    esRef.current = api.streamSession(sessionIdRef.current, handleEvent);
  }

  const selectedArtifact = inputMode === 'stage2'
    ? stage2Artifacts.find(a => a.id === selectedStage2ArtifactId)
    : stage3Artifacts.find(a => a.id === selectedStage3ArtifactId);

  return (
    <div style={{ display: 'flex', flexDirection: 'column', gap: 16 }}>
      <h2 style={{ fontSize: 16, fontWeight: 700, color: '#1e3a5f' }}>Stage 3 — HWP 편집 준비</h2>

      <p style={{ fontSize: 13, lineHeight: 1.7, color: '#475569', margin: 0 }}>
        현재는 HWP COM 자동화 전 단계입니다. Stage 2 보고서나 기존 Stage 3 편집본을 선택해 편집용 텍스트 초안을 다시 만들고,
        결과는 Stage 3 artifact로 별도 저장됩니다.
      </p>

      <div style={{ display: 'flex', gap: 12 }}>
        {(['stage2', 'stage3'] as InputMode[]).map(mode => (
          <label key={mode} style={{ display: 'flex', alignItems: 'center', gap: 6, cursor: 'pointer' }}>
            <input
              type="radio"
              checked={inputMode === mode}
              onChange={() => setInputMode(mode)}
              disabled={phase === 'running'}
            />
            <span style={{ fontSize: 13 }}>
              {mode === 'stage2' ? 'Stage 2 확정 보고서에서 시작' : '기존 Stage 3 편집본 발전'}
            </span>
          </label>
        ))}
      </div>

      <div>
        <label style={{ display: 'block', marginBottom: 6, fontWeight: 600, fontSize: 13 }}>
          {inputMode === 'stage2' ? 'Stage 2 확정 결과물' : '기존 Stage 3 결과물'}
        </label>
        <select
          value={inputMode === 'stage2' ? selectedStage2ArtifactId : selectedStage3ArtifactId}
          onChange={e => {
            if (inputMode === 'stage2') setSelectedStage2ArtifactId(e.target.value);
            else setSelectedStage3ArtifactId(e.target.value);
          }}
          disabled={phase === 'running'}
        >
          <option value="">— 선택하세요 —</option>
          {(inputMode === 'stage2' ? stage2Artifacts : stage3Artifacts).map(a => (
            <option key={a.id} value={a.id}>
              {a.status} | v{a.version} | {a.created_at.slice(0, 16)} | {a.summary ?? '(요약 없음)'}
            </option>
          ))}
        </select>
        {selectedArtifact && (
          <pre style={{
            marginTop: 8, background: '#f8fafc', borderRadius: 4, padding: 10,
            fontSize: 12, lineHeight: 1.6, maxHeight: 160, overflowY: 'auto',
            whiteSpace: 'pre-wrap', wordBreak: 'break-word', color: '#374151',
          }}>
            {selectedArtifact.content.slice(0, 700)}{selectedArtifact.content.length > 700 ? '…' : ''}
          </pre>
        )}
      </div>

      <div>
        <label style={{ display: 'block', marginBottom: 6, fontWeight: 600, fontSize: 13 }}>추가 편집 요청</label>
        <textarea
          value={developmentNote}
          onChange={e => setDevelopmentNote(e.target.value)}
          rows={4}
          placeholder="예) 문장 길이 축약, 헤더 표현 통일, 개조식 단계 정리, 임원 보고용 톤으로 보수화"
          disabled={phase === 'running'}
        />
      </div>

      <div>
        <button
          onClick={startRun}
          disabled={phase === 'running' || !selectedArtifact}
          style={{ background: '#0f766e', color: '#fff', padding: '8px 20px' }}
        >
          {phase === 'running' ? '⏳ 편집 중...' : '편집 초안 생성'}
        </button>
      </div>

      <EventLog entries={logEntries} streamText={streamText} />

      {artifact && (
        <div style={{ background: '#fff', border: '1px solid #e5e7eb', borderRadius: 8, padding: 16 }}>
          <div style={{ display: 'flex', justifyContent: 'space-between', alignItems: 'center', marginBottom: 10 }}>
            <h3 style={{ fontSize: 14, fontWeight: 700 }}>
              Stage 3 편집 초안 v{artifact.version}
              {artifact.summary && (
                <span style={{ fontWeight: 400, color: '#6b7280', marginLeft: 8 }}>— {artifact.summary}</span>
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
            {artifact.content}
          </pre>
        </div>
      )}

      {showFeedback && (
        <div style={{ background: '#fffbeb', border: '1px solid #fbbf24', borderRadius: 8, padding: 14 }}>
          <label style={{ display: 'block', marginBottom: 6, fontWeight: 600, fontSize: 13 }}>피드백</label>
          <textarea
            value={feedbackText}
            onChange={e => setFeedbackText(e.target.value)}
            rows={4}
            placeholder="추가 편집 요청 내용을 입력하세요..."
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
