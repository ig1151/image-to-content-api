import { v4 as uuidv4 } from 'uuid';
import { logger } from '../utils/logger';
import type { AnalyzeRequest, AnalyzeResponse, Module, CaptionStyle } from '../types/index';

const OPENROUTER_API_URL = 'https://openrouter.ai/api/v1/chat/completions';
const MODEL = 'anthropic/claude-sonnet-4-5';

function buildPrompt(modules: Module[], language: string, maxTags: number, captionStyle: CaptionStyle): string {
  const fields: string[] = [];
  if (modules.includes('caption')) fields.push(`"caption": { "text": "<${captionStyle === 'alt-text' ? 'concise alt text' : captionStyle === 'brief' ? 'one sentence' : '1-2 sentences'}>", "confidence": <0.0-1.0>, "style": "${captionStyle}" }`);
  if (modules.includes('summary')) fields.push(`"summary": { "short": "<one sentence>", "detailed": "<2-3 sentences>", "bullets": ["<point1>", "<point2>", "<point3>"] }`);
  if (modules.includes('tags')) fields.push(`"tags": [{ "label": "<tag>", "confidence": <0.0-1.0>, "category": "<object|scene|color|mood|style|action>" }] /* up to ${maxTags} tags */`);
  if (modules.includes('metadata')) fields.push(`"metadata": { "scene_type": "<scene>", "setting": "<indoor|outdoor|studio|unknown>", "time_of_day": "<morning|afternoon|evening|night|unknown>", "dominant_colors": ["<c1>","<c2>","<c3>"], "objects_detected": ["<o1>","<o2>"], "people_count": <int>, "has_text": <bool>, "aspect_ratio_guess": "<landscape|portrait|square>" }`);
  if (modules.includes('sentiment')) fields.push(`"sentiment": { "tone": "<positive|neutral|negative|mixed>", "score": <-1.0 to 1.0>, "emotions": ["<e1>","<e2>"] }`);
  if (modules.includes('ocr')) fields.push(`"ocr": { "text": "<extracted text or empty>", "blocks": [{ "text": "<t>", "confidence": <0.0-1.0> }], "language_detected": "<BCP-47>" }`);
  if (modules.includes('faces')) fields.push('"faces": { "count": <integer>, "details": [{ "emotion": "<happy|sad|angry|surprised|neutral|fearful|disgusted>", "age_range": "<18-24|25-34|35-44|45-54|55-64|65+>", "gender": "<male|female|unknown>", "lighting_quality": "<excellent|good|fair|poor>", "is_looking_at_camera": <boolean> }], "profile_score": <integer 0-100>, "profile_suggestions": ["<suggestion1>", "<suggestion2>"], "suitable_for_professional": <boolean>, "suitable_for_social": <boolean> }');
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
  const apiKey = process.env.OPENROUTER_API_KEY;
  if (!apiKey) throw new Error('OPENROUTER_API_KEY not set');

  logger.info({ id, modules }, 'Starting analysis');

  const image = req.image;
  const promptText = buildPrompt(modules, language, maxTags, captionStyle);

  let imageContent: unknown;
  if (image.startsWith('https://')) {
    imageContent = { type: 'image_url', image_url: { url: image } };
  } else {
    const raw = image.includes(',') ? image.split(',')[1] : image;
    const mimeMap: Record<string, string> = {
      jpeg: 'image/jpeg', jpg: 'image/jpeg', png: 'image/png', webp: 'image/webp', gif: 'image/gif',
    };
    const mediaType = mimeMap[req.image_format ?? 'jpeg'] ?? 'image/jpeg';
    imageContent = { type: 'image_url', image_url: { url: `data:${mediaType};base64,${raw}` } };
  }

  const response = await fetch(OPENROUTER_API_URL, {
    method: 'POST',
    headers: {
      'Content-Type': 'application/json',
      'Authorization': `Bearer ${apiKey}`,
    },
    body: JSON.stringify({
      model: MODEL,
      max_tokens: 1024,
      messages: [{
        role: 'user',
        content: [
          imageContent,
          { type: 'text', text: promptText },
        ],
      }],
      response_format: { type: 'json_object' },
    }),
  });

  if (!response.ok) {
    const err = await response.text();
    throw new Error(`OpenRouter error: ${response.status} ${err}`);
  }

  const data = await response.json() as { choices: { message: { content: string } }[], usage: { prompt_tokens: number; completion_tokens: number } };
  const rawText = data.choices[0].message.content ?? '{}';

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
    model: MODEL,
    ...(parsed.caption ? { caption: parsed.caption as AnalyzeResponse['caption'] } : {}),
    ...(parsed.summary ? { summary: parsed.summary as AnalyzeResponse['summary'] } : {}),
    ...(parsed.tags ? { tags: parsed.tags as AnalyzeResponse['tags'] } : {}),
    ...(parsed.metadata ? { metadata: parsed.metadata as AnalyzeResponse['metadata'] } : {}),
    ...(parsed.sentiment ? { sentiment: parsed.sentiment as AnalyzeResponse['sentiment'] } : {}),
    ...(parsed.ocr ? { ocr: parsed.ocr as AnalyzeResponse['ocr'] } : {}),
    ...(parsed.faces ? { faces: parsed.faces as AnalyzeResponse['faces'] } : {}),
    latency_ms: Date.now() - t0,
    usage: { input_tokens: data.usage.prompt_tokens, output_tokens: data.usage.completion_tokens },
    created_at: new Date().toISOString(),
  };
}
