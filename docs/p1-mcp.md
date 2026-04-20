# P1 — MCP 도구 레이어 설계

> 판례 연동은 이 Phase에서 배제. 법령정보 MCP + 법령해석 MCP + 내부 검토문서 MCP 3개를 구현한다.

---

## 1. 역할 분담 원칙

MCP 서버는 **판단하지 않는다.** 조회만 한다.

| 주체 | 역할 |
|------|------|
| **Claude API (에이전트)** | 이슈에서 관련 법령명 추론, 검색 키워드 선정, 결과 충분성 평가, 추가 조회 여부 결정 |
| **MCP 서버** | 에이전트가 요청한 법령명·키워드로 데이터 조회 후 반환. 추론 없음 |

예시 흐름:
```
에이전트: "이 이슈에는 전자금융거래법이 관련된다"
  → MCP 호출: get_law_text("전자금융거래법")
  → 결과 수신 후 에이전트 판단: "28조가 핵심이다. 해석례도 찾아야겠다"
  → MCP 호출: search_interpretation(query="지급결제대행 중계 정산")
  → 결과 수신 후 에이전트 판단: "배경 검토가 더 필요하니 내부 문서도 찾아보자"
  → MCP 호출: search_fss_documents(query="선불전자지급수단 발행")
  → 결과 수신 후 에이전트 판단: "이 문서가 유사해 보인다"
  → MCP 호출: get_fss_document(id)
  → 결과 수신 후 에이전트 판단: "충분하다. 결론을 작성한다"
```

---

## 2. MCP 서버 A — 법령정보 (law-mcp)

### 역할

법령명을 받아 **법령 원문(조문)**을 반환한다.

### 실제 API 흐름

국가법령정보 OpenAPI는 **2단계** 구조다. 법령명 → 법령ID → 본문 순서로 조회한다.

```
STEP 1: 법령명으로 현행 법령 검색
GET http://www.law.go.kr/DRF/lawSearch.do
    ?OC={LAW_OC}&target=eflaw&type=JSON&query={법령명}&nw=3
    ※ nw=3: 현행 법령만 반환 (생략 시 연혁+시행예정+현행 전체 반환 → 수십 건)

응답 필드 중 핵심:
  - 현행연혁코드: "현행" | "시행예정" | "연혁"
  - 법령ID:       "010199"  ← 법령의 고유 식별자, 버전 무관하게 동일
  - 법령일련번호: "280277"  ← MST값, 개정 버전마다 다름 (사용하지 않음)

→ nw=3으로 요청하면 현행만 나오므로 별도 필터 불필요.
  단, 혹시 모를 경우를 대비해 현행연혁코드 === "현행" 인 항목을 선택.
  법령ID를 추출하여 STEP 2로 전달.

STEP 2: 법령ID로 현행 본문 자동 조회
GET http://www.law.go.kr/DRF/lawService.do
    ?OC={LAW_OC}&target=eflaw&type=JSON&ID={법령ID}
    ※ ID= 방식은 항상 현행 버전을 반환. MST+efYd 방식은 사용하지 않음.

응답: 조문번호, 조문제목, 조문내용, 항번호, 항내용, 호번호, 호내용 계층

STEP 2-b: 특정 조문만 조회 (컨텍스트 절약)
GET http://www.law.go.kr/DRF/lawService.do
    ?OC={LAW_OC}&target=eflaw&type=JSON&ID={법령ID}&JO={조번호6자리}
    JO 형식: 4자리 조번호 + 2자리 가지번호 (예: 000200=2조, 001002=10조의2)
```

환경변수: `LAW_OC` (`.env`에 설정됨)

> **설계 결정 (2026-04-19)**: `MST+efYd` 방식 대신 `ID=` 방식 사용.
> 이유: ID= 는 현행 버전을 자동 반환하므로 버전 관리 불필요. MCP는 항상 현행법 기준으로 조회.

### 법령 5단 구조 처리

금융법령은 통상 5단으로 구성되며 각각 **별도 법령ID**를 가진다.

```
1단: 법          (예: 전자금융거래법)
2단: 시행령       (예: 전자금융거래법 시행령)
3단: 시행규칙     (예: 전자금융거래법 시행규칙)
4단: 감독규정     (예: 전자금융업감독규정)
5단: 시행세칙     (예: 전자금융업감독규정시행세칙)
```

→ 에이전트가 이슈를 판단하여 필요한 단(들)을 **각각 검색·조회**한다.
→ MCP는 단 구조를 알 필요 없음. 법령명을 받아 ID를 찾고 본문을 반환하면 됨.

### 노출할 Tool 목록

```typescript
// Tool 1: 법령명 검색 → 법령ID 반환
// 에이전트가 정확한 법령명·ID를 모를 때 사용
// nw=3 으로 현행만 요청, 현행연혁코드==="현행" 항목 필터 후 반환
search_law(query: string): LawSearchResult[]
// 반환: [{ 법령ID, 법령명한글, 법령구분명, 시행일자, 소관부처명 }, ...]
// 에이전트가 목록 보고 적합한 법령ID를 선택

// Tool 2: 법령 전문 조회 (법령ID 사용)
// 전체 조문이 필요할 때
get_law_text(law_id: string): LawFullText
// 반환: { 법령명, 조문목록: [{ 조번호, 조제목, 조문내용, 항목록 }, ...] }

// Tool 3: 특정 조문 조회 (법령ID + 조번호)
// 에이전트가 특정 조만 필요할 때 (컨텍스트 절약)
// sub_number: 6조의2 → article_number=6, sub_number=2 (생략 시 0)
get_law_article(law_id: string, article_number: number, sub_number?: number): LawArticle
// 반환: { 조번호, 조제목, 조문내용, 항목록: [{ 항번호, 항내용, 호목록 }] }
```

### 실제 응답 JSON 구조 (구현 필수 참조)

```
법령
├── 기본정보              법령명, 법령ID, 시행일자, 소관부처 등
├── 조문
│   └── 조문단위[]        조문 배열
│       ├── 조문번호      "1", "2", "6" 등 숫자 문자열
│       ├── 조문가지번호  "2" → 6조의2, 생략 시 기본 조문
│       ├── 조문여부      "조문" | "전문"   ← 핵심 필드
│       ├── 조문제목      "목적", "정의" 등
│       ├── 조문내용      조문 본문 텍스트
│       └── 항            단일 object 또는 array (불일치 주의!)
│           ├── 항번호    "①", "②"
│           ├── 항내용
│           └── 호[]
│               ├── 호번호  "1.", "2."
│               ├── 호내용
│               └── 목[]
│                   ├── 목번호  "가.", "나."
│                   └── 목내용
├── 부칙
│   └── 부칙단위[]
└── 개정문
    └── 개정문내용
```

**구현 시 반드시 처리해야 할 quirk 3가지**

| 항목 | 내용 | 처리 방법 |
|------|------|-----------|
| `조문여부 === "전문"` | 편·장·절·관 제목 (조문 아님) | 필터링하여 에이전트에게 전달하지 않음 |
| `항` 타입 불일치 | 항이 1개면 object, 2개 이상이면 array로 옴 | MCP 서버에서 항상 array로 정규화 |
| `조문가지번호` | 6조의2 → 조문번호:"6" + 조문가지번호:"2" | get_law_article 파라미터에 sub_number 추가 |

### 구현 메모

- 법령 전문(`get_law_text`)은 분량이 매우 크다. 에이전트가 `search_law` → `get_law_article`로 좁혀 쓰도록 프롬프트에서 유도할 것
- MCP 서버는 raw JSON을 그대로 넘기지 말고, 조문·항·호·목을 정리된 텍스트 또는 정규화된 구조로 변환하여 반환할 것
- `ID`로 조회 시 `efYd`(시행일자) 불필요. `MST` 방식은 사용하지 않음
- 부칙·개정문은 에이전트에게 일반적으로 불필요. 기본 반환에서 제외하고 옵션으로만 제공

---

## 3. MCP 서버 B — 법령해석 (interpretation-mcp)

### 역할

키워드로 **lawquery MySQL DB**에서 법령해석례를 검색·반환한다.

### DB 정보

lawquery 프로젝트(`c:\projects\lawquery`)의 MySQL DB를 **직접 접속**한다.
lawquery 웹 앱을 경유하지 않는다.

```
DB:    ldb_i
Table: db_i
접속:  .env의 MYSQL_HOST / MYSQL_USER / MYSQL_PASSWORD / MYSQL_PORT 재활용
```

### DB 스키마 (db_i 테이블)

| 컬럼 | 설명 | 검색 대상 |
|------|------|-----------|
| `id` | PK | — |
| `구분` | 유권해석 / 비조치의견서 등 | 필터 |
| `분야` | 업무 분야 | 필터 |
| `제목` | 질의 제목 | 키워드 검색 |
| `일련번호` | 문서 번호 | 필터 |
| `회신일자` | 회신 날짜 | 날짜 필터 |
| `질의요지` | 질의 본문 | 키워드 검색 |
| `회답` | 회신 결론 | 키워드 검색 |
| `이유` | 회신 근거 | 키워드 검색 |

### 노출할 Tool 목록

```typescript
// Tool 1: 키워드 검색 (목록 반환)
// 에이전트가 관련 해석례 목록을 파악할 때 사용
search_interpretation(params: {
  query: string;        // 공백 기준 AND 검색
  category?: string;    // "법령해석" | "비조치의견서" | "현장건의 과제"
  limit?: number;       // 기본 20, 최대 50
}): InterpretationSummary[]
// 반환: [{ id, 구분, 분야, 제목, 일련번호, 회신일자 }, ...]

// Tool 2: 특정 해석례 상세 조회
// search 결과에서 id를 골라 전문 조회
get_interpretation(id: number): InterpretationDetail
// 반환: { id, 질의요지, 회답, 이유 }
```

### 검색 전략 메모

- 에이전트는 키워드를 한 번에 과하게 넣지 말고, 핵심어 2~3개부터 시작하여 결과가 적으면 키워드를 줄이는 방식으로 운용
- `search` 결과(목록)에서 제목을 보고 관련성 높은 것만 `get_detail`로 전문 조회 → 컨텍스트 낭비 방지
- `회답` + `이유` 필드가 실질적인 법적 판단을 담고 있음. 에이전트 프롬프트에서 이 두 필드에 집중하도록 안내할 것

---

## 4. MCP 서버 C — 내부 검토문서 (document-mcp)

### 역할

금융감독원 내부 검토문서를 **폴더명/파일명 기준으로 먼저 탐색**하고, 그다음 **특정 1건의 본문을 확인**한다.

이 MCP는 사람의 실제 업무 흐름과 동일하게 설계한다.

```
법령 확인
  → 법령해석 확인
    → Everything처럼 폴더명/파일명 후보 탐색
      → 그럴듯한 문서 1건을 열어 내용 확인
```

내부 검토문서는 법령이나 법령해석을 대체하는 1차 법적 근거가 아니다.  
법에 없는 검토 배경, 당시의 쟁점 정리, 과거 처리 흐름, 유사사례 문맥을 확인하는 보조 자료다.

### DB 정보

직접 구축한 MariaDB 문서 저장소를 직접 조회한다.

```
DB:    fss_document_db
Table: documents
접속:  ddbuser / 1226 / localhost:3306
```

### DB 스키마 (documents)

| 컬럼 | 설명 | 검색 대상 |
|------|------|-----------|
| `id` | PK | 상세 조회 키 |
| `directory` | 저장 폴더명 | 1단 검색 |
| `filename` | 파일명 | 1단 검색 |
| `extension` | 확장자 | 결과 표시 |
| `file_size` | 파일 크기 | 결과 표시 |
| `file_mtime` | 파일 수정시각 문자열 | 결과 표시 |
| `body_text` | 추출 본문 | 2단 상세 조회 |
| `parse_status` | success / error / skip | 기본적으로 success만 검색 |
| `error_msg` | 파싱 오류 메시지 | 상세 조회 시 표시 |
| `parsed_at` | DB 적재 시각 | 결과 정렬 |

### 노출할 Tool 목록

```typescript
// Tool 1: 폴더명/파일명 후보 검색
// 공백 기준 AND 검색, directory + filename만 조회
search_fss_documents(params: {
  query: string;
  limit?: number; // 기본 20, 최대 50
}): FssDocumentSummary[]
// 반환: [{ id, path, directory, filename, extension, file_size, file_mtime, parsed_at }, ...]

// Tool 2: 특정 문서 본문 조회
get_fss_document(id: number): FssDocumentDetail
// 반환: { id, path, directory, filename, extension, parse_status, body_text, ... }
```

### 운용 원칙

- 에이전트는 **법령 → 법령해석 → 내부 검토문서** 순으로 접근한다.
- 내부 검토문서는 `search_fss_documents`로 폴더명/파일명 후보를 먼저 좁힌다.
- 후보가 타당해 보일 때만 `get_fss_document`로 본문을 연다.
- 본문에서 얻은 정보는 배경, 과거 검토 포인트, 유사사례의 처리 흐름 확인에 사용한다.
- 내부 문서만으로 법적 결론을 확정하지 않는다.

---

## 5. 구현 방향

### 언어 및 프레임워크

```
언어: TypeScript (Node.js)
이유: lawquery와 동일 스택 → DB 접속 코드(DbContext) 재활용 가능
MCP SDK: @modelcontextprotocol/sdk
```

### 프로토콜 방식

```
로컬 개발: stdio (Claude Desktop에서 직접 MCP 서버 프로세스 실행)
프로덕션:  HTTP + SSE (서버 상시 구동, 여러 에이전트 인스턴스 공유)
```

### 디렉토리 구조 (제안)

```
sentinel/
└── mcp/
    ├── law-mcp/
    │   ├── src/
    │   │   ├── index.ts        ← MCP 서버 진입점
    │   │   ├── tools/
    │   │   │   ├── searchLawNames.ts
    │   │   │   ├── getLawText.ts
    │   │   │   └── getLawArticle.ts
    │   │   └── client/
    │   │       └── LawApiClient.ts   ← 국가법령정보 API HTTP 클라이언트
    │   └── package.json
    └── interpretation-mcp/
        ├── src/
        │   ├── index.ts
        │   ├── tools/
        │   │   ├── searchInterpretations.ts
        │   │   └── getInterpretationDetail.ts
        │   └── db/
        │       └── InterpretationDb.ts   ← lawquery DbContext 재활용 or 복사
        └── package.json
    └── document-mcp/
        ├── src/
        │   ├── index.ts
        │   ├── client/
        │   │   └── DocumentDbClient.ts
        │   └── types/
        │       └── index.ts
        └── package.json
```

### Claude Desktop 연결 설정 예시 (개발 검증용)

```json
// %APPDATA%\Claude\claude_desktop_config.json
{
  "mcpServers": {
    "law": {
      "command": "node",
      "args": ["C:/projects/sentinel/mcp/law-mcp/dist/index.js"],
      "env": {
        "LAW_OC": "YOUR_OC_KEY"
      }
    },
    "interpretation": {
      "command": "node",
      "args": ["C:/projects/sentinel/mcp/interpretation-mcp/dist/index.js"],
      "env": {
        "MYSQL_HOST": "localhost",
        "MYSQL_USER": "YOUR_DB_USER",
        "MYSQL_PASSWORD": "YOUR_DB_PASSWORD",
        "MYSQL_PORT": "3306"
      }
    },
    "document": {
      "command": "node",
      "args": ["C:/projects/sentinel/mcp/document-mcp/dist/index.js"],
      "env": {
        "MYSQL_HOST": "localhost",
        "MYSQL_PORT": "3306",
        "MYSQL_USER": "ddbuser",
        "MYSQL_PASSWORD": "1226",
        "DB_NAME": "fss_document_db",
        "TABLE_NAME": "documents"
      }
    }
  }
}
```

---

## 6. 검증 계획

P1 완료 기준: Claude Desktop에서 아래 흐름이 수동으로 동작할 것.

```
1. "전자금융거래법을 찾아줘"
   → law-mcp: search_law("전자금융거래법") → 법령ID 포함 목록 반환 확인

2. "방금 찾은 전자금융거래법 28조를 보여줘"
   → law-mcp: get_law_article(법령ID, 28) → 조문·항·호 반환 확인

3. "전자금융거래법 시행령도 찾아줘"
   → law-mcp: search_law("전자금융거래법 시행령") → 별도 법령ID 반환 확인
   (5단 각 tier가 독립 법령으로 조회되는지 검증)

4. "지급결제대행, 중계 키워드로 해석례를 찾아줘"
   → interpretation-mcp: search_interpretation 호출 → 목록 반환 확인

5. 목록에서 id 하나 골라 "이 해석례 전문을 보여줘"
   → interpretation-mcp: get_interpretation 호출 → 전문 반환 확인

6. "선불전자지급수단 발행 관련 내부 검토문서 후보를 찾아줘"
   → document-mcp: search_fss_documents 호출 → 폴더명/파일명 후보 목록 반환 확인

7. 후보 중 id 하나 골라 "이 내부 문서 본문을 보여줘"
   → document-mcp: get_fss_document 호출 → 메타데이터 + 본문 반환 확인
```

이 흐름이 Claude Desktop에서 수동으로 동작하면 P2(에이전트 루프)로 진행.

---

## 7. 미결정 사항

| 항목 | 상태 | 내용 |
|------|------|------|
| 법령정보 API 키 | ✅ 완료 | `LAW_OC=phw1985` (.env 설정됨) |
| MySQL 접속 정보 | ✅ 완료 | `ldbuser / localhost:3306` (.env 설정됨) |
| 내부 문서 DB 접속 정보 | ✅ 완료 | `ddbuser / localhost:3306 / fss_document_db` |
| MCP 서버 운영 방식 | 미결정 | 프로덕션에서 stdio vs HTTP SSE 결정 필요 |
| law-mcp 구현 | ✅ 완료 | `mcp/law-mcp/` — 빌드 및 API 호출 검증 완료 |
| document-mcp 구현 | ✅ 완료 | `mcp/document-mcp/` — 폴더명/파일명 검색 + 단건 본문 조회 |

---

*작성: 2026-04-19 | 연관: [CLAUDE.md](../CLAUDE.md)*
