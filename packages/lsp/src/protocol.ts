/**
 * JSON-RPC over a stream, framed the way LSP frames it.
 *
 * This is about eighty lines, and the alternative was a dependency tree with a
 * dozen packages in it. The rest of this compiler argues against dependencies
 * nobody needs; the argument applies here too.
 */

export interface Message {
  jsonrpc: '2.0';
  id?: number | string | null;
  method?: string;
  params?: unknown;
  result?: unknown;
  error?: { code: number; message: string; data?: unknown };
}

/** LSP error codes this server can answer with. */
export const ErrorCodes = {
  parseError: -32700,
  invalidRequest: -32600,
  methodNotFound: -32601,
  internalError: -32603,
  serverNotInitialized: -32002,
  requestCancelled: -32800,
} as const;

/**
 * Reassembles messages from however the stream happened to break them up.
 *
 * A header can arrive split across two chunks, and a body can arrive with the
 * next message's header already glued to its end. Both happen in practice, and
 * both are silent corruption if the reader assumes one chunk is one message.
 */
export class MessageReader {
  private buffer = Buffer.alloc(0);

  /** Appends `chunk` and returns every complete message it now holds. */
  push(chunk: Buffer | string): Message[] {
    this.buffer = Buffer.concat([this.buffer, typeof chunk === 'string' ? Buffer.from(chunk, 'utf8') : chunk]);
    const messages: Message[] = [];

    for (;;) {
      const separator = this.buffer.indexOf('\r\n\r\n');
      if (separator < 0) break;

      const header = this.buffer.subarray(0, separator).toString('ascii');
      const length = contentLength(header);
      if (length === null) {
        // A header with no length is unrecoverable: there is no way to know
        // where the body ends, so the only safe move is to drop it.
        this.buffer = this.buffer.subarray(separator + 4);
        continue;
      }

      const start = separator + 4;
      if (this.buffer.length < start + length) break;

      const body = this.buffer.subarray(start, start + length).toString('utf8');
      this.buffer = this.buffer.subarray(start + length);
      try {
        messages.push(JSON.parse(body) as Message);
      } catch {
        // A malformed body is the client's problem to notice; dropping it keeps
        // the stream aligned, which is what lets the next message through.
      }
    }
    return messages;
  }
}

function contentLength(header: string): number | null {
  for (const line of header.split('\r\n')) {
    const match = /^content-length:\s*(\d+)$/i.exec(line.trim());
    if (match) return Number(match[1]);
  }
  return null;
}

export function encode(message: Message): string {
  const body = JSON.stringify(message);
  return `Content-Length: ${Buffer.byteLength(body, 'utf8')}\r\n\r\n${body}`;
}
