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

- 2026-04-26 +09:00 | Claude Code | **Stage 3 (HWP 편집 준비) 전면 제거**. Forge로 이관된 기능이라 본 프로젝트에 잔존할 이유 없음. 변경: (1) DB STAGE_3 데이터 0건 확인 후 ENUM에서 제거(`stage_sessions.stage`, `issues.current_stage`). (2) `schema.sql` ENUM 갱신. (3) Backend: `STAGE3_SYSTEM_PROMPT` 삭제, `Stage` 타입 `'STAGE_1' | 'STAGE_2'`로 축소, `server.ts`의 STAGE_3 분기·`buildInitialInput` STAGE_3 케이스 제거, mock 생성기에서 Stage 3 fallback 제거. (4) Frontend: `Stage3Tab.tsx` 파일 삭제, `App.tsx` 탭/import/Tab 타입 정리, `types.ts`/`api.ts`/`AdminTab.tsx`의 stage 옵션·`stageLabel` 정리. (5) `docs/p2-agent.md`·`docs/p3-frontend.md` STAGE_3 참조 정리(Forge 이관 안내). 백엔드/프론트 풀빌드 통과(번들 176KB→170KB).
- 2026-04-25 +09:00 | Claude Code | **mock/live 분기 구조 단일 진입점화**. (1) `stage_sessions` 테이블에 `agent_mode ENUM('live','mock')` 컬럼 추가 (DEFAULT 'live'), 기존 mock 이슈 2건 cascade 삭제(live 8건 보존). (2) 백엔드: 모듈 레벨 `AGENT_MODE` 상수 제거, `parseAgentMode` 함수 제거, `Anthropic` 클라이언트 lazy 생성, `runSession` 내 분기를 `session.agent_mode === 'mock'`으로 전환, `POST /api/sessions`에서 `agentMode` 수신, `/api/runtime`은 mode 정보 제거(port만), `createStageSession(issueId, stage, agentMode, inputArtifactId)` 시그니처 변경. (3) 프론트: `AgentModeContext`(localStorage 영속) 신규, 헤더 배지를 체크박스 토글로 전환, Stage1/2/3 탭이 context의 mode를 createSession에 전달, `is_mock` 표시는 컬럼 기반 JOIN으로 일원화. (4) `.vscode/tasks.json`·`launch.json` Mock/Live 짝 task 8개 → 단일 stack 8개로 단순화 (포트 3101/5173 단일). (5) `ecosystem.config.cjs`에서 `env_mock` 블록 제거. (6) `SENTINEL_AGENT_MODE` 환경변수 코드/설정에서 완전 제거. 백엔드/프론트 풀빌드 통과.
- 2026-04-25 +09:00 | Claude Code | **Forge 자산 이관 완료**. 본 프로젝트에서 다음 자산 제거: `hwp_api_reference/`, `mcp/hwp-api-mcp/`, `scripts/{extract-hwp-api.py, parse_hwp_api.py, hwp_api_schema.sql, smoke_test_hwp_mcp.py}`. `.mcp.json`에서 `hwp-api` 항목 제거. 전부 `c:/projects/sentinel-forge/`로 이동·재빌드·smoke test 통과. CLAUDE.md 디렉토리 트리에서 hwp 관련 항목 제거, 이관 체크리스트 완료 표시. MariaDB `hwp_api_db` 데이터 자체는 그대로 유지(Forge가 환경1에서 그대로 사용). 이로써 Sentinel은 LLM 기반 보고서 작성기로 책임 범위가 정리됨.
- 2026-04-25 +09:00 | Claude Code | **Sentinel 마무리**: `STAGE2_SYSTEM_PROMPT`(`backend/src/engine/AgentEngine.ts:79`)를 md 사양 v1.1에 맞춰 전면 갱신. (1) YAML front-matter 메타데이터(보고서명·작성부서·작성일) 출력 의무화 (2) `□` 레벨 `(요약단어)` 의무화 (3) Bold `__X__` 표기 + 이탤릭/markdown bold 금지(asterisk는 참조 주석 전용) 명시 (4) 섹션 헤더 앞 빈 줄 의무화 (5) 결론 화살표(`==>`)·일반 주석(`※`) 사용법 안내 (6) 완성 예시도 v1.1 표기로 갱신. TypeScript 컴파일 통과 확인. CLAUDE.md 진행 상황을 "Sentinel 마무리 단계"로 갱신 — 이후 신규 작업은 Sentinel-Forge에서 진행.
- 2026-04-25 +09:00 | Claude Code | md 사양 v1.1 확정 (양 프로젝트 사본 동기화). 변경: (a) Bold 표기 `__X__` 채택 + 이탤릭 사용 금지 + asterisk(`*`/`**`/`***`) 참조 주석 전용 — 다중 참조와 markdown bold 충돌 회피. (b) `*`/`※` 주석 한 단락 공존 명문화. (c) 들여쓰기 규칙 삭제 — 라인 시작 글머리 문자만으로 레벨 식별. (d) 섹션 헤더 앞 빈 줄 1개 이상 의무화. (e) 결론 화살표 위치 자유 명문화. STAGE 2 프롬프트 갱신 항목(Bold 표기·이탤릭 금지·헤더 빈 줄)을 다음 작업 체크리스트에 추가.
- 2026-04-25 +09:00 | Claude Code | md 사양 v1.0 확정 (양 프로젝트 사본 동기화). 5종 의미(메타데이터·층위·요약단어·주석·결론 화살표)만 명문화. 시각적 서식 항목은 모두 Forge 책임으로 이전. CLAUDE.md § 5(보고서 출력 사양) 단순화. 다음 작업 체크리스트에 STAGE 2 시스템 프롬프트 갱신 항목 추가 (front-matter 출력, □ 요약단어 의무화, 결론 화살표·일반 주석 안내).
- 2026-04-25 +09:00 | Claude Code | md 사양 스켈레톤을 양 프로젝트에 미러링. `docs/markdown-spec.md` 신설(Forge `spec/markdown-spec.md`와 바이트 동일). 동기화 규약: 상단 배너 + CLAUDE.md AI 협업 지침 6항에 의무 명시. 양 위치 동시 갱신 필수, 사양 변경은 양 프로젝트 합의로만.
- 2026-04-25 +09:00 | Claude Code | **프로젝트 분리**: STAGE 3·4·5(HWPX 작성·정규화·COM 폴리싱)와 관련 자산(`hwp_api_reference`, `hwp_api_db`, `hwp-api-mcp`, 추출/적재 스크립트)을 신규 프로젝트 [Sentinel-Forge](../sentinel-forge/) (`c:/projects/sentinel-forge`)로 분리. Sentinel의 산출 종착점은 **개조식 md**까지로 한정. 결합점은 md 사양 하나. CLAUDE.md 섹션 2/3/4/5/6/7/8/9/11 모두 갱신, Sentinel-Forge에 신규 CLAUDE.md/TASK_LOG.md 신설. 자산 물리 이동(F0)은 별도 후속 작업.
- 2026-04-25 +09:00 | Claude Code | 설계 변경: 단일 STAGE 3(HWP 편집)을 **STAGE 3 HWPX 초안 작성 / STAGE 4 HWPX 정규화(린터) / STAGE 5 COM 렌더링 폴리싱** 3단계로 분리. 한/글 의존도 최소화 + 폐쇄망 운용성 확보. P5도 P5a/P5b/P5c로 분리, 기존 `hwp_api_db`/`hwp-api-mcp`는 P5c 전용 자산으로 위치 명확화. CLAUDE.md 섹션 2(단계 구조), 7(개발 우선순위), 8(진행상황), 11(STAGE 격리 원칙) 모두 갱신.
- 2026-04-25 +09:00 | Claude Code | HWP COM API 레퍼런스 MCP 구축. `hwp_api_db` 신규 DB(5개 테이블) 생성, 한컴 공식 PDF 4종 → PyMuPDF 추출 → 정규식 파서(`scripts/parse_hwp_api.py`)로 적재(actions 969 / parametersets 140 / parameterset_items 1250 / members 362 / member_items 29). `mcp/hwp-api-mcp/` 추가, 6개 도구(search/get × Action/ParameterSet/Member) 제공. 전용 read-only 계정 `hdbuser` 생성, `.mcp.json` 등록.
- 2026-04-24 +09:00 | Claude Code | `CLAUDE.md` 점검 및 갱신. blueprint.md 참조 제거, scripts/ 디렉토리 반영, docs/ 트리 현행화(p1~p4, references, report-samples), 문서 인덱스 상태 갱신(p3/p4/law-api.md 작성완료), P4 비고에서 few-shot 사례 파일이 아직 프롬프트 내 간이 예시 수준임을 명시.
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
