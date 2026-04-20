import { McpServer } from '@modelcontextprotocol/sdk/server/mcp.js';
import { StdioServerTransport } from '@modelcontextprotocol/sdk/server/stdio.js';
import { z } from 'zod';
import * as dotenv from 'dotenv';
import { fileURLToPath } from 'url';
import { dirname, resolve } from 'path';
import { getFssDocument, searchFssDocuments } from './client/DocumentDbClient.js';

const __dirname = dirname(fileURLToPath(import.meta.url));
dotenv.config({ path: resolve(__dirname, '../../../.env') });

const server = new McpServer({
  name: 'document-mcp',
  version: '1.0.0',
});

server.tool(
  'search_fss_documents',
  '금융감독원 내부 문서를 폴더명(directory)과 파일명(filename) 기준으로 검색합니다. ' +
  '공백으로 구분된 검색어는 각각 AND 조건으로 처리되며, 본문 내용은 검색하지 않습니다. ' +
  '사람이 Everything으로 후보 문서를 먼저 고르는 단계와 같은 용도이며, 결과의 id로 get_fss_document를 호출해 본문을 확인하세요.',
  {
    query: z.string().describe('폴더명/파일명 검색어 (예: "선불전자지급수단 발행", "간편송금 PG")'),
    limit: z.number().int().min(1).max(50).default(20)
      .describe('반환할 최대 건수 (기본 20, 최대 50)'),
  },
  async ({ query, limit }) => {
    try {
      const results = await searchFssDocuments(query, limit);
      if (results.length === 0) {
        return { content: [{ type: 'text', text: `"${query}"에 해당하는 내부 문서 후보를 찾을 수 없습니다.` }] };
      }

      const text = results.map(result => [
        `[id: ${result.id}] ${result.filename}`,
        `  path: ${result.path}`,
        `  extension: ${result.extension} | size: ${result.file_size} | mtime: ${result.file_mtime} | parsed_at: ${result.parsed_at}`,
      ].join('\n')).join('\n\n');

      return { content: [{ type: 'text', text: `총 ${results.length}건\n\n${text}` }] };
    } catch (error) {
      return { content: [{ type: 'text', text: `오류: ${(error as Error).message}` }], isError: true };
    }
  },
);

server.tool(
  'get_fss_document',
  'id로 금융감독원 내부 문서 1건의 메타데이터와 본문을 조회합니다. ' +
  'id는 search_fss_documents 결과에서 획득하세요. ' +
  '법령이나 법령해석을 대체하는 1차 법적 근거가 아니라, 과거 내부 검토 배경·유사 사안 처리방향을 확인하는 보조 자료입니다.',
  {
    id: z.number().int().positive().describe('문서 id (search_fss_documents 결과에서 획득)'),
  },
  async ({ id }) => {
    try {
      const result = await getFssDocument(id);
      if (!result) {
        return { content: [{ type: 'text', text: `id ${id}에 해당하는 내부 문서를 찾을 수 없습니다.` }] };
      }

      const text = [
        `# ${result.filename}`,
        `id: ${result.id} | extension: ${result.extension} | parse_status: ${result.parse_status}`,
        `path: ${result.path}`,
        `file_size: ${result.file_size} | file_mtime: ${result.file_mtime} | parsed_at: ${result.parsed_at}`,
        result.error_msg ? `error_msg: ${result.error_msg}` : '',
        '',
        '## 본문',
        result.body_text || '(본문 없음)',
      ].filter(Boolean).join('\n');

      return { content: [{ type: 'text', text }] };
    } catch (error) {
      return { content: [{ type: 'text', text: `오류: ${(error as Error).message}` }], isError: true };
    }
  },
);

const transport = new StdioServerTransport();
await server.connect(transport);
