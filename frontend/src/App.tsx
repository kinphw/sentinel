import { useState } from 'react';
import Stage1Tab from './components/Stage1Tab';
import Stage2Tab from './components/Stage2Tab';
import Stage3Tab from './components/Stage3Tab';

type Tab = 'stage1' | 'stage2' | 'stage3';

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

  return (
    <div style={{ minHeight: '100vh', display: 'flex', flexDirection: 'column' }}>
      {/* 헤더 */}
      <header style={{ background: '#1e3a5f', color: '#fff', padding: '12px 24px' }}>
        <h1 style={{ fontSize: 18, fontWeight: 700, letterSpacing: '-0.3px' }}>
          Sentinel — 법령 검토 에이전트
        </h1>
      </header>

      {/* 탭 바 */}
      <div style={{ background: '#fff', borderBottom: '1px solid #e5e7eb', display: 'flex', gap: 0, paddingLeft: 16 }}>
        <button style={tab === 'stage1' ? ACTIVE_TAB_STYLE : TAB_STYLE} onClick={() => setTab('stage1')}>
          Stage 1 — 검토 결론
        </button>
        <button style={tab === 'stage2' ? ACTIVE_TAB_STYLE : TAB_STYLE} onClick={() => setTab('stage2')}>
          Stage 2 — 보고서 초안
        </button>
        <button style={tab === 'stage3' ? ACTIVE_TAB_STYLE : TAB_STYLE} onClick={() => setTab('stage3')}>
          Stage 3 — HWP 편집 준비
        </button>
      </div>

      {/* 탭 콘텐츠 */}
      <main style={{ flex: 1, padding: '20px 24px', maxWidth: 1100, width: '100%', margin: '0 auto' }}>
        {tab === 'stage1' && <Stage1Tab />}
        {tab === 'stage2' && <Stage2Tab />}
        {tab === 'stage3' && <Stage3Tab />}
      </main>
    </div>
  );
}
