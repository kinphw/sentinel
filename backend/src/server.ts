import express from 'express';
import cors from 'cors';
import * as dotenv from 'dotenv';
import { resolve, dirname, join } from 'path';
import { fileURLToPath } from 'url';
import { existsSync } from 'fs';
import { SessionStore } from './store/SessionStore.js';
import { ToolGateway } from './engine/ToolGateway.js';
import { AgentEngine, buildStage2SystemPrompt } from './engine/AgentEngine.js';
import type { AgentEvent } from './engine/AgentEngine.js';
import { closePool } from './db/connection.js';

const __dirname = dirname(fileURLToPath(import.meta.url));
dotenv.config({ path: resolve(__dirname, '../../.env') });

const PORT = parseInt(process.env.PORT ?? '3101', 10);

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
      systemPrompt = buildStage2SystemPrompt(opts.customToc);
      useMcpTools = false;
    }

    if (!opts.feedback) {
      initialInputOverride = buildInitialInput(stage, {
        sourceArtifact,
        manualInput: opts.manualInput,
        developmentNote: opts.developmentNote,
      });
    }

    // Stage 2는 도구 호출 없이 단발 응답으로 끝나므로 cache write의 25% premium만
    // 부담하게 됨 → 캐시 끄기. Stage 1은 다회전 루프이므로 캐시 효과 큼.
    const enablePromptCache = stage !== 'STAGE_2';

    await engine.runSession(sessionId, opts.feedback, {
      systemPrompt,
      useMcpTools,
      initialInputOverride,
      enablePromptCache,
      onEvent: (event) => broadcast(sessionId, event),
    });
  } finally {
    runningSession.delete(sessionId);
  }
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
      const hasEditedInput = Boolean(opts.manualInput?.trim());
      const sourceText = opts.manualInput?.trim() || opts.sourceArtifact.content;
      const label = opts.sourceArtifact.session_stage === 'STAGE_2'
        ? hasEditedInput ? '사용자 수정본 보고서 초안' : '기존 보고서 초안'
        : hasEditedInput ? '사용자 수정본 검토 결론' : '검토 결론';
      const action = opts.sourceArtifact.session_stage === 'STAGE_2'
        ? '위 기존 보고서를 바탕으로 요청사항을 반영한 새로운 보고서 초안을 작성해주세요.'
        : '위 검토 결론을 바탕으로 새로운 보고서 초안을 작성해주세요.';
      return `[${label}]\n${sourceText}${noteSection}\n\n${action}`;
    }

    if (opts.manualInput?.trim()) {
      return `[검토 결론]\n${opts.manualInput.trim()}${noteSection}\n\n위 내용을 바탕으로 새로운 보고서 초안을 작성해주세요.`;
    }

    return undefined;
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

// GET /api/runtime
app.get('/api/runtime', (_req, res) => {
  res.json({
    port: PORT,
  });
});

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
      agentMode,
      inputArtifactId,
      manualInput,
      customToc,
      developmentNote,
    } = req.body as {
      issueId?: string;
      stage: 'STAGE_1' | 'STAGE_2';
      agentMode?: 'live' | 'mock';
      inputArtifactId?: string;
      manualInput?: string;
      customToc?: string;
      developmentNote?: string;
    };

    if (!stage) { res.status(400).json({ error: 'stage required' }); return; }

    const mode: 'live' | 'mock' = agentMode === 'mock' ? 'mock' : 'live';

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

    const session = await store.createStageSession(actualIssueId, stage, mode, inputArtifactId);
    res.json({ id: session.id, issueId: actualIssueId, agentMode: mode });

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

// POST /api/sessions/:id/resume — 일시적 오류로 중단된 세션 재개
app.post('/api/sessions/:id/resume', async (req, res) => {
  try {
    const sessionId = req.params.id;
    const session = await store.getStageSession(sessionId);

    // READY: recoverable 오류로 자동 복구된 상태 / FAILED: 사용자가 명시적으로 재개 시도
    if (!['READY', 'FAILED'].includes(session.status)) {
      res.status(409).json({ error: `세션 상태가 재개 불가: ${session.status}` });
      return;
    }

    if (runningSession.has(sessionId)) {
      res.status(409).json({ error: '이미 실행 중인 세션입니다.' });
      return;
    }

    if (session.status === 'FAILED') {
      await store.updateSessionStatus(sessionId, 'READY');
    }

    res.json({ ok: true });

    // feedback 없이 기존 messages 그대로 이어서 실행
    startAgent(sessionId, session.stage).catch(console.error);
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

// GET /api/admin/issues
app.get('/api/admin/issues', async (req, res) => {
  try {
    const { query, stage, onlyMock, limit } = req.query as Record<string, string>;
    const issues = await store.getAdminIssues({
      query,
      stage,
      onlyMock: onlyMock === 'true',
      limit: limit ? parseInt(limit, 10) : undefined,
    });
    res.json(issues);
  } catch (e) { res.status(500).json({ error: (e as Error).message }); }
});

// GET /api/admin/issues/:id
app.get('/api/admin/issues/:id', async (req, res) => {
  try {
    const detail = await store.getAdminIssueDetail(req.params.id);
    res.json(detail);
  } catch (e) { res.status(500).json({ error: (e as Error).message }); }
});

// DELETE /api/admin/issues/:id
app.delete('/api/admin/issues/:id', async (req, res) => {
  try {
    const detail = await store.getAdminIssueDetail(req.params.id);
    if (detail.sessions.some(session => runningSession.has(session.id))) {
      res.status(409).json({ error: '현재 실행 중인 이슈는 삭제할 수 없습니다.' });
      return;
    }

    const result = await store.deleteIssueCascade(req.params.id);
    res.json({ ok: true, ...result });
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
    console.warn('[경고] ANTHROPIC_API_KEY 미설정 — live 모드 세션은 실패합니다 (mock 모드는 동작).');
  }

  await gateway.connect();
  console.log('[ToolGateway] MCP 서버 연결 완료');

  app.listen(PORT, () => {
    console.log(`[Sentinel API] http://localhost:${PORT}`);
  });

  let shuttingDown = false;
  const shutdown = async (signal: string) => {
    if (shuttingDown) return;
    shuttingDown = true;
    console.log(`[Sentinel API] ${signal} 수신 — graceful shutdown`);
    try {
      await gateway.disconnect();
      await closePool();
    } finally {
      process.exit(0);
    }
  };

  process.on('SIGINT',  () => { void shutdown('SIGINT'); });
  process.on('SIGTERM', () => { void shutdown('SIGTERM'); });
}

main().catch(e => { console.error(e); process.exit(1); });
