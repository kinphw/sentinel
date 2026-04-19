import express from 'express';
import cors from 'cors';
import * as dotenv from 'dotenv';
import { resolve, dirname, join } from 'path';
import { fileURLToPath } from 'url';
import { existsSync } from 'fs';
import { SessionStore } from './store/SessionStore.js';
import { ToolGateway } from './engine/ToolGateway.js';
import { AgentEngine, STAGE2_SYSTEM_PROMPT, STAGE3_SYSTEM_PROMPT } from './engine/AgentEngine.js';
import type { AgentEvent } from './engine/AgentEngine.js';
import { closePool } from './db/connection.js';

const __dirname = dirname(fileURLToPath(import.meta.url));
dotenv.config({ path: resolve(__dirname, '../../.env') });

const PORT = parseInt(process.env.PORT ?? '3000', 10);

// ── 의존성 초기화 ─────────────────────────────────────────────

const store   = new SessionStore();
const gateway = new ToolGateway();
const engine  = new AgentEngine(store, gateway);

// ── SSE 이벤트 브로드캐스터 ──────────────────────────────────

type Listener = (event: AgentEvent) => void;
const sseListeners = new Map<string, Set<Listener>>();
const runningSession = new Set<string>();

function subscribe(sessionId: string, fn: Listener): () => void {
  if (!sseListeners.has(sessionId)) sseListeners.set(sessionId, new Set());
  sseListeners.get(sessionId)!.add(fn);
  return () => sseListeners.get(sessionId)?.delete(fn);
}

function broadcast(sessionId: string, event: AgentEvent): void {
  sseListeners.get(sessionId)?.forEach(fn => fn(event));
}

// ── 에이전트 실행 ─────────────────────────────────────────────

async function startAgent(
  sessionId: string,
  stage: string,
  opts: { feedback?: string; inputArtifactId?: string; manualInput?: string; customToc?: string; developmentNote?: string } = {},
): Promise<void> {
  if (runningSession.has(sessionId)) return;
  runningSession.add(sessionId);

  try {
    let systemPrompt: string | undefined;
    let useMcpTools: boolean | undefined;
    let initialInputOverride: string | undefined;
    let sourceArtifact = null;

    if (opts.inputArtifactId) {
      sourceArtifact = await store.getArtifactWithContext(opts.inputArtifactId);
    }

    if (stage === 'STAGE_2') {
      systemPrompt = opts.customToc
        ? buildCustomTocPrompt(opts.customToc)
        : STAGE2_SYSTEM_PROMPT;
      useMcpTools = false;
    } else if (stage === 'STAGE_3') {
      systemPrompt = STAGE3_SYSTEM_PROMPT;
      useMcpTools = false;
    }

    if (!opts.feedback) {
      initialInputOverride = buildInitialInput(stage, {
        sourceArtifact,
        manualInput: opts.manualInput,
        developmentNote: opts.developmentNote,
      });
    }

    await engine.runSession(sessionId, opts.feedback, {
      systemPrompt,
      useMcpTools,
      initialInputOverride,
      onEvent: (event) => broadcast(sessionId, event),
    });
  } finally {
    runningSession.delete(sessionId);
  }
}

function buildCustomTocPrompt(customToc: string): string {
  return STAGE2_SYSTEM_PROMPT.replace(
    '사용자가 별도 목차를 제시한 경우, 아래 기본 구조 대신 제시된 목차를 우선 적용합니다.',
    '사용자가 다음 목차를 제시하였으므로, 기본 구조 대신 이 목차를 적용합니다:\n\n' + customToc,
  );
}

function buildInitialInput(
  stage: string,
  opts: {
    sourceArtifact: Awaited<ReturnType<SessionStore['getArtifactWithContext']>> | null;
    manualInput?: string;
    developmentNote?: string;
  },
): string | undefined {
  const noteSection = opts.developmentNote?.trim()
    ? `\n\n[추가 요청]\n${opts.developmentNote.trim()}`
    : '';

  if (stage === 'STAGE_1') {
    if (!opts.sourceArtifact) return undefined;
    return (
      `[기존 검토 결론]\n${opts.sourceArtifact.content}` +
      `${noteSection}\n\n위 기존 결론을 바탕으로 요청사항을 반영한 새로운 검토 결론 초안을 작성해주세요.`
    );
  }

  if (stage === 'STAGE_2') {
    if (opts.sourceArtifact) {
      const label = opts.sourceArtifact.session_stage === 'STAGE_2' ? '기존 보고서 초안' : '검토 결론';
      const action = opts.sourceArtifact.session_stage === 'STAGE_2'
        ? '위 기존 보고서를 바탕으로 요청사항을 반영한 새로운 보고서 초안을 작성해주세요.'
        : '위 검토 결론을 바탕으로 새로운 보고서 초안을 작성해주세요.';
      return `[${label}]\n${opts.sourceArtifact.content}${noteSection}\n\n${action}`;
    }

    if (opts.manualInput?.trim()) {
      return `[검토 결론]\n${opts.manualInput.trim()}${noteSection}\n\n위 내용을 바탕으로 새로운 보고서 초안을 작성해주세요.`;
    }

    return undefined;
  }

  if (stage === 'STAGE_3') {
    if (!opts.sourceArtifact) return undefined;
    const label = opts.sourceArtifact.session_stage === 'STAGE_3' ? '기존 편집본' : '보고서 초안';
    return (
      `[${label}]\n${opts.sourceArtifact.content}` +
      `${noteSection}\n\n위 문서를 바탕으로 내용의 결론은 유지한 채 편집용 새 초안을 작성해주세요.`
    );
  }

  return undefined;
}

// ── Express 앱 ────────────────────────────────────────────────

const app = express();
app.use(cors());
app.use(express.json());

// 빌드된 프론트엔드 정적 파일 서빙
const frontendDist = resolve(__dirname, '../../frontend/dist');
if (existsSync(frontendDist)) {
  app.use(express.static(frontendDist));
}

// ── REST API ──────────────────────────────────────────────────

// POST /api/issues
app.post('/api/issues', async (req, res) => {
  try {
    const { inputText } = req.body as { inputText: string };
    if (!inputText?.trim()) { res.status(400).json({ error: 'inputText required' }); return; }
    const issue = await store.createIssue(inputText.trim());
    res.json({ id: issue.id, inputText: issue.input_text, createdAt: issue.created_at });
  } catch (e) { res.status(500).json({ error: (e as Error).message }); }
});

// POST /api/sessions
app.post('/api/sessions', async (req, res) => {
  try {
    const {
      issueId,
      stage,
      inputArtifactId,
      manualInput,
      customToc,
      developmentNote,
    } = req.body as {
      issueId?: string;
      stage: 'STAGE_1' | 'STAGE_2' | 'STAGE_3';
      inputArtifactId?: string;
      manualInput?: string;
      customToc?: string;
      developmentNote?: string;
    };

    if (!stage) { res.status(400).json({ error: 'stage required' }); return; }

    let actualIssueId = issueId;

    if (!actualIssueId && inputArtifactId) {
      const sourceArtifact = await store.getArtifactWithContext(inputArtifactId);
      actualIssueId = sourceArtifact.issue_id;
    }

    // 직접 입력: 임시 이슈 생성
    if (!actualIssueId && manualInput) {
      const issue = await store.createIssue(manualInput.trim());
      actualIssueId = issue.id;
    }

    if (!actualIssueId) { res.status(400).json({ error: 'issueId or manualInput required' }); return; }

    const session = await store.createStageSession(actualIssueId, stage, inputArtifactId);
    res.json({ id: session.id, issueId: actualIssueId });

    // 에이전트 비동기 실행
    startAgent(session.id, stage, { inputArtifactId, manualInput, customToc, developmentNote }).catch(console.error);
  } catch (e) { res.status(500).json({ error: (e as Error).message }); }
});

// GET /api/sessions/:id
app.get('/api/sessions/:id', async (req, res) => {
  try {
    const session = await store.getStageSession(req.params.id);
    let artifact = null;
    if (session.latest_artifact_id) {
      artifact = await store.getArtifact(session.latest_artifact_id);
    }
    res.json({ session, artifact, running: runningSession.has(req.params.id) });
  } catch (e) { res.status(500).json({ error: (e as Error).message }); }
});

// GET /api/sessions/:id/stream  — SSE
app.get('/api/sessions/:id/stream', (req, res) => {
  const { id } = req.params;

  res.setHeader('Content-Type', 'text/event-stream');
  res.setHeader('Cache-Control', 'no-cache');
  res.setHeader('Connection', 'keep-alive');
  res.flushHeaders();

  const unsubscribe = subscribe(id, (event) => {
    res.write(`data: ${JSON.stringify(event)}\n\n`);
  });

  req.on('close', unsubscribe);
});

// POST /api/sessions/:id/confirm
app.post('/api/sessions/:id/confirm', async (req, res) => {
  try {
    const { artifactId } = req.body as { artifactId: string };
    if (!artifactId) { res.status(400).json({ error: 'artifactId required' }); return; }
    await store.confirmArtifact(req.params.id, artifactId);
    res.json({ ok: true });
  } catch (e) { res.status(500).json({ error: (e as Error).message }); }
});

// POST /api/sessions/:id/feedback
app.post('/api/sessions/:id/feedback', async (req, res) => {
  try {
    const { text, customToc } = req.body as { text: string; customToc?: string };
    if (!text?.trim()) { res.status(400).json({ error: 'text required' }); return; }

    const sessionId = req.params.id;
    const session = await store.getStageSession(sessionId);

    await store.createFeedback(sessionId, text.trim(), 'user');
    await store.incrementRetryCount(sessionId);
    await store.updateSessionStatus(sessionId, 'READY');
    res.json({ ok: true });

    startAgent(sessionId, session.stage, { feedback: text.trim(), customToc }).catch(console.error);
  } catch (e) { res.status(500).json({ error: (e as Error).message }); }
});

// GET /api/artifacts
app.get('/api/artifacts', async (req, res) => {
  try {
    const { stage, status, issueId } = req.query as Record<string, string>;
    const artifacts = await store.getArtifactsList({ stage, status, issueId });
    res.json(artifacts);
  } catch (e) { res.status(500).json({ error: (e as Error).message }); }
});

// SPA fallback — 빌드된 프론트엔드가 있을 때만
if (existsSync(frontendDist)) {
  app.get('*', (_req, res) => {
    res.sendFile(join(frontendDist, 'index.html'));
  });
}

// ── 서버 시작 ─────────────────────────────────────────────────

async function main(): Promise<void> {
  if (!process.env.ANTHROPIC_API_KEY) {
    console.error('[오류] ANTHROPIC_API_KEY 환경변수가 설정되지 않았습니다.');
    process.exit(1);
  }

  await gateway.connect();
  console.log('[ToolGateway] MCP 서버 연결 완료');

  app.listen(PORT, () => {
    console.log(`[Sentinel API] http://localhost:${PORT}`);
  });

  process.on('SIGINT', async () => {
    await gateway.disconnect();
    await closePool();
    process.exit(0);
  });
}

main().catch(e => { console.error(e); process.exit(1); });
