import { createHmac } from "node:crypto";
import { AppError } from "../../platform/errors";
import type { Model, ProviderName } from "../policy";

type ObjectValue = Record<string, unknown>;
export function object(value: unknown): ObjectValue {
  if (!value || typeof value !== "object" || Array.isArray(value))
    throw new AppError("invalid_request");
  return value as ObjectValue;
}
const allowed: Record<ProviderName, Set<string>> = {
  openai: new Set([
    "model",
    "input",
    "instructions",
    "tools",
    "tool_choice",
    "parallel_tool_calls",
    "include",
    "reasoning",
    "text",
    "temperature",
    "top_p",
    "truncation",
    "max_output_tokens",
    "max_tool_calls",
    "stream",
    "store",
    "user",
    "metadata",
    "safety_identifier",
    "prompt_cache_key",
    "prompt_cache_retention",
    "prompt_cache_options",
    "service_tier",
    "background",
    "previous_response_id",
    "conversation",
    "stream_options",
  ]),
  anthropic: new Set([
    "model",
    "messages",
    "system",
    "tools",
    "tool_choice",
    "thinking",
    "output_config",
    "temperature",
    "top_p",
    "top_k",
    "stream",
    "stop_sequences",
    "metadata",
    "max_tokens",
    "cache_control",
    "service_tier",
  ]),
  google: new Set(["contents", "systemInstruction", "tools", "toolConfig", "generationConfig"]),
  openrouter: new Set([
    "model",
    "messages",
    "tools",
    "tool_choice",
    "parallel_tool_calls",
    "stream",
    "stream_options",
    "max_tokens",
    "max_completion_tokens",
    "temperature",
    "top_p",
    "top_k",
    "stop",
    "seed",
    "response_format",
    "reasoning",
    "frequency_penalty",
    "presence_penalty",
    "user",
    "usage",
  ]),
  deepseek: new Set([
    "model",
    "messages",
    "tools",
    "tool_choice",
    "parallel_tool_calls",
    "stream",
    "stream_options",
    "max_tokens",
    "temperature",
    "top_p",
    "stop",
    "response_format",
    "thinking",
    "reasoning_effort",
    "frequency_penalty",
    "presence_penalty",
    "user",
  ]),
  typesafe: new Set(["model", "state", "questions"]),
};
export interface PreparedRequest {
  body: ObjectValue;
  stream: boolean;
  outputLimit: number;
  searchCalls: number;
  cacheWriteHint?: "5m" | "unknown";
}
/**
 * Model-authored tool arguments and tool JSON results are opaque data: a browser
 * tool may legitimately pass {"type":"file"} or a "video" field. Media blocks
 * (tool_result content, functionResponse.parts) are still inspected.
 */
export function toolArguments(record: Record<string, unknown>, key: string): boolean {
  if (key === "input") return record.type === "tool_use" || record.type === "server_tool_use";
  if (key === "args") return typeof record.name === "string";
  if (key === "response") return typeof record.name === "string" && !("type" in record);
  return false;
}

export function prepareRequest(
  model: Model,
  input: unknown,
  userId: string,
  secret: string,
): PreparedRequest {
  const body = { ...object(input) };
  for (const key of Object.keys(body))
    if (!allowed[model.provider].has(key)) throw new AppError("unsupported_request_field");
  let nodes = 0;
  let cacheWriteHint: "5m" | "unknown" = "5m";
  const inspect = (v: unknown, depth = 0, dataOnly = false) => {
    if (++nodes > 100000 || depth > 40) throw new AppError("request_structure_limit", 413);
    if (Array.isArray(v)) {
      for (const entry of v) inspect(entry, depth + 1, dataOnly);
      return;
    }
    if (!v || typeof v !== "object") return;
    const record = v as ObjectValue;
    for (const [key, value] of Object.entries(record)) {
      if (!dataOnly && record.type === "item_reference")
        throw new AppError("provider_storage_not_supported");
      if (
        !dataOnly &&
        ["input_file", "file", "image"].includes(String(record.type)) &&
        ["file_id", "fileId"].includes(key)
      )
        throw new AppError("provider_storage_not_supported");
      if (
        !dataOnly &&
        model.provider === "openai" &&
        ["prompt_cache_options", "prompt_cache_breakpoint"].includes(key)
      ) {
        const cache = object(value);
        if (cache.ttl !== undefined && cache.ttl !== "30m")
          throw new AppError("extended_cache_not_supported");
      }
      if (!dataOnly && key === "cache_control") {
        const cache = object(value);
        if (
          cache.type !== "ephemeral" ||
          (cache.ttl !== undefined && !["5m", "1h"].includes(String(cache.ttl)))
        )
          throw new AppError("unsupported_cache_policy");
        if (cache.ttl === "1h") cacheWriteHint = "unknown";
      }
      if (
        !dataOnly &&
        !model.supports.vision &&
        ["input_image", "image_url", "image"].includes(String(record.type))
      )
        throw new AppError("vision_not_supported");
      inspect(
        value,
        depth + 1,
        dataOnly ||
          ["parameters", "input_schema", "schema", "state", "questions"].includes(key) ||
          toolArguments(record, key),
      );
    }
  };
  inspect(body);
  delete body.user;
  delete body.metadata;
  const limit = (value: unknown, fallback: number) => {
    const n = value === undefined ? fallback : value;
    if (typeof n !== "number" || !Number.isSafeInteger(n) || n < 1 || n > fallback)
      throw new AppError("output_limit_exceeded");
    return n;
  };
  let outputLimit = model.maxOutput,
    searchCalls = 0;
  const tools = body.tools === undefined ? [] : body.tools;
  if (!Array.isArray(tools) || tools.length > 128) throw new AppError("invalid_tools");
  if (tools.length && !model.supports.tools) {
    const onlyNativeSearch =
      model.supports.nativeSearch &&
      tools.every((t) => {
        const type = object(t).type;
        return (
          (model.provider === "openai" && type === "web_search") ||
          (model.provider === "anthropic" && type === "web_search_20250305")
        );
      });
    if (!onlyNativeSearch) throw new AppError("tools_not_supported");
  }
  const identity = createHmac("sha256", secret)
    .update(`provider:${model.provider}:${userId}`)
    .digest("hex");
  if (model.provider === "openai") {
    if (body.background === true || body.conversation != null || body.previous_response_id != null)
      throw new AppError("provider_storage_not_supported");
    if (body.prompt_cache_retention !== undefined && body.prompt_cache_retention !== "in_memory")
      throw new AppError("extended_cache_not_supported");
    body.store = false;
    body.background = false;
    body.service_tier = "default";
    body.safety_identifier = identity;
    body.prompt_cache_key = identity;
    outputLimit = limit(body.max_output_tokens, model.maxOutput);
    body.max_output_tokens = outputLimit;
    for (const t of tools) {
      const tool = object(t);
      if (tool.type === "web_search") {
        if (!model.supports.nativeSearch || model.maxSearchCalls === 0)
          throw new AppError("native_search_not_supported");
        searchCalls = model.maxSearchCalls;
      } else if (!["function", "custom"].includes(String(tool.type)))
        throw new AppError("unsupported_tool");
    }
    if (searchCalls) {
      const n = body.max_tool_calls === undefined ? searchCalls : body.max_tool_calls;
      if (typeof n !== "number" || !Number.isInteger(n) || n < 1 || n > searchCalls)
        throw new AppError("search_limit_exceeded");
      searchCalls = n;
      body.max_tool_calls = n;
    }
  } else if (model.provider === "anthropic") {
    body.service_tier = "standard_only";
    outputLimit = limit(body.max_tokens, model.maxOutput);
    body.max_tokens = outputLimit;
    for (const t of tools) {
      const tool = object(t);
      if (tool.type === "web_search_20250305") {
        if (!model.maxSearchCalls) throw new AppError("native_search_not_supported");
        const n = tool.max_uses === undefined ? model.maxSearchCalls : tool.max_uses;
        if (typeof n !== "number" || !Number.isInteger(n) || n < 1 || n > model.maxSearchCalls)
          throw new AppError("search_limit_exceeded");
        tool.max_uses = n;
        searchCalls += n;
      } else if (tool.type !== undefined || typeof tool.name !== "string" || !tool.input_schema)
        throw new AppError("unsupported_tool");
    }
    if (searchCalls > model.maxSearchCalls) throw new AppError("search_limit_exceeded");
  } else if (model.provider === "google") {
    const generation = {
      ...(body.generationConfig === undefined ? {} : object(body.generationConfig)),
    };
    outputLimit = limit(generation.maxOutputTokens, model.maxOutput);
    generation.maxOutputTokens = outputLimit;
    if (generation.candidateCount !== undefined && generation.candidateCount !== 1)
      throw new AppError("multiple_candidates_not_supported");
    generation.candidateCount = 1;
    body.generationConfig = generation;
    for (const t of tools) {
      const tool = object(t);
      if (Object.keys(tool).some((key) => key !== "functionDeclarations"))
        throw new AppError("google_hosted_tools_not_supported");
    }
    if (!Array.isArray(body.contents)) throw new AppError("invalid_request");
  } else if (model.provider === "typesafe") {
    object(body.questions);
    if (body.state === undefined) throw new AppError("invalid_request");
    outputLimit = 0;
  } else {
    if (model.provider === "deepseek") {
      if (
        body.reasoning_effort !== undefined &&
        (typeof body.reasoning_effort !== "string" ||
          !["low", "high"].includes(body.reasoning_effort))
      )
        throw new AppError("unsupported_reasoning_effort");
      if (body.parallel_tool_calls !== undefined && typeof body.parallel_tool_calls !== "boolean")
        throw new AppError("invalid_parallel_tool_calls");
    }
    if (body.max_tokens !== undefined && body.max_completion_tokens !== undefined)
      throw new AppError("ambiguous_output_limit");
    outputLimit = limit(body.max_completion_tokens ?? body.max_tokens, model.maxOutput);
    if (body.max_completion_tokens !== undefined) body.max_completion_tokens = outputLimit;
    else body.max_tokens = outputLimit;
    for (const t of tools)
      if (object(t).type !== "function") throw new AppError("unsupported_tool");
    if (body.stream === true) body.stream_options = { include_usage: true };
    if (model.provider === "openrouter") body.usage = { include: true };
  }
  if (searchCalls && !model.supports.nativeSearch)
    throw new AppError("native_search_not_supported");
  if (model.provider !== "google") body.model = model.upstreamModel;
  if (body.stream !== undefined && typeof body.stream !== "boolean")
    throw new AppError("invalid_stream_mode");
  return {
    body,
    stream: model.provider === "google" || body.stream === true,
    outputLimit,
    searchCalls,
    cacheWriteHint,
  };
}
