# Project Sentinel — AI Collaboration Guide

> 이 문서는 Claude Code, GPT Codex 등 모든 AI 협업 도구가 공유하는 프로젝트 정의서입니다.
> 작업 시 이 문서를 우선 참조하십시오.

---

## 1. 프로젝트 개요

**Project Sentinel**은 금융감독원의 법령 검토 및 보고서 작성 업무를 LLM 기반으로 자동화하는 웹 애플리케이션입니다.

### 핵심 가치

- **자율 에이전트**: Claude Code나 GPT Codex처럼, 스스로 도구를 호출하고 반복 추론하여 결론에 도달하는 독립 AI 에이전트
- **Human-in-the-loop**: 각 STAGE 경계에서 사람이 확인·피드백을 주면, 에이전트가 해당 STAGE 내에서 재진입하여 개선
- 법령 원문·법령해석·내부 검토문서 등 법적·업무 참고 데이터와의 실시간 연계 (MCP 도구로 에이전트에게 제공)

---

## 2. 핵심 설계 원칙: 2단계 LLM 작성기 + 외부 HWP 툴킷

**Sentinel은 LLM 의존 작업(STAGE 1·2)을 수행하며, 산출물은 개조식 md까지입니다.**
HWP 형식화·폴리싱은 별도 프로젝트 [Sentinel-Forge](../sentinel-forge/)에서 수행  

- Sentinel은 **환경1(LLM 접근 가능)에서만** 운용
- Sentinel-Forge는 **환경2(폐쇄망)에서도** 운용 가능
- 두 프로젝트의 결합점은 **개조식 md 사양** 하나뿐. 코드 의존 없음
- Sentinel을 거치지 않은 손글 md도 Sentinel-Forge가 동일하게 처리 (사용자 직접 입력 시나리오)

### Sentinel 내부 단계

```
이슈 입력
  └─ 법적 근거 조회 (법령 원문 / 법령해석 / 내부 검토문서)
        │
        ▼
┌──────────────────────────────────┐
│  STAGE 1: 검토 결론              │  산출물: 줄글 텍스트 (자유 형식)
│  LLM이 법적 근거를 분석하여      │  ← 사용자 피드백
│  쟁점·판단·근거를 자유로운       │  → 결론 재생성 (법령 재조회 포함)
│  줄글로 서술                     │
│  ※ 보고서 형식 아님. 논리와      │
│    내용의 정확성이 목표           │
└──────────────┬───────────────────┘
               │ confirm
               ▼
┌──────────────────────────────────┐
│  STAGE 2: 보고서 초안            │  산출물: 개조식 md (Sentinel 최종 산출)
│  확정된 결론을 금감원 보고서     │  ← 사용자 피드백
│  형식으로 재구성                 │  → 초안 재작성 (결론 고정)
│  (현황/이슈/검토의견/향후계획,   │
│   개조식)                        │
│  ※ markdown-spec.md 준수        │
└──────────────┬───────────────────┘
               │ md 파일로 인계
               ▼
        ┌─────────────────┐
        │ Sentinel-Forge  │  ← 별도 프로젝트
        │  (Formatter →   │     c:/projects/sentinel-forge
        │   Linter →      │
        │   Polisher)     │     md → HWPX → .hwp 최종
        └─────────────────┘
```

### 단계별 산출물 요약 (Sentinel 범위)

| 단계 | 입력 | 산출물 | 피드백 범위 |
|------|------|--------|------------|
| **STAGE 1** 검토 결론 | 이슈 + 법적 근거 | 줄글 결론 | 결론 재생성 (법령 재조회 가능) |
| **STAGE 2** 보고서 초안 | 확정 결론 | **개조식 md** (Sentinel-Forge로 인계) | 초안 재작성 (결론 고정) |

### 피드백 단방향 원칙

- 내용 피드백 ("이 단락 법령 인용이 틀렸다"): **STAGE 1 또는 2까지 거슬러 올라가서 재생성** → md를 Sentinel-Forge로 다시 인계
- 양식·렌더링 피드백 ("번호 깊이가 안 맞다", "제목이 페이지 끝에 외톨이"): **Sentinel 책임 아님**. Sentinel-Forge의 룰셋에 추가하여 처리
- HWPX·HWP 단계에서 LLM이 텍스트를 직접 수정하지 않음 (단방향 데이터 흐름 유지)

---

## 3. 시스템 아키텍처

```
┌─────────────────────────────────────────────┐
│                  Web Frontend                │
│           (브라우저 기반 UI, SPA)              │
└───────────────────┬─────────────────────────┘
                    │ REST / SSE
┌───────────────────▼─────────────────────────┐
│               Backend Server                 │
│      (Node.js / TypeScript + Express)        │
│                                             │
│  ┌──────────────┐   ┌─────────────────────┐ │
│  │  Job Queue   │   │   Worker Pool        │ │
│  │  (이슈 큐)   │──▶│  (Claude API 루프)   │ │
│  └──────────────┘   └────────┬────────────┘ │
│                              │              │
│  ┌───────────────────────────▼────────────┐ │
│  │           MCP Server Layer              │ │
│  │  ┌─────────────┐  ┌──────────────────┐ │ │
│  │  │interpretation│ │  법령정보 MCP     │ │ │
│  │  │ MCP (해석DB) │ │(국가법령정보 API) │ │ │
│  │  ├─────────────┤  ├──────────────────┤ │ │
│  │  │ document MCP│  │ 내부 검토문서 DB   │ │ │
│  │  │(MariaDB)    │  │(documents)       │ │ │
│  │  └─────────────┘  └──────────────────┘ │ │
│  └────────────────────────────────────────┘ │
│                                             │
└─────────────────────────────────────────────┘
              │
              │ 개조식 md 인계 (파일 또는 다운로드)
              ▼
       [Sentinel-Forge — 별도 프로젝트]
        c:/projects/sentinel-forge
        Formatter / Linter / Polisher
```

### 아키텍처 설계 원칙

- **에이전트 루프가 핵심**: 단발성 API 호출이 아님. 에이전트가 스스로 도구 호출 → 추론 → 자기 평가 → 재시도를 반복하다가 만족 조건에 도달하면 사람에게 확인 요청
- **STAGE = 에이전트 인스턴스 경계**: 각 STAGE는 독립된 에이전트 컨텍스트를 가짐. 이전 STAGE의 확정 산출물만 초기 입력으로 받고, 내부 추론 과정은 공유하지 않음
- **단방향 데이터 흐름**: 역방향 재호출 없음. STAGE 2가 법령을 재조회하는 것은 설계 위반
- **단계 내 피드백 재진입**: 사람의 피드백은 해당 STAGE 에이전트를 재시작시킴. 다른 STAGE를 건드리지 않음
- **중단 허용**: 어느 STAGE에서든 사람이 멈추면 그것이 Sentinel의 최종 산출물 (md). 이후 처리는 Sentinel-Forge에서
- **HWP 영역 분리**: HWP/HWPX 처리는 본 프로젝트의 책임이 아니며 Sentinel-Forge로 인계

---

## 4. 기반 기술 및 외부 연동

| 항목 | 기술/소스 | 비고 |
|------|-----------|------|
| 백엔드 | Node.js / TypeScript / Express | HTTP API + SSE |
| 프론트엔드 | React + Vite SPA | |
| 영속 저장소 | MariaDB (`sentinel_db`) | issues, stage_sessions, agent_runs, artifacts, feedbacks, messages |
| LLM | Claude API (Anthropic) | 주력 모델 |
| 법령 원문 | 국가법령정보 공동활용 API | 공개 API |
| 법령해석 | `c:\projects\lawquery` 프로젝트 DB | 약 4만 건 크롤링 DB |
| 내부 검토문서 | `fss_document_db.documents` (MariaDB) | 금융감독원 내부 검토문서. 법령/법령해석 다음의 보조 검토 소스 |
| HWP 편집 | **별도 프로젝트 [Sentinel-Forge](../sentinel-forge/)** | Sentinel은 md까지만, HWP 변환·폴리싱은 Forge 담당 |

---

## 5. 보고서 출력 사양

Sentinel STAGE 2의 산출물은 [docs/markdown-spec.md](docs/markdown-spec.md)에 정의된 개조식 markdown입니다. 이 파일은 Sentinel-Forge의 [`spec/markdown-spec.md`](../sentinel-forge/spec/markdown-spec.md)와 항상 동일하게 유지되며, 두 프로젝트의 결합 계약입니다.

**핵심 원칙**: 마크다운은 **논리 구조**(메타데이터·층위·요약단어·주석·강조·결론 화살표 6종)만 표기. 시각적 서식(폰트·자간·색상·들여쓰기 등)은 모두 Sentinel-Forge 책임.

상세 규범·예시는 [docs/markdown-spec.md](docs/markdown-spec.md) 참조.

---

## 6. 디렉토리 구조

```
sentinel/
├── CLAUDE.md              ← 이 파일 (AI 협업 가이드)
├── TASK_LOG.md            ← 전역 작업 이력 로그
├── .mcp.json              ← Sentinel이 사용하는 MCP 서버 연결 설정
├── docs/
│   ├── markdown-spec.md   ← Sentinel↔Forge 결합 계약 (md 사양)
│   ├── references/        ← 외부 API 레퍼런스 (law-api.md 등)
│   └── report-samples/    ← 보고서 사례 (few-shot 학습용, 보강 여지)
├── backend/
│   └── src/               ← Express API, AgentEngine, ToolGateway, SessionStore
├── frontend/
│   └── src/               ← 웹 UI (React + Vite SPA)
├── mcp/
│   ├── law-mcp/           ← 국가법령정보 API MCP 서버
│   ├── interpretation-mcp/← 법령해석 DB MCP 서버
│   └── document-mcp/      ← 내부 검토문서 DB MCP 서버 (2단 검색 구조)
├── scripts/               ← 운영 스크립트 (DB 탐색 등)
├── .vscode/               ← 로컬 개발용 launch/tasks
└── ecosystem.config.cjs   ← PM2 운영/모킹 실행 설정
```

---

## 7. 운영 가이드

### 실행

| 용도 | 명령 |
|---|---|
| 백엔드 서버 (개발) | `npm run server` (backend/) — http://localhost:3101 |
| 프론트엔드 개발 서버 | `npm run dev` (frontend/) — http://localhost:5173 |
| 통합 개발 (VS Code) | "Sentinel: Full Stack Debug" (백엔드 launch + 프론트엔드 chrome) |
| 운영 실행 | PM2 (`ecosystem.config.cjs` 참조) |

### Mock / Live 모드

- 프론트엔드 헤더 토글로 세션 단위 결정. DB `stage_sessions.agent_mode` 컬럼에 영속
- Mock은 Claude API 호출 없이 결정적 더미 산출물을 흘려 UI/플로우 검증용
- Live는 실제 Claude API 사용

### 안정성

- 모든 API 메시지는 매 step마다 `messages` 테이블에 영속 저장 → 재개 가능
- recoverable 오류(잔액 부족·rate limit·5xx·네트워크)는 세션을 `READY`로 되돌려 ▶ 재개 버튼으로 이어서 실행
- fatal 오류(인증·입력 검증)만 `FAILED`로 종결
- 활성 세션 ID는 localStorage에 저장 → 새로고침 후 자동 복원

---

## 8. 문서 인덱스

| 파일 | 내용 |
|------|------|
| [TASK_LOG.md](TASK_LOG.md) | 전역 작업 이력 로그. 시간/작업주체/작업내용 append 전용 |
| [docs/markdown-spec.md](docs/markdown-spec.md) | **Sentinel↔Forge 계약** — 개조식 md 입력 사양. `sentinel-forge/spec/markdown-spec.md`와 동기 유지 필수 |
| [docs/references/law-api.md](docs/references/law-api.md) | 국가법령정보 OpenAPI 문서 (법령목록·본문 조회) |
| [docs/report-samples/](docs/report-samples/) | 보고서 사례 (few-shot 학습용 — 보강 시 사용) |
| [.mcp.json](.mcp.json) | MCP 서버 연결 설정 (`law`, `interpretation`, `document`) |
| [.vscode/tasks.json](.vscode/tasks.json) | 로컬 개발/디버그 스택 실행 태스크 |
| [.vscode/launch.json](.vscode/launch.json) | 백엔드 launch + 프론트 chrome 디버그 설정 |
| [ecosystem.config.cjs](ecosystem.config.cjs) | PM2 운영/mock 실행 설정 |

---

## 9. Git 커밋 컨벤션

```
<type>(<scope>): <subject>
```

| type | 용도 |
|------|------|
| `feat` | 새 기능 추가 |
| `fix` | 버그 수정 |
| `docs` | 문서 변경 (CLAUDE.md, *.md 등) |
| `refactor` | 기능 변경 없는 코드 구조 개선 |
| `chore` | 빌드·설정·의존성 등 기타 |
| `test` | 테스트 추가·수정 |

**scope** (선택): 변경 범위 — `law-mcp`, `interpretation-mcp`, `document-mcp`, `backend`, `frontend` 등

**예시**
```
feat(law-mcp): add get_law_hierarchy and get_admin_rule_text tools
fix(interpretation-mcp): preserve DATE timezone via dateStrings: true
docs: update markdown-spec to v1.2 (=> 단일 표기)
chore: convert backend debug from attach to launch
```

---

## 10. AI 협업 지침

이 문서를 읽는 AI(Claude, GPT 등)는 다음을 준수하십시오.

1. **이 문서를 진실의 원천(source of truth)으로 취급하십시오.** 구조 변경 시 이 문서를 먼저 업데이트하십시오.
2. **STAGE 격리를 유지하십시오.** Sentinel은 STAGE 1·2(검토 결론, 보고서 초안 md) 두 단계 독립 모듈입니다. STAGE 2가 STAGE 1의 법령을 재호출하는 것은 설계 위반입니다. HWP 형식화·폴리싱은 본 프로젝트가 책임지지 않으며 [Sentinel-Forge](../sentinel-forge/)에서 처리됩니다.
3. **법적 정확성 우선.** 법령과 법령해석을 1차 근거로, 내부 검토문서를 2차 근거(과거 처리 선례·검토 경위·해석 일관성)로 사용하십시오. 셋 모두 적극 조사하고 본문에 인용합니다.
4. **인용 형식.** 법령해석은 `구분 + 일련번호 + 회신일자` 3요소로, 내부 검토문서는 `파일명 + 작성·수정시기`로 인용합니다. 도구 결과의 `id`는 내부 적재키이므로 본문 표기 금지.
5. **보안.** lawquery DB 및 내부 보고서 데이터는 외부 노출 금지.
6. **HWP 영역 분리.** 본 프로젝트에서 HWP/HWPX/COM API 관련 코드를 새로 추가하지 마십시오. 모든 HWP 작업은 [Sentinel-Forge](../sentinel-forge/)에서 처리됩니다.
7. **md 사양 동기화.** [docs/markdown-spec.md](docs/markdown-spec.md)는 Sentinel-Forge의 동일 파일(`sentinel-forge/spec/markdown-spec.md`)과 항상 일치해야 합니다. 한쪽을 수정하면 반드시 다른 쪽도 동일하게 갱신하고, 사양 문서 자체의 변경 이력 표에 기록하십시오. 사양 변경은 양 프로젝트의 합의로만 진행합니다.
8. **작업 이력 기록.** 의미 있는 변경을 완료하면 `TASK_LOG.md`에 시간·작업주체·작업내용을 append하여 다음 작업자가 문맥을 이어받을 수 있게 하십시오.

---

*최초 작성: 2026-04-19*
