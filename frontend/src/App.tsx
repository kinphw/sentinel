import { useEffect, useState } from 'react';
import * as api from './api';
import { UnauthenticatedError, type SentinelUser } from './api';
import { useAgentMode } from './AgentModeContext';
import Stage1Tab from './components/Stage1Tab';
import Stage2Tab from './components/Stage2Tab';
import AdminTab from './components/AdminTab';

type Tab = 'stage1' | 'stage2' | 'admin';
type BackendStatus = 'online' | 'offline' | 'unknown';
type AuthState = 'checking' | 'authenticated' | 'unauthenticated';

function buildNestLaunchUrl(nestBaseUrl: string): string {
  const next = encodeURIComponent(window.location.pathname + window.location.search);
  return `${nestBaseUrl.replace(/\/$/, '')}/sentinel/launch?next=${next}`;
}

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
  const [authState, setAuthState] = useState<AuthState>('checking');
  const [user, setUser] = useState<SentinelUser | null>(null);
  const [nestBaseUrl, setNestBaseUrl] = useState<string>('');
  const { mode, setMode } = useAgentMode();

  useEffect(() => {
    let mounted = true;
    api.getRuntime()
      .then(rt => { if (mounted) { setBackend('online'); setNestBaseUrl(rt.nestBaseUrl); } })
      .catch(() => { if (mounted) setBackend('offline'); });
    return () => { mounted = false; };
  }, []);

  useEffect(() => {
    let mounted = true;
    api.getMe()
      .then(u => { if (mounted) { setUser(u); setAuthState('authenticated'); } })
      .catch(err => {
        if (!mounted) return;
        if (err instanceof UnauthenticatedError) {
          setAuthState('unauthenticated');
        } else {
          // 백엔드 다운 등은 backend status가 처리. 인증 상태는 그대로 둠.
          setAuthState('unauthenticated');
        }
      });
    return () => { mounted = false; };
  }, []);

  if (authState === 'checking') {
    return (
      <div style={{ display: 'flex', justifyContent: 'center', alignItems: 'center', minHeight: '100vh', color: '#666' }}>
        인증 확인 중…
      </div>
    );
  }

  if (authState === 'unauthenticated') {
    const ready = nestBaseUrl !== '';
    const nestHost = ready ? new URL(nestBaseUrl).host : '';
    return (
      <div style={{ display: 'flex', flexDirection: 'column', justifyContent: 'center', alignItems: 'center', minHeight: '100vh', padding: 24, gap: 16 }}>
        <h1 style={{ fontSize: 22, fontWeight: 700, color: '#1e3a5f', margin: 0 }}>Sentinel</h1>
        <p style={{ color: '#475569', margin: 0, textAlign: 'center', maxWidth: 420 }}>
          Sentinel은 메인 페이지 회원만 사용할 수 있습니다.<br />
          메인 페이지에서 로그인한 뒤 다시 접속해주세요.
        </p>
        <a
          href={ready ? buildNestLaunchUrl(nestBaseUrl) : '#'}
          aria-disabled={!ready}
          style={{
            padding: '10px 20px',
            fontSize: 14,
            fontWeight: 600,
            background: ready ? '#1e3a5f' : '#94a3b8',
            color: '#fff',
            borderRadius: 4,
            textDecoration: 'none',
            pointerEvents: ready ? 'auto' : 'none',
          }}
        >
          메인 페이지로 이동
        </a>
      </div>
    );
  }

  const isAdmin = user?.role === 'admin';
  const isMock = mode === 'mock';
  // 비-admin이 admin 탭에 머물러 있다면 stage1으로 보냄
  const effectiveTab: Tab = !isAdmin && tab === 'admin' ? 'stage1' : tab;

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
    cursor: !isAdmin ? 'default' : backend === 'offline' ? 'not-allowed' : 'pointer',
    background: backend === 'offline' ? '#e2e8f0' : isMock ? '#fef3c7' : '#dcfce7',
    color: backend === 'offline' ? '#475569' : isMock ? '#92400e' : '#166534',
    border: 'none',
  };

  const statusLabel = backend === 'offline' ? 'BACKEND OFFLINE' : isMock ? 'MOCK' : 'LIVE';
  const statusTitle = backend === 'offline'
    ? '백엔드 연결 실패'
    : isMock
      ? 'Mock 모드 — 실제 LLM 호출 없이 시뮬레이션'
      : 'Live 모드 — 실제 Claude API 호출';

  return (
    <div style={{ minHeight: '100vh', display: 'flex', flexDirection: 'column' }}>
      {/* 헤더 */}
      <header style={{ background: '#1e3a5f', color: '#fff', padding: '12px 24px' }}>
        <div style={{ display: 'flex', alignItems: 'center', justifyContent: 'space-between', gap: 12 }}>
          <h1 style={{ fontSize: 18, fontWeight: 700, letterSpacing: '-0.3px', margin: 0 }}>
            Sentinel — 법령 검토 에이전트
          </h1>
          <div style={{ display: 'flex', alignItems: 'center', gap: 12 }}>
            {isAdmin ? (
              <label style={togglePillStyle} title={statusTitle}>
                <input
                  type="checkbox"
                  checked={isMock}
                  disabled={backend === 'offline'}
                  onChange={e => setMode(e.target.checked ? 'mock' : 'live')}
                  style={{ margin: 0, accentColor: '#92400e' }}
                />
                {statusLabel}
              </label>
            ) : (
              <span style={togglePillStyle} title={statusTitle}>{statusLabel}</span>
            )}
            {user && (
              <div style={{ display: 'flex', alignItems: 'center', gap: 8, fontSize: 12 }}>
                <span style={{ color: '#cbd5e1' }}>
                  {user.nickname}
                  <span style={{ color: '#94a3b8', marginLeft: 6, textTransform: 'uppercase', fontWeight: 700 }}>
                    {user.role}
                  </span>
                </span>
                <button
                  onClick={async () => {
                    await api.logout();
                    // Sentinel 자체 세션 폐기 직후 nest 세션도 끊고 nest /login으로 이동
                    window.location.assign(`${nestBaseUrl.replace(/\/$/, '')}/sentinel/logout`);
                  }}
                  style={{
                    padding: '4px 10px',
                    fontSize: 11,
                    fontWeight: 600,
                    background: 'transparent',
                    color: '#cbd5e1',
                    border: '1px solid #475569',
                    borderRadius: 4,
                    cursor: 'pointer',
                  }}
                >
                  로그아웃
                </button>
              </div>
            )}
          </div>
        </div>
      </header>

      {/* 탭 바 */}
      <div style={{ background: '#fff', borderBottom: '1px solid #e5e7eb', display: 'flex', gap: 0, paddingLeft: 16 }}>
        <button style={effectiveTab === 'stage1' ? ACTIVE_TAB_STYLE : TAB_STYLE} onClick={() => setTab('stage1')}>
          Stage 1 — 검토 결론
        </button>
        <button style={effectiveTab === 'stage2' ? ACTIVE_TAB_STYLE : TAB_STYLE} onClick={() => setTab('stage2')}>
          Stage 2 — 보고서 초안
        </button>
        {isAdmin && (
          <button style={effectiveTab === 'admin' ? ACTIVE_TAB_STYLE : TAB_STYLE} onClick={() => setTab('admin')}>
            Admin — 작업결과 정리
          </button>
        )}
      </div>

      {/* 탭 콘텐츠 */}
      <main style={{ flex: 1, padding: '20px 24px', maxWidth: 1100, width: '100%', margin: '0 auto' }}>
        {effectiveTab === 'stage1' && <Stage1Tab />}
        {effectiveTab === 'stage2' && <Stage2Tab />}
        {effectiveTab === 'admin' && isAdmin && <AdminTab />}
      </main>
    </div>
  );
}
