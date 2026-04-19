# P2 — 에이전트 엔진 (Agent Core) 설계

> P2의 목표는 `P1`에서 확보한 MCP 도구를 실제로 사용하는 에이전트 실행 골조를 만드는 것이다.
> 이 단계에서는 아직 STAGE 1/2/3의 도메인 프롬프트를 완성하지 않는다. 먼저 "도구를 호출하고, 상태를 저장하고, 사람의 확인을 기다리는 엔진"을 만든다.

---

## 1. P2의 범위

P2는 아래 네 가지를 제공해야 한다.

1. 에이전트 실행 루프
2. STAGE별 상태 저장
3. MCP 도구 호출 프레임워크
4. Human-in-the-loop 대기 및 재개

P2에서 하지 않는 일:

- STAGE 1 법률 검토 프롬프트의 완성
- STAGE 2 보고서 문체/형식 최적화
- STAGE 3 HWP 편집 자동화
- 판례 도입

---

## 2. 핵심 원칙

- `P2`는 **도메인 로직보다 실행 인프라**가 우선이다.
- 엔진은 `STAGE 1/2/3`의 내용을 몰라도 돌아가야 한다.
- 각 STAGE는 독립 세션으로 저장되며, 확정 산출물만 다음 STAGE로 전달된다.
- 사람의 피드백은 항상 특정 STAGE 세션에 귀속된다.
- 에이전트는 도구 호출 결과와 내부 평가를 바탕으로 `계속 실행` 또는 `사람 대기`를 선택해야 한다.

---

## 3. 실행 단위 정의

P2에서는 아래 개념을 명확히 분리한다.

| 개념 | 설명 |
|------|------|
| `Issue` | 사용자가 처음 입력한 업무 단위. 전체 파이프라인의 루트 |
| `Stage` | `STAGE_1`, `STAGE_2`, `STAGE_3` 중 하나 |
| `StageSession` | 특정 이슈의 특정 단계 실행 컨텍스트 |
| `AgentRun` | StageSession 안에서 실제로 한 번 시작된 에이전트 실행 |
| `Message` | 사용자/시스템/에이전트/도구 간 메시지 기록 |
| `Artifact` | 각 단계의 산출물 초안/확정본 |
| `Feedback` | 사람이 StageSession에 준 피드백 |

권장 식별자 예시:

```text
issue_001
stage_session_001
run_001
artifact_001
feedback_001
```

---

## 4. 상태 머신

### Issue 상태

```text
OPEN
IN_PROGRESS
WAITING_CONFIRM
COMPLETED
FAILED
```

### StageSession 상태

```text
READY
RUNNING
WAITING_FOR_HUMAN
CONFIRMED
SUPERSEDED
FAILED
```

### AgentRun 상태

```text
QUEUED
RUNNING
PAUSED_FOR_TOOL
PAUSED_FOR_HUMAN
COMPLETED
FAILED
```

상태 전이 원칙:

- `READY -> RUNNING`: 워커가 세션을 집어 실행 시작
- `RUNNING -> WAITING_FOR_HUMAN`: 에이전트가 confirm 또는 feedback을 요청
- `WAITING_FOR_HUMAN -> RUNNING`: 사용자 피드백이 입력되어 재진입
- `RUNNING -> CONFIRMED`: 사용자가 현재 산출물을 확정
- `CONFIRMED -> READY`: 다음 STAGE 세션 생성 시에만 해당, 기존 세션은 유지

---

## 5. 최소 실행 흐름

```text
1. 사용자가 이슈 생성
2. 시스템이 STAGE 1 StageSession 생성
3. 워커가 StageSession 실행
4. 에이전트가 MCP 도구 호출 / 추론 반복
5. 충분하면 초안 Artifact 생성
6. 에이전트가 사람 확인 요청
7. 사용자가
   - confirm 하면 StageSession = CONFIRMED
   - feedback 주면 Feedback 저장 후 동일 StageSession 재실행
8. STAGE 1이 확정되면 STAGE 2 세션 생성
```

---

## 6. 저장해야 할 최소 데이터

초기 구현에서는 관계형 DB든 문서형 저장소든 아래 필드는 반드시 보존되어야 한다.

### Issue

| 필드 | 설명 |
|------|------|
| `id` | 이슈 ID |
| `title` | 짧은 제목 |
| `input_text` | 원문 이슈 |
| `status` | 전체 상태 |
| `current_stage` | 현재 진행 단계 |
| `created_at`, `updated_at` | 타임스탬프 |

### StageSession

| 필드 | 설명 |
|------|------|
| `id` | 세션 ID |
| `issue_id` | 상위 이슈 ID |
| `stage` | `STAGE_1`, `STAGE_2`, `STAGE_3` |
| `status` | 세션 상태 |
| `input_artifact_id` | 이전 단계 확정 산출물 ID, 없으면 null |
| `latest_artifact_id` | 최신 초안 또는 확정본 |
| `confirmed_artifact_id` | 사용자가 확정한 산출물 |
| `retry_count` | 재진입 횟수 |
| `last_feedback_at` | 마지막 피드백 시각 |
| `created_at`, `updated_at` | 타임스탬프 |

### AgentRun

| 필드 | 설명 |
|------|------|
| `id` | 실행 ID |
| `stage_session_id` | 소속 세션 |
| `status` | 실행 상태 |
| `model` | 사용 모델명 |
| `started_at`, `ended_at` | 실행 시각 |
| `stop_reason` | tool, human, completed, error |

### Artifact

| 필드 | 설명 |
|------|------|
| `id` | 산출물 ID |
| `stage_session_id` | 소속 세션 |
| `version` | 1, 2, 3... |
| `status` | draft, confirmed, superseded |
| `content` | 실제 텍스트 본문 |
| `summary` | UI에 보여줄 짧은 요약 |
| `created_at` | 생성 시각 |

### Feedback

| 필드 | 설명 |
|------|------|
| `id` | 피드백 ID |
| `stage_session_id` | 소속 세션 |
| `author_type` | user 또는 reviewer |
| `content` | 피드백 본문 |
| `created_at` | 생성 시각 |

### Message / Tool Call Log

최소한 아래는 남겨야 한다.

- role: `system`, `user`, `assistant`, `tool`
- content
- tool_name
- tool_args
- tool_result_summary
- created_at

이 로그는 이후 품질 디버깅과 재현성 확보에 중요하다.

---

## 7. 엔진 인터페이스 초안

백엔드 언어는 아직 미확정이므로, 인터페이스는 개념적으로 먼저 고정한다.

```ts
interface AgentEngine {
  startStageSession(sessionId: string): Promise<void>;
  resumeStageSession(sessionId: string, feedbackId?: string): Promise<void>;
}

interface ToolGateway {
  listTools(): Promise<ToolSpec[]>;
  callTool(name: string, args: Record<string, unknown>): Promise<ToolResult>;
}

interface SessionStore {
  getStageSession(sessionId: string): Promise<StageSession>;
  appendMessage(message: Message): Promise<void>;
  createArtifact(input: CreateArtifactInput): Promise<Artifact>;
  markWaitingForHuman(sessionId: string, artifactId: string): Promise<void>;
  confirmArtifact(sessionId: string, artifactId: string): Promise<void>;
}
```

핵심은 구현 언어가 바뀌어도 아래 경계는 유지하는 것이다.

- 엔진
- 도구 게이트웨이
- 상태 저장소
- 사람 확인 인터페이스

---

## 8. MCP 도구 연결 방식

P2 엔진은 각 MCP 서버의 내부 구현을 알 필요가 없다. 아래 정보만 알면 된다.

| 항목 | 설명 |
|------|------|
| `server_name` | 예: `law`, `interpretation` |
| `tool_name` | 예: `search_law`, `get_law_article`, `search_interpretation` |
| `input_schema` | 파라미터 구조 |
| `description` | 모델에게 전달할 도구 설명 |

엔진의 책임:

- 사용 가능한 도구 목록을 모델에 노출
- 모델이 선택한 도구를 실제 MCP 호출로 변환
- 도구 결과를 메시지 히스토리에 기록
- 반복 호출 횟수 제한, 타임아웃, 오류 처리

안전장치 최소 기준:

- 한 Run당 최대 tool call 수 제한
- 같은 인자 반복 호출 감지
- 도구 오류 시 재시도 횟수 제한
- 최종 실패 시 사람에게 오류 상태 노출

---

## 9. Human-in-the-loop 설계

사람은 각 STAGE 경계에서만 아래 행동을 할 수 있어야 한다.

1. `confirm`
2. `feedback`
3. `stop`

동작 의미:

| 사용자 행동 | 시스템 동작 |
|------|------|
| `confirm` | 현재 Artifact를 확정하고 다음 STAGE 준비 |
| `feedback` | Feedback 저장 후 동일 STAGE 세션 재실행 |
| `stop` | 해당 이슈 종료 또는 보류 |

중요 규칙:

- `STAGE 2`는 `STAGE 1 confirmed_artifact`만 입력으로 사용
- `STAGE 3`는 `STAGE 2 confirmed_artifact`만 입력으로 사용
- 이미 확정된 이전 단계 내용은 다음 단계에서 수정하지 않음

---

## 10. P2 구현 순서 제안

### Slice A — 상태 모델

- Issue / StageSession / AgentRun / Artifact / Feedback 모델 정의
- 메모리 저장소 또는 파일 저장소로도 먼저 검증 가능

### Slice B — 엔진 루프

- 단일 StageSession 실행
- 도구 호출 1회 이상 포함
- 초안 생성 후 사람 대기 상태 전환

### Slice C — 재진입

- 피드백 저장
- 동일 StageSession 재실행
- Artifact version 증가

### Slice D — STAGE 전환

- confirm 처리
- 다음 StageSession 생성

---

## 11. P2 완료 기준

아래 시나리오가 재현되면 `P2`를 완료로 본다.

```text
1. 이슈 생성
2. STAGE 1 세션 생성 및 실행
3. 에이전트가 law / interpretation MCP 중 하나 이상 호출
4. 초안 Artifact 생성
5. 상태가 WAITING_FOR_HUMAN 으로 전환
6. 사용자가 feedback 입력
7. 동일 STAGE 1 세션이 재실행되고 새 Artifact version 생성
8. 사용자가 confirm
9. STAGE 2 세션이 새로 생성됨
```

---

## 12. 미결정 사항

| 항목 | 상태 | 내용 |
|------|------|------|
| 백엔드 언어 | 미결정 | `Node.js`와 `Python` 중 선택 필요. 현재 MCP 구현은 TypeScript |
| 영속 저장소 | 미결정 | SQLite, Postgres, JSON 파일 중 초기 선택 필요 |
| 워커 실행 방식 | 미결정 | 단일 프로세스 루프 vs 큐 기반 비동기 워커 |
| 모델 API 래퍼 | 미결정 | Claude API를 기본 가정하되 추상화 경계 필요 |

---

*작성: 2026-04-19 | 연관: [CLAUDE.md](../CLAUDE.md), [docs/p1-mcp.md](./p1-mcp.md)*
