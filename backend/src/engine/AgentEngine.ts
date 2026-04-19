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

// ── AgentEvent ────────────────────────────────────────────────

export type AgentEvent =
  | { type: 'api_start'; apiCount: number }
  | { type: 'text'; delta: string }
  | { type: 'response_end' }
  | { type: 'tool_call'; seq: number; name: string; argsStr: string }
  | { type: 'tool_result'; seq: number; isError: boolean; preview: string }
  | { type: 'submit' }
  | { type: 'artifact'; artifactId: string; version: number; summary: string }
  | { type: 'cost'; apiCount: number; inputTokens: number; outputTokens: number; totalIn: number; totalOut: number }
  | { type: 'done'; finalStatus: 'waiting_for_human' | 'failed'; apiCount: number; totalIn: number; totalOut: number }
  | { type: 'error'; message: string }
  | { type: 'rate_limit'; waitSec: number; attempt: number }
  | { type: 'compaction'; before: number; after: number }
  | { type: 'force_stop'; reason: 'consecutive_errors' | 'max_tool_calls' };

// ── 시스템 프롬프트 ────────────────────────────────────────────

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

export const STAGE2_SYSTEM_PROMPT = `당신은 금융감독원 보고서 초안 작성 에이전트입니다.
확정된 법령 검토 결론을 입력으로 받아 금감원 내부 보고서 형식으로 재구성합니다.
법령 재조회나 추가 판단은 절대 하지 않습니다.

## 기본 보고서 구조

사용자가 별도 목차를 제시한 경우, 아래 기본 구조 대신 제시된 목차를 우선 적용합니다.

1. 현황 — 보고서 작성 배경·경위 (왜 이 보고서를 쓰게 됐는지)
2. 이슈 — 의사결정이 필요한 쟁점 (필요 시 대안 포함)
3. 검토의견 — 작성자가 판단하는 처리방향
4. 향후계획 — 처리방향 수락 시 구체적 action plan (타 부서 협의, 금융위 협의, 법 개정 건의 등)

## 개조식 작성 규칙

레벨 순서: 1(최상위) → □ → ○ → - → ·(최하위)
- 각 개조식 문단은 한 문장으로 구성
- 주석: 해당 내용 뒤에 * 표기, 하단에 * 설명 추가
- 분량: 붙임 제외 HWP 1~2페이지 이내 (과도한 세부내용은 [붙임]으로 분리)
- 법령 조문 인용 시 간략히 요약, 원문 전체 삽입 금지

## 형식 예시

[금융결제원 뱅크페이서비스의 PG업 등록 필요여부 검토]
1. 현황
□ 금융위는 '26.4.19.자로 우리원 앞 금융결제원의 전자금융거래법 상 직불업 등록 필요여부 검토를 요구
 ○ 금융결제원은 스스로의 지위는 전금법 제정취지상 전자금융보조업자*라는 입장
   * 전금법 제정 당시 결제중계시스템 운영자(금융결제원)을 전자금융보조업자로 명시

2. 이슈
□ 현재 오픈뱅킹·펌뱅킹 등 계좌이체방식 결제서비스 제공 주체에 대한 필요 라이센스 해석이 상이
 ○ 금융위는 '24년 계좌이체방식 결제서비스를 직불수단으로 해석한 바 있음
 ○ 하위사업자 연계 오픈뱅킹 이용기관에 대해서는 직불업 등록 요구
  - 그러나 하위사업자 및 직접 서비스 제공 이용기관에 대해서는 일관성 부족

3. 검토의견
□ 행정지도를 통한 직불업 요구 필요
 ○ 오픈뱅킹·펌뱅킹 등 경로와 무관하게 서비스를 제공하는 사업자에 대해 직불업 요구하는 것이 타당

4. 향후계획
□ 금융위 앞 본 검토방향에 대한 의견요청(즉시)
□ CPC발송을 통한 영향분석(즉시)
□ 수단이 아닌 행위에 기반한 전금법 라이센스체계 정비방안 건의(장기)

## 완료 조건

보고서 초안 작성이 완료되면 즉시 submit_for_review를 호출하세요.`;

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

// ── 헬퍼 함수 ─────────────────────────────────────────────────

function clip(text: string, max = 80): string {
  return text.length > max ? text.slice(0, max) + '…' : text;
}

function fmtArgs(args: Record<string, unknown>): string {
  return Object.entries(args)
    .map(([k, v]) => `${k}=${clip(typeof v === 'string' ? v : JSON.stringify(v), 40)}`)
    .join(', ');
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

async function withRateLimitRetry<T>(
  fn: () => Promise<T>,
  maxRetries = 3,
  onRateLimit?: (waitSec: number, attempt: number) => void,
): Promise<T> {
  for (let attempt = 0; attempt <= maxRetries; attempt++) {
    try {
      return await fn();
    } catch (e) {
      if (e instanceof Anthropic.RateLimitError && attempt < maxRetries) {
        const waitSec = parseInt(String((e.headers as Record<string, string>)?.['retry-after'] ?? '60'), 10);
        onRateLimit?.(waitSec, attempt + 1);
        await new Promise(r => setTimeout(r, waitSec * 1000));
        continue;
      }
      throw e;
    }
  }
  throw new Error('최대 재시도 횟수 초과');
}

// ── RunConfig ────────────────────────────────────────────────

export interface RunConfig {
  useMcpTools?: boolean;
  systemPrompt?: string;
  initialInputOverride?: string;
  onEvent?: (event: AgentEvent) => void;
}

export class AgentEngine {
  private client: Anthropic;

  constructor(
    private store: SessionStore,
    private gateway: ToolGateway,
  ) {
    this.client = new Anthropic();
  }

  async runSession(sessionId: string, feedback?: string, config: RunConfig = {}): Promise<void> {
    const emit = config.onEvent ?? (() => {});

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
        content: config.initialInputOverride ?? `다음 이슈를 검토해주세요.\n\n${issue.input_text}`,
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
            { type: 'text', text: feedbackText } as Anthropic.TextBlockParam,
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
                { type: 'text', text: feedbackText } as Anthropic.TextBlockParam,
              ],
            }
          : { role: 'user', content: feedbackText };

        messages.push(resumeMsg);
        await this.store.appendMessage(sessionId, run.id, resumeMsg);
      }
    }

    const activeSystemPrompt = config.systemPrompt ?? SYSTEM_PROMPT;
    const mcpTools = (config.useMcpTools !== false) ? await this.gateway.listTools() : [];
    const allTools = [...mcpTools, SUBMIT_FOR_REVIEW_TOOL];
    let toolCallCount = 0;
    let consecutiveErrors = 0;
    const MAX_CONSECUTIVE_ERRORS = 3;

    try {
      while (true) {
        apiCount++;
        emit({ type: 'api_start', apiCount });

        const response = await withRateLimitRetry(
          async () => {
            const requestMessages = buildRequestMessages(messages);
            if (requestMessages.length !== messages.length) {
              emit({ type: 'compaction', before: messages.length, after: requestMessages.length });
            }

            const stream = this.client.messages.stream({
              model: MODEL,
              max_tokens: MAX_TOKENS,
              system: activeSystemPrompt,
              messages: requestMessages,
              tools: allTools,
              temperature: TEMPERATURE,
            });

            stream.on('text', (text) => {
              emit({ type: 'text', delta: text });
            });

            const msg = await stream.finalMessage();
            emit({ type: 'response_end' });
            return msg;
          },
          3,
          (waitSec, attempt) => emit({ type: 'rate_limit', waitSec, attempt }),
        );

        const { input_tokens, output_tokens } = response.usage;
        totalIn  += input_tokens;
        totalOut += output_tokens;
        emit({ type: 'cost', apiCount, inputTokens: input_tokens, outputTokens: output_tokens, totalIn, totalOut });

        const assistantMsg: Anthropic.MessageParam = {
          role: 'assistant',
          content: response.content,
        };
        messages.push(assistantMsg);
        await this.store.appendMessage(sessionId, run.id, assistantMsg);

        // ── end_turn ─────────────────────────────────────────
        if (response.stop_reason === 'end_turn') {
          const text = response.content
            .filter((b): b is Anthropic.TextBlock => b.type === 'text')
            .map(b => b.text)
            .join('\n');
          const artifact = await this.store.createArtifact(sessionId, text, '');
          await this.store.markWaitingForHuman(sessionId, artifact.id);
          await this.store.updateRunStatus(run.id, 'PAUSED_FOR_HUMAN', 'human');
          emit({ type: 'artifact', artifactId: artifact.id, version: artifact.version, summary: artifact.summary ?? '' });
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
              emit({ type: 'submit' });
              const input = block.input as { content: string; summary: string };
              const artifact = await this.store.createArtifact(sessionId, input.content, input.summary);
              await this.store.markWaitingForHuman(sessionId, artifact.id);
              emit({ type: 'artifact', artifactId: artifact.id, version: artifact.version, summary: input.summary });
              shouldStop = true;
            } else {
              const args = block.input as Record<string, unknown>;
              emit({ type: 'tool_call', seq: toolCallCount, name: block.name, argsStr: fmtArgs(args) });

              let resultText: string;
              let isError = false;
              try {
                resultText = await this.gateway.callTool(block.name, args);
                if (resultText.startsWith('오류:')) isError = true;
              } catch (e) {
                resultText = `도구 오류: ${(e as Error).message}`;
                isError = true;
              }

              if (isError) {
                consecutiveErrors++;
              } else {
                consecutiveErrors = 0;
                if (resultText.length > MAX_TOOL_RESULT_CHARS) {
                  resultText = resultText.slice(0, MAX_TOOL_RESULT_CHARS) +
                    `\n\n[결과가 길어 ${MAX_TOOL_RESULT_CHARS.toLocaleString()}자에서 잘렸습니다. ` +
                    '더 좁은 범위로 재조회하거나 get_law_article로 특정 조문을 조회하세요.]';
                }
              }

              emit({
                type: 'tool_result',
                seq: toolCallCount,
                isError,
                preview: clip(resultText.replace(/\n/g, ' '), 120),
              });

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
            emit({ type: 'done', finalStatus: 'waiting_for_human', apiCount, totalIn, totalOut });
            return;
          }

          if (consecutiveErrors >= MAX_CONSECUTIVE_ERRORS) {
            emit({ type: 'force_stop', reason: 'consecutive_errors' });
            const lastText = messages
              .filter(m => m.role === 'assistant')
              .flatMap(m => (Array.isArray(m.content) ? m.content : []))
              .filter((b): b is Anthropic.TextBlock => (b as Anthropic.ContentBlock).type === 'text')
              .map(b => b.text)
              .join('\n');
            const artifact = await this.store.createArtifact(sessionId, lastText, `(도구 연속 오류 ${MAX_CONSECUTIVE_ERRORS}회로 중단)`);
            await this.store.markWaitingForHuman(sessionId, artifact.id);
            await this.store.updateRunStatus(run.id, 'PAUSED_FOR_HUMAN', 'human');
            emit({ type: 'artifact', artifactId: artifact.id, version: artifact.version, summary: artifact.summary ?? '' });
            break;
          }

          if (toolCallCount >= MAX_TOOL_CALLS) {
            emit({ type: 'force_stop', reason: 'max_tool_calls' });
            const pauseNotice =
              `도구 호출 한도(${MAX_TOOL_CALLS}회)에 도달하여 여기서 중단합니다.\n` +
              '현재까지 수집한 근거를 바탕으로 사람이 검토를 이어갈 수 있도록 대기 상태로 전환합니다.';
            const pauseMsg: Anthropic.MessageParam = { role: 'assistant', content: pauseNotice };
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
            emit({ type: 'artifact', artifactId: artifact.id, version: artifact.version, summary: artifact.summary ?? '' });
            break;
          }

          continue;
        }

        emit({ type: 'error', message: `예상치 못한 stop_reason: ${response.stop_reason}` });
        await this.store.updateRunStatus(run.id, 'FAILED', 'error');
        await this.store.updateSessionStatus(sessionId, 'FAILED');
        emit({ type: 'done', finalStatus: 'failed', apiCount, totalIn, totalOut });
        break;
      }
    } catch (e) {
      const msg = (e as Error).message;
      emit({ type: 'error', message: msg });
      await this.store.updateRunStatus(run.id, 'FAILED', 'error');
      await this.store.updateSessionStatus(sessionId, 'FAILED');
      emit({ type: 'done', finalStatus: 'failed', apiCount, totalIn, totalOut });
      throw e;
    }

    emit({ type: 'done', finalStatus: 'waiting_for_human', apiCount, totalIn, totalOut });
  }
}
