import { getPreferences } from './preferences.js';

// Gemini TTS 回傳的是原始 PCM（預設 24kHz、16-bit、單聲道），瀏覽器無法直接播放，
// 因此在 main 端補上 WAV 檔頭，回傳可直接餵給 <audio> 的 base64 WAV。
function pcmToWav(pcm: Buffer, sampleRate: number): Buffer {
  const numChannels = 1;
  const bitsPerSample = 16;
  const byteRate = (sampleRate * numChannels * bitsPerSample) / 8;
  const blockAlign = (numChannels * bitsPerSample) / 8;
  const header = Buffer.alloc(44);
  header.write('RIFF', 0);
  header.writeUInt32LE(36 + pcm.length, 4);
  header.write('WAVE', 8);
  header.write('fmt ', 12);
  header.writeUInt32LE(16, 16);
  header.writeUInt16LE(1, 20); // PCM
  header.writeUInt16LE(numChannels, 22);
  header.writeUInt32LE(sampleRate, 24);
  header.writeUInt32LE(byteRate, 28);
  header.writeUInt16LE(blockAlign, 32);
  header.writeUInt16LE(bitsPerSample, 34);
  header.write('data', 36);
  header.writeUInt32LE(pcm.length, 40);
  return Buffer.concat([header, pcm]);
}

interface InlineData {
  mimeType?: string;
  data?: string;
}

export async function speakText(
  text: string
): Promise<{ ok: true; audio: string } | { ok: false; reason: string }> {
  const { geminiApiKey, geminiTtsModel } = getPreferences();
  if (!geminiApiKey) return { ok: false, reason: '請先在偏好設定填入 Gemini API Key' };
  const model = geminiTtsModel.trim() || 'gemini-3.1-flash-tts-preview';
  const trimmed = text.trim();
  if (!trimmed) return { ok: false, reason: '沒有可朗讀的文字' };

  try {
    const res = await fetch(
      `https://generativelanguage.googleapis.com/v1beta/models/${encodeURIComponent(
        model
      )}:generateContent?key=${geminiApiKey}`,
      {
        method: 'POST',
        headers: { 'Content-Type': 'application/json' },
        body: JSON.stringify({
          contents: [{ parts: [{ text: trimmed }] }],
          generationConfig: {
            responseModalities: ['AUDIO'],
            speechConfig: {
              voiceConfig: { prebuiltVoiceConfig: { voiceName: 'Kore' } },
            },
          },
        }),
      }
    );
    if (!res.ok) {
      let detail = '';
      try {
        const err = (await res.json()) as { error?: { message?: string } };
        if (err?.error?.message) detail = `：${err.error.message}`;
      } catch {
        /* ignore parse errors */
      }
      return { ok: false, reason: `Gemini 錯誤 ${res.status}${detail}` };
    }
    const data = (await res.json()) as {
      candidates?: Array<{ content?: { parts?: Array<{ inlineData?: InlineData }> } }>;
    };
    const parts = data?.candidates?.[0]?.content?.parts ?? [];
    const inline = parts.map((p) => p.inlineData).find((d) => d?.data);
    if (!inline?.data) return { ok: false, reason: '回應沒有音訊資料' };

    const rateMatch = /rate=(\d+)/.exec(inline.mimeType ?? '');
    const sampleRate = rateMatch ? Number(rateMatch[1]) : 24000;
    const wav = pcmToWav(Buffer.from(inline.data, 'base64'), sampleRate);
    return { ok: true, audio: wav.toString('base64') };
  } catch {
    return { ok: false, reason: '網路或 API 錯誤' };
  }
}
