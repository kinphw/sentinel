# Project Sentinel Task Log

> 모든 AI와 사용자가 공유하는 전역 작업 로그입니다.
> 최신 항목을 맨 위에 추가합니다. 기존 기록은 수정하지 말고, 정정이 필요하면 새 항목으로 남깁니다.

## 기록 규칙

- 형식: `YYYY-MM-DD HH:MM:SS ±TZ | 작업주체 | 작업내용`
- 작업주체 예시: `User`, `Claude Code`, `GPT Codex`
- 한 항목은 1~2줄 수준으로 간결하게 작성
- 설계 결정, 문서 추가, 기능 구현, 상태 변경만 기록
- 사소한 탐색/읽기만 한 경우는 기록하지 않아도 됨

## Log

- 2026-04-20 22:01:00 +09:00 | GPT Codex | `CLAUDE.md`를 현재 구현 기준으로 정리. 백엔드 스택(Node.js/TypeScript, REST+SSE), 실제 디렉토리 구조, P3/P4 완료 상태, mock/live 실행 설정 및 관련 문서 인덱스를 최신 상태로 갱신.
- 2026-04-20 21:41:30 +09:00 | GPT Codex | `document-mcp` 추가. `fss_document_db.fss_documents`를 대상으로 `search_fss_documents`(폴더/파일명 후보 검색)와 `get_fss_document`(단건 본문 조회) 도구를 구현하고, Stage 1 조사 순서 및 프로젝트 문서를 내부 검토문서 기준으로 갱신.
- 2026-04-20 19:56:23 +09:00 | GPT Codex | 개발용 mock 에이전트 모드 추가. `SENTINEL_AGENT_MODE=mock`에서 Anthropic 실호출 없이 Stage1~3 SSE/feedback/artifact 흐름을 시뮬레이션하고, VS Code task/launch는 기본 mock로 실행되도록 조정. PM2는 `env_production` 기본 live, `env_mock` 선택 mock 지원.
- 2026-04-19 21:42:51 +09:00 | GPT Codex | 개발/운영 실행 설정 추가. 백엔드 기본 포트를 `3101`로 변경하고, `frontend/vite.config.ts` 프록시를 연동. `.vscode/tasks.json`·`launch.json`으로 윈도우 개발용 실행/디버그 세팅 추가, 루트 `ecosystem.config.cjs`로 Ubuntu PM2 운영 세팅 추가.
- 2026-04-19 21:28:56 +09:00 | GPT Codex | Stage 재개발 흐름 확장. `Stage 1`은 기존 Stage1 artifact 선택 후 새 Stage1 세션으로 발전 가능, `Stage 2`는 Stage1 확정본 또는 기존 Stage2 artifact를 입력으로 새 Stage2 세션 생성 가능, `Stage 3`는 Stage2/기존 Stage3 artifact 선택 기반 편집 초안 세션과 별도 artifact 저장 지원.
- 2026-04-19 +09:00 | Claude Code | P3 프론트엔드 구현 완료. React+Vite SPA(frontend/). Stage1 탭(이슈입력→에이전트실행→confirm/feedback), Stage2 탭(DB선택/직접입력/커스텀목차→보고서작성→confirm/feedback), EventLog SSE 실시간 스트리밍. Express REST API(backend/src/server.ts) 추가. npm run server로 기동.
- 2026-04-19 +09:00 | Claude Code | P4 보고서 에이전트 개선. STAGE2_SYSTEM_PROMPT 구조를 현황/이슈/검토의견/향후계획으로 수정. 개조식 레벨(1/□/○/-/·) 명시. few-shot 예시 삽입. 커스텀 목차 우선 적용 로직 추가.
- 2026-04-19 +09:00 | Claude Code | AgentEngine에 AgentEvent 이벤트 시스템 추가. onEvent 콜백으로 CLI·HTTP 양쪽 지원. index.ts에 콘솔 어댑터(makeConsoleHandler) 구현. SessionStore에 getArtifactsList 추가.
- 2026-04-19 +09:00 | Claude Code | CLAUDE.md Phase 상태판 갱신. P3(피드백 재진입)·P4(STAGE 1 에이전트)·P5(STAGE 2 에이전트) 모두 완료로 업데이트. 현재 상태 요약 및 다음 작업 체크리스트 재정렬.
- 2026-04-19 +09:00 | Claude Code | STAGE 2 보고서 초안 에이전트 구현. `STAGE2_SYSTEM_PROMPT`, `RunConfig` 패턴 추가. `index.ts`에 Stage 1→Stage 2 전환 흐름(자동/직접입력/건너뜀) 및 `readMultiline()` 헬퍼 구현.
- 2026-04-19 +09:00 | Claude Code | `messages` 테이블 `seq BIGINT AUTO_INCREMENT` PK 추가. `getApiMessages`·`replaceLastMessage`를 `seq` 기준 정렬로 변경. DATETIME 1초 정밀도 한계로 인한 메시지 순서 버그 수정.
- 2026-04-19 18:18:47 +09:00 | GPT Codex | `AgentEngine` 피드백 재진입 버그 수정 완료. MAX_TOOL_CALLS 도달 후에도 히스토리가 assistant로 종료되도록 보정하고, 기존에 user `tool_result`로 끝난 세션은 마지막 메시지 병합 방식으로 안전 재개되게 수정.
- 2026-04-19 18:18:47 +09:00 | GPT Codex | API 비용 최적화 반영. `ToolGateway` 도구 정의/동일 인자 결과 캐시 추가, `AgentEngine`에 컨텍스트 압축 옵션 추가. 기본값은 성능 보존 우선으로 유지(`max_tokens=8192`, `tool_result` 8000자, 컨텍스트 압축 기본 비활성).
- 2026-04-19 +09:00 | Claude Code | `AgentEngine` 피드백 재진입 버그 수정 미완료(진행중). MAX_TOOL_CALLS 도달 후 피드백 재진입 시 연속 user 메시지로 API 400 에러 발생 — 수정 작업 중단됨, 다음 세션에서 계속 필요.
- 2026-04-19 +09:00 | Claude Code | `issues` 테이블 `title` 컬럼 제거. `createIssue(inputText)` 단일 인자로 통합. schema.sql, types.ts, SessionStore, CLI, test.ts 모두 반영. DB ALTER TABLE 적용 완료.
- 2026-04-19 +09:00 | Claude Code | `law-mcp`에 `get_admin_rule_article` 도구 추가. 행정규칙 전문을 로컬 파싱하여 특정 조문만 반환 (get_law_article과 동일한 역할). AgentEngine 프롬프트에서 get_admin_rule_text 대신 우선 사용하도록 안내.
- 2026-04-19 +09:00 | Claude Code | `interpretation-mcp` 검색 로직 수정. 키워드를 공백 기준으로 분리하여 각 어절 AND 조건 처리 (lawquery UI와 동일). 검색 범위를 제목·질의요지에서 제목·질의요지·회답·이유 전체로 확장. 기본 limit 10 → 20으로 상향.
- 2026-04-19 +09:00 | Claude Code | `law-mcp`에 `get_law_toc`, `get_admin_rule_toc` 도구 추가. 조문 번호·제목 목차만 반환(내용 없음). `get_law_hierarchy` 설명에 "하위규정 연결 관계 확인 전용" 명시. AgentEngine 시스템 프롬프트에 3단계 조회 흐름(체계도 → 목차 → 개별조문) 명시.
- 2026-04-19 +09:00 | Claude Code | `P2` 에이전트 엔진 골조 구현 완료. 백엔드 언어=Node.js/TypeScript, 저장소=MariaDB(sentinel_db) 확정. `backend/` 하위에 `SessionStore`, `ToolGateway`, `AgentEngine`, CLI(`src/index.ts`) 작성. MariaDB 6개 테이블 스키마 적용 완료. `.env`에 `SENTINEL_DB_NAME`, `ANTHROPIC_API_KEY` 항목 추가. CLAUDE.md P2 상태를 완료로 갱신.
- 2026-04-19 03:40:51 +09:00 | GPT Codex | `docs/p2-agent.md` 작성 시작. P2 범위, 상태 머신, 저장 모델, human-in-the-loop 흐름, 완료 기준 문서화.
- 2026-04-19 03:40:51 +09:00 | GPT Codex | `CLAUDE.md` 진행상황 체크 갱신. `P2` 상태를 진행중으로 변경하고 다음 체크리스트를 엔진 구현 기준으로 재정렬.
- 2026-04-19 03:37:22 +09:00 | GPT Codex | `CLAUDE.md`에 진행상황 체크 섹션 추가. `P1` 완료 상태와 `P2` 착수 준비 항목 반영.
- 2026-04-19 03:37:22 +09:00 | GPT Codex | 전역 작업 이력 공유를 위해 `TASK_LOG.md` 생성. 이후 모든 AI는 의미 있는 변경 후 이 로그에 append.
