import Anthropic from '@anthropic-ai/sdk';
import type { SessionStore } from '../store/SessionStore.js';
import type { ToolGateway } from './ToolGateway.js';

const MODEL = process.env.ANTHROPIC_MODEL ?? 'claude-sonnet-4-6';
const DEFAULT_MAX_TOOL_CALLS = 60;
const MAX_TOOL_CALLS = parsePositiveInt(process.env.SENTINEL_MAX_TOOL_CALLS, DEFAULT_MAX_TOOL_CALLS);
const DEFAULT_MAX_TOKENS = 8_192;
const MAX_TOKENS = parsePositiveInt(process.env.SENTINEL_MAX_TOKENS, DEFAULT_MAX_TOKENS);
const DEFAULT_MAX_TOOL_RESULT_CHARS = 8_000;
const MAX_TOOL_RESULT_CHARS = parsePositiveInt(
  process.env.SENTINEL_MAX_TOOL_RESULT_CHARS,
  DEFAULT_MAX_TOOL_RESULT_CHARS,
);
const ENABLE_CONTEXT_COMPACTION = parseBoolean(process.env.SENTINEL_ENABLE_CONTEXT_COMPACTION, false);
const DEFAULT_MAX_CONTEXT_MESSAGES = 12;
const MAX_CONTEXT_MESSAGES = parsePositiveInt(
  process.env.SENTINEL_MAX_CONTEXT_MESSAGES,
  DEFAULT_MAX_CONTEXT_MESSAGES,
);
const DEFAULT_CONTEXT_SUMMARY_CHARS = 1_200;
const CONTEXT_SUMMARY_CHARS = parsePositiveInt(
  process.env.SENTINEL_CONTEXT_SUMMARY_CHARS,
  DEFAULT_CONTEXT_SUMMARY_CHARS,
);
const TEMPERATURE = parseNumberInRange(process.env.SENTINEL_TEMPERATURE, 0, 0, 1);

// claude-sonnet-4-6 근사 단가 (USD/1M tokens)
const PRICE_INPUT  = 3.0;
const PRICE_OUTPUT = 15.0;
const KRW_PER_USD  = 1400;

const SYSTEM_PROMPT = `당신은 금융감독원 법령 검토 에이전트입니다.

목표:
- 이슈의 법적 쟁점을 파악하고
- 필요한 법령·법령해석만 좁게 조회한 뒤
- 근거를 바탕으로 판단을 정리하고
- 충분하면 submit_for_review를 호출합니다.

원칙:
- 같은 검색어, 같은 법령ID, 같은 조문, 같은 해석 ID를 반복 조회하지 마세요.
- 이미 확보한 정보가 있으면 재사용하고, 정말 필요할 때만 추가 조회하세요.
- 긴 전문 조회보다 목차/특정 조문 조회를 우선하세요.
- get_law_text는 사용하지 마세요.

도구 사용 순서:
1. 법령해석: search_interpretation(짧은 키워드) -> get_interpretation(id)
2. 법령: search_law -> get_law_hierarchy
3. 조문 탐색: get_law_toc 또는 get_admin_rule_toc
4. 정밀 조회: get_law_article 또는 get_admin_rule_article
5. get_admin_rule_text는 전체 확인이 꼭 필요할 때만 사용

산출물:
- 검토 결론은 보고서 형식이 아닌 줄글 텍스트
- 쟁점, 판단, 근거가 분명해야 함`;

const SUBMIT_FOR_REVIEW_TOOL: Anthropic.Tool = {
  name: 'submit_for_review',
  description:
    '검토 결론 초안이 완성되었을 때 사람의 확인을 요청합니다. ' +
    '법령 조회가 충분히 이루어지고 판단이 완성되었다고 판단될 때 이 도구를 호출하세요.',
  input_schema: {
    type: 'object',
    properties: {
      content: { type: 'string', description: '검토 결론 전문 (쟁점·판단·근거를 포함한 완전한 줄글 텍스트)' },
      summary: { type: 'string', description: '검토 결론 2-3줄 요약' },
    },
    required: ['content', 'summary'],
  },
};

// ── 로깅 헬퍼 ────────────────────────────────────────────────

function clip(text: string, max = 80): string {
  return text.length > max ? text.slice(0, max) + '…' : text;
}

function fmtArgs(args: Record<string, unknown>): string {
  return Object.entries(args)
    .map(([k, v]) => `${k}=${clip(typeof v === 'string' ? v : JSON.stringify(v), 40)}`)
    .join(', ');
}

function fmtCost(inputTok: number, outputTok: number): string {
  const usd = (inputTok / 1_000_000) * PRICE_INPUT + (outputTok / 1_000_000) * PRICE_OUTPUT;
  const krw = usd * KRW_PER_USD;
  return `$${usd.toFixed(5)} (₩${Math.round(krw).toLocaleString()})`;
}

function fmtTokens(input: number, output: number): string {
  return `${input.toLocaleString()}in / ${output.toLocaleString()}out`;
}

function parsePositiveInt(value: string | undefined, fallback: number): number {
  if (!value) return fallback;
  const parsed = Number.parseInt(value, 10);
  return Number.isFinite(parsed) && parsed > 0 ? parsed : fallback;
}

function parseBoolean(value: string | undefined, fallback: boolean): boolean {
  if (!value) return fallback;
  const normalized = value.trim().toLowerCase();
  if (['1', 'true', 'yes', 'on'].includes(normalized)) return true;
  if (['0', 'false', 'no', 'off'].includes(normalized)) return false;
  return fallback;
}

function parseNumberInRange(
  value: string | undefined,
  fallback: number,
  min: number,
  max: number,
): number {
  if (!value) return fallback;
  const parsed = Number.parseFloat(value);
  return Number.isFinite(parsed) && parsed >= min && parsed <= max ? parsed : fallback;
}

function isToolResultUserMessage(
  msg: Anthropic.MessageParam | undefined,
): msg is Anthropic.MessageParam & { role: 'user'; content: Anthropic.ContentBlockParam[] } {
  return Boolean(
    msg &&
    msg.role === 'user' &&
    Array.isArray(msg.content) &&
    msg.content.some(block => block.type === 'tool_result'),
  );
}

function extractMessageText(msg: Anthropic.MessageParam): string {
  if (typeof msg.content === 'string') return msg.content;
  if (!Array.isArray(msg.content)) return '';

  return msg.content
    .map(block => {
      if (block.type === 'text') return block.text;
      if (block.type === 'tool_result') {
        const content = typeof block.content === 'string'
          ? block.content
          : Array.isArray(block.content)
            ? block.content
                .filter(
                  (nested): nested is Anthropic.TextBlockParam =>
                    nested.type === 'text' && typeof nested.text === 'string',
                )
                .map(nested => nested.text)
                .join('\n')
            : '';
        return `[tool_result]\n${content}`;
      }
      if (block.type === 'tool_use') {
        return `[tool_use] ${block.name}(${fmtArgs(block.input as Record<string, unknown>)})`;
      }
      return '';
    })
    .filter(Boolean)
    .join('\n');
}

function summarizeCompactedMessages(messages: Anthropic.MessageParam[]): string {
  const snippets = messages
    .map(msg => {
      const text = clip(extractMessageText(msg).replace(/\s+/g, ' ').trim(), 220);
      if (!text) return '';
      const prefix = msg.role === 'assistant' ? '[assistant]' : '[user]';
      return `${prefix} ${text}`;
    })
    .filter(Boolean);

  if (snippets.length === 0) {
    return '이전 메시지 일부가 비용 절감을 위해 생략되었습니다.';
  }

  const joined = snippets.join('\n');
  return clip(joined, CONTEXT_SUMMARY_CHARS);
}

function buildRequestMessages(messages: Anthropic.MessageParam[]): Anthropic.MessageParam[] {
  if (!ENABLE_CONTEXT_COMPACTION) return messages;
  if (messages.length <= MAX_CONTEXT_MESSAGES + 1) return messages;

  let start = Math.max(1, messages.length - MAX_CONTEXT_MESSAGES);
  while (start > 1 && isToolResultUserMessage(messages[start])) {
    start--;
  }

  const compacted = messages.slice(1, start);
  if (compacted.length === 0) return messages;

  const summaryMsg: Anthropic.MessageParam = {
    role: 'user',
    content:
      '[이전 맥락 요약]\n' +
      summarizeCompactedMessages(compacted) +
      '\n\n이 요약을 전제로 최근 메시지와 최신 도구 결과를 우선 반영해 계속 진행하세요.',
  };

  return [messages[0], summaryMsg, ...messages.slice(start)];
}

// ── Rate limit 자동 재시도 ───────────────────────────────────

async function withRateLimitRetry<T>(fn: () => Promise<T>, maxRetries = 3): Promise<T> {
  for (let attempt = 0; attempt <= maxRetries; attempt++) {
    try {
      return await fn();
    } catch (e) {
      if (e instanceof Anthropic.RateLimitError && attempt < maxRetries) {
        const waitSec = parseInt(String((e.headers as Record<string, string>)?.['retry-after'] ?? '60'), 10);
        console.log(`\n  ⏳ Rate limit 도달. ${waitSec}초 대기 후 재시도... (${attempt + 1}/${maxRetries})`);
        await new Promise(r => setTimeout(r, waitSec * 1000));
        continue;
      }
      throw e;
    }
  }
  throw new Error('최대 재시도 횟수 초과');
}

// ── AgentEngine ──────────────────────────────────────────────

export class AgentEngine {
  private client: Anthropic;

  constructor(
    private store: SessionStore,
    private gateway: ToolGateway,
  ) {
    this.client = new Anthropic();
  }

  async runSession(sessionId: string, feedback?: string): Promise<void> {
    const session = await this.store.getStageSession(sessionId);
    const issue   = await this.store.getIssue(session.issue_id);

    await this.store.updateSessionStatus(sessionId, 'RUNNING');
    const run = await this.store.createAgentRun(sessionId, MODEL);

    let totalIn  = 0;
    let totalOut = 0;
    let apiCount = 0;

    let messages: Anthropic.MessageParam[] = await this.store.getApiMessages(sessionId);

    if (messages.length === 0) {
      const initMsg: Anthropic.MessageParam = {
        role: 'user',
        content: `다음 이슈를 검토해주세요.\n\n${issue.input_text}`,
      };
      messages.push(initMsg);
      await this.store.appendMessage(sessionId, run.id, initMsg);
    } else if (feedback) {
      const feedbackText = `[피드백]\n${feedback}\n\n위 피드백을 반영하여 검토 결론을 재작성해주세요.`;
      const lastMessage = messages.at(-1);

      if (isToolResultUserMessage(lastMessage)) {
        const mergedMsg: Anthropic.MessageParam = {
          role: 'user',
          content: [
            ...lastMessage.content,
            {
              type: 'text',
              text: feedbackText,
            } as Anthropic.TextBlockParam,
          ],
        };

        messages[messages.length - 1] = mergedMsg;
        await this.store.replaceLastMessage(sessionId, mergedMsg);
      } else {
      const lastAssistant = [...messages].reverse().find(m => m.role === 'assistant');
      const submitBlock = lastAssistant && Array.isArray(lastAssistant.content)
        ? (lastAssistant.content as Anthropic.ContentBlock[]).find(
            (b): b is Anthropic.ToolUseBlock => b.type === 'tool_use' && b.name === 'submit_for_review',
          )
        : undefined;

      const resumeMsg: Anthropic.MessageParam = submitBlock
        ? {
            role: 'user',
            content: [
              {
                type: 'tool_result',
                tool_use_id: submitBlock.id,
                content: '피드백이 접수되었습니다. 아래 피드백을 반영하여 재작성합니다.',
              } as Anthropic.ToolResultBlockParam,
              {
                type: 'text',
                text: feedbackText,
              } as Anthropic.TextBlockParam,
            ],
          }
        : {
            role: 'user',
            content: feedbackText,
          };

        messages.push(resumeMsg);
        await this.store.appendMessage(sessionId, run.id, resumeMsg);
      }
    }

    const mcpTools = await this.gateway.listTools();
    const allTools = [...mcpTools, SUBMIT_FOR_REVIEW_TOOL];
    let toolCallCount = 0;
    let consecutiveErrors = 0;
    const MAX_CONSECUTIVE_ERRORS = 3;

    try {
      while (true) {
        apiCount++;
        console.log(`\n  🤔 [API #${apiCount}] Claude 추론 시작`);
        console.log('  ─────────────────────────────────────────');

        // 스트리밍으로 Claude 응답을 실시간 출력 (rate limit 시 자동 재시도)
        const response = await withRateLimitRetry(async () => {
          const requestMessages = buildRequestMessages(messages);
          if (requestMessages.length !== messages.length) {
            console.log(
              `  🗜️ 컨텍스트 압축: ${messages.length}개 메시지 → ${requestMessages.length}개 메시지`,
            );
          }

          const stream = this.client.messages.stream({
            model: MODEL,
            max_tokens: MAX_TOKENS,
            system: SYSTEM_PROMPT,
            messages: requestMessages,
            tools: allTools,
            temperature: TEMPERATURE,
          });

          // 첫 텍스트 수신 전까지 대기 점 표시
          process.stdout.write('  ⌛ 응답 대기 중');
          let firstText = true;
          const dotInterval = setInterval(() => process.stdout.write('.'), 800);

          stream.on('text', (text) => {
            if (firstText) {
              firstText = false;
              clearInterval(dotInterval);
              process.stdout.write('\n');
            }
            process.stdout.write(text);
          });

          const msg = await stream.finalMessage();
          if (firstText) { clearInterval(dotInterval); process.stdout.write('\n'); }
          return msg;
        });
        process.stdout.write('\n');
        console.log('  ─────────────────────────────────────────');

        const { input_tokens, output_tokens } = response.usage;
        totalIn  += input_tokens;
        totalOut += output_tokens;
        console.log(
          `  📊 [API #${apiCount}] 이번: ${fmtTokens(input_tokens, output_tokens)} ${fmtCost(input_tokens, output_tokens)}` +
          `\n  📊 누계: ${fmtTokens(totalIn, totalOut)} ${fmtCost(totalIn, totalOut)}`,
        );

        const assistantMsg: Anthropic.MessageParam = {
          role: 'assistant',
          content: response.content,
        };
        messages.push(assistantMsg);
        await this.store.appendMessage(sessionId, run.id, assistantMsg);

        // ── end_turn ─────────────────────────────────────────
        if (response.stop_reason === 'end_turn') {
          console.log('\n  📝 [결론] 텍스트 응답 종료 → 초안 생성');
          const text = response.content
            .filter((b): b is Anthropic.TextBlock => b.type === 'text')
            .map(b => b.text)
            .join('\n');
          const artifact = await this.store.createArtifact(sessionId, text, '');
          await this.store.markWaitingForHuman(sessionId, artifact.id);
          await this.store.updateRunStatus(run.id, 'PAUSED_FOR_HUMAN', 'human');
          break;
        }

        // ── tool_use ─────────────────────────────────────────
        if (response.stop_reason === 'tool_use') {
          const toolUseBlocks = response.content.filter(
            (b): b is Anthropic.ToolUseBlock => b.type === 'tool_use',
          );
          const regularToolResults: Anthropic.ToolResultBlockParam[] = [];
          let shouldStop = false;

          for (const block of toolUseBlocks) {
            toolCallCount++;

            if (block.name === 'submit_for_review') {
              console.log('\n  📤 [제출] submit_for_review → 초안 Artifact 생성');
              const input = block.input as { content: string; summary: string };
              const artifact = await this.store.createArtifact(sessionId, input.content, input.summary);
              await this.store.markWaitingForHuman(sessionId, artifact.id);
              shouldStop = true;
            } else {
              const args = block.input as Record<string, unknown>;
              console.log(`\n  🔧 [도구 #${toolCallCount}] ${block.name}(${fmtArgs(args)})`);

              let resultText: string;
              let isError = false;
              try {
                resultText = await this.gateway.callTool(block.name, args);
                // MCP가 오류 텍스트를 반환하는 경우도 감지
                if (resultText.startsWith('오류:')) isError = true;
              } catch (e) {
                resultText = `도구 오류: ${(e as Error).message}`;
                isError = true;
              }

              if (isError) {
                consecutiveErrors++;
                console.log(`  ❌ [오류 #${toolCallCount}] ${clip(resultText, 120)} (연속 오류: ${consecutiveErrors}/${MAX_CONSECUTIVE_ERRORS})`);
              } else {
                consecutiveErrors = 0;
                // 긴 결과는 잘라서 컨텍스트 폭발 방지
                if (resultText.length > MAX_TOOL_RESULT_CHARS) {
                  resultText = resultText.slice(0, MAX_TOOL_RESULT_CHARS) +
                    `\n\n[결과가 길어 ${MAX_TOOL_RESULT_CHARS.toLocaleString()}자에서 잘렸습니다. ` +
                    '더 좁은 범위로 재조회하거나 get_law_article로 특정 조문을 조회하세요.]';
                }
                console.log(`  ✅ [결과 #${toolCallCount}] ${clip(resultText.replace(/\n/g, ' '), 120)}`);
              }

              regularToolResults.push({
                type: 'tool_result',
                tool_use_id: block.id,
                content: resultText,
                ...(isError && { is_error: true }),
              } as Anthropic.ToolResultBlockParam);
            }
          }

          if (regularToolResults.length > 0) {
            const toolResultMsg: Anthropic.MessageParam = { role: 'user', content: regularToolResults };
            messages.push(toolResultMsg);
            await this.store.appendMessage(sessionId, run.id, toolResultMsg);
          }

          if (shouldStop) {
            await this.store.updateRunStatus(run.id, 'PAUSED_FOR_HUMAN', 'human');
            return;
          }

          if (consecutiveErrors >= MAX_CONSECUTIVE_ERRORS) {
            console.log(`\n  ⛔ 연속 도구 오류 ${MAX_CONSECUTIVE_ERRORS}회 → 강제 중단`);
            const lastText = messages
              .filter(m => m.role === 'assistant')
              .flatMap(m => (Array.isArray(m.content) ? m.content : []))
              .filter((b): b is Anthropic.TextBlock => (b as Anthropic.ContentBlock).type === 'text')
              .map(b => b.text)
              .join('\n');
            const artifact = await this.store.createArtifact(sessionId, lastText, `(도구 연속 오류 ${MAX_CONSECUTIVE_ERRORS}회로 중단)`);
            await this.store.markWaitingForHuman(sessionId, artifact.id);
            await this.store.updateRunStatus(run.id, 'PAUSED_FOR_HUMAN', 'human');
            break;
          }

          if (toolCallCount >= MAX_TOOL_CALLS) {
            console.log(`\n  ⚠️ 최대 도구 호출 횟수(${MAX_TOOL_CALLS}) 도달 → 강제 중단`);
            const pauseNotice =
              `도구 호출 한도(${MAX_TOOL_CALLS}회)에 도달하여 여기서 중단합니다.\n` +
              '현재까지 수집한 근거를 바탕으로 사람이 검토를 이어갈 수 있도록 대기 상태로 전환합니다.';
            const pauseMsg: Anthropic.MessageParam = {
              role: 'assistant',
              content: pauseNotice,
            };
            messages.push(pauseMsg);
            await this.store.appendMessage(sessionId, run.id, pauseMsg);

            const lastText = messages
              .filter(m => m.role === 'assistant')
              .flatMap(m => (Array.isArray(m.content) ? m.content : []))
              .filter((b): b is Anthropic.TextBlock => (b as Anthropic.ContentBlock).type === 'text')
              .map(b => b.text)
              .join('\n');
            const artifact = await this.store.createArtifact(
              sessionId,
              lastText || pauseNotice,
              '(최대 도구 호출 횟수 도달)',
            );
            await this.store.markWaitingForHuman(sessionId, artifact.id);
            await this.store.updateRunStatus(run.id, 'PAUSED_FOR_HUMAN', 'human');
            break;
          }

          continue;
        }

        console.log(`\n  ❌ 예상치 못한 stop_reason: ${response.stop_reason}`);
        await this.store.updateRunStatus(run.id, 'FAILED', 'error');
        await this.store.updateSessionStatus(sessionId, 'FAILED');
        break;
      }
    } catch (e) {
      console.error('\n  ❌ [AgentEngine] 오류:', (e as Error).message);
      await this.store.updateRunStatus(run.id, 'FAILED', 'error');
      await this.store.updateSessionStatus(sessionId, 'FAILED');
      throw e;
    }

    console.log(
      `\n  ══ 실행 완료 | API ${apiCount}회 | ` +
      `토큰 ${fmtTokens(totalIn, totalOut)} | 비용 ${fmtCost(totalIn, totalOut)} ══`,
    );
  }
}
