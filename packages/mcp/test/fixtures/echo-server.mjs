#!/usr/bin/env node
/**
 * A real MCP server speaking newline-delimited JSON-RPC over stdio.
 * Used by the stdio transport tests to prove the client works against an actual
 * child process rather than an in-process stub.
 */
import { createInterface } from 'node:readline';

const tools = [
  {
    name: 'add',
    description: 'Add two integers',
    inputSchema: {
      type: 'object',
      properties: { a: { type: 'integer' }, b: { type: 'integer' } },
      required: ['a', 'b'],
      additionalProperties: false,
    },
    annotations: { readOnlyHint: true },
  },
  {
    name: 'crash',
    description: 'Kill the server process',
    inputSchema: { type: 'object', properties: {} },
    annotations: { destructiveHint: true },
  },
];

process.stderr.write('echo-server starting\n');

const rl = createInterface({ input: process.stdin });
rl.on('line', (line) => {
  if (line.trim().length === 0) return;
  let message;
  try {
    message = JSON.parse(line);
  } catch {
    process.stderr.write('dropped a non-JSON line\n');
    return;
  }
  const respond = (result) => {
    if (message.id === undefined) return;
    process.stdout.write(`${JSON.stringify({ jsonrpc: '2.0', id: message.id, result })}\n`);
  };
  const fail = (code, text) => {
    if (message.id === undefined) return;
    process.stdout.write(`${JSON.stringify({ jsonrpc: '2.0', id: message.id, error: { code, message: text } })}\n`);
  };

  switch (message.method) {
    case 'initialize':
      respond({
        protocolVersion: message.params?.protocolVersion ?? '2025-06-18',
        capabilities: { tools: { listChanged: false }, resources: {}, prompts: {} },
        serverInfo: { name: 'echo-server', version: '0.1.0' },
        instructions: 'Reference MCP server used by the AgentOS test suite.',
      });
      break;
    case 'notifications/initialized':
      process.stderr.write('client initialized\n');
      break;
    case 'ping':
      respond({});
      break;
    case 'tools/list':
      respond({ tools });
      break;
    case 'tools/call': {
      const name = message.params?.name;
      const args = message.params?.arguments ?? {};
      if (name === 'add') {
        if (typeof args.a !== 'number' || typeof args.b !== 'number') {
          fail(-32602, 'a and b must be numbers');
          break;
        }
        respond({ content: [{ type: 'text', text: String(args.a + args.b) }], structuredContent: { sum: args.a + args.b } });
        break;
      }
      if (name === 'crash') {
        process.stderr.write('crashing on request\n');
        process.exit(9);
      }
      fail(-32601, `unknown tool ${name}`);
      break;
    }
    case 'resources/list':
      respond({ resources: [{ uri: 'echo://greeting', name: 'greeting', mimeType: 'text/plain' }] });
      break;
    case 'resources/read':
      respond({ contents: [{ uri: message.params?.uri ?? '', mimeType: 'text/plain', text: 'hello from a real process' }] });
      break;
    case 'prompts/list':
      respond({ prompts: [{ name: 'greet', arguments: [{ name: 'who', required: false }] }] });
      break;
    case 'prompts/get':
      respond({ messages: [{ role: 'user', content: { type: 'text', text: 'Greet the user' } }] });
      break;
    default:
      fail(-32601, `unknown method ${message.method}`);
  }
});

rl.on('close', () => process.exit(0));
