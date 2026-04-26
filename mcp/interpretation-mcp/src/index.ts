import { McpServer } from '@modelcontextprotocol/sdk/server/mcp.js';
import { StdioServerTransport } from '@modelcontextprotocol/sdk/server/stdio.js';
import { z } from 'zod';
import * as dotenv from 'dotenv';
import { fileURLToPath } from 'url';
import { dirname, resolve } from 'path';
import { searchInterpretation, getInterpretation } from './client/InterpretationDbClient.js';

const __dirname = dirname(fileURLToPath(import.meta.url));
dotenv.config({ path: resolve(__dirname, '../../../.env') });

const server = new McpServer({
  name: 'interpretation-mcp',
  version: '1.0.0',
});

// --- Tool 1: 법령해석 검색 ---
server.tool(
  'search_interpretation',
  '키워드로 금감원 법령해석·비조치의견서·현장건의 과제를 검색합니다. ' +
  '공백으로 구분된 어절을 match 파라미터에 따라 AND 또는 OR로 결합합니다 (기본 AND). ' +
  '추천 전략: 최초 검색은 match="or"로 어절 2~4개를 넓게 던져 후보를 확보한 뒤, ' +
  '결과가 너무 많거나 부정확하면 match="and"로 어절을 추가해 좁힙니다. ' +
  '결과가 0건이면 어절을 더 짧게 쪼개거나 1개 어절만 사용해 재시도하세요. ' +
  '제목·질의요지·회답·이유 전체를 대상으로 검색하며 결과 목록(id, 제목, 구분, 분야, 회신일자)을 반환합니다. ' +
  '전문은 id로 get_interpretation을 호출하세요.',
  {
    query: z.string().describe('검색 키워드. 공백으로 어절 분리 (예: "선불전자지급수단", "선불 계좌 정보")'),
    category: z.enum(['법령해석', '비조치의견서', '현장건의 과제'])
      .optional()
      .describe('구분 필터: "법령해석" | "비조치의견서" | "현장건의 과제" (생략 시 전체)'),
    match: z.enum(['and', 'or']).default('and')
      .describe('어절 결합 방식. "or"=하나라도 포함하면 매칭(넓게), "and"=모두 포함해야 매칭(좁게). 최초 탐색은 "or" 권장'),
    limit: z.number().int().min(1).max(50).default(20)
      .describe('반환할 최대 건수 (기본 20, 최대 50)'),
  },
  async ({ query, category, match, limit }) => {
    try {
      const results = await searchInterpretation(query, category, limit, match);
      if (results.length === 0) {
        const hint = match === 'and'
          ? ' (어절을 줄이거나 match="or"로 재시도해 보세요.)'
          : ' (어절을 더 짧게 쪼개거나 1개 어절로 재시도해 보세요.)';
        return { content: [{ type: 'text', text: `"${query}" (match=${match})에 해당하는 결과를 찾을 수 없습니다.${hint}` }] };
      }
      const text = results.map(r =>
        `[id: ${r.id}] [${r.구분}] ${r.제목}\n  분야: ${r.분야} | 회신: ${r.회신일자} | 일련번호: ${r.일련번호}`
      ).join('\n\n');
      return { content: [{ type: 'text', text: `총 ${results.length}건 (match=${match})\n\n${text}` }] };
    } catch (e) {
      return { content: [{ type: 'text', text: `오류: ${(e as Error).message}` }], isError: true };
    }
  },
);

// --- Tool 2: 법령해석 전문 조회 ---
server.tool(
  'get_interpretation',
  'id로 법령해석·비조치의견서의 질의요지·회답·이유 전문을 조회합니다. ' +
  'id는 search_interpretation 결과에서 획득하세요.',
  {
    id: z.number().int().positive().describe('법령해석 id (search_interpretation 결과에서 획득)'),
  },
  async ({ id }) => {
    try {
      const result = await getInterpretation(id);
      if (!result) {
        return { content: [{ type: 'text', text: `id ${id}에 해당하는 항목을 찾을 수 없습니다.` }] };
      }
      const text = [
        `# ${result.제목}`,
        `[${result.구분}] 분야: ${result.분야} | 회신: ${result.회신일자} | 회신부서: ${result.회신부서} | 일련번호: ${result.일련번호}`,
        '',
        '## 질의요지',
        result.질의요지,
        '',
        '## 회답',
        result.회답,
        '',
        '## 이유',
        result.이유,
      ].join('\n');
      return { content: [{ type: 'text', text }] };
    } catch (e) {
      return { content: [{ type: 'text', text: `오류: ${(e as Error).message}` }], isError: true };
    }
  },
);

const transport = new StdioServerTransport();
await server.connect(transport);
