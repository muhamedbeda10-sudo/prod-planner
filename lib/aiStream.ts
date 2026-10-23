/** NDJSON may split inside a UTF-8 character or finish without a newline. */
export async function readAiStream(body: ReadableStream<Uint8Array>, onEvent: (event: { type: string; [key: string]: unknown }) => void): Promise<void> {
  const reader = body.getReader();
  const decoder = new TextDecoder();
  let buffer = "";
  let completed = false;
  const consume = (line: string) => {
    if (!line.trim()) return;
    const event: unknown = JSON.parse(line);
    if (!event || typeof event !== "object" || Array.isArray(event) || typeof (event as { type?: unknown }).type !== "string") throw new Error("The answer stream could not be read. Reopen the chat to check what was saved.");
    if (completed) throw new Error("Unexpected data after the answer finished.");
    onEvent(event as { type: string; [key: string]: unknown });
    if ((event as { type: string }).type === "done") completed = true;
  };
  try {
    for (;;) {
      const { value, done } = await reader.read();
      buffer += done ? decoder.decode() : decoder.decode(value, { stream: true });
      let nl: number;
      while ((nl = buffer.indexOf("\n")) !== -1) {
        consume(buffer.slice(0, nl));
        buffer = buffer.slice(nl + 1);
      }
      if (buffer.length > 1_000_000) throw new Error("The answer stream was too large to read.");
      if (done) break;
    }
    consume(buffer);
    if (!completed) throw new Error("The connection ended before the answer finished. Reopen the chat to check what was saved before sending anything again.");
  } finally {
    reader.releaseLock();
  }
}
