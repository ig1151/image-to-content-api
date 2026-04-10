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

function resolveImageSource(image: string, format?: string) {
  if (image.startsWith('https://')) return { type: 'url' as const, url: image };
  const raw = image.includes(',') ? image.split(',')[1] : image;
  const mimeMap: Record<string, string> = { jpeg: 'image/jpeg', jpg: 'image/jpeg', png: 'image/png', webp: 'image/webp', gif: 'image/gif' };
  return { type: 'base64' as const, media_type: mimeMap[format ?? 'jpeg'] ?? 'image/jpeg', data: raw };
}

export async function analyzeImage(req: AnalyzeRequest): Promise<AnalyzeResponse> {
  const id = `req_${uuidv4().replace(/-/g, '').slice(0, 12)}`;
  const modules = req.modules ?? ['caption', 'summary', 'tags', 'metadata'];
  const language = req.language ?? 'en';
  const maxTags = req.max_tags ?? 10;
  const captionStyle = req.caption_style ?? 'detailed';
  const t0 = Date.now();
  const imageSource = resolveImageSource(req.image, req.image_format);
  logger.info({ id, modules }, 'Starting analysis');

  const imageContent: Anthropic.ImageBlockParam = imageSource.type === 'url'
    ? { type: 'image', source: { type: 'url', url: imageSource.url } }
    : { type: 'image', source: { type: 'base64', media_type: imageSource.media_type as Anthropic.Base64ImageSource['media_type'], data: imageSource.data } };

  const response = await client.messages.create({
    model: config.anthropic.model,
    max_tokens: 1024,
    messages: [{ role: 'user', content: [imageContent, { type: 'text', text: buildPrompt(modules, language, maxTags, captionStyle) }] }],
  });

  const raw = response.content.find((b) => b.type === 'text')?.text ?? '{}';
  let parsed: Record<string, unknown>;
  try { parsed = JSON.parse(raw.replace(/```json|```/g, '').trim()); }
  catch (err) { logger.error({ id, raw, err }, 'Failed to parse JSON'); throw new Error('Model returned malformed JSON'); }

  logger.info({ id, latency: Date.now() - t0 }, 'Analysis complete');
  return {
    id, status: 'success', model: config.anthropic.model,
    ...(parsed.caption && { caption: parsed.caption as AnalyzeResponse['caption'] }),
    ...(parsed.summary && { summary: parsed.summary as AnalyzeResponse['summary'] }),
    ...(parsed.tags && { tags: parsed.tags as AnalyzeResponse['tags'] }),
    ...(parsed.metadata && { metadata: parsed.metadata as AnalyzeResponse['metadata'] }),
    ...(parsed.sentiment && { sentiment: parsed.sentiment as AnalyzeResponse['sentiment'] }),
    ...(parsed.ocr && { ocr: parsed.ocr as AnalyzeResponse['ocr'] }),
    latency_ms: Date.now() - t0,
    usage: { input_tokens: response.usage.input_tokens, output_tokens: response.usage.output_tokens },
    created_at: new Date().toISOString(),
  };
}
