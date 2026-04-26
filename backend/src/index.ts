import * as readline from 'readline/promises';
import * as dotenv from 'dotenv';
import { resolve, dirname } from 'path';
import { fileURLToPath } from 'url';
import { SessionStore } from './store/SessionStore.js';
import { ToolGateway } from './engine/ToolGateway.js';
import { AgentEngine, STAGE2_SYSTEM_PROMPT } from './engine/AgentEngine.js';
import type { AgentEvent } from './engine/AgentEngine.js';
import { closePool } from './db/connection.js';

const __dirname = dirname(fileURLToPath(import.meta.url));
dotenv.config({ path: resolve(__dirname, '../../.env') });

const SEP = '─'.repeat(60);

const PRICE_INPUT  = 3.0;
const PRICE_OUTPUT = 15.0;
const KRW_PER_USD  = 1400;

function fmtCost(inTok: number, outTok: number): string {
  const usd = (inTok / 1_000_000) * PRICE_INPUT + (outTok / 1_000_000) * PRICE_OUTPUT;
  return `$${usd.toFixed(5)} (₩${Math.round(usd * KRW_PER_USD).toLocaleString()})`;
}

function clip(text: string, max = 120): string {
  return text.length > max ? text.slice(0, max) + '…' : text;
}

// ── 콘솔 이벤트 핸들러 ────────────────────────────────────────

function makeConsoleHandler(): (event: AgentEvent) => void {
  let dotInterval: ReturnType<typeof setInterval> | null = null;
  let firstText = true;

  return (event) => {
    switch (event.type) {
      case 'api_start':
        console.log(`\n  🤔 [API #${event.apiCount}] Claude 추론 시작`);
        console.log('  ─────────────────────────────────────────');
        process.stdout.write('  ⌛ 응답 대기 중');
        firstText = true;
        dotInterval = setInterval(() => process.stdout.write('.'), 800);
        break;

      case 'text':
        if (firstText) {
          firstText = false;
          if (dotInterval) { clearInterval(dotInterval); dotInterval = null; }
          process.stdout.write('\n');
        }
        process.stdout.write(event.delta);
        break;

      case 'response_end':
        if (dotInterval) { clearInterval(dotInterval); dotInterval = null; }
        process.stdout.write('\n');
        console.log('  ─────────────────────────────────────────');
        break;

      case 'cost':
        console.log(
          `  📊 [API #${event.apiCount}] ` +
          `${event.inputTokens.toLocaleString()}in / ${event.outputTokens.toLocaleString()}out  ` +
          fmtCost(event.inputTokens, event.outputTokens),
        );
        break;

      case 'tool_call':
        console.log(`\n  🔧 [도구 #${event.seq}] ${event.name}(${event.argsStr})`);
        break;

      case 'tool_result':
        console.log(event.isError
          ? `  ❌ [오류 #${event.seq}] ${event.preview}`
          : `  ✅ [결과 #${event.seq}] ${event.preview}`);
        break;

      case 'submit':
        console.log('\n  📤 [제출] submit_for_review 호출');
        break;

      case 'artifact':
        console.log(`  📝 [초안 v${event.version}]${event.summary ? ` — ${clip(event.summary, 60)}` : ''}`);
        break;

      case 'compaction':
        console.log(`  🗜️ 컨텍스트 압축: ${event.before}개 → ${event.after}개 메시지`);
        break;

      case 'rate_limit':
        console.log(`\n  ⏳ Rate limit. ${event.waitSec}초 대기... (${event.attempt}/3)`);
        break;

      case 'force_stop':
        console.log(event.reason === 'consecutive_errors'
          ? '\n  ⛔ 연속 도구 오류 3회 → 강제 중단'
          : `\n  ⚠️ 최대 도구 호출 횟수 도달 → 강제 중단`);
        break;

      case 'error':
        console.error(`\n  ❌ 오류: ${event.message}`);
        break;

      case 'done':
        console.log(
          `\n  ══ 실행 완료 | API ${event.apiCount}회 | ` +
          `${event.totalIn.toLocaleString()}in / ${event.totalOut.toLocaleString()}out | ` +
          `${fmtCost(event.totalIn, event.totalOut)} ══`,
        );
        break;
    }
  };
}

async function main(): Promise<void> {
  if (!process.env.ANTHROPIC_API_KEY) {
    console.error('[오류] ANTHROPIC_API_KEY 환경변수가 설정되지 않았습니다.');
    process.exit(1);
  }

  const store   = new SessionStore();
  const gateway = new ToolGateway();
  const engine  = new AgentEngine(store, gateway);
  const rl      = readline.createInterface({ input: process.stdin, output: process.stdout });

  try {
    console.log('=== Sentinel — 법령 검토 에이전트 ===\n');
    await gateway.connect();

    const inputText = await rl.question('이슈 내용: ');
    const issue  = await store.createIssue(inputText);
    const stage1 = await store.createStageSession(issue.id, 'STAGE_1', 'live');
    console.log(`\n[이슈 생성] ${issue.id}`);
    console.log(`[STAGE 1 세션] ${stage1.id}\n`);

    const confirmedArtifactId = await runStageLoop(rl, store, engine, stage1.id, 'STAGE 1: 검토 결론', {});

    if (!confirmedArtifactId) {
      console.log('\n[STAGE 1 중단 — 종료합니다]');
      return;
    }

    const confirmedArtifact = await store.getArtifact(confirmedArtifactId);
    console.log(`\n✅ STAGE 1 확정 완료 (Artifact: ${confirmedArtifactId})`);
    console.log(`   요약: ${confirmedArtifact.summary ?? '(없음)'}`);

    console.log('\n' + SEP);
    console.log('STAGE 2: 보고서 초안 작성');
    console.log(SEP);
    console.log('  y = 확정된 결론을 기반으로 자동 작성');
    console.log('  i = 직접 입력 (추가 맥락 포함)');
    console.log('  n = 건너뜀');
    const stage2Choice = (await rl.question('선택: ')).trim().toLowerCase();

    if (stage2Choice === 'n') { console.log('\n[STAGE 2 건너뜀]'); return; }

    let stage2InputText: string;
    if (stage2Choice === 'i') {
      console.log('\n[확정된 검토 결론]\n' + SEP);
      console.log(confirmedArtifact.content);
      console.log(SEP + '\n');
      const extra = await readMultiline(rl);
      stage2InputText = `[검토 결론]\n${confirmedArtifact.content}${extra ? `\n\n[추가 지시]\n${extra}` : ''}`;
    } else {
      stage2InputText = `[검토 결론]\n${confirmedArtifact.content}`;
    }

    const stage2 = await store.createStageSession(issue.id, 'STAGE_2', 'live', confirmedArtifactId);
    console.log(`\n[STAGE 2 세션] ${stage2.id}\n`);

    await runStageLoop(rl, store, engine, stage2.id, 'STAGE 2: 보고서 초안', {
      useMcpTools: false,
      systemPrompt: STAGE2_SYSTEM_PROMPT,
      initialInputOverride: stage2InputText,
    });

  } finally {
    await gateway.disconnect();
    await closePool();
    rl.close();
  }
}

// ── 스테이지 공통 루프 ─────────────────────────────────────────

interface LoopConfig {
  useMcpTools?: boolean;
  systemPrompt?: string;
  initialInputOverride?: string;
}

async function runStageLoop(
  rl: readline.Interface,
  store: SessionStore,
  engine: AgentEngine,
  sessionId: string,
  label: string,
  config: LoopConfig,
): Promise<string | null> {
  let currentFeedback: string | undefined;
  let isFirst = true;

  while (true) {
    console.log(`\n[${label} — 에이전트 실행 중...]\n`);

    const overrideForThisRun = isFirst ? config.initialInputOverride : undefined;
    isFirst = false;

    await engine.runSession(sessionId, currentFeedback, {
      useMcpTools: config.useMcpTools,
      systemPrompt: config.systemPrompt,
      initialInputOverride: overrideForThisRun,
      onEvent: makeConsoleHandler(),
    });
    currentFeedback = undefined;

    const s = await store.getStageSession(sessionId);
    console.log(`\n[세션 상태: ${s.status}]`);

    if (s.status === 'FAILED') { console.log('[에이전트가 오류로 종료되었습니다]'); return null; }
    if (s.status !== 'WAITING_FOR_HUMAN' || !s.latest_artifact_id) {
      console.log('[예상치 못한 상태입니다]');
      return null;
    }

    const artifact = await store.getArtifact(s.latest_artifact_id);
    console.log('\n' + SEP);
    console.log(`[${label} 초안 v${artifact.version}]`);
    if (artifact.summary) console.log(`요약: ${artifact.summary}`);
    console.log(SEP);
    console.log(artifact.content);
    console.log(SEP + '\n');

    const action = (await rl.question('행동 선택 [c=확정 / f=피드백 / s=중단]: ')).trim();

    if (action === 'c') {
      await store.confirmArtifact(sessionId, artifact.id);
      console.log(`\n[${label} 확정 완료] Artifact ID: ${artifact.id}`);
      return artifact.id;
    } else if (action === 'f') {
      const feedbackText = await readMultiline(rl);
      if (!feedbackText.trim()) { console.log('[피드백 내용이 비어있습니다]'); continue; }
      await store.createFeedback(sessionId, feedbackText, 'user');
      await store.incrementRetryCount(sessionId);
      await store.updateSessionStatus(sessionId, 'READY');
      currentFeedback = feedbackText;
      const updated = await store.getStageSession(sessionId);
      console.log(`\n[피드백 저장 완료. 누적 재진입: ${updated.retry_count}회]\n`);
    } else {
      console.log('\n[중단]');
      return null;
    }
  }
}

async function readMultiline(rl: readline.Interface): Promise<string> {
  const lines: string[] = [];
  while (true) {
    const line = await rl.question('');
    if (line === '' && lines.length > 0 && lines[lines.length - 1] === '') {
      lines.pop();
      break;
    }
    lines.push(line);
  }
  return lines.join('\n');
}

main().catch(e => { console.error(e); process.exit(1); });
