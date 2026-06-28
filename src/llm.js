// DeepSeek chat-completions client (OpenAI-compatible, with tool calling).
// Docs: https://api-docs.deepseek.com/  — endpoint POST {baseUrl}/chat/completions

const DEFAULTS = {
  baseUrl: "https://api.deepseek.com",
  model: "deepseek-v4-flash",
};

export function llmDefaults() {
  return { ...DEFAULTS };
}

/**
 * Call the model.
 * @returns {Promise<{content: string, tool_calls?: Array}>} the assistant message.
 */
export async function chatCompletion({
  baseUrl = DEFAULTS.baseUrl,
  apiKey,
  model = DEFAULTS.model,
  messages,
  tools,
  temperature = 0,
  signal,
}) {
  if (!apiKey) throw new Error("Missing API key. Open settings and add your DeepSeek API key.");

  const url = `${baseUrl.replace(/\/+$/, "")}/chat/completions`;
  const body = {
    model,
    messages,
    temperature,
  };
  if (tools && tools.length) {
    body.tools = tools;
    body.tool_choice = "auto";
  }

  let res;
  try {
    res = await fetch(url, {
      method: "POST",
      headers: {
        "Content-Type": "application/json",
        Authorization: `Bearer ${apiKey}`,
      },
      body: JSON.stringify(body),
      signal,
    });
  } catch (e) {
    throw new Error(`Network error calling DeepSeek: ${e.message}`);
  }

  if (!res.ok) {
    let detail = "";
    try {
      detail = (await res.text()).slice(0, 500);
    } catch {}
    throw new Error(`DeepSeek API ${res.status}: ${detail}`);
  }

  const data = await res.json();
  const msg = data.choices && data.choices[0] && data.choices[0].message;
  if (!msg) throw new Error("DeepSeek returned no message.");
  return msg;
}
