import { fetchWithTimeout, hasUnsafeHostname, readResponseText, strictHttpUrl } from "./runtime.mjs";

function endpoint(baseUrl, suffix) {
  return `${baseUrl.replace(/\/$/, "")}${suffix}`;
}

function stripCodeFence(raw) {
  return String(raw ?? "").trim().replace(/^```(?:json)?\s*/i, "").replace(/\s*```$/, "");
}

/**
 * Salvage every complete object from an `items` array that the output token limit cut off.
 * A truncated tail would otherwise waste the whole paid request.
 */
export function salvageItemsArray(rawText) {
  const text = stripCodeFence(rawText);
  const match = /"items"\s*:\s*\[/.exec(text);
  if (!match) return null;
  const items = [];
  let depth = 0;
  let start = -1;
  let inString = false;
  let escaped = false;
  for (let index = match.index + match[0].length; index < text.length; index += 1) {
    const character = text[index];
    if (inString) {
      if (escaped) escaped = false;
      else if (character === "\\") escaped = true;
      else if (character === '"') inString = false;
      continue;
    }
    if (character === '"') {
      inString = true;
      continue;
    }
    if (character === "{") {
      if (depth === 0) start = index;
      depth += 1;
      continue;
    }
    if (character === "}") {
      if (depth > 0) {
        depth -= 1;
        if (depth === 0 && start >= 0) {
          items.push(text.slice(start, index + 1));
          start = -1;
        }
      }
      continue;
    }
    if (character === "]" && depth === 0) break;
  }
  const parsed = [];
  for (const candidate of items) {
    try {
      parsed.push(JSON.parse(candidate));
    } catch {
      // Skip an unparsable fragment; the rest of the batch is still usable.
    }
  }
  return parsed.length > 0 ? parsed : null;
}

function parseJsonText(raw) {
  const text = stripCodeFence(raw);
  try {
    return JSON.parse(text);
  } catch (error) {
    const salvaged = salvageItemsArray(text);
    if (salvaged) {
      console.warn(`[provider] recovered ${salvaged.length} item(s) from a truncated response.`);
      return { items: salvaged };
    }
    const diagnostic = text.slice(0, 280).replace(/\s+/g, " ");
    const invalidJson = new Error(`Model returned invalid JSON: ${diagnostic || error.message}`);
    invalidJson.code = "invalid-model-json";
    throw invalidJson;
  }
}

function parseModelData(content, usage, estimatedCny) {
  try {
    return parseJsonText(content);
  } catch (error) {
    error.usage = usage;
    error.estimatedCny = estimatedCny;
    throw error;
  }
}

function usageNumber(value, field, providerLabel) {
  const number = Number(value);
  if (!Number.isFinite(number) || number < 0) {
    throw new Error(`${providerLabel} returned invalid ${field} usage.`);
  }
  return number;
}

function readUsage(raw, inputField, outputField, providerLabel) {
  if (!raw || raw[inputField] === undefined || raw[outputField] === undefined) {
    if (process.env.OBSERVATORY_ALLOW_UNMETERED_PROVIDER === "true") {
      return { inputTokens: 0, outputTokens: 0, unmetered: true };
    }
    throw new Error(`${providerLabel} did not return token usage; refusing to spend an unmetered request.`);
  }
  return {
    inputTokens: usageNumber(raw[inputField], inputField, providerLabel),
    outputTokens: usageNumber(raw[outputField], outputField, providerLabel),
    unmetered: false,
  };
}

function estimateCost(provider, inputTokens, outputTokens) {
  if (provider.inputCnyPerMillion === null || provider.outputCnyPerMillion === null) return null;
  return Number((
    (inputTokens / 1_000_000) * Number(provider.inputCnyPerMillion) +
    (outputTokens / 1_000_000) * Number(provider.outputCnyPerMillion)
  ).toFixed(8));
}

function validateProviderEndpoint(providerId, provider) {
  let url;
  try {
    url = strictHttpUrl(provider.baseUrl, {
      allowHttp: providerId === "custom" && ["localhost", "127.0.0.1", "::1"].includes(new URL(provider.baseUrl).hostname.replace(/^\[|\]$/g, "")),
      allowPrivate: providerId === "custom",
    });
  } catch (error) {
    throw new Error(`${provider.label} Base URL is invalid: ${error.message}`);
  }
  const builtInOrigins = {
    deepseek: "https://api.deepseek.com",
    openai: "https://api.openai.com",
    gemini: "https://generativelanguage.googleapis.com",
  };
  if (builtInOrigins[providerId] && url.origin !== builtInOrigins[providerId]) {
    throw new Error(`${provider.label} Base URL must stay on its official host.`);
  }
  if (providerId === "custom") {
    const loopback = ["localhost", "127.0.0.1", "::1"].includes(url.hostname.replace(/^\[|\]$/g, ""));
    if (hasUnsafeHostname(url.hostname) && !loopback) throw new Error("Custom provider cannot target a private host.");
    if (!loopback && process.env.OBSERVATORY_ALLOW_CUSTOM_EGRESS !== "true") {
      throw new Error("Custom external provider egress is disabled.");
    }
  }
}

function providerError(provider, status, payload) {
  const message = String(payload?.error?.message ?? "request failed")
    .replace(/https?:\/\/\S+/gi, "[url]")
    .replace(/Bearer\s+\S+/gi, "Bearer [redacted]")
    .slice(0, 240);
  return new Error(`${provider.label} HTTP ${status}: ${message}`);
}

/**
 * opencode-go 的网关强制要求 `x-opencode-session`：缺了它，任何 /chat/completions 都会
 * 400 MissingSessionID（"cannot be routed efficiently"），并要求客户端自报 UA。
 * 只对 opencode.ai 的端点加这两个头，其他 provider 的请求保持原样。
 * 会话 id 每个进程稳定，可用 OBSERVATORY_OPENCODE_SESSION 覆盖。
 */
const opencodeSessionId =
  process.env.OBSERVATORY_OPENCODE_SESSION?.trim() ||
  `yanzhi-observatory-${process.pid.toString(36)}-${Date.now().toString(36)}`;

function opencodeHostname(provider) {
  try {
    return new URL(provider.baseUrl).hostname;
  } catch {
    return "";
  }
}

function isOpencodeEndpoint(provider) {
  const hostname = opencodeHostname(provider);
  return hostname === "opencode.ai" || hostname.endsWith(".opencode.ai");
}

function requestHeaders(provider, apiKey) {
  const headers = {
    Authorization: `Bearer ${apiKey}`,
    "Content-Type": "application/json",
  };
  if (isOpencodeEndpoint(provider)) {
    headers["x-opencode-session"] = opencodeSessionId;
    headers["User-Agent"] = "yanzhi-observatory/1.0";
  }
  return headers;
}

/**
 * 请求体。opencode-go 上的 deepseek 系列默认开思考，实测一条 4,330 prompt token 的蒸馏请求
 * 会先花掉 2,035 个 reasoning token（正文 6,012 字符），而蒸馏只给 2,600 个输出 token：
 * 思考多花一点，正文就被挤空，整段蒸馏回落到常青目录（2026-10-17 实测）。
 * 实测 `thinking:{type:"disabled"}` 被网关接受（reasoning 归零、耗时 14s→4s），
 * `reasoning_effort` 则完全不起作用（low 与默认的 reasoning token 数几乎一样）。
 * 只对 opencode.ai 上的 deepseek 生效；想恢复思考设 OBSERVATORY_OPENCODE_THINKING=on。
 */
function requestBody(provider, messages, maximumOutputTokens) {
  const body = {
    model: provider.model,
    messages,
    response_format: { type: "json_object" },
    max_tokens: maximumOutputTokens,
    stream: false,
  };
  if (
    isOpencodeEndpoint(provider) &&
    /^deepseek/i.test(String(provider.model ?? "")) &&
    process.env.OBSERVATORY_OPENCODE_THINKING !== "on"
  ) {
    body.thinking = { type: "disabled" };
  }
  return body;
}

async function callOpenAiCompatible(provider, apiKey, messages, timeoutMs, maximumOutputTokens) {
  const response = await fetchWithTimeout(
    endpoint(provider.baseUrl, "/chat/completions"),
    {
      method: "POST",
      redirect: "error",
      headers: requestHeaders(provider, apiKey),
      body: JSON.stringify(requestBody(provider, messages, maximumOutputTokens)),
    },
    timeoutMs,
  );
  const responseText = await readResponseText(response, 4_000_000);
  let payload;
  try {
    payload = JSON.parse(responseText);
  } catch {
    throw new Error(`${provider.label} returned a non-JSON response.`);
  }
  if (!response.ok) {
    throw providerError(provider, response.status, payload);
  }
  const content = payload.choices?.[0]?.message?.content;
  if (!content) {
    // 空内容有两种常见成因：上游把额度全用在思考上（finish_reason=length），或网关换了字段。
    // 出错信息里带上证据，避免下次只能看到一句"returned no message content"。
    const choice = payload.choices?.[0];
    const reasoning = choice?.message?.reasoning_content;
    const detail = [
      `finish_reason=${choice?.finish_reason ?? "unknown"}`,
      `usage=${JSON.stringify(payload.usage ?? null)}`,
      reasoning ? `reasoning_content=${String(reasoning).length} chars` : "no reasoning_content",
    ].join("; ");
    throw new Error(`${provider.label} returned no message content (${detail}).`);
  }
  const usage = readUsage(payload.usage, "prompt_tokens", "completion_tokens", provider.label);
  const estimatedCny = usage.unmetered ? null : estimateCost(provider, usage.inputTokens, usage.outputTokens);
  return {
    data: parseModelData(content, usage, estimatedCny),
    usage,
    estimatedCny,
  };
}

async function callGemini(provider, apiKey, messages, timeoutMs, maximumOutputTokens) {
  const system = messages.filter((message) => message.role === "system").map((message) => message.content).join("\n\n");
  const contents = messages
    .filter((message) => message.role !== "system")
    .map((message) => ({
      role: message.role === "assistant" ? "model" : "user",
      parts: [{ text: message.content }],
    }));
  const url = new URL(
    endpoint(provider.baseUrl, `/models/${encodeURIComponent(provider.model)}:generateContent`),
  );
  const response = await fetchWithTimeout(
    url,
    {
      method: "POST",
      redirect: "error",
      headers: { "Content-Type": "application/json", "x-goog-api-key": apiKey },
      body: JSON.stringify({
        system_instruction: system ? { parts: [{ text: system }] } : undefined,
        contents,
        generationConfig: {
          responseMimeType: "application/json",
          temperature: 0.2,
          maxOutputTokens: maximumOutputTokens,
        },
      }),
    },
    timeoutMs,
  );
  const responseText = await readResponseText(response, 4_000_000);
  let payload;
  try {
    payload = JSON.parse(responseText);
  } catch {
    throw new Error(`${provider.label} returned a non-JSON response.`);
  }
  if (!response.ok) {
    throw providerError(provider, response.status, payload);
  }
  const content = payload.candidates?.[0]?.content?.parts?.map((part) => part.text ?? "").join("");
  if (!content) throw new Error(`${provider.label} returned no message content.`);
  const usage = readUsage(
    payload.usageMetadata,
    "promptTokenCount",
    "candidatesTokenCount",
    provider.label,
  );
  const estimatedCny = usage.unmetered ? null : estimateCost(provider, usage.inputTokens, usage.outputTokens);
  return {
    data: parseModelData(content, usage, estimatedCny),
    usage,
    estimatedCny,
  };
}

export async function generateStructured(providerConfig, messages, timeoutMs = 90000, maximumOutputTokens = 4500) {
  const providerId = providerConfig.activeLlm;
  const provider = providerConfig.llmProviders[providerId];
  if (!provider) throw new Error(`Unknown active provider: ${providerId}`);
  validateProviderEndpoint(providerId, provider);
  const apiKey = process.env[provider.apiKeyEnv];
  if (!apiKey) {
    const error = new Error(
      `${provider.apiKeyEnv} is not configured. Set it in /studio API 设置, .env.local, or GitHub Actions Secrets.`,
    );
    error.code = "missing-api-key";
    throw error;
  }
  const result = provider.protocol === "gemini"
    ? await callGemini(provider, apiKey, messages, timeoutMs, maximumOutputTokens)
    : await callOpenAiCompatible(provider, apiKey, messages, timeoutMs, maximumOutputTokens);
  return { ...result, providerId, model: provider.model, apiKeyEnv: provider.apiKeyEnv };
}
