import { AppError } from "../../platform/errors";
import type { Model, ProviderName } from "../policy";
import { type PreparedRequest, toolArguments } from "./protocol";

/** Local admission estimate. It is a hold, not a provider token count. */
export interface InputReservation {
  inputTokens: number;
  searchInputTokens: number;
  countImages: boolean;
}

const textFactors: Partial<Record<ProviderName, number>> = {
  openai: 2,
  anthropic: 2,
  google: 2,
  openrouter: 2,
  deepseek: 2,
  typesafe: 1,
};
const encoder = new TextEncoder();
const imageData = /^data:image\/(png|jpeg);base64,([A-Za-z0-9+/]+={0,2})$/i;
const base64 = /^[A-Za-z0-9+/]+={0,2}$/;

function embeddedImage(value: unknown): boolean {
  return typeof value === "string" && imageData.test(value);
}

function mediaKind(provider: ProviderName, body: Record<string, unknown>): "text" | "image" {
  if (provider === "typesafe") return "text"; // State and questions are evaluated as JSON text.
  let image = false;
  let visited = 0;
  const walk = (value: unknown, depth = 0, dataOnly = false): void => {
    if (++visited > 100_000 || depth > 40) throw new AppError("request_structure_limit", 413);
    if (Array.isArray(value)) {
      for (const part of value) walk(part, depth + 1, dataOnly);
      return;
    }
    if (!value || typeof value !== "object") return;
    const record = value as Record<string, unknown>;
    if (dataOnly) return;
    const type = record.type;
    if (type === "input_image") {
      if (!embeddedImage(record.image_url)) throw new AppError("unbounded_media_source");
      image = true;
    } else if (type === "image_url") {
      const url =
        typeof record.image_url === "string"
          ? record.image_url
          : (record.image_url as Record<string, unknown> | undefined)?.url;
      if (!embeddedImage(url)) throw new AppError("unbounded_media_source");
      image = true;
    } else if (type === "image") {
      const source = record.source as Record<string, unknown> | undefined;
      if (
        source?.type !== "base64" ||
        !["image/png", "image/jpeg"].includes(String(source.media_type)) ||
        typeof source.data !== "string" ||
        !base64.test(source.data)
      )
        throw new AppError("unbounded_media_source");
      image = true;
    } else if (typeof type === "string" && /(audio|video|file|document|image)/i.test(type)) {
      throw new AppError("unsupported_media");
    }
    for (const [key, part] of Object.entries(record)) {
      if (
        ["fileData", "file_data", "file_id", "fileId", "input_audio", "audio", "video"].includes(
          key,
        )
      )
        throw new AppError("unsupported_media");
      if (key === "inlineData" || key === "inline_data") {
        const inline = part as Record<string, unknown> | undefined;
        if (
          !inline ||
          !["image/png", "image/jpeg"].includes(String(inline.mimeType ?? inline.mime_type)) ||
          typeof inline.data !== "string" ||
          !base64.test(inline.data)
        )
          throw new AppError("unbounded_media_source");
        image = true;
        continue;
      }
      if (key === "image_url" && type !== "input_image" && type !== "image_url")
        throw new AppError("unsupported_media");
      walk(
        part,
        depth + 1,
        ["parameters", "input_schema", "schema", "response_format"].includes(key) ||
          toolArguments(record, key),
      );
    }
  };
  walk(body);
  return image ? "image" : "text";
}

function structureCount(value: unknown): number {
  let count = 0;
  const walk = (part: unknown, depth = 0) => {
    if (++count > 100_000 || depth > 40) throw new AppError("request_structure_limit", 413);
    if (Array.isArray(part)) for (const item of part) walk(item, depth + 1);
    else if (part && typeof part === "object")
      for (const item of Object.values(part)) walk(item, depth + 1);
  };
  walk(value);
  return count;
}

/**
 * Uses the whole request, including system text, history and tool schemas. Text factors
 * are deliberately conservative admission constants, not provider tokenizer guarantees.
 * Media uses the full model context ceiling because image tokenization is model dependent.
 * Settlement must still use actual provider usage and absorb any overrun beyond the hold.
 */
export function reserveInput(model: Model, prepared: PreparedRequest): InputReservation {
  if (
    !Number.isSafeInteger(model.contextWindow) ||
    model.contextWindow < 1 ||
    !Number.isSafeInteger(prepared.searchCalls) ||
    prepared.searchCalls < 0 ||
    prepared.searchCalls > model.maxSearchCalls
  )
    throw new AppError("invalid_model_configuration", 503);
  const kind = mediaKind(model.provider, prepared.body);
  if (kind === "image" && !model.supports.vision) throw new AppError("vision_not_supported");
  let json: string;
  try {
    json = JSON.stringify(prepared.body);
  } catch {
    throw new AppError("invalid_request");
  }
  if (typeof json !== "string") throw new AppError("invalid_request");
  const bytes = encoder.encode(json).length;
  if (bytes > 8 * 1024 * 1024 + 16_384) throw new AppError("body_too_large", 413);
  let inputTokens = model.contextWindow;
  if (kind === "text") {
    const factor = textFactors[model.provider];
    if (factor !== undefined) {
      const nodes = structureCount(prepared.body);
      const margin =
        model.provider === "typesafe"
          ? 512
          : Math.min(8192, Math.max(256, Math.ceil(model.contextWindow / 100)));
      const perNode = model.provider === "typesafe" ? 16 : 64;
      inputTokens = bytes * factor + nodes * perNode + margin;
      if (inputTokens + prepared.outputLimit > model.contextWindow)
        throw new AppError("context_limit_exceeded", 400);
    }
  }
  return {
    inputTokens,
    searchInputTokens: prepared.searchCalls * model.contextWindow,
    countImages: kind === "image" && ["openai", "anthropic", "google"].includes(model.provider),
  };
}
