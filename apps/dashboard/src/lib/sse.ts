/**
 * A server-sent-events parser.
 *
 * The dashboard cannot use `EventSource`: a deployment with authentication
 * needs an `Authorization` header, which `EventSource` cannot send. So the
 * stream is read with `fetch` and framed here, using the field rules from the
 * HTML standard: lines are separated by LF, fields by the first colon, a
 * leading space after the colon is dropped, `data` fields accumulate, and a
 * blank line dispatches.
 */

export interface SseMessage {
  id?: string;
  event?: string;
  data: string;
  retry?: number;
}

export interface SseParseResult {
  messages: SseMessage[];
  /** Bytes that did not yet form a complete event; carry them into the next chunk. */
  rest: string;
}

export function parseSseChunk(buffer: string): SseParseResult {
  const messages: SseMessage[] = [];

  let cursor = 0;
  // Where the event block currently being parsed starts. An incomplete block is
  // returned whole, so the parser stays stateless and a split chunk is not lost.
  let blockStart = 0;
  let current: { id?: string; event?: string; data: string[]; retry?: number } | undefined;

  const flush = (): void => {
    // The standard dispatches only when the data buffer is non-empty, so
    // `event: x\ndata:\n\n` is not an event.
    if (!current || current.data.join('\n') === '') {
      current = undefined;
      return;
    }
    messages.push({
      ...(current.id === undefined ? {} : { id: current.id }),
      ...(current.event === undefined ? {} : { event: current.event }),
      ...(current.retry === undefined ? {} : { retry: current.retry }),
      data: current.data.join('\n'),
    });
    current = undefined;
  };

  while (cursor < buffer.length) {
    const newline = buffer.indexOf('\n', cursor);
    if (newline === -1) break;
    let line = buffer.slice(cursor, newline);
    cursor = newline + 1;
    if (line.endsWith('\r')) line = line.slice(0, -1);

    if (line === '') {
      flush();
      blockStart = cursor;
      continue;
    }
    if (line.startsWith(':')) continue;

    const colon = line.indexOf(':');
    const field = colon === -1 ? line : line.slice(0, colon);
    let value = colon === -1 ? '' : line.slice(colon + 1);
    if (value.startsWith(' ')) value = value.slice(1);

    if (field === 'data') {
      if (current === undefined) current = { data: [] };
      current.data.push(value);
      continue;
    }
    if (current === undefined) current = { data: [] };
    if (field === 'event') current.event = value;
    else if (field === 'id') current.id = value;
    else if (field === 'retry') {
      const parsed = Number(value);
      if (Number.isInteger(parsed) && parsed >= 0) current.retry = parsed;
    }
  }

  return { messages, rest: buffer.slice(blockStart) };
}

/** Read a `fetch` body of `text/event-stream` and yield each event. */
export async function readSseStream(
  body: ReadableStream<Uint8Array>,
  onMessage: (message: SseMessage) => void,
  options: { signal?: AbortSignal } = {},
): Promise<void> {
  const decoder = new TextDecoder();
  const reader = body.getReader();
  let buffer = '';
  try {
    for (;;) {
      if (options.signal?.aborted) return;
      const { done, value } = await reader.read();
      if (done) break;
      buffer += decoder.decode(value, { stream: true });
      const { messages, rest } = parseSseChunk(buffer);
      buffer = rest;
      for (const message of messages) {
        onMessage(message);
        if (options.signal?.aborted) return;
      }
    }
    // A stream that ends mid-event has still delivered a usable event.
    if (buffer.length > 0) {
      const { messages } = parseSseChunk(`${buffer}\n\n`);
      for (const message of messages) onMessage(message);
    }
  } finally {
    reader.releaseLock?.();
  }
}
