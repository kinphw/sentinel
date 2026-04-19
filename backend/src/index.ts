import * as readline from 'readline/promises';
import * as dotenv from 'dotenv';
import { resolve, dirname } from 'path';
import { fileURLToPath } from 'url';
import { SessionStore } from './store/SessionStore.js';
import { ToolGateway } from './engine/ToolGateway.js';
import { AgentEngine, STAGE2_SYSTEM_PROMPT } from './engine/AgentEngine.js';
import { closePool } from './db/connection.js';
import type { StageSession } from './models/types.js';

const __dirname = dirname(fileURLToPath(import.meta.url));
dotenv.config({ path: resolve(__dirname, '../../.env') });

const SEP = '─'.repeat(60);

async function main(): Promise<void> {
  if (!process.env.ANTHROPIC_API_KEY) {
    console.error('[오류] ANTHROPIC_API_KEY 환경변수가 설정되지 않았습니다. .env 파일을 확인하세요.');
    process.exit(1);
  }

  const store   = new SessionStore();
  const gateway = new ToolGateway();
  const engine  = new AgentEngine(store, gateway);
  const rl      = readline.createInterface({ input: process.stdin, output: process.stdout });

  try {
    console.log('=== Sentinel — 법령 검토 에이전트 ===\n');

    await gateway.connect();

    // ── 이슈 입력 ─────────────────────────────────────────────
    const inputText = await rl.question('이슈 내용: ');
    const issue   = await store.createIssue(inputText);
    const stage1  = await store.createStageSession(issue.id, 'STAGE_1');
    console.log(`\n[이슈 생성] ${issue.id}`);
    console.log(`[STAGE 1 세션] ${stage1.id}\n`);

    // ── STAGE 1 루프 ──────────────────────────────────────────
    const confirmedArtifactId = await runStageLoop(rl, store, engine, stage1.id, 'STAGE 1: 검토 결론', {});

    if (!confirmedArtifactId) {
      console.log('\n[STAGE 1 중단 — 종료합니다]');
      return;
    }

    const confirmedArtifact = await store.getArtifact(confirmedArtifactId);
    console.log(`\n✅ STAGE 1 확정 완료 (Artifact: ${confirmedArtifactId})`);
    console.log(`   요약: ${confirmedArtifact.summary ?? '(없음)'}`);

    // ── STAGE 2 시작 여부 ──────────────────────────────────────
    console.log('\n' + SEP);
    console.log('STAGE 2: 보고서 초안 작성');
    console.log(SEP);
    console.log('  y = 확정된 결론을 기반으로 자동 작성');
    console.log('  i = 직접 입력 (추가 맥락 포함)');
    console.log('  n = 건너뜀');
    const stage2Choice = (await rl.question('선택: ')).trim().toLowerCase();

    if (stage2Choice === 'n') {
      console.log('\n[STAGE 2 건너뜀 — 종료합니다]');
      return;
    }

    let stage2InputText: string;

    if (stage2Choice === 'i') {
      console.log('\n[확정된 검토 결론]\n' + SEP);
      console.log(confirmedArtifact.content);
      console.log(SEP + '\n');
      console.log('추가 맥락이나 수정 지시사항을 입력하세요.');
      console.log('(빈 줄로 입력을 마치려면 빈 줄에서 Enter를 두 번 누르세요)\n');
      const extra = await readMultiline(rl);
      stage2InputText = `[검토 결론]\n${confirmedArtifact.content}${extra ? `\n\n[추가 지시]\n${extra}` : ''}`;
    } else {
      // y (default)
      stage2InputText = `[검토 결론]\n${confirmedArtifact.content}`;
    }

    const stage2 = await store.createStageSession(issue.id, 'STAGE_2', confirmedArtifactId);
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
  initialInputOverride?: string; // Stage 2처럼 이슈 텍스트 대신 다른 내용을 첫 메시지로
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

    // initialInputOverride: 첫 실행에만 적용 (Stage 2 전용 입력)
    const overrideForThisRun = isFirst ? config.initialInputOverride : undefined;
    isFirst = false;

    await engine.runSession(sessionId, currentFeedback, {
      useMcpTools: config.useMcpTools,
      systemPrompt: config.systemPrompt,
      initialInputOverride: overrideForThisRun,
    });
    currentFeedback = undefined;

    const s = await store.getStageSession(sessionId);
    console.log(`\n[세션 상태: ${s.status}]`);

    if (s.status === 'FAILED') {
      console.log('[에이전트가 오류로 종료되었습니다]');
      return null;
    }

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
      console.log('피드백 내용을 입력하세요. (빈 줄에서 Enter 두 번으로 완료)\n');
      const feedbackText = await readMultiline(rl);
      if (!feedbackText.trim()) {
        console.log('[피드백 내용이 비어있습니다. 다시 선택해주세요]');
        continue;
      }
      await store.createFeedback(sessionId, feedbackText, 'user');
      await store.incrementRetryCount(sessionId);
      await store.updateSessionStatus(sessionId, 'READY');
      currentFeedback = feedbackText;
      const updated = await store.getStageSession(sessionId);
      console.log(`\n[피드백 저장 완료. 누적 재진입 횟수: ${updated.retry_count}]\n`);

    } else {
      console.log('\n[중단]');
      return null;
    }
  }
}

// ── 여러 줄 입력 헬퍼 ─────────────────────────────────────────
// 빈 줄이 연속으로 오면 입력 종료

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

main().catch(e => {
  console.error(e);
  process.exit(1);
});
