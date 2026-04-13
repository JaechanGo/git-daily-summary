// ========== AI Provider System (확장 가능) ==========
// 새 AI 모델을 추가하려면 AIProvider를 상속하고 registry에 등록

class AIProvider {
  constructor(config) {
    this.config = config;
  }

  async summarize(prompt, userMessage) {
    throw new Error('summarize() must be implemented');
  }

  async test() {
    try {
      const result = await this.summarize(
        'You are a test assistant. Reply with only: OK',
        'Say "OK" if you can read this. Reply with only the word OK, nothing else.'
      );
      return { success: true, message: result.substring(0, 100) };
    } catch (e) {
      return { success: false, error: e.message };
    }
  }
}

// ---------- Gemini ----------
class GeminiProvider extends AIProvider {
  async summarize(prompt, userMessage) {
    const { apiKey, model } = this.config;
    const modelName = model || 'gemini-2.0-flash';
    const url = `https://generativelanguage.googleapis.com/v1beta/models/${modelName}:generateContent?key=${apiKey}`;

    // gemini-2.5-* 시리즈는 thinking 모델 → 토큰을 많이 쓰므로 여유있게 설정
    const isThinkingModel = modelName.includes('2.5');

    const generationConfig = {
      temperature: 0.3,
      maxOutputTokens: isThinkingModel ? 8192 : 2048,
    };

    // thinking 모델이면 thinking budget 제한 (실제 출력에 토큰을 더 배분)
    if (isThinkingModel) {
      generationConfig.thinkingConfig = { thinkingBudget: 1024 };
    }

    const res = await fetch(url, {
      method: 'POST',
      headers: { 'Content-Type': 'application/json' },
      body: JSON.stringify({
        system_instruction: { parts: [{ text: prompt }] },
        contents: [{ parts: [{ text: userMessage }] }],
        generationConfig,
      }),
    });

    if (!res.ok) {
      const err = await res.text();
      throw new Error(`Gemini API 오류 (${res.status}): ${err}`);
    }

    const data = await res.json();

    // finishReason 체크
    const candidate = data.candidates?.[0];
    if (candidate?.finishReason === 'MAX_TOKENS') {
      // 잘린 응답이라도 있는 만큼 반환
      const partial = candidate.content?.parts?.[0]?.text || '';
      if (partial) return partial;
      throw new Error('Gemini 응답이 토큰 한도로 잘렸습니다. 모델을 gemini-2.0-flash로 변경해보세요.');
    }

    return candidate?.content?.parts?.[0]?.text || '';
  }
}

// ---------- vLLM (OpenAI-compatible) ----------
class VLLMProvider extends AIProvider {
  async summarize(prompt, userMessage) {
    const { endpoint, model, apiKey } = this.config;
    const url = `${endpoint}/chat/completions`;

    const headers = { 'Content-Type': 'application/json' };
    if (apiKey) headers['Authorization'] = `Bearer ${apiKey}`;

    const res = await fetch(url, {
      method: 'POST',
      headers,
      body: JSON.stringify({
        model,
        messages: [
          { role: 'system', content: prompt },
          { role: 'user', content: userMessage },
        ],
        temperature: 0.3,
        max_tokens: 2048,
      }),
    });

    if (!res.ok) {
      const err = await res.text();
      throw new Error(`vLLM API 오류 (${res.status}): ${err}`);
    }

    const data = await res.json();
    return data.choices?.[0]?.message?.content || '';
  }
}

// ---------- OpenAI ----------
class OpenAIProvider extends AIProvider {
  async summarize(prompt, userMessage) {
    const { apiKey, model } = this.config;

    const res = await fetch('https://api.openai.com/v1/chat/completions', {
      method: 'POST',
      headers: {
        'Content-Type': 'application/json',
        Authorization: `Bearer ${apiKey}`,
      },
      body: JSON.stringify({
        model: model || 'gpt-4o-mini',
        messages: [
          { role: 'system', content: prompt },
          { role: 'user', content: userMessage },
        ],
        temperature: 0.3,
        max_tokens: 2048,
      }),
    });

    if (!res.ok) {
      const err = await res.text();
      throw new Error(`OpenAI API 오류 (${res.status}): ${err}`);
    }

    const data = await res.json();
    return data.choices?.[0]?.message?.content || '';
  }
}

// ---------- Anthropic ----------
class AnthropicProvider extends AIProvider {
  async summarize(prompt, userMessage) {
    const { apiKey, model } = this.config;

    const res = await fetch('https://api.anthropic.com/v1/messages', {
      method: 'POST',
      headers: {
        'Content-Type': 'application/json',
        'x-api-key': apiKey,
        'anthropic-version': '2023-06-01',
        'anthropic-dangerous-direct-browser-access': 'true',
      },
      body: JSON.stringify({
        model: model || 'claude-sonnet-4-20250514',
        max_tokens: 2048,
        system: prompt,
        messages: [{ role: 'user', content: userMessage }],
      }),
    });

    if (!res.ok) {
      const err = await res.text();
      throw new Error(`Anthropic API 오류 (${res.status}): ${err}`);
    }

    const data = await res.json();
    return data.content?.[0]?.text || '';
  }
}

// ---------- Ollama ----------
class OllamaProvider extends AIProvider {
  async summarize(prompt, userMessage) {
    const { endpoint, model } = this.config;

    const res = await fetch(`${endpoint}/api/chat`, {
      method: 'POST',
      headers: { 'Content-Type': 'application/json' },
      body: JSON.stringify({
        model: model || 'llama3',
        messages: [
          { role: 'system', content: prompt },
          { role: 'user', content: userMessage },
        ],
        stream: false,
      }),
    });

    if (!res.ok) {
      const err = await res.text();
      throw new Error(`Ollama API 오류 (${res.status}): ${err}`);
    }

    const data = await res.json();
    return data.message?.content || '';
  }
}

// ---------- Custom (OpenAI-compatible) ----------
class CustomProvider extends AIProvider {
  async summarize(prompt, userMessage) {
    const { endpoint, model, apiKey } = this.config;
    const url = `${endpoint}/chat/completions`;

    const headers = { 'Content-Type': 'application/json' };
    if (apiKey) headers['Authorization'] = `Bearer ${apiKey}`;

    const res = await fetch(url, {
      method: 'POST',
      headers,
      body: JSON.stringify({
        model,
        messages: [
          { role: 'system', content: prompt },
          { role: 'user', content: userMessage },
        ],
        temperature: 0.3,
        max_tokens: 2048,
      }),
    });

    if (!res.ok) {
      const err = await res.text();
      throw new Error(`Custom API 오류 (${res.status}): ${err}`);
    }

    const data = await res.json();
    return data.choices?.[0]?.message?.content || '';
  }
}

// ========== Provider Registry ==========
const AI_PROVIDER_REGISTRY = {
  gemini: GeminiProvider,
  vllm: VLLMProvider,
  openai: OpenAIProvider,
  anthropic: AnthropicProvider,
  ollama: OllamaProvider,
  custom: CustomProvider,
};

function createAIProvider(aiSettings) {
  const providerName = aiSettings.provider;
  const ProviderClass = AI_PROVIDER_REGISTRY[providerName];
  if (!ProviderClass) {
    throw new Error(`알 수 없는 AI Provider: ${providerName}`);
  }
  const config = aiSettings[providerName];
  if (!config) {
    throw new Error(`${providerName} 설정이 없습니다.`);
  }
  return new ProviderClass(config);
}

if (typeof self !== 'undefined') {
  self.AI_PROVIDER_REGISTRY = AI_PROVIDER_REGISTRY;
  self.createAIProvider = createAIProvider;
}
