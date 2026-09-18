import { describe, expect, it } from 'vitest';
import { parseSseChunk, readSseStream } from '../src/lib/sse.js';

describe('server-sent event framing', () => {
  it('dispatches an event only on a blank line', () => {
    const partial = parseSseChunk('event: run.created\ndata: {"a":1}\n');
    expect(partial.messages).toHaveLength(0);
    expect(partial.rest).toBe('event: run.created\ndata: {"a":1}\n');

    const complete = parseSseChunk(`${partial.rest}\n`);
    expect(complete.messages).toEqual([{ event: 'run.created', data: '{"a":1}' }]);
    expect(complete.rest).toBe('');
  });

  it('carries the id, the event name and every data line', () => {
    const { messages } = parseSseChunk('id: 42\nevent: stream.end\ndata: line one\ndata: line two\n\n');
    expect(messages).toEqual([{ id: '42', event: 'stream.end', data: 'line one\nline two' }]);
  });

  it('ignores comments and heartbeats, and tolerates CRLF', () => {
    const { messages } = parseSseChunk(': keep-alive\r\n\r\nid: 1\r\ndata: x\r\n\r\n');
    expect(messages).toEqual([{ id: '1', data: 'x' }]);
  });

  it('drops a field-only event, as the standard requires', () => {
    const { messages } = parseSseChunk('event: nothing\ndata:\n\n');
    expect(messages).toHaveLength(0);
  });

  it('parses a retry field and rejects a nonsense one', () => {
    expect(parseSseChunk('retry: 2500\ndata: x\n\n').messages[0]?.retry).toBe(2500);
    expect(parseSseChunk('retry: soon\ndata: x\n\n').messages[0]?.retry).toBeUndefined();
  });

  it('reads a fetch body chunk by chunk without losing a split event', async () => {
    const encoder = new TextEncoder();
    const chunks = ['data: {"n":', '1}\n\neve', 'nt: x\ndata: 2\n\n'];
    const body = new ReadableStream<Uint8Array>({
      start(controller) {
        for (const chunk of chunks) controller.enqueue(encoder.encode(chunk));
        controller.close();
      },
    });
    const seen: string[] = [];
    await readSseStream(body, (message) => seen.push(`${message.event ?? 'message'}=${message.data}`));
    expect(seen).toEqual(['message={"n":1}', 'x=2']);
  });
});
