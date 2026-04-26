import { useEffect, useState } from 'react';
import * as api from './api';
import { useAgentMode } from './AgentModeContext';
import Stage1Tab from './components/Stage1Tab';
import Stage2Tab from './components/Stage2Tab';
import AdminTab from './components/AdminTab';

type Tab = 'stage1' | 'stage2' | 'admin';
type BackendStatus = 'online' | 'offline' | 'unknown';

const TAB_STYLE: React.CSSProperties = {
  padding: '10px 24px',
  fontSize: 14,
  fontWeight: 600,
  background: 'none',
  borderRadius: 0,
  borderBottom: '2px solid transparent',
  color: '#666',
};

const ACTIVE_TAB_STYLE: React.CSSProperties = {
  ...TAB_STYLE,
  borderBottom: '2px solid #2563eb',
  color: '#2563eb',
};

const DISABLED_TAB_STYLE: React.CSSProperties = {
  ...TAB_STYLE,
  color: '#bbb',
  cursor: 'not-allowed',
};

export default function App() {
  const [tab, setTab] = useState<Tab>('stage1');
  const [backend, setBackend] = useState<BackendStatus>('unknown');
  const { mode, setMode } = useAgentMode();

  useEffect(() => {
    let mounted = true;
    api.getRuntime()
      .then(() => { if (mounted) setBackend('online'); })
      .catch(() => { if (mounted) setBackend('offline'); });
    return () => { mounted = false; };
  }, []);

  const isMock = mode === 'mock';

  const togglePillStyle: React.CSSProperties = {
    display: 'inline-flex',
    alignItems: 'center',
    gap: 8,
    padding: '4px 12px',
    borderRadius: 999,
    fontSize: 12,
    fontWeight: 700,
    letterSpacing: '0.04em',
    textTransform: 'uppercase',
    cursor: backend === 'offline' ? 'not-allowed' : 'pointer',
    background: backend === 'offline' ? '#e2e8f0' : isMock ? '#fef3c7' : '#dcfce7',
    color: backend === 'offline' ? '#475569' : isMock ? '#92400e' : '#166534',
    border: 'none',
  };

  return (
    <div style={{ minHeight: '100vh', display: 'flex', flexDirection: 'column' }}>
      {/* 헤더 */}
      <header style={{ background: '#1e3a5f', color: '#fff', padding: '12px 24px' }}>
        <div style={{ display: 'flex', alignItems: 'center', justifyContent: 'space-between', gap: 12 }}>
          <h1 style={{ fontSize: 18, fontWeight: 700, letterSpacing: '-0.3px', margin: 0 }}>
            Sentinel — 법령 검토 에이전트
          </h1>
          <label
            style={togglePillStyle}
            title={
              backend === 'offline'
                ? '백엔드 연결 실패'
                : isMock
                  ? 'Mock 모드 — 실제 LLM 호출 없이 시뮬레이션'
                  : 'Live 모드 — 실제 Claude API 호출'
            }
          >
            <input
              type="checkbox"
              checked={isMock}
              disabled={backend === 'offline'}
              onChange={e => setMode(e.target.checked ? 'mock' : 'live')}
              style={{ margin: 0, accentColor: '#92400e' }}
            />
            {backend === 'offline' ? 'BACKEND OFFLINE' : isMock ? 'MOCK' : 'LIVE'}
          </label>
        </div>
      </header>

      {/* 탭 바 */}
      <div style={{ background: '#fff', borderBottom: '1px solid #e5e7eb', display: 'flex', gap: 0, paddingLeft: 16 }}>
        <button style={tab === 'stage1' ? ACTIVE_TAB_STYLE : TAB_STYLE} onClick={() => setTab('stage1')}>
          Stage 1 — 검토 결론
        </button>
        <button style={tab === 'stage2' ? ACTIVE_TAB_STYLE : TAB_STYLE} onClick={() => setTab('stage2')}>
          Stage 2 — 보고서 초안
        </button>
        <button style={tab === 'admin' ? ACTIVE_TAB_STYLE : TAB_STYLE} onClick={() => setTab('admin')}>
          Admin — 작업결과 정리
        </button>
      </div>

      {/* 탭 콘텐츠 */}
      <main style={{ flex: 1, padding: '20px 24px', maxWidth: 1100, width: '100%', margin: '0 auto' }}>
        {tab === 'stage1' && <Stage1Tab />}
        {tab === 'stage2' && <Stage2Tab />}
        {tab === 'admin' && <AdminTab />}
      </main>
    </div>
  );
}
