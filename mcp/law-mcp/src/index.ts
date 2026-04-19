import { McpServer } from '@modelcontextprotocol/sdk/server/mcp.js';
import { StdioServerTransport } from '@modelcontextprotocol/sdk/server/stdio.js';
import { z } from 'zod';
import * as dotenv from 'dotenv';
import { fileURLToPath } from 'url';
import { dirname, resolve } from 'path';
import { searchLaw, getLawText, getLawArticle, getLawHierarchy, getAdminRuleText } from './client/LawApiClient.js';
import type { LawArticle, LawFullText, LawHierarchy } from './types/index.js';

// sentinel 루트의 .env 로드 (Claude Desktop 실행 시에는 env로 주입되므로 무시됨)
const __dirname = dirname(fileURLToPath(import.meta.url));
dotenv.config({ path: resolve(__dirname, '../../../.env') });

const server = new McpServer({
  name: 'law-mcp',
  version: '1.0.0',
});

// --- Tool 1: 법령 검색 ---
server.tool(
  'search_law',
  '법령명으로 현행 법령을 검색하여 법령ID 목록을 반환합니다. ' +
  '법령ID는 get_law_text 또는 get_law_article 호출에 사용합니다.',
  { query: z.string().describe('검색할 법령명 (예: "전자금융거래법", "전자금융거래법 시행령")') },
  async ({ query }) => {
    try {
      const results = await searchLaw(query);
      if (results.length === 0) {
        return { content: [{ type: 'text', text: `"${query}"에 해당하는 현행 법령을 찾을 수 없습니다.` }] };
      }
      const text = results.map(r =>
        `[법령ID: ${r.법령ID}] ${r.법령명한글} (${r.법령구분명}) | 시행일: ${r.시행일자} | 소관: ${r.소관부처명}`
      ).join('\n');
      return { content: [{ type: 'text', text }] };
    } catch (e) {
      return { content: [{ type: 'text', text: `오류: ${(e as Error).message}` }], isError: true };
    }
  },
);

// --- Tool 2: 법령체계도 조회 ---
server.tool(
  'get_law_hierarchy',
  '법령ID로 법령체계도를 조회합니다. ' +
  '이 도구는 법률·시행령·시행규칙의 법령ID와 각 단계에 연결된 행정규칙(고시·세칙 등) 목록을 반환합니다. ' +
  '하위규정(시행령·시행규칙·행정규칙) 연결 관계 확인용입니다. ' +
  '법령 내부 조문 목차 확인은 get_law_toc를 사용하세요. ' +
  '행정규칙 본문은 행정규칙일련번호로 get_admin_rule_text를 호출하세요.',
  { law_id: z.string().describe('법령ID (search_law 결과에서 획득, 예: "010199")') },
  async ({ law_id }) => {
    try {
      const h: LawHierarchy = await getLawHierarchy(law_id);
      const lines: string[] = [`# ${h.법령명} 법령체계도 (법령ID: ${h.법령ID})`, ''];

      const formatTier = (label: string, tier: LawHierarchy['법률']) => {
        if (!tier) return;
        lines.push(`## ${label}: ${tier.법령명} (법령ID: ${tier.법령ID}) | 시행: ${tier.시행일자}`);
        if (tier.행정규칙목록.length > 0) {
          lines.push('  행정규칙:');
          for (const r of tier.행정규칙목록) {
            lines.push(`    - [${r.종류}] ${r.행정규칙명} (일련번호: ${r.행정규칙일련번호}) | 시행: ${r.시행일자}`);
          }
        }
        lines.push('');
      };

      formatTier('법률', h.법률);
      formatTier('시행령', h.시행령);
      formatTier('시행규칙', h.시행규칙);

      return { content: [{ type: 'text', text: lines.join('\n') }] };
    } catch (e) {
      return { content: [{ type: 'text', text: `오류: ${(e as Error).message}` }], isError: true };
    }
  },
);

// --- Tool 3: 행정규칙 본문 조회 ---
server.tool(
  'get_admin_rule_text',
  '행정규칙 일련번호로 행정규칙(고시·세칙·훈령 등) 본문을 조회합니다. ' +
  '일련번호는 get_law_hierarchy 결과의 "일련번호:" 값을 사용하세요.',
  { rule_serial_no: z.string().describe('행정규칙 일련번호 (예: "2100000274812")') },
  async ({ rule_serial_no }) => {
    try {
      const result = await getAdminRuleText(rule_serial_no);
      const header = [
        `# ${result.행정규칙명} (${result.행정규칙종류})`,
        `일련번호: ${result.행정규칙일련번호} | 발령: ${result.발령일자} | 시행: ${result.시행일자} | 소관: ${result.소관부처명}`,
        '',
      ].join('\n');
      return { content: [{ type: 'text', text: header + result.조문내용 }] };
    } catch (e) {
      return { content: [{ type: 'text', text: `오류: ${(e as Error).message}` }], isError: true };
    }
  },
);

// --- Tool 4: 행정규칙 특정 조문 조회 ---
server.tool(
  'get_admin_rule_article',
  '행정규칙 일련번호와 조번호로 특정 조문만 조회합니다. ' +
  '전문(get_admin_rule_text) 대신 이 도구를 우선 사용하세요. ' +
  '"6조의2"는 article_number=6, sub_number=2로 입력합니다. ' +
  '일련번호는 get_law_hierarchy 결과에서 획득하세요.',
  {
    rule_serial_no: z.string().describe('행정규칙 일련번호 (예: "2100000274812")'),
    article_number: z.number().int().positive().describe('조번호 (예: 25)'),
    sub_number: z.number().int().min(0).default(0).describe('가지번호 (예: 6조의2이면 2, 기본값 0)'),
  },
  async ({ rule_serial_no, article_number, sub_number }) => {
    try {
      const res = await (await import('axios')).default.get('http://www.law.go.kr/DRF/lawService.do', {
        params: { OC: process.env.LAW_OC, target: 'admrul', ID: rule_serial_no, type: 'JSON' },
      });
      const svc = res.data?.AdmRulService;
      if (!svc) throw new Error(`행정규칙 일련번호 ${rule_serial_no}를 찾을 수 없습니다.`);

      const lines: string[] = Array.isArray(svc.조문내용) ? svc.조문내용: [svc.조문내용];
      const articlePattern = sub_number > 0
        ? new RegExp(`^제${article_number}조의${sub_number}(?:\\(|\\s|$)`)
        : new RegExp(`^제${article_number}조(?!의)(?:\\(|\\s|$)`);
      const nextArticlePattern = /^제\d+조/;

      const startIdx = lines.findIndex(line => articlePattern.test(String(line)));
      if (startIdx === -1) {
        const label = sub_number > 0 ? `제${article_number}조의${sub_number}` : `제${article_number}조`;
        return { content: [{ type: 'text', text: `${label}를 찾을 수 없습니다.` }] };
      }

      const articleLines: string[] = [];
      for (let i = startIdx; i < lines.length; i++) {
        if (i > startIdx && nextArticlePattern.test(String(lines[i]))) break;
        articleLines.push(String(lines[i]));
      }

      const info = svc.행정규칙기본정보 ?? {};
      const header = `[${info.행정규칙명 ?? ''} | 일련번호: ${rule_serial_no}]\n\n`;
      return { content: [{ type: 'text', text: header + articleLines.join('\n') }] };
    } catch (e) {
      return { content: [{ type: 'text', text: `오류: ${(e as Error).message}` }], isError: true };
    }
  },
);

// --- Tool 5: 법령 전문 조회 ---
server.tool(
  'get_law_text',
  '법령ID로 현행 법령의 전체 조문을 조회합니다. ' +
  '분량이 크므로 특정 조문만 필요한 경우 get_law_article을 사용하세요.',
  { law_id: z.string().describe('법령ID (search_law 결과에서 획득, 예: "010199")') },
  async ({ law_id }) => {
    try {
      const result: LawFullText = await getLawText(law_id);
      const lines: string[] = [
        `# ${result.법령명}`,
        `법령ID: ${result.법령ID} | 시행일: ${result.시행일자} | 소관: ${result.소관부처명}`,
        '',
      ];
      for (const article of result.조문목록) {
        lines.push(formatArticle(article));
      }
      return { content: [{ type: 'text', text: lines.join('\n') }] };
    } catch (e) {
      return { content: [{ type: 'text', text: `오류: ${(e as Error).message}` }], isError: true };
    }
  },
);

// --- Tool 5: 특정 조문 조회 ---
server.tool(
  'get_law_article',
  '법령ID와 조번호로 특정 조문을 상세 조회합니다. ' +
  '"6조의2"는 article_number=6, sub_number=2로 입력합니다.',
  {
    law_id: z.string().describe('법령ID (예: "010199")'),
    article_number: z.number().int().positive().describe('조번호 (예: 28)'),
    sub_number: z.number().int().min(0).default(0).describe('가지번호 (예: 6조의2이면 2, 기본값 0)'),
  },
  async ({ law_id, article_number, sub_number }) => {
    try {
      const result = await getLawArticle(law_id, article_number, sub_number);
      if (!result) {
        const label = sub_number > 0 ? `${article_number}조의${sub_number}` : `${article_number}조`;
        return { content: [{ type: 'text', text: `${label}를 찾을 수 없습니다.` }] };
      }
      return { content: [{ type: 'text', text: formatArticle(result) }] };
    } catch (e) {
      return { content: [{ type: 'text', text: `오류: ${(e as Error).message}` }], isError: true };
    }
  },
);

// --- Tool 6: 행정규칙 조문 목차 조회 ---
server.tool(
  'get_admin_rule_toc',
  '행정규칙 일련번호로 행정규칙의 조문 번호·제목 목차만 조회합니다. ' +
  '조문 내용은 포함하지 않아 가볍습니다. ' +
  '목차를 보고 필요한 내용을 파악한 뒤 get_admin_rule_text로 전문을 조회하세요. ' +
  '일련번호는 get_law_hierarchy 결과에서 획득하세요.',
  { rule_serial_no: z.string().describe('행정규칙 일련번호 (예: "2100000274812")') },
  async ({ rule_serial_no }) => {
    try {
      const res = await (await import('axios')).default.get('http://www.law.go.kr/DRF/lawService.do', {
        params: { OC: process.env.LAW_OC, target: 'admrul', ID: rule_serial_no, type: 'JSON' },
      });
      const svc = res.data?.AdmRulService;
      if (!svc) throw new Error(`행정규칙 일련번호 ${rule_serial_no}를 찾을 수 없습니다.`);

      const info = svc.행정규칙기본정보 ?? {};
      const lines: string[] = (Array.isArray(svc.조문내용) ? svc.조문내용 : [svc.조문내용])
        .filter((line: string) => /^제\d+조/.test(String(line)));

      const header = [
        `# ${info.행정규칙명 ?? ''} 조문 목차`,
        `일련번호: ${rule_serial_no} | 시행: ${info.시행일자 ?? ''} | 소관: ${info.소관부처명 ?? ''}`,
        '',
      ].join('\n');

      const toc = lines
        .map((line: string) => {
          const m = line.match(/^(제\d+조(?:의\d+)?(?:\([^)]+\))?)/);
          return m ? m[1] : line.slice(0, 60);
        })
        .join('\n');

      return { content: [{ type: 'text', text: header + toc }] };
    } catch (e) {
      return { content: [{ type: 'text', text: `오류: ${(e as Error).message}` }], isError: true };
    }
  },
);

// --- Tool 7: 법령 조문 목차 조회 ---
server.tool(
  'get_law_toc',
  '법령ID로 법령의 조문 번호와 제목 목록(목차)만 조회합니다. ' +
  '조문 내용은 포함하지 않아 가볍습니다. ' +
  '목차를 보고 필요한 조문 번호를 파악한 뒤 get_law_article로 해당 조문만 조회하세요.',
  { law_id: z.string().describe('법령ID (search_law 결과에서 획득, 예: "010199")') },
  async ({ law_id }) => {
    try {
      const result: LawFullText = await getLawText(law_id);
      const lines: string[] = [
        `# ${result.법령명} 조문 목차`,
        `법령ID: ${result.법령ID} | 시행일: ${result.시행일자} | 소관: ${result.소관부처명}`,
        '',
      ];
      for (const article of result.조문목록) {
        const title = article.조제목 ? `(${article.조제목})` : '';
        lines.push(`제${article.조번호}조${title}`);
      }
      return { content: [{ type: 'text', text: lines.join('\n') }] };
    } catch (e) {
      return { content: [{ type: 'text', text: `오류: ${(e as Error).message}` }], isError: true };
    }
  },
);

// --- 조문 텍스트 포매터 ---
function formatArticle(article: LawArticle): string {
  const lines: string[] = [`제${article.조번호}조${article.조제목 ? `(${article.조제목})` : ''}`];
  if (article.조문내용) lines.push(article.조문내용);

  for (const hang of article.항목록) {
    if (hang.항내용) lines.push(`  ${hang.항내용}`);
    for (const ho of hang.호목록) {
      if (ho.호내용) lines.push(`    ${ho.호내용}`);
      for (const mok of ho.목목록) {
        if (mok.목내용) lines.push(`      ${mok.목내용}`);
      }
    }
  }
  return lines.join('\n');
}

// --- 서버 시작 ---
const transport = new StdioServerTransport();
await server.connect(transport);
