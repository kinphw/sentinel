import * as readline from 'readline/promises';
import * as dotenv from 'dotenv';
import { resolve, dirname } from 'path';
import { fileURLToPath } from 'url';
import { SessionStore } from './store/SessionStore.js';
import { ToolGateway } from './engine/ToolGateway.js';
import { AgentEngine } from './engine/AgentEngine.js';
import { closePool } from './db/connection.js';

const __dirname = dirname(fileURLToPath(import.meta.url));
dotenv.config({ path: resolve(__dirname, '../../.env') });

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
    console.log('=== Sentinel P2 — 에이전트 엔진 테스트 ===\n');

    const inputText = await rl.question('이슈 내용: ');

    const issue   = await store.createIssue(inputText);
    const session = await store.createStageSession(issue.id, 'STAGE_1');
    console.log(`\n[이슈 생성] ${issue.id}`);
    console.log(`[STAGE 1 세션] ${session.id}\n`);

    await gateway.connect();
    console.log('');

    let currentFeedback: string | undefined;

    while (true) {
      console.log('[에이전트 실행 중...]\n');
      await engine.runSession(session.id, currentFeedback);
      currentFeedback = undefined;

      const s = await store.getStageSession(session.id);
      console.log(`\n[세션 상태: ${s.status}]`);

      if (s.status === 'FAILED') {
        console.log('[에이전트가 오류로 종료되었습니다]');
        break;
      }

      if (s.status !== 'WAITING_FOR_HUMAN' || !s.latest_artifact_id) {
        console.log('[예상치 못한 상태입니다]');
        break;
      }

      const artifact = await store.getArtifact(s.latest_artifact_id);
      console.log('\n' + '─'.repeat(60));
      console.log(`[검토 결론 초안 v${artifact.version}]`);
      if (artifact.summary) console.log(`요약: ${artifact.summary}`);
      console.log('─'.repeat(60));
      console.log(artifact.content);
      console.log('─'.repeat(60) + '\n');

      const action = await rl.question('행동 선택 [c=확정 / f=피드백 / s=중단]: ');

      if (action.trim() === 'c') {
        await store.confirmArtifact(session.id, artifact.id);
        console.log('\n[STAGE 1 확정 완료]');
        console.log(`확정된 Artifact ID: ${artifact.id}`);
        console.log('다음 단계: STAGE 2 세션을 생성하면 보고서 초안 에이전트가 실행됩니다.');
        break;

      } else if (action.trim() === 'f') {
        const feedbackText = await rl.question('피드백 내용: ');
        await store.createFeedback(session.id, feedbackText, 'user');
        await store.incrementRetryCount(session.id);
        await store.updateSessionStatus(session.id, 'READY');
        currentFeedback = feedbackText;
        const updated = await store.getStageSession(session.id);
        console.log(`\n[피드백 저장 완료. 누적 재진입 횟수: ${updated.retry_count}]\n`);

      } else {
        console.log('\n[중단]');
        break;
      }
    }
  } finally {
    await gateway.disconnect();
    await closePool();
    rl.close();
  }
}

main().catch(e => {
  console.error(e);
  process.exit(1);
});
