import { useEffect, useRef, useState } from 'react';
import type { LogEntry } from '../types';

const KIND_COLOR: Record<LogEntry['kind'], string> = {
  info:   '#2563eb',
  tool:   '#7c3aed',
  result: '#16a34a',
  error:  '#dc2626',
  cost:   '#92400e',
  system: '#64748b',
};

interface Props {
  entries: LogEntry[];
  streamText: string;
  awaiting?: boolean;
}

export default function EventLog({ entries, streamText, awaiting }: Props) {
  const bottomRef = useRef<HTMLDivElement>(null);
  const [dots, setDots] = useState('');

  useEffect(() => {
    bottomRef.current?.scrollIntoView({ behavior: 'smooth' });
  }, [entries, streamText, awaiting, dots]);

  useEffect(() => {
    if (!awaiting) { setDots(''); return; }
    const id = setInterval(() => {
      setDots(prev => prev.length >= 6 ? '' : prev + '.');
    }, 400);
    return () => clearInterval(id);
  }, [awaiting]);

  if (entries.length === 0 && !streamText && !awaiting) return null;

  return (
    <div style={{
      background: '#0f172a',
      color: '#e2e8f0',
      borderRadius: 6,
      padding: '12px 14px',
      fontFamily: 'Consolas, "Courier New", monospace',
      fontSize: 12,
      lineHeight: 1.6,
      maxHeight: 360,
      overflowY: 'auto',
      marginTop: 12,
    }}>
      {entries.map(entry => (
        <div key={entry.id} style={{ marginBottom: 2 }}>
          <span style={{ color: KIND_COLOR[entry.kind] }}>{entry.text}</span>
        </div>
      ))}
      {streamText && (
        <div style={{
          color: '#cbd5e1',
          whiteSpace: 'pre-wrap',
          marginTop: 4,
          padding: '6px 8px',
          background: '#1e293b',
          borderLeft: '2px solid #64748b',
          borderRadius: 3,
        }}>
          <span style={{ color: '#94a3b8' }}>💭 </span>{streamText}
        </div>
      )}
      {awaiting && !streamText && (
        <div style={{ color: '#94a3b8', marginTop: 4 }}>
          ⌛ 응답 대기 중{dots}
        </div>
      )}
      <div ref={bottomRef} />
    </div>
  );
}
