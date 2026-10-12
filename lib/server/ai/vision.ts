import "server-only";
import Anthropic from "@anthropic-ai/sdk";
import { aiModel } from "@/lib/domain/ai";
import type { SeenImageType } from "@/lib/domain/aiFiles";
import type { MeasureSeen } from "./files";

// A photo or a PDF is measured by the model's own token count before it is
// kept: the count reads the file exactly as a question would send it, so a
// file the model refuses (damaged, a PDF past its page limit, a picture it
// cannot decode) is refused at the paperclip — never in the middle of a chat,
// where it would be refused again with every later question. The count is
// free. A count that could not be made (the network, a busy API) does not
// hold the file back: the magic-byte check has passed, and the chat keeps
// the question without the file should the model refuse it after all.

export function seenMeasurer(apiKey: string, model: string): MeasureSeen {
  const client = new Anthropic({ apiKey, maxRetries: 1, timeout: 30_000 });
  return async (f) => {
    const data = Buffer.from(f.data).toString("base64");
    const block =
      f.kind === "image"
        ? ({ type: "image", source: { type: "base64", media_type: f.type as SeenImageType, data } } as const)
        : ({ type: "document", source: { type: "base64", media_type: "application/pdf", data } } as const);
    try {
      const r = await client.messages.countTokens({ model: aiModel(model).id, messages: [{ role: "user", content: [block, { type: "text", text: "." }] }] });
      return { ok: true, tokens: r.input_tokens };
    } catch (e) {
      if (e instanceof Anthropic.BadRequestError) {
        const inner = (e.error as { error?: { message?: string } } | undefined)?.error?.message;
        return { ok: false, error: inner ?? e.message };
      }
      console.error("AI: could not measure an attached file", e);
      return { ok: true, tokens: null };
    }
  };
}
