import { getPreferences } from './preferences.js';

type Message = { role: 'system' | 'user'; content: string };

export async function runAI(
  userContent: string
): Promise<{ ok: true; content: string } | { ok: false; reason: string }> {
  const { openRouterApiKey, openRouterModel, aiGlobalInstruction } = getPreferences();
  if (!openRouterApiKey) return { ok: false, reason: '請先在偏好設定填入 OpenRouter API Key' };
  if (!openRouterModel) return { ok: false, reason: '請先在偏好設定填入 Model Name' };

  const messages: Message[] = [];
  if (aiGlobalInstruction.trim()) messages.push({ role: 'system', content: aiGlobalInstruction });
  messages.push({ role: 'user', content: userContent });

  try {
    const res = await fetch('https://openrouter.ai/api/v1/chat/completions', {
      method: 'POST',
      headers: {
        Authorization: `Bearer ${openRouterApiKey}`,
        'Content-Type': 'application/json',
      },
      body: JSON.stringify({ model: openRouterModel, messages }),
    });
    if (!res.ok) return { ok: false, reason: `OpenRouter 錯誤 ${res.status}` };
    const data = (await res.json()) as {
      choices?: Array<{ message?: { content?: string } }>;
    };
    const content = data?.choices?.[0]?.message?.content;
    if (typeof content !== 'string') return { ok: false, reason: '回應格式無法解析' };
    return { ok: true, content };
  } catch {
    return { ok: false, reason: '網路或 API 錯誤' };
  }
}
