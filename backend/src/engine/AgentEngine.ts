import Anthropic from '@anthropic-ai/sdk';
import type { SessionStore } from '../store/SessionStore.js';
import type { ToolGateway } from './ToolGateway.js';
import type { Artifact, Stage, StageSession } from '../models/types.js';

const MODEL = process.env.ANTHROPIC_MODEL ?? 'claude-opus-4-7';
const MOCK_DELAY_MS = parsePositiveInt(process.env.SENTINEL_MOCK_DELAY_MS, 120);
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
  | { type: 'cost'; apiCount: number; inputTokens: number; outputTokens: number; cacheReadTokens: number; cacheCreationTokens: number; totalIn: number; totalOut: number }
  | { type: 'done'; finalStatus: 'waiting_for_human' | 'failed' | 'interrupted'; apiCount: number; totalIn: number; totalOut: number; totalCacheRead: number; totalCacheCreation: number }
  | { type: 'error'; message: string; recoverable: boolean }
  | { type: 'rate_limit'; waitSec: number; attempt: number }
  | { type: 'compaction'; before: number; after: number }
  | { type: 'force_stop'; reason: 'consecutive_errors' | 'max_tool_calls' };

// ── 에러 분류 ────────────────────────────────────────────────

export function classifyError(error: unknown): 'recoverable' | 'fatal' {
  if (error instanceof Anthropic.APIError) {
    const status = error.status;
    const message = String(error.message ?? '');

    // 인증·권한 오류 — 재개해도 동일 결과
    if (status === 401 || status === 403) return 'fatal';

    // 400 invalid_request_error: 메시지 내용으로 분기
    if (status === 400) {
      // 잔액 부족 — 충전 후 재개 가능
      if (/credit balance/i.test(message)) return 'recoverable';
      if (/insufficient.*(balance|credit)/i.test(message)) return 'recoverable';
      // 그 외 (입력 검증 등) — 재시도해도 안 풀림
      return 'fatal';
    }

    // 429 rate limit (3회 재시도 후에도 실패) — 일시적
    if (status === 429) return 'recoverable';

    // 5xx 서버 오류 — 일시적
    if (status && status >= 500) return 'recoverable';

    // 그 외 API 오류 — 보수적으로 recoverable
    return 'recoverable';
  }

  // 네트워크 오류
  const code = (error as { code?: string })?.code;
  if (code && ['ECONNRESET', 'ETIMEDOUT', 'ENOTFOUND', 'EAI_AGAIN', 'ECONNREFUSED'].includes(code)) {
    return 'recoverable';
  }

  // 알 수 없는 에러 — 보수적으로 fatal
  return 'fatal';
}

// ── 시스템 프롬프트 ────────────────────────────────────────────

const SYSTEM_PROMPT = `당신은 금융감독원 법령 검토 에이전트입니다.

목표:
- 이슈의 법적 쟁점을 파악하고
- 필요한 법령·법령해석을 좁게 조회한 뒤
- **반드시** 유사한 과거 내부 검토문서를 함께 조사하여 우리원의 처리 선례·검토 경위·해석 흐름을 확인하고
- 법적 근거(법령·해석)와 과거 선례(내부 문서)를 종합하여 판단을 정리하고
- 충분하면 submit_for_review를 호출합니다.

원칙:
- 같은 검색어, 같은 법령ID, 같은 조문, 같은 해석 ID를 반복 조회하지 마세요.
- 이미 확보한 정보가 있으면 재사용하고, 정말 필요할 때만 추가 조회하세요.
- 1차 근거는 법령·법령해석, 2차 근거는 내부 검토문서입니다. **세 종류 모두 적극적으로 조사**하세요. 내부 검토문서는 단순 배경 자료가 아니라 **우리원의 과거 처리 선례·검토 경위·해석 일관성**을 보여주는 핵심 자료이며, 동일·유사 사안을 어떻게 판단했는지가 본 검토의 결론에 직접 영향을 줍니다.
- 내부 검토문서는 반드시 search_fss_documents로 폴더명/파일명 후보를 먼저 좁힌 뒤, 관련 있어 보이는 문서를 get_fss_document로 본문 확인하여 **실제 본문에 인용**합니다.
- search_fss_documents가 0건을 반환하면 즉시 포기하지 말고, 어절을 줄이거나 동의어로 바꿔 최소 2~3회는 재시도합니다. 그 후에도 0건이면 "관련 내부 선례를 찾지 못함"을 결론에 명시합니다.
- 긴 전문 조회보다 목차/특정 조문 조회를 우선하세요.
- get_law_text는 사용하지 마세요.

인용 형식 (검토 결론 본문에 법령해석을 인용할 때):
- **반드시 "구분 + 일련번호 + 회신일자" 3요소**로 인용합니다. 도구 결과의 \`id\` 값은 내부 적재키이므로 본문에 절대 표기하지 마세요.
- 구분은 "법령해석", "비조치의견서", "현장건의 과제" 중 하나 — search_interpretation 결과의 \`[법령해석]\`/\`[비조치의견서]\`/\`[현장건의 과제]\` 라벨을 그대로 사용합니다.
- 권장 형식: \`금감원 법령해석(일련번호 140118, 2015-08-27)\` / \`비조치의견서(일련번호 240026, 2025-01-05)\` / \`현장건의 과제(일련번호 14411X, 2016-06-08)\`
- 회신일자는 도구가 반환한 값(YYYY-MM-DD)을 그대로 옮기고, 임의로 형식을 변환하거나 날짜를 추정하지 마세요.

인용 형식 (검토 결론 본문에 내부 검토문서를 인용할 때):
- **"파일명(또는 보고서 제목) + 작성·수정시기"** 형식으로 인용합니다. 도구 결과의 \`id\`는 내부 적재키이므로 본문에 절대 표기하지 마세요.
- 작성시기는 search_fss_documents/get_fss_document가 반환한 \`file_mtime\` 또는 \`parsed_at\`(YYYY-MM-DD) 값을 그대로 사용합니다. 추정 금지.
- 권장 형식: \`내부 검토문서('전자금융거래법 적용범위 검토.hwp', 2023-06-12)\` 또는 \`우리원 과거 검토('선불전자지급수단 발행 실무 검토.docx', 2024-09-30)\`
- 단순히 문서명만 인용하지 말고, **그 문서가 보여주는 처리 결론·논거·선례**를 한두 문장으로 요약해 함께 제시합니다 (예: "… 우리원은 동일 사안에서 직불업 등록을 요구한 바 있음").

검색 전략 (search_interpretation, search_fss_documents):
- 두 도구는 모두 공백으로 어절을 분리하며, match 파라미터로 AND/OR 결합 방식을 선택합니다.
- **최초 검색은 반드시 1개 어절 또는 match="or"로 넓게 시작하세요.** 여러 어절을 AND로 묶으면 0건이 빈번합니다.
  - 권장: 핵심 명사 1개 (예: "선불업자") 또는 핵심 명사 2~4개 + match="or" (예: "선불 계좌 정보 보유" + match="or")
  - 금지: 처음부터 4어절 이상 AND 검색 ("선불업자 계좌번호 개인정보 수집")
- OR 또는 단일 어절로 후보를 확보한 뒤, 결과가 너무 많거나 부정확할 때 어절을 추가해 match="and"로 좁힙니다.
- 0건이 나오면 동일 키워드를 단순 반복하지 말고 어절을 더 짧게(접미사 제거 등) 쪼개거나 유의어로 교체해 재시도하세요.
- 한자어/외래어/일반명사는 부분 일치 가능성이 높으므로 짧게 유지하세요 (예: "선불전자지급수단" 대신 "선불").

도구 사용 순서:
1. 법령: search_law -> get_law_hierarchy
2. 조문 탐색: get_law_toc 또는 get_admin_rule_toc
3. 정밀 조회: get_law_article 또는 get_admin_rule_article
4. 법령해석: search_interpretation(1개 어절 또는 match="or"로 시작) -> get_interpretation(id)
5. 내부 문서: search_fss_documents(1개 어절 또는 match="or"로 시작) -> get_fss_document(id)
6. get_admin_rule_text는 전체 확인이 꼭 필요할 때만 사용

산출물:
- 검토 결론은 보고서 형식이 아닌 줄글 텍스트
- **쟁점·판단·법적 근거(법령·법령해석)·과거 선례(내부 검토문서)** 4요소가 모두 분명해야 함
- 내부 검토문서를 1건도 인용하지 않은 결론은 미완성으로 간주합니다 (단, 재시도 후에도 0건이면 그 사실을 결론에 명시)`;

export const STAGE2_SYSTEM_PROMPT = `당신은 금융감독원 보고서 초안 작성 에이전트입니다.
확정된 법령 검토 결론 또는 기존 보고서 초안을 입력으로 받아 금감원 내부 보고서 형식의 개조식 markdown으로 재구성하거나 보완합니다.
법령 재조회나 추가 판단은 절대 하지 않습니다.

산출물은 후속 단계(Sentinel-Forge — HWPX 작성·정규화·COM 폴리싱)의 입력입니다.
시각적 서식(폰트·자간·색상·들여쓰기·페이지 레이아웃 등)은 Forge가 자동 적용하므로, 본 단계에서는 **논리 구조만** 표기합니다.

## 출력 형식 — markdown 사양 v1.4

### 1. 메타데이터 (문서 최상단, YAML front-matter)

1개 항목만 정확히 이 키 이름으로 출력합니다:

---
보고서명: (이슈 핵심 내용을 한 줄로 요약한 보고서 제목)
---

- 보고서명: 입력 이슈에서 추출하여 자동 작성합니다.
- 작성부서, 작성일은 출력하지 않습니다. 이 두 값은 Sentinel-Forge에서 별도 입력으로 처리합니다.

### 2. 본문 구조

사용자가 별도 목차를 제시한 경우 그것을 우선 적용. 그렇지 않으면 다음 4개 섹션:

1. 현황 — 보고서 작성 배경·경위 (왜 이 보고서를 쓰게 됐는지)
2. 이슈 — 의사결정이 필요한 쟁점 (필요 시 대안 포함)
3. 검토의견 — 작성자가 판단하는 처리방향
4. 향후계획 — 처리방향 수락 시 구체적 action plan

**각 섹션 헤더(\`1.\`, \`2.\`...) 앞에는 빈 줄 1개 이상이 필수**입니다.

### 3. 본문 층위 (6단계)

| 레벨 | 글머리 | 용도 |
|---|---|---|
| 1 | \`1.\` \`2.\` \`3.\` ... | 섹션 헤더 (요약단어 불필요) |
| 2 | \`가.\` \`나.\` \`다.\` ... \`하.\` | **소제목** — 섹션 내 하위 분류 (요약단어 불필요) |
| 3 | \`□\` | 1차 분기 (요약단어 **필수**) |
| 4 | \`○\` | 2차 분기 |
| 5 | \`-\` | 3차 분기 |
| 6 | \`·\` | 4차 분기 (최하위) |

- 각 글머리 단락은 한 문장으로 작성합니다.
- 들여쓰기는 가독성용으로 자유롭게 사용합니다 (레벨은 라인 시작의 글머리 문자만으로 결정됨).
- 소제목(\`가.\`)은 **선택 사항** — 한 섹션 내 1~5개 권장. 섹션이 단순하면 \`1.\` 섹션 직후 바로 \`□\`로 가도 됩니다. 분량이 있거나 하위 분류가 명확한 섹션에만 사용하세요.
- 소제목 글머리는 한글 가나다 음절 14개(\`가.\`~\`하.\`)를 순서대로 사용합니다.

### 4. 요약단어 (\`□\` 레벨 필수)

\`□\` 레벨 단락은 반드시 \`□ (요약단어) 본문\` 형식으로 시작합니다.
- 요약단어: 한 단어 또는 짧은 어구 (한글 1~3어절)
- 다른 레벨(섹션 헤더 \`1.\`, 소제목 \`가.\`, \`○\`, \`-\`, \`·\`)에는 사용하지 않습니다 — 섹션명·소제목명 자체가 요약 역할입니다.

예: \`□ (행정지도) 행정지도를 통한 직불업 요구 필요\`

### 5. 주석 (두 종류, 한 단락에 공존 가능)

**참조 주석**: 본문 어절 뒤에 \`*\` 표기 + 같은 단락 하단에 \`*\` 시작 라인. 한 단락에 여러 개일 경우 \`**\`, \`***\` 사용.

\`\`\`
○ 금융결제원은 스스로의 지위는 전금법 제정취지상 전자금융보조업자*라는 입장
* 전금법 제정 당시 결제중계시스템 운영자(금융결제원)을 전자금융보조업자로 명시
\`\`\`

**일반 주석**: 라인 시작 \`※\`로 보충 설명.

\`\`\`
□ (행정지도) 행정지도를 통한 직불업 요구 필요
※ 본 검토는 직불업 등록 의무 범위에 한함
\`\`\`

### 6. 강조 (Bold)

핵심 명사·어근을 **\`__X__\`** (언더스코어 두 개) 로 감쌉니다.

- **모든 본문 단락에 적용**합니다 — \`□\`, \`○\`, \`-\`, \`·\` 모든 층위와 \`=>\` 결론 화살표 단락 모두 (단, \`1.\` 섹션 헤더와 \`가.\` 소제목 자체는 제외).
- **단락마다 1~3개**의 핵심 어절을 골라 강조합니다. 정보가 단순한 단락이라도 최소 1개는 강조합니다. 핵심 어절이 둘 이상이면 각각 따로 감쌉니다 (예: \`__금융결제원__이 __직불업__ 등록을 …\`).
- **명사·어근에만** 적용하고 **조사·어미는 Bold 바깥**에 둡니다: ✅ \`__행정지도__를\` (X) \`__행정지도를__\`
- 동사·형용사는 어근까지만 감쌉니다: ✅ \`__검토__하여\` (X) \`__검토하여__\`
- **이탤릭(\`*X*\`) 및 markdown 표준 bold(\`**X**\`)는 사용 금지**합니다 — asterisk는 본 사양에서 참조 주석 전용입니다.

### 7. 결론 화살표 (선택)

분석들의 결론·요약을 강조할 때 라인 시작에 **\`=>\`** (등호 1개 + 부등호) 사용. 위치는 자유.

- **표기는 \`=>\`로 통일**합니다. \`==>\`, \`===>>\` 같은 다른 길이는 사용하지 않습니다.

\`\`\`
□ (전제) 라이센스 해석이 상이
 ○ 금융위는 직불수단으로 해석
 ○ 우리원은 일관성 부족 우려
=> 일관된 해석 기준 필요
\`\`\`

### 8. Callout 박스 (\`[참고]\`, \`[붙임]\`)

본문 흐름과 별개로 **별도의 시각 박스**로 분리되어야 할 내용. 두 종류:

**참고 박스 (\`[참고]\`)** — 본문 중간에 끼어드는 보충 참조 정보. 라인 시작 \`[참고]\` 단독으로 박스 시작, 다음 줄부터 박스 내용, **빈 줄을 만나면 박스 종료**. 한 문서에 여러 번 등장 가능.

\`\`\`
[참고]
관련 법령: 전자금융거래법 §28, §29
관련 규정: 전자금융감독규정 §13
\`\`\`

**붙임 박스 (\`[붙임]\`, \`[붙임 N]\`)** — 본문 끝에 첨부되는 별도 페이지 분량의 부속 자료. 라인 시작 \`[붙임]\` 또는 \`[붙임 2]\` 단독으로 시작, 다음 빈 줄 또는 다음 \`[붙임 …]\` 마커까지 박스 본문. Forge가 자동으로 새 페이지 분리.

\`\`\`
[붙임 1]
관련 법령 발췌

[붙임 2]
유사 사례 비교표
\`\`\`

- 마커는 **라인 시작에서 단독으로** 사용 (앞에 공백 허용, 뒤에 텍스트 금지).
- 박스 내부에 \`□\`/\`○\`/\`-\`/\`·\`·강조(\`__X__\`)·참조(\`*\`)는 사용 가능. 다른 callout 또는 섹션 헤더는 박스 내부에 등장 불가.
- **자동 [붙임] 분리는 Forge가 처리**하므로, 본문 분량 초과 분리 목적의 \`[붙임]\` 표기는 불필요합니다. 작성자가 명시적으로 별도 페이지로 분리하고자 하는 부속 자료에만 사용하세요.

## 분량

본문 1~2페이지 분량으로 작성합니다. 과도한 세부 내용은 본문에 포함시키지 않습니다 (Forge가 본문 분량 초과 시 [붙임] 자동 분리).
법령 조문 인용은 간략히 요약하며 원문을 그대로 삽입하지 않습니다.

## 완성 예시

---
보고서명: 금융결제원 뱅크페이서비스의 PG업 등록 필요여부 검토
---

1. 현황
가. 개요
□ (배경) __금융위__는 '26.4.19.자로 우리원 앞 __금융결제원__의 __직불업 등록__ 필요여부 검토를 요구
 ○ 금융결제원은 스스로의 지위는 __전금법 제정취지__상 __전자금융보조업자__*라는 입장
* 전금법 제정 당시 결제중계시스템 운영자(금융결제원)을 전자금융보조업자로 명시

나. 진행상황
□ (현재) __금융결제원 회신__ 대기 중
 ○ 회신 기한: '26.5.10.

[참고]
관련 법령: 전자금융거래법 §28, §29
관련 규정: 전자금융감독규정 §13

2. 이슈
□ (해석상이) __오픈뱅킹__·__펌뱅킹__ 등 계좌이체방식 결제서비스 제공 주체에 대한 __라이센스 해석__이 상이
 ○ __금융위__는 '24년 __계좌이체방식 결제서비스__를 __직불수단__으로 해석
 ○ 우리원은 __하위사업자__ 및 __직접 제공 이용기관__에 대한 __일관성 부족__ 지적
=> __일관된 해석 기준__ 필요

3. 검토의견
□ (행정지도) __행정지도__를 통한 __직불업 요구__ 필요
 ○ __경로__와 무관하게 __서비스 제공 사업자__에 __직불업 요구__가 타당
※ 본 검토는 직불업 등록 의무 범위에 한함

4. 향후계획
□ (즉시) __금융위__ 앞 __본 검토방향__ 의견요청
□ (즉시) __CPC발송__을 통한 __영향분석__
□ (장기) __수단이 아닌 행위 기반__ __라이센스체계 정비방안__ 건의

[붙임 1]
관련 법령 발췌

[붙임 2]
유사 사례 비교표

## 완료 조건

보고서 초안 작성이 완료되면 즉시 submit_for_review를 호출하세요.`;

// ── STAGE 2 시스템 프롬프트 빌더 (customToc 주입) ─────────────

const STAGE2_DEFAULT_BODY_STRUCTURE = `사용자가 별도 목차를 제시한 경우 그것을 우선 적용. 그렇지 않으면 다음 4개 섹션:

1. 현황 — 보고서 작성 배경·경위 (왜 이 보고서를 쓰게 됐는지)
2. 이슈 — 의사결정이 필요한 쟁점 (필요 시 대안 포함)
3. 검토의견 — 작성자가 판단하는 처리방향
4. 향후계획 — 처리방향 수락 시 구체적 action plan`;

export function buildStage2SystemPrompt(customToc?: string): string {
  if (!customToc?.trim()) return STAGE2_SYSTEM_PROMPT;

  if (!STAGE2_SYSTEM_PROMPT.includes(STAGE2_DEFAULT_BODY_STRUCTURE)) {
    throw new Error(
      'STAGE2_SYSTEM_PROMPT의 기본 본문 구조 섹션이 변경되어 customToc 주입에 실패했습니다. ' +
      'STAGE2_DEFAULT_BODY_STRUCTURE 상수를 현재 프롬프트와 일치하도록 갱신하세요.',
    );
  }

  const customSection = `**사용자가 다음 목차를 지정했습니다. 이 목차를 절대 무시하지 말고 항목명·순서·취지를 그대로 사용하세요. 기본 4개 섹션(현황/이슈/검토의견/향후계획)은 적용하지 않습니다.** 각 항목 옆에 작성 방향이나 내용 단서가 명시되어 있으면 그것을 본문 작성의 핵심 기준으로 삼습니다:

${customToc.trim()}

위 목차를 그대로 본문 섹션 헤더(\`1.\`, \`2.\`, \`3.\` …)로 사용합니다. 항목 옆의 콜론(\`:\`) 뒷부분은 사용자가 그 섹션에 담길 내용 방향을 적은 것이므로, 그 방향을 \`□\`/\`○\` 단락으로 풀어 작성합니다.`;

  return STAGE2_SYSTEM_PROMPT.replace(STAGE2_DEFAULT_BODY_STRUCTURE, customSection);
}

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

async function sleep(ms: number): Promise<void> {
  await new Promise(resolve => setTimeout(resolve, ms));
}

// ── Prompt Caching 헬퍼 ──────────────────────────────────────
// Anthropic의 ephemeral cache는 prefix를 5분간 보관하고 cache hit 시
// 입력 단가를 90% 할인합니다. system / tools / 누적 messages 끝에
// breakpoint를 두면 매 turn마다 가장 긴 일치 prefix가 캐시 적중합니다.

const CACHE_CONTROL = { type: 'ephemeral' as const };

function withSystemCache(systemPrompt: string): Anthropic.TextBlockParam[] {
  return [{ type: 'text', text: systemPrompt, cache_control: CACHE_CONTROL }];
}

function withToolsCache(tools: Anthropic.Tool[]): Anthropic.Tool[] {
  if (tools.length === 0) return tools;
  const last = tools[tools.length - 1];
  return [
    ...tools.slice(0, -1),
    { ...last, cache_control: CACHE_CONTROL },
  ];
}

function withMessagesCache(messages: Anthropic.MessageParam[]): Anthropic.MessageParam[] {
  if (messages.length === 0) return messages;
  const lastIdx = messages.length - 1;
  const last = messages[lastIdx];

  let newContent: Anthropic.ContentBlockParam[];
  if (typeof last.content === 'string') {
    newContent = [{ type: 'text', text: last.content, cache_control: CACHE_CONTROL }];
  } else {
    newContent = [...last.content];
    const lastBlockIdx = newContent.length - 1;
    if (lastBlockIdx < 0) return messages;
    newContent[lastBlockIdx] = {
      ...newContent[lastBlockIdx],
      cache_control: CACHE_CONTROL,
    } as Anthropic.ContentBlockParam;
  }

  return [
    ...messages.slice(0, lastIdx),
    { ...last, content: newContent },
  ];
}

// ── RunConfig ────────────────────────────────────────────────

export interface RunConfig {
  useMcpTools?: boolean;
  systemPrompt?: string;
  initialInputOverride?: string;
  onEvent?: (event: AgentEvent) => void;
  /**
   * Anthropic ephemeral prompt caching 사용 여부 (default true).
   * Stage 2처럼 단발 호출로 끝나는 세션은 false로 — cache write의 25% premium만
   * 부담하고 read benefit이 없으므로 손해.
   */
  enablePromptCache?: boolean;
}

export class AgentEngine {
  private client: Anthropic | null = null;

  constructor(
    private store: SessionStore,
    private gateway: ToolGateway,
  ) {}

  private getClient(): Anthropic {
    if (!this.client) this.client = new Anthropic();
    return this.client;
  }

  async runSession(sessionId: string, feedback?: string, config: RunConfig = {}): Promise<void> {
    const emit = config.onEvent ?? (() => {});

    const session = await this.store.getStageSession(sessionId);
    const issue   = await this.store.getIssue(session.issue_id);

    await this.store.updateSessionStatus(sessionId, 'RUNNING');
    const run = await this.store.createAgentRun(sessionId, MODEL);

    let totalIn  = 0;
    let totalOut = 0;
    let totalCacheRead = 0;
    let totalCacheCreation = 0;
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

    if (session.agent_mode === 'mock') {
      await this.runMockSession({
        session,
        issue,
        runId: run.id,
        messages,
        config,
        feedback,
        emit,
      });
      return;
    }

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

            const useCache = config.enablePromptCache !== false;
            const stream = this.getClient().messages.stream({
              model: MODEL,
              max_tokens: MAX_TOKENS,
              system: useCache ? withSystemCache(activeSystemPrompt) : activeSystemPrompt,
              messages: useCache ? withMessagesCache(requestMessages) : requestMessages,
              tools: useCache ? withToolsCache(allTools) : allTools,
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
        const cacheReadTokens = response.usage.cache_read_input_tokens ?? 0;
        const cacheCreationTokens = response.usage.cache_creation_input_tokens ?? 0;
        // totalIn은 fresh input only — cache는 별도 누적해 비용을 정확히 환산
        totalIn  += input_tokens;
        totalOut += output_tokens;
        totalCacheRead += cacheReadTokens;
        totalCacheCreation += cacheCreationTokens;
        emit({
          type: 'cost',
          apiCount,
          inputTokens: input_tokens,
          outputTokens: output_tokens,
          cacheReadTokens,
          cacheCreationTokens,
          totalIn,
          totalOut,
        });

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
            emit({ type: 'done', finalStatus: 'waiting_for_human', apiCount, totalIn, totalOut, totalCacheRead, totalCacheCreation });
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

        emit({ type: 'error', message: `예상치 못한 stop_reason: ${response.stop_reason}`, recoverable: false });
        await this.store.updateRunStatus(run.id, 'FAILED', 'error');
        await this.store.updateSessionStatus(sessionId, 'FAILED');
        emit({ type: 'done', finalStatus: 'failed', apiCount, totalIn, totalOut, totalCacheRead, totalCacheCreation });
        break;
      }
    } catch (e) {
      const msg = (e as Error).message;
      const errorClass = classifyError(e);
      const recoverable = errorClass === 'recoverable';
      emit({ type: 'error', message: msg, recoverable });
      await this.store.updateRunStatus(run.id, 'FAILED', 'error');

      if (recoverable) {
        // 일시적 오류 — 세션을 READY로 되돌려 사용자가 재개할 수 있게 둠
        await this.store.updateSessionStatus(sessionId, 'READY');
        emit({ type: 'done', finalStatus: 'interrupted', apiCount, totalIn, totalOut, totalCacheRead, totalCacheCreation });
      } else {
        await this.store.updateSessionStatus(sessionId, 'FAILED');
        emit({ type: 'done', finalStatus: 'failed', apiCount, totalIn, totalOut, totalCacheRead, totalCacheCreation });
      }
      return;
    }

    emit({ type: 'done', finalStatus: 'waiting_for_human', apiCount, totalIn, totalOut, totalCacheRead, totalCacheCreation });
  }

  private async runMockSession(params: {
    session: StageSession;
    issue: { input_text: string };
    runId: string;
    messages: Anthropic.MessageParam[];
    config: RunConfig;
    feedback?: string;
    emit: (event: AgentEvent) => void;
  }): Promise<void> {
    const { session, issue, runId, messages, config, feedback, emit } = params;

    emit({ type: 'api_start', apiCount: 1 });
    await sleep(MOCK_DELAY_MS);

    if (session.stage === 'STAGE_1' && config.useMcpTools !== false) {
      emit({ type: 'tool_call', seq: 1, name: 'search_law', argsStr: 'query="(mock) 관련 법령 탐색"' });
      await sleep(MOCK_DELAY_MS);
      emit({
        type: 'tool_result',
        seq: 1,
        isError: false,
        preview: '[mock] 개발 모드에서는 실제 법령 조회 없이 시뮬레이션 결과를 반환합니다.',
      });
    }

    const latestArtifact = session.latest_artifact_id
      ? await this.store.getArtifact(session.latest_artifact_id).catch(() => null)
      : null;
    const initialSource = typeof messages[0]?.content === 'string'
      ? messages[0].content
      : extractMessageText(messages.at(-1) ?? { role: 'user', content: issue.input_text });
    const draft = buildMockDraft({
      stage: session.stage,
      issueText: issue.input_text,
      initialInput: config.initialInputOverride,
      userPrompt: initialSource,
      latestArtifact,
      feedback,
    });

    for (const chunk of chunkText(draft, 80)) {
      emit({ type: 'text', delta: chunk });
      await sleep(Math.max(30, Math.min(MOCK_DELAY_MS, 90)));
    }
    emit({ type: 'response_end' });

    const assistantMsg: Anthropic.MessageParam = {
      role: 'assistant',
      content: draft,
    };
    await this.store.appendMessage(session.id, runId, assistantMsg);

    const artifact = await this.store.createArtifact(session.id, draft, buildMockSummary(session.stage, feedback));
    await this.store.markWaitingForHuman(session.id, artifact.id);
    await this.store.updateRunStatus(runId, 'PAUSED_FOR_HUMAN', 'human');

    emit({ type: 'cost', apiCount: 1, inputTokens: 0, outputTokens: 0, cacheReadTokens: 0, cacheCreationTokens: 0, totalIn: 0, totalOut: 0 });
    emit({ type: 'artifact', artifactId: artifact.id, version: artifact.version, summary: artifact.summary ?? '' });
    emit({ type: 'done', finalStatus: 'waiting_for_human', apiCount: 1, totalIn: 0, totalOut: 0, totalCacheRead: 0, totalCacheCreation: 0 });
  }
}

function chunkText(text: string, size: number): string[] {
  const result: string[] = [];
  for (let i = 0; i < text.length; i += size) {
    result.push(text.slice(i, i + size));
  }
  return result;
}

function buildMockSummary(stage: Stage, feedback?: string): string {
  const label = stage === 'STAGE_1'
    ? 'Mock 검토 결론'
    : stage === 'STAGE_2'
      ? 'Mock 보고서 초안'
      : 'Mock 편집 초안';
  return feedback ? `${label} (피드백 반영)` : label;
}

function buildMockDraft(params: {
  stage: Stage;
  issueText: string;
  initialInput?: string;
  userPrompt: string;
  latestArtifact: Artifact | null;
  feedback?: string;
}): string {
  const source = (params.initialInput ?? params.latestArtifact?.content ?? params.userPrompt ?? params.issueText).trim();
  const compact = clip(source.replace(/\s+/g, ' '), 700);
  const feedbackSection = params.feedback?.trim()
    ? `\n\n[반영한 사용자 요청]\n${params.feedback.trim()}`
    : '';

  if (params.stage === 'STAGE_1') {
    return (
      `[mock] Stage 1 개발용 검토 결론 초안\n\n` +
      `쟁점은 다음 입력을 바탕으로 정리되었습니다.\n${compact}${feedbackSection}\n\n` +
      `판단:\n` +
      `- 개발 모드에서는 실제 Claude API 호출 없이 검토 결론 생성 흐름만 시뮬레이션합니다.\n` +
      `- 프런트엔드 상태 전환, SSE 스트리밍, artifact 생성, feedback 재진입을 확인할 수 있습니다.\n\n` +
      `근거:\n` +
      `- 실제 법령 탐색은 수행하지 않았으며, 운영 모드에서는 동일 경로에서 실조회가 실행됩니다.\n` +
      `- 이 초안은 UI/백엔드 개발 확인용 mock 산출물입니다.`
    );
  }

  return (
    `[mock] Stage 2 개발용 보고서 초안\n\n` +
    `1. 현황\n` +
    `□ 아래 입력을 바탕으로 보고서 작성 흐름만 시뮬레이션함\n` +
    ` ○ ${compact}\n\n` +
    `2. 이슈\n` +
    `□ 실제 LLM 호출 없이도 Stage 2 선택, 재작성, 확정 흐름이 동작해야 함\n\n` +
    `3. 검토의견\n` +
    `□ 개발 모드에서는 mock 결과를 생성하고 운영 모드에서는 실제 Claude를 사용함${feedbackSection ? `\n ○ 추가 요청 반영: ${params.feedback!.trim()}` : ''}\n\n` +
    `4. 향후계획\n` +
    `□ 프런트/백엔드 연동 검증 후 live 모드로 전환하여 실제 보고서 초안 작성`
  );
}
