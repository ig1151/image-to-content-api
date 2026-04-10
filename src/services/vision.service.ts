import Anthropic from '@anthropic-ai/sdk';
import { v4 as uuidv4 } from 'uuid';
import { config } from '../utils/config';
import { logger } from '../utils/logger';
import type { AnalyzeRequest, AnalyzeResponse, Module, CaptionStyle } from '../types/index';

const client = new Anthropic({ apiKey: config.anthropic.apiKey });

function buildPrompt(modules: Module[], language: string, maxTags: number, captionStyle: CaptionStyle): string {
  const fields: string[] = [];
  if (modules.includes('caption')) fields.push(`"caption": { "text": "<${captionStyle === 'alt-text' ? 'concise alt text' : captionStyle === 'brief' ? 'one sentence' : '1-2 sentences'}>", "confidence": <0.0-1.0>, "style": "${captionStyle}" }`);
  if (modules.includes('summary')) fields.push(`"summary": { "short": "<one sentence>", "detailed": "<2-3 sentences>", "bullets": ["<point1>", "<point2>", "<point3>"] }`);
  if (modules.includes('tags')) fields.push(`"tags": [{ "label": "<tag>", "confidence": <0.0-1.0>, "category": "<object|scene|color|mood|style|action>" }] /* up to ${maxTags} tags */`);
  if (modules.includes('metadata')) fields.push(`"metadata": { "scene_type": "<scene>", "setting": "<indoor|outdoor|studio|unknown>", "time_of_day": "<morning|afternoon|evening|night|unknown>", "dominant_colors": ["<c1>","<c2>","<c3>"], "objects_detected": ["<o1>","<o2>"], "people_count": <int>, "has_text": <bool>, "aspect_ratio_guess": "<landscape|portrait|square>" }`);
  if (modules.includes('sentiment')) fields.push(`"sentiment": { "tone": "<positive|neutral|negative|mixed>", "score": <-1.0 to 1.0>, "emotions": ["<e1>","<e2>"] }`);
  if (modules.includes('ocr')) fields.push(`"ocr": { "text": "<extracted text or empty>", "blocks": [{ "text": "<t>", "confidence": <0.0-1.0> }], "language_detected": "<BCP-47>" }`);
  const langNote = language !== 'en' ? `Output all human-readable strings in language: ${language}.\n` : '';
  return `Analyze this image. Return ONLY valid JSON — no markdown, no explanation.\n${langNote}\n{\n  ${fields.join(',\n  ')}\n}`;
}

export async function analyzeImage(req: AnalyzeRequest): Promise<AnalyzeResponse> {
  const id = `req_${uuidv4().replace(/-/g, '').slice(0, 12)}`;
  const modules = req.modules ?? ['caption', 'summary', 'tags', 'metadata'];
  const language = req.language ?? 'en';
  const maxTags = req.max_tags ?? 10;
  const captionStyle = req.caption_style ?? 'detailed';
  const t0 = Date.now();

  logger.info({ id, modules }, 'Starting analysis');

  const image = req.image;
  let messageContent: Anthropic.MessageParam['content'];

  if (image.startsWith('https://')) {
    messageContent = [
      {
        type: 'image',
        source: { type: 'url', url: image },
      } as unknown as Anthropic.ImageBlockParam,
      { type: 'text', text: buildPrompt(modules, language, maxTags, captionStyle) },
    ];
  } else {
    const raw = image.includes(',') ? image.split(',')[1] : image;
    const mimeMap: Record<string, 'image/jpeg' | 'image/png' | 'image/webp' | 'image/gif'> = {
      jpeg: 'image/jpeg', jpg: 'image/jpeg', png: 'image/png', webp: 'image/webp', gif: 'image/gif',
    };
    const mediaType = mimeMap[req.image_format ?? 'jpeg'] ?? 'image/jpeg';
    messageContent = [
      {
        type: 'image',
        source: { type: 'base64', media_type: mediaType, data: raw },
      },
      { type: 'text', text: buildPrompt(modules, language, maxTags, captionStyle) },
    ];
  }

  const response = await client.messages.create({
    model: config.anthropic.model,
    max_tokens: 1024,
    messages: [{ role: 'user', content: messageContent }],
  });

  const rawText = response.content.find((b) => b.type === 'text')?.text ?? '{}';
  let parsed: Record<string, unknown>;
  try {
    parsed = JSON.parse(rawText.replace(/```json|```/g, '').trim());
  } catch (err) {
    logger.error({ id, rawText, err }, 'Failed to parse JSON');
    throw new Error('Model returned malformed JSON');
  }

  logger.info({ id, latency: Date.now() - t0 }, 'Analysis complete');

  return {
    id,
    status: 'success',
    model: config.anthropic.model,
    ...(parsed.caption ? { caption: parsed.caption as AnalyzeResponse['caption'] } : {}),
    ...(parsed.summary ? { summary: parsed.summary as AnalyzeResponse['summary'] } : {}),
    ...(parsed.tags ? { tags: parsed.tags as AnalyzeResponse['tags'] } : {}),
    ...(parsed.metadata ? { metadata: parsed.metadata as AnalyzeResponse['metadata'] } : {}),
    ...(parsed.sentiment ? { sentiment: parsed.sentiment as AnalyzeResponse['sentiment'] } : {}),
    ...(parsed.ocr ? { ocr: parsed.ocr as AnalyzeResponse['ocr'] } : {}),
    latency_ms: Date.now() - t0,
    usage: { input_tokens: response.usage.input_tokens, output_tokens: response.usage.output_tokens },
    created_at: new Date().toISOString(),
  };
}
