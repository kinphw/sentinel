import { useEffect, useState } from 'react';
import * as api from '../api';
import type { AdminIssueDetail, AdminIssueSummary } from '../types';

type StageFilter = '' | 'STAGE_1' | 'STAGE_2' | 'STAGE_3';

const cardStyle: React.CSSProperties = {
  background: '#fff',
  border: '1px solid #e5e7eb',
  borderRadius: 10,
  padding: 16,
};

function formatDate(value?: string | null): string {
  if (!value) return '-';
  return value.slice(0, 16).replace('T', ' ');
}

function shorten(value: string, max = 180): string {
  return value.length > max ? `${value.slice(0, max)}...` : value;
}

function stageLabel(stage: string | null | undefined): string {
  if (stage === 'STAGE_1') return 'Stage 1';
  if (stage === 'STAGE_2') return 'Stage 2';
  if (stage === 'STAGE_3') return 'Stage 3';
  return '-';
}

export default function AdminTab() {
  const [items, setItems] = useState<AdminIssueSummary[]>([]);
  const [selectedId, setSelectedId] = useState<string | null>(null);
  const [detail, setDetail] = useState<AdminIssueDetail | null>(null);
  const [query, setQuery] = useState('');
  const [stage, setStage] = useState<StageFilter>('');
  const [onlyMock, setOnlyMock] = useState(true);
  const [loadingList, setLoadingList] = useState(false);
  const [loadingDetail, setLoadingDetail] = useState(false);
  const [statusMsg, setStatusMsg] = useState('');
  const [errorMsg, setErrorMsg] = useState('');
  const [deletingId, setDeletingId] = useState<string | null>(null);

  useEffect(() => {
    refreshList().catch(console.error);
  }, []);

  async function refreshList(nextSelectedId?: string | null) {
    setLoadingList(true);
    setErrorMsg('');

    try {
      const nextItems = await api.getAdminIssues({
        query: query.trim() || undefined,
        stage: stage || undefined,
        onlyMock,
        limit: 100,
      });
      setItems(nextItems);

      const preferredId = nextSelectedId === undefined ? selectedId : nextSelectedId;
      if (preferredId && nextItems.some(item => item.id === preferredId)) {
        await loadDetail(preferredId);
      } else {
        setSelectedId(null);
        setDetail(null);
      }
    } catch (error) {
      setErrorMsg((error as Error).message);
    } finally {
      setLoadingList(false);
    }
  }

  async function loadDetail(issueId: string) {
    setSelectedId(issueId);
    setLoadingDetail(true);
    setErrorMsg('');

    try {
      const nextDetail = await api.getAdminIssueDetail(issueId);
      setDetail(nextDetail);
    } catch (error) {
      setErrorMsg((error as Error).message);
      setDetail(null);
    } finally {
      setLoadingDetail(false);
    }
  }

  async function handleDelete(issue: AdminIssueSummary) {
    const confirmed = window.confirm(
      `이 이슈를 삭제하면 연결된 세션, artifact, feedback, message가 함께 제거됩니다.\n\n` +
      `${shorten(issue.input_text, 120)}`,
    );
    if (!confirmed) return;

    setDeletingId(issue.id);
    setStatusMsg('');
    setErrorMsg('');

    try {
      const result = await api.deleteAdminIssue(issue.id);
      setStatusMsg(
        `삭제 완료: 세션 ${result.deletedSessionCount}건, artifact ${result.deletedArtifactCount}건, ` +
        `feedback ${result.deletedFeedbackCount}건`,
      );
      const shouldClearDetail = selectedId === issue.id;
      await refreshList(shouldClearDetail ? null : selectedId);
    } catch (error) {
      setErrorMsg((error as Error).message);
    } finally {
      setDeletingId(null);
    }
  }

  return (
    <div style={{ display: 'flex', flexDirection: 'column', gap: 16 }}>
      <div>
        <h2 style={{ fontSize: 16, fontWeight: 700, color: '#1e3a5f', marginBottom: 6 }}>Admin — 작업결과 정리</h2>
        <p style={{ fontSize: 13, lineHeight: 1.7, color: '#475569' }}>
          DB에 적재된 작업 이슈를 조회하고, 선택한 이슈에 연결된 세션·산출물·피드백·메시지를 한 번에 삭제할 수 있습니다.
          기본값은 mock 결과만 보도록 설정했습니다.
        </p>
      </div>

      <div style={{ ...cardStyle, display: 'grid', gridTemplateColumns: 'minmax(0, 1.5fr) 180px 120px auto', gap: 10, alignItems: 'end' }}>
        <div>
          <label style={{ display: 'block', marginBottom: 6, fontWeight: 600, fontSize: 13 }}>검색</label>
          <input
            type="text"
            value={query}
            onChange={e => setQuery(e.target.value)}
            placeholder="이슈 내용, 요약, 본문 일부"
          />
        </div>
        <div>
          <label style={{ display: 'block', marginBottom: 6, fontWeight: 600, fontSize: 13 }}>Stage</label>
          <select value={stage} onChange={e => setStage(e.target.value as StageFilter)}>
            <option value="">전체</option>
            <option value="STAGE_1">Stage 1</option>
            <option value="STAGE_2">Stage 2</option>
            <option value="STAGE_3">Stage 3</option>
          </select>
        </div>
        <label style={{ display: 'flex', alignItems: 'center', gap: 8, fontSize: 13, fontWeight: 600, paddingBottom: 8 }}>
          <input type="checkbox" checked={onlyMock} onChange={e => setOnlyMock(e.target.checked)} />
          Mock만 보기
        </label>
        <div style={{ display: 'flex', gap: 8, justifyContent: 'flex-end' }}>
          <button onClick={() => refreshList().catch(console.error)} style={{ background: '#0f766e', color: '#fff' }}>
            {loadingList ? '조회 중...' : '조회'}
          </button>
        </div>
      </div>

      <div style={{ display: 'grid', gridTemplateColumns: 'minmax(360px, 420px) minmax(0, 1fr)', gap: 16, alignItems: 'start' }}>
        <div style={{ ...cardStyle, display: 'flex', flexDirection: 'column', gap: 12 }}>
          <div style={{ display: 'flex', justifyContent: 'space-between', alignItems: 'center' }}>
            <strong style={{ fontSize: 14 }}>작업 목록</strong>
            <span style={{ fontSize: 12, color: '#64748b' }}>{items.length}건</span>
          </div>

          <div style={{ display: 'flex', flexDirection: 'column', gap: 10, maxHeight: 720, overflowY: 'auto' }}>
            {items.map(item => (
              <div
                key={item.id}
                onClick={() => loadDetail(item.id).catch(console.error)}
                style={{
                  textAlign: 'left',
                  padding: 12,
                  borderRadius: 8,
                  border: item.id === selectedId ? '1px solid #2563eb' : '1px solid #e5e7eb',
                  background: item.id === selectedId ? '#eff6ff' : '#fff',
                  display: 'flex',
                  flexDirection: 'column',
                  gap: 8,
                  cursor: 'pointer',
                }}
              >
                <div style={{ display: 'flex', justifyContent: 'space-between', gap: 8, alignItems: 'center' }}>
                  <div style={{ display: 'flex', gap: 6, flexWrap: 'wrap' }}>
                    <span style={{ fontSize: 11, fontWeight: 700, color: '#1d4ed8', background: '#dbeafe', padding: '2px 8px', borderRadius: 999 }}>
                      {stageLabel(item.latest_stage ?? item.current_stage)}
                    </span>
                    {item.is_mock && (
                      <span style={{ fontSize: 11, fontWeight: 700, color: '#92400e', background: '#fef3c7', padding: '2px 8px', borderRadius: 999 }}>
                        MOCK
                      </span>
                    )}
                  </div>
                  <span style={{ fontSize: 11, color: '#64748b' }}>{formatDate(item.latest_artifact_created_at ?? item.created_at)}</span>
                </div>
                <div style={{ fontSize: 13, fontWeight: 600, lineHeight: 1.6, color: '#111827' }}>
                  {shorten(item.input_text, 120)}
                </div>
                <div style={{ fontSize: 12, color: '#475569', lineHeight: 1.6 }}>
                  최근 요약: {item.latest_artifact_summary ? shorten(item.latest_artifact_summary, 90) : '(없음)'}
                </div>
                <div style={{ display: 'flex', justifyContent: 'space-between', gap: 8, alignItems: 'center' }}>
                  <span style={{ fontSize: 11, color: '#64748b' }}>
                    세션 {item.session_count} | artifact {item.artifact_count} | 확정 {item.confirmed_artifact_count}
                  </span>
                  <span
                    onClick={(e) => {
                      e.stopPropagation();
                      handleDelete(item).catch(console.error);
                    }}
                    style={{
                      fontSize: 12,
                      fontWeight: 700,
                      color: deletingId === item.id ? '#9ca3af' : '#dc2626',
                      cursor: deletingId === item.id ? 'default' : 'pointer',
                    }}
                  >
                    {deletingId === item.id ? '삭제 중...' : '삭제'}
                  </span>
                </div>
              </div>
            ))}

            {!loadingList && items.length === 0 && (
              <div style={{ fontSize: 13, color: '#64748b', lineHeight: 1.7 }}>조건에 맞는 작업 결과가 없습니다.</div>
            )}
          </div>
        </div>

        <div style={{ ...cardStyle, minHeight: 320 }}>
          {!selectedId && (
            <div style={{ fontSize: 13, color: '#64748b', lineHeight: 1.7 }}>
              왼쪽에서 작업을 선택하면 세션별 산출물과 피드백 내역을 볼 수 있습니다.
            </div>
          )}

          {loadingDetail && (
            <div style={{ fontSize: 13, color: '#64748b' }}>상세 조회 중...</div>
          )}

          {detail && !loadingDetail && (
            <div style={{ display: 'flex', flexDirection: 'column', gap: 14 }}>
              <div style={{ borderBottom: '1px solid #e5e7eb', paddingBottom: 12 }}>
                <div style={{ display: 'flex', gap: 8, alignItems: 'center', marginBottom: 8, flexWrap: 'wrap' }}>
                  <strong style={{ fontSize: 15 }}>이슈 상세</strong>
                  {detail.issue.is_mock && (
                    <span style={{ fontSize: 11, fontWeight: 700, color: '#92400e', background: '#fef3c7', padding: '2px 8px', borderRadius: 999 }}>
                      MOCK
                    </span>
                  )}
                </div>
                <div style={{ fontSize: 13, lineHeight: 1.7, color: '#111827', whiteSpace: 'pre-wrap' }}>
                  {detail.issue.input_text}
                </div>
                <div style={{ marginTop: 8, fontSize: 12, color: '#64748b' }}>
                  생성 {formatDate(detail.issue.created_at)} | 수정 {formatDate(detail.issue.updated_at)} | 상태 {detail.issue.status}
                </div>
              </div>

              {detail.sessions.map(session => (
                <div key={session.id} style={{ border: '1px solid #e5e7eb', borderRadius: 8, padding: 14, display: 'flex', flexDirection: 'column', gap: 10 }}>
                  <div style={{ display: 'flex', justifyContent: 'space-between', gap: 12, alignItems: 'center', flexWrap: 'wrap' }}>
                    <div style={{ display: 'flex', gap: 8, alignItems: 'center', flexWrap: 'wrap' }}>
                      <strong style={{ fontSize: 14 }}>{stageLabel(session.stage)}</strong>
                      <span style={{ fontSize: 11, fontWeight: 700, color: '#334155', background: '#e2e8f0', padding: '2px 8px', borderRadius: 999 }}>
                        {session.status}
                      </span>
                    </div>
                    <span style={{ fontSize: 12, color: '#64748b' }}>
                      runs {session.run_count} | messages {session.message_count} | feedbacks {session.feedbacks.length}
                    </span>
                  </div>

                  <div style={{ fontSize: 12, color: '#64748b', lineHeight: 1.6 }}>
                    세션 생성 {formatDate(session.created_at)} | retry {session.retry_count}
                  </div>

                  <div style={{ display: 'flex', flexDirection: 'column', gap: 8 }}>
                    <strong style={{ fontSize: 13 }}>Artifacts</strong>
                    {session.artifacts.length === 0 && (
                      <div style={{ fontSize: 12, color: '#94a3b8' }}>저장된 artifact 없음</div>
                    )}
                    {session.artifacts.map(artifact => (
                      <div key={artifact.id} style={{ background: '#f8fafc', borderRadius: 6, padding: 12 }}>
                        <div style={{ display: 'flex', justifyContent: 'space-between', gap: 12, marginBottom: 6, flexWrap: 'wrap' }}>
                          <span style={{ fontSize: 12, fontWeight: 700, color: '#1e293b' }}>
                            v{artifact.version} | {artifact.status}
                          </span>
                          <span style={{ fontSize: 11, color: '#64748b' }}>{formatDate(artifact.created_at)}</span>
                        </div>
                        <div style={{ fontSize: 12, color: '#475569', marginBottom: 6 }}>
                          {artifact.summary ?? '(요약 없음)'}
                        </div>
                        <pre style={{
                          fontSize: 12,
                          lineHeight: 1.6,
                          color: '#0f172a',
                          whiteSpace: 'pre-wrap',
                          wordBreak: 'break-word',
                          maxHeight: 220,
                          overflowY: 'auto',
                        }}>
                          {artifact.content}
                        </pre>
                      </div>
                    ))}
                  </div>

                  <div style={{ display: 'flex', flexDirection: 'column', gap: 8 }}>
                    <strong style={{ fontSize: 13 }}>Feedbacks</strong>
                    {session.feedbacks.length === 0 && (
                      <div style={{ fontSize: 12, color: '#94a3b8' }}>피드백 없음</div>
                    )}
                    {session.feedbacks.map(feedback => (
                      <div key={feedback.id} style={{ background: '#fffbeb', borderRadius: 6, padding: 10 }}>
                        <div style={{ fontSize: 11, color: '#92400e', marginBottom: 4 }}>
                          {feedback.author_type} | {formatDate(feedback.created_at)}
                        </div>
                        <div style={{ fontSize: 12, lineHeight: 1.6, color: '#78350f', whiteSpace: 'pre-wrap' }}>
                          {feedback.content}
                        </div>
                      </div>
                    ))}
                  </div>
                </div>
              ))}
            </div>
          )}
        </div>
      </div>

      {(statusMsg || errorMsg) && (
        <div style={{ ...cardStyle, borderColor: errorMsg ? '#fecaca' : '#bbf7d0', background: errorMsg ? '#fef2f2' : '#f0fdf4' }}>
          <div style={{ fontSize: 13, color: errorMsg ? '#b91c1c' : '#166534', lineHeight: 1.7 }}>
            {errorMsg || statusMsg}
          </div>
        </div>
      )}
    </div>
  );
}
