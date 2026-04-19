import { useEffect, useRef } from 'react';
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
}

export default function EventLog({ entries, streamText }: Props) {
  const bottomRef = useRef<HTMLDivElement>(null);

  useEffect(() => {
    bottomRef.current?.scrollIntoView({ behavior: 'smooth' });
  }, [entries, streamText]);

  if (entries.length === 0 && !streamText) return null;

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
        <div style={{ color: '#f8fafc', whiteSpace: 'pre-wrap', marginTop: 4 }}>
          {streamText}
        </div>
      )}
      <div ref={bottomRef} />
    </div>
  );
}
