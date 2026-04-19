import * as dotenv from 'dotenv';
import { resolve, dirname } from 'path';
import { fileURLToPath } from 'url';

const __dirname = dirname(fileURLToPath(import.meta.url));
dotenv.config({ path: resolve(__dirname, '../../.env') });

import Anthropic from '@anthropic-ai/sdk';
import { getPool, closePool } from './db/connection.js';
import { ToolGateway } from './engine/ToolGateway.js';
import { SessionStore } from './store/SessionStore.js';

async function run() {
  let passed = 0;
  let failed = 0;
  const ok  = (msg: string) => { console.log(`  ✓ ${msg}`); passed++; };
  const err = (msg: string, e: unknown) => { console.log(`  ✗ ${msg}: ${(e as Error).message}`); failed++; };

  // ── 1. DB 연결 ──────────────────────────────────────────
  console.log('\n[1] MariaDB 연결');
  try {
    const pool = getPool();
    const [rows] = await pool.query('SELECT 1+1 AS result');
    ok(`sentinel_db 연결 성공 (${JSON.stringify(rows)})`);
  } catch (e) { err('DB 연결 실패', e); }

  // ── 2. SessionStore 기본 동작 ──────────────────────────
  console.log('\n[2] SessionStore CRUD');
  const store = new SessionStore();
  let issueId = '';
  let sessionId = '';
  try {
    const issue = await store.createIssue('테스트용 입력입니다.');
    issueId = issue.id;
    ok(`Issue 생성: ${issueId}`);

    const session = await store.createStageSession(issueId, 'STAGE_1');
    sessionId = session.id;
    ok(`StageSession 생성: ${sessionId}`);

    const artifact = await store.createArtifact(sessionId, '테스트 산출물', '테스트 요약');
    ok(`Artifact 생성 v${artifact.version}: ${artifact.id}`);
  } catch (e) { err('SessionStore 오류', e); }

  // ── 3. Claude API 최소 호출 ────────────────────────────
  console.log('\n[3] Claude API (Haiku, 최소 토큰)');
  try {
    const client = new Anthropic();
    const response = await client.messages.create({
      model: 'claude-haiku-4-5-20251001',
      max_tokens: 30,
      messages: [{ role: 'user', content: '숫자 1을 한국어로 쓰면?' }],
    });
    const text = (response.content[0] as { type: string; text: string }).text;
    ok(`API 응답: "${text.trim()}" (입력 ${response.usage.input_tokens}tok / 출력 ${response.usage.output_tokens}tok)`);
  } catch (e) { err('Claude API 오류', e); }

  // ── 4. MCP ToolGateway 연결 ────────────────────────────
  console.log('\n[4] MCP ToolGateway (도구 목록만)');
  const gateway = new ToolGateway();
  try {
    await gateway.connect();
    const tools = await gateway.listTools();
    ok(`도구 ${tools.length}개 확인: ${tools.map(t => t.name).join(', ')}`);
  } catch (e) { err('ToolGateway 오류', e); }
  await gateway.disconnect();

  // ── 결과 ──────────────────────────────────────────────
  await closePool();
  console.log(`\n결과: ${passed}개 통과 / ${failed}개 실패\n`);
  if (failed > 0) process.exit(1);
}

run().catch(e => { console.error(e); process.exit(1); });
