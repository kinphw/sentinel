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
  '공백으로 구분된 키워드는 각각 AND 조건으로 처리됩니다 (예: "경제적 이익 카드" → 세 단어 모두 포함). ' +
  '제목·질의요지·회답·이유 전체를 대상으로 검색하며 결과 목록(id, 제목, 구분, 분야, 회신일자)을 반환합니다. ' +
  '전문은 id로 get_interpretation을 호출하세요.',
  {
    query: z.string().describe('검색 키워드 (예: "선불전자지급수단", "전자금융거래법 적용범위")'),
    category: z.enum(['법령해석', '비조치의견서', '현장건의 과제'])
      .optional()
      .describe('구분 필터: "법령해석" | "비조치의견서" | "현장건의 과제" (생략 시 전체)'),
    limit: z.number().int().min(1).max(50).default(20)
      .describe('반환할 최대 건수 (기본 20, 최대 50)'),
  },
  async ({ query, category, limit }) => {
    try {
      const results = await searchInterpretation(query, category, limit);
      if (results.length === 0) {
        return { content: [{ type: 'text', text: `"${query}"에 해당하는 결과를 찾을 수 없습니다.` }] };
      }
      const text = results.map(r =>
        `[id: ${r.id}] [${r.구분}] ${r.제목}\n  분야: ${r.분야} | 회신: ${r.회신일자} | 일련번호: ${r.일련번호}`
      ).join('\n\n');
      return { content: [{ type: 'text', text: `총 ${results.length}건\n\n${text}` }] };
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
