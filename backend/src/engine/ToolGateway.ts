import { Client } from '@modelcontextprotocol/sdk/client/index.js';
import { StdioClientTransport } from '@modelcontextprotocol/sdk/client/stdio.js';
import { readFile } from 'fs/promises';
import { resolve, dirname } from 'path';
import { fileURLToPath } from 'url';
import type Anthropic from '@anthropic-ai/sdk';

const __dirname = dirname(fileURLToPath(import.meta.url));
const MCP_CONFIG_PATH = resolve(__dirname, '../../../.mcp.json');

interface McpServerConfig {
  command: string;
  args: string[];
  env?: Record<string, string>;
}

interface McpConfig {
  mcpServers: Record<string, McpServerConfig>;
}

interface ConnectedServer {
  name: string;
  client: Client;
  toolNames: string[];
  tools: Anthropic.Tool[];
}

export class ToolGateway {
  private servers: ConnectedServer[] = [];
  private toolDefinitions: Anthropic.Tool[] = [];
  private toolResultCache = new Map<string, string>();

  async connect(): Promise<void> {
    const raw = await readFile(MCP_CONFIG_PATH, 'utf-8');
    const config: McpConfig = JSON.parse(raw);

    for (const [serverName, cfg] of Object.entries(config.mcpServers)) {
      const transport = new StdioClientTransport({
        command: cfg.command,
        args: cfg.args,
        env: { ...(process.env as Record<string, string>), ...(cfg.env ?? {}) },
      });

      const client = new Client({ name: 'sentinel-backend', version: '0.1.0' });

      try {
        await client.connect(transport);
        const { tools } = await client.listTools();
        const toolDefinitions = tools.map(tool => ({
          name: tool.name,
          description: tool.description ?? '',
          input_schema: tool.inputSchema as Anthropic.Tool['input_schema'],
        }));
        this.servers.push({
          name: serverName,
          client,
          toolNames: toolDefinitions.map(t => t.name),
          tools: toolDefinitions,
        });
        console.log(`[ToolGateway] ${serverName}: ${tools.length}개 도구 연결됨`);
      } catch (e) {
        console.error(`[ToolGateway] ${serverName} 연결 실패: ${(e as Error).message}`);
      }
    }

    this.toolDefinitions = this.servers.flatMap(server => server.tools);
  }

  async listTools(): Promise<Anthropic.Tool[]> {
    return this.toolDefinitions.map(tool => ({ ...tool }));
  }

  async callTool(name: string, args: Record<string, unknown>): Promise<string> {
    const server = this.servers.find(s => s.toolNames.includes(name));
    if (!server) throw new Error(`도구를 찾을 수 없습니다: ${name}`);

    const cacheKey = `${name}:${stableStringify(args)}`;
    const cached = this.toolResultCache.get(cacheKey);
    if (cached !== undefined) return cached;

    const result = await server.client.callTool({ name, arguments: args });
    const texts = (result.content as Array<{ type: string; text?: string }>)
      .filter(c => c.type === 'text')
      .map(c => c.text ?? '')
      .join('\n');
    this.toolResultCache.set(cacheKey, texts);
    return texts;
  }

  async disconnect(): Promise<void> {
    for (const server of this.servers) {
      try { await server.client.close(); } catch { /* ignore */ }
    }
    this.servers = [];
    this.toolDefinitions = [];
    this.toolResultCache.clear();
  }
}

function stableStringify(value: unknown): string {
  if (Array.isArray(value)) {
    return `[${value.map(stableStringify).join(',')}]`;
  }

  if (value && typeof value === 'object') {
    const entries = Object.entries(value as Record<string, unknown>)
      .sort(([a], [b]) => a.localeCompare(b))
      .map(([key, nestedValue]) => `${JSON.stringify(key)}:${stableStringify(nestedValue)}`);
    return `{${entries.join(',')}}`;
  }

  return JSON.stringify(value);
}
