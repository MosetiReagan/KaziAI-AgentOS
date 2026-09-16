/**
 * A real HTTP server that speaks the OpenAI chat-completions wire format.
 *
 * Tests point an `openai-compatible` provider at it, so provider integration is
 * exercised over HTTP rather than by stubbing a function. The script of turns
 * is read from the file named by OPENAI_SCRIPT; every request consumes one turn.
 */
import { createServer } from 'node:http';
import { readFileSync } from 'node:fs';

const scriptPath = process.env['OPENAI_SCRIPT'];
const script = scriptPath ? JSON.parse(readFileSync(scriptPath, 'utf8')) : [];
let cursor = 0;
const requests = [];

const server = createServer((request, response) => {
  let body = '';
  request.on('data', (chunk) => {
    body += chunk;
  });
  request.on('end', () => {
    if (request.url === '/requests') {
      response.writeHead(200, { 'content-type': 'application/json' });
      response.end(JSON.stringify(requests));
      return;
    }
    if (request.url === '/reset') {
      cursor = 0;
      requests.length = 0;
      response.writeHead(200, { 'content-type': 'application/json' });
      response.end('{"ok":true}');
      return;
    }
    if (!request.url.endsWith('/chat/completions')) {
      response.writeHead(404, { 'content-type': 'application/json' });
      response.end('{"error":{"message":"not found"}}');
      return;
    }
    let payload;
    try {
      payload = JSON.parse(body);
    } catch {
      payload = {};
    }
    requests.push({
      url: request.url,
      model: payload.model,
      messages: payload.messages,
      tools: payload.tools,
    });

    const turn = script[Math.min(cursor, script.length - 1)] ?? { content: 'done' };
    cursor += 1;
    if (turn.status && turn.status >= 400) {
      response.writeHead(turn.status, { 'content-type': 'application/json' });
      response.end(JSON.stringify({ error: { message: turn.error ?? 'upstream failure' } }));
      return;
    }

    const message = { role: 'assistant', content: turn.content ?? null };
    if (turn.toolCalls) {
      message.tool_calls = turn.toolCalls.map((call, index) => ({
        id: call.id ?? `call_${cursor}_${index}`,
        type: 'function',
        function: { name: call.name, arguments: JSON.stringify(call.arguments ?? {}) },
      }));
    }
    response.writeHead(200, { 'content-type': 'application/json' });
    response.end(
      JSON.stringify({
        id: `chatcmpl_${cursor}`,
        model: payload.model ?? 'stub',
        choices: [{ index: 0, message, finish_reason: turn.toolCalls ? 'tool_calls' : 'stop' }],
        usage: turn.usage ?? { prompt_tokens: 12, completion_tokens: 7, total_tokens: 19 },
      }),
    );
  });
});

const port = Number(process.env['PORT'] ?? 0);
server.listen(port, '127.0.0.1', () => {
  const address = server.address();
  process.stdout.write(
    `${JSON.stringify({ port: typeof address === 'object' && address ? address.port : port })}\n`,
  );
});

const shutdown = () => server.close(() => process.exit(0));
process.on('SIGTERM', shutdown);
process.on('SIGINT', shutdown);
