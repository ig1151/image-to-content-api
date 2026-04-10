#!/bin/bash
set -e

echo "🚀 Building Image-to-Content API..."

cat > src/types/index.ts << 'HEREDOC'
export type Module = 'caption' | 'summary' | 'tags' | 'metadata' | 'sentiment' | 'ocr';
export type CaptionStyle = 'brief' | 'detailed' | 'alt-text';
export type ImageFormat = 'jpeg' | 'png' | 'webp' | 'gif';
export type JobStatus = 'pending' | 'processing' | 'success' | 'error';
export type Tone = 'positive' | 'neutral' | 'negative' | 'mixed';
export type Setting = 'indoor' | 'outdoor' | 'studio' | 'unknown';
export type Orientation = 'landscape' | 'portrait' | 'square';

export interface AnalyzeRequest {
  image: string;
  image_format?: ImageFormat;
  modules?: Module[];
  language?: string;
  max_tags?: number;
  caption_style?: CaptionStyle;
  async?: boolean;
  webhook_url?: string;
}
export interface CaptionResult { text: string; confidence: number; style: CaptionStyle; }
export interface SummaryResult { short: string; detailed: string; bullets: string[]; }
export interface TagResult { label: string; confidence: number; category: 'object' | 'scene' | 'color' | 'mood' | 'style' | 'action'; }
export interface MetadataResult { scene_type: string; setting: Setting; time_of_day: string; dominant_colors: string[]; objects_detected: string[]; people_count: number; has_text: boolean; aspect_ratio_guess: Orientation; }
export interface SentimentResult { tone: Tone; score: number; emotions: string[]; }
export interface OcrBlock { text: string; confidence: number; }
export interface OcrResult { text: string; blocks: OcrBlock[]; language_detected: string; }
export interface UsageResult { input_tokens: number; output_tokens: number; }
export interface AnalyzeResponse { id: string; status: JobStatus; model: string; caption?: CaptionResult; summary?: SummaryResult; tags?: TagResult[]; metadata?: MetadataResult; sentiment?: SentimentResult; ocr?: OcrResult; latency_ms: number; usage: UsageResult; created_at: string; }
export interface Job { job_id: string; status: JobStatus; created_at: string; completed_at?: string; result?: AnalyzeResponse; error?: string; }
export interface BatchRequest { images: AnalyzeRequest[]; }
HEREDOC

cat > src/utils/config.ts << 'HEREDOC'
import 'dotenv/config';
function required(key: string): string { const val = process.env[key]; if (!val) throw new Error(`Missing required env var: ${key}`); return val; }
function optional(key: string, fallback: string): string { return process.env[key] ?? fallback; }
export const config = {
  anthropic: { apiKey: required('ANTHROPIC_API_KEY'), model: optional('ANTHROPIC_MODEL', 'claude-sonnet-4-20250514') },
  server: { port: parseInt(optional('PORT', '3000'), 10), nodeEnv: optional('NODE_ENV', 'development'), apiVersion: optional('API_VERSION', 'v1') },
  rateLimit: { windowMs: parseInt(optional('RATE_LIMIT_WINDOW_MS', '60000'), 10), maxFree: parseInt(optional('RATE_LIMIT_MAX_FREE', '20'), 10), maxPro: parseInt(optional('RATE_LIMIT_MAX_PRO', '500'), 10) },
  upload: { maxFileSizeMb: parseInt(optional('MAX_FILE_SIZE_MB', '20'), 10), allowedMimeTypes: optional('ALLOWED_MIME_TYPES', 'image/jpeg,image/png,image/webp,image/gif').split(',') },
  jobs: { ttlSeconds: parseInt(optional('JOB_TTL_SECONDS', '3600'), 10) },
  logging: { level: optional('LOG_LEVEL', 'info') },
} as const;
HEREDOC

cat > src/utils/logger.ts << 'HEREDOC'
import pino from 'pino';
import { config } from './config.js';
export const logger = pino({
  level: config.logging.level,
  transport: config.server.nodeEnv === 'development' ? { target: 'pino-pretty', options: { colorize: true } } : undefined,
  base: { service: 'image-to-content-api' },
  timestamp: pino.stdTimeFunctions.isoTime,
  redact: { paths: ['req.headers.authorization'], censor: '[REDACTED]' },
});
HEREDOC

cat > src/utils/validation.ts << 'HEREDOC'
import Joi from 'joi';
const MODULE_VALUES = ['caption', 'summary', 'tags', 'metadata', 'sentiment', 'ocr'] as const;
const CAPTION_STYLES = ['brief', 'detailed', 'alt-text'] as const;
const IMAGE_FORMATS = ['jpeg', 'png', 'webp', 'gif'] as const;
export const analyzeSchema = Joi.object({
  image: Joi.string().required(),
  image_format: Joi.string().valid(...IMAGE_FORMATS).optional(),
  modules: Joi.array().items(Joi.string().valid(...MODULE_VALUES)).min(1).max(6).default(['caption', 'summary', 'tags', 'metadata']),
  language: Joi.string().min(2).max(10).default('en'),
  max_tags: Joi.number().integer().min(1).max(50).default(10),
  caption_style: Joi.string().valid(...CAPTION_STYLES).default('detailed'),
  async: Joi.boolean().default(false),
  webhook_url: Joi.string().uri({ scheme: ['https'] }).optional().when('async', { is: false, then: Joi.forbidden() }),
});
export const batchSchema = Joi.object({
  images: Joi.array().items(analyzeSchema).min(1).max(20).required().messages({ 'array.max': 'Batch endpoint accepts a maximum of 20 images per request' }),
});
HEREDOC

cat > src/services/vision.service.ts << 'HEREDOC'
import Anthropic from '@anthropic-ai/sdk';
import { v4 as uuidv4 } from 'uuid';
import { config } from '../utils/config.js';
import { logger } from '../utils/logger.js';
import type { AnalyzeRequest, AnalyzeResponse, Module, CaptionStyle } from '../types/index.js';

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
HEREDOC

cat > src/services/jobs.service.ts << 'HEREDOC'
import { v4 as uuidv4 } from 'uuid';
import { config } from '../utils/config.js';
import { logger } from '../utils/logger.js';
import type { Job, JobStatus, AnalyzeResponse } from '../types/index.js';
const store = new Map<string, Job>();
setInterval(() => {
  const now = Date.now(); const ttlMs = config.jobs.ttlSeconds * 1000;
  for (const [id, job] of store.entries()) { if (now - new Date(job.created_at).getTime() > ttlMs) { store.delete(id); logger.debug({ job_id: id }, 'Job expired'); } }
}, 60_000);
export function createJob(): Job { const job: Job = { job_id: `job_${uuidv4().replace(/-/g,'').slice(0,12)}`, status: 'pending', created_at: new Date().toISOString() }; store.set(job.job_id, job); return job; }
export function getJob(jobId: string): Job | undefined { return store.get(jobId); }
export function updateJob(jobId: string, status: JobStatus, result?: AnalyzeResponse, error?: string): void { const job = store.get(jobId); if (!job) return; job.status = status; if (result) job.result = result; if (error) job.error = error; if (status === 'success' || status === 'error') job.completed_at = new Date().toISOString(); store.set(jobId, job); }
HEREDOC

cat > src/middleware/error.middleware.ts << 'HEREDOC'
import { Request, Response, NextFunction } from 'express';
import { logger } from '../utils/logger.js';
export function errorHandler(err: Error, req: Request, res: Response, _next: NextFunction): void {
  logger.error({ err, path: req.path }, 'Unhandled error');
  if (err.message?.includes('File too large')) { res.status(413).json({ error: { code: 'FILE_TOO_LARGE', message: err.message } }); return; }
  if (err.constructor.name === 'APIError') { res.status(502).json({ error: { code: 'UPSTREAM_ERROR', message: 'Error communicating with AI provider' } }); return; }
  res.status(500).json({ error: { code: 'INTERNAL_ERROR', message: 'An unexpected error occurred' } });
}
export function notFound(req: Request, res: Response): void { res.status(404).json({ error: { code: 'NOT_FOUND', message: `Route ${req.method} ${req.path} not found` } }); }
HEREDOC

cat > src/middleware/ratelimit.middleware.ts << 'HEREDOC'
import rateLimit from 'express-rate-limit';
import { config } from '../utils/config.js';
export const rateLimiter = rateLimit({
  windowMs: config.rateLimit.windowMs, max: config.rateLimit.maxFree,
  standardHeaders: 'draft-7', legacyHeaders: false,
  keyGenerator: (req) => req.headers['authorization']?.replace('Bearer ', '') ?? req.ip ?? 'unknown',
  handler: (_req, res) => { res.status(429).json({ error: { code: 'RATE_LIMIT_EXCEEDED', message: 'Too many requests.' } }); },
});
HEREDOC

cat > src/routes/health.route.ts << 'HEREDOC'
import { Router, Request, Response } from 'express';
import { config } from '../utils/config.js';
export const healthRouter = Router();
const startTime = Date.now();
healthRouter.get('/', (_req: Request, res: Response) => {
  res.status(200).json({ status: 'ok', version: '1.0.0', model: config.anthropic.model, uptime_seconds: Math.floor((Date.now() - startTime) / 1000), timestamp: new Date().toISOString() });
});
HEREDOC

cat > src/routes/analyze.route.ts << 'HEREDOC'
import { Router, Request, Response, NextFunction } from 'express';
import multer from 'multer';
import { analyzeSchema, batchSchema } from '../utils/validation.js';
import { analyzeImage } from '../services/vision.service.js';
import { createJob, getJob, updateJob } from '../services/jobs.service.js';
import { config } from '../utils/config.js';
import { logger } from '../utils/logger.js';
import type { AnalyzeRequest, BatchRequest } from '../types/index.js';
export const analyzeRouter = Router();
const upload = multer({ storage: multer.memoryStorage(), limits: { fileSize: config.upload.maxFileSizeMb * 1024 * 1024 }, fileFilter: (_req, file, cb) => { config.upload.allowedMimeTypes.includes(file.mimetype) ? cb(null, true) : cb(new Error(`Unsupported mime type: ${file.mimetype}`)); } });

analyzeRouter.post('/', upload.single('image_file'), async (req: Request, res: Response, next: NextFunction) => {
  try {
    let body: AnalyzeRequest = req.body;
    if (req.file) body = { ...body, image: req.file.buffer.toString('base64'), image_format: req.file.mimetype.split('/')[1] as AnalyzeRequest['image_format'] };
    const { error, value } = analyzeSchema.validate(body, { abortEarly: false });
    if (error) { res.status(422).json({ error: { code: 'VALIDATION_ERROR', message: 'Validation failed', details: error.details.map((d) => d.message) } }); return; }
    if (value.async) {
      const job = createJob();
      res.status(202).json({ job_id: job.job_id, status: 'pending' });
      setImmediate(async () => {
        updateJob(job.job_id, 'processing');
        try { const result = await analyzeImage(value); updateJob(job.job_id, 'success', result); }
        catch (err) { updateJob(job.job_id, 'error', undefined, err instanceof Error ? err.message : 'Unknown'); }
      });
      return;
    }
    res.status(200).json(await analyzeImage(value));
  } catch (err) { next(err); }
});

analyzeRouter.post('/batch', async (req: Request, res: Response, next: NextFunction) => {
  try {
    const { error, value } = batchSchema.validate(req.body, { abortEarly: false });
    if (error) { res.status(422).json({ error: { code: 'VALIDATION_ERROR', message: 'Validation failed', details: error.details.map((d) => d.message) } }); return; }
    const t0 = Date.now();
    const results = await Promise.allSettled((value as BatchRequest).images.map((img: AnalyzeRequest) => analyzeImage(img)));
    const out = results.map((r) => r.status === 'fulfilled' ? r.value : { error: r.reason instanceof Error ? r.reason.message : 'Unknown' });
    res.status(200).json({ batch_id: `batch_${Date.now()}`, total: (value as BatchRequest).images.length, succeeded: out.filter((r) => !('error' in r)).length, failed: out.filter((r) => 'error' in r).length, results: out, latency_ms: Date.now() - t0 });
  } catch (err) { next(err); }
});

analyzeRouter.get('/jobs/:jobId', (req: Request, res: Response) => {
  const job = getJob(req.params.jobId);
  if (!job) { res.status(404).json({ error: { code: 'JOB_NOT_FOUND', message: `No job found: ${req.params.jobId}` } }); return; }
  res.status(200).json(job);
});
HEREDOC

cat > src/app.ts << 'HEREDOC'
import express from 'express';
import cors from 'cors';
import helmet from 'helmet';
import compression from 'compression';
import pinoHttp from 'pino-http';
import { analyzeRouter } from './routes/analyze.route.js';
import { healthRouter } from './routes/health.route.js';
import { errorHandler, notFound } from './middleware/error.middleware.js';
import { rateLimiter } from './middleware/ratelimit.middleware.js';
import { logger } from './utils/logger.js';
import { config } from './utils/config.js';
const app = express();
app.use(helmet()); app.use(cors()); app.use(compression());
app.use(pinoHttp({ logger }));
app.use(express.json({ limit: '25mb' }));
app.use(express.urlencoded({ extended: true, limit: '25mb' }));
app.use(`/${config.server.apiVersion}/analyze`, rateLimiter);
app.use(`/${config.server.apiVersion}/analyze`, analyzeRouter);
app.use(`/${config.server.apiVersion}/health`, healthRouter);
app.get('/', (_req, res) => res.redirect(`/${config.server.apiVersion}/health`));
app.use(notFound); app.use(errorHandler);
export { app };
HEREDOC

cat > src/index.ts << 'HEREDOC'
import { app } from './app.js';
import { config } from './utils/config.js';
import { logger } from './utils/logger.js';
const server = app.listen(config.server.port, () => { logger.info({ port: config.server.port, env: config.server.nodeEnv }, '🚀 Image-to-Content API started'); });
const shutdown = (signal: string) => { logger.info({ signal }, 'Shutting down'); server.close(() => { logger.info('Closed'); process.exit(0); }); setTimeout(() => process.exit(1), 10_000); };
process.on('SIGTERM', () => shutdown('SIGTERM'));
process.on('SIGINT', () => shutdown('SIGINT'));
process.on('unhandledRejection', (reason) => logger.error({ reason }, 'Unhandled rejection'));
process.on('uncaughtException', (err) => { logger.fatal({ err }, 'Uncaught exception'); process.exit(1); });
HEREDOC

cat > jest.config.js << 'HEREDOC'
module.exports = { preset: 'ts-jest', testEnvironment: 'node', rootDir: '.', testMatch: ['**/tests/**/*.test.ts'], collectCoverageFrom: ['src/**/*.ts', '!src/index.ts'], setupFiles: ['<rootDir>/tests/setup.ts'] };
HEREDOC

cat > tests/setup.ts << 'HEREDOC'
process.env.ANTHROPIC_API_KEY = 'sk-ant-test-key';
process.env.NODE_ENV = 'test';
process.env.LOG_LEVEL = 'silent';
HEREDOC

cat > .gitignore << 'HEREDOC'
node_modules/
dist/
.env
coverage/
*.log
.DS_Store
HEREDOC

echo ""
echo "✅ All files created! Run: npm install"