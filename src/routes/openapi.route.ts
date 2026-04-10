import { Router, Request, Response } from 'express';
import { config } from '../utils/config';

export const openapiRouter = Router();

openapiRouter.get('/', (_req: Request, res: Response) => {
  res.status(200).json({
    openapi: '3.0.3',
    info: {
      title: 'Image to Content API',
      version: '1.0.0',
      description: 'Convert any image into captions, tags, summaries, metadata, sentiment and OCR — powered by Claude AI.',
    },
    servers: [
      { url: 'https://image-to-content-api.onrender.com', description: 'Production' },
      { url: `http://localhost:${config.server.port}`, description: 'Local' },
    ],
    paths: {
      '/v1/health': {
        get: {
          summary: 'Health check',
          operationId: 'getHealth',
          responses: {
            '200': { description: 'Service is healthy' },
          },
        },
      },
      '/v1/analyze': {
        post: {
          summary: 'Analyze a single image',
          operationId: 'analyzeImage',
          requestBody: {
            required: true,
            content: {
              'application/json': {
                schema: { $ref: '#/components/schemas/AnalyzeRequest' },
                examples: {
                  url_input: {
                    summary: 'Image URL input',
                    value: {
                      image: 'https://example.com/photo.jpg',
                      modules: ['caption', 'tags', 'metadata'],
                      language: 'en',
                      caption_style: 'detailed',
                      max_tags: 10,
                    },
                  },
                },
              },
            },
          },
          responses: {
            '200': { description: 'Successful analysis' },
            '202': { description: 'Async job accepted' },
            '422': { description: 'Validation error' },
            '429': { description: 'Rate limit exceeded' },
            '500': { description: 'Internal server error' },
          },
        },
      },
      '/v1/analyze/batch': {
        post: {
          summary: 'Analyze up to 20 images in one request',
          operationId: 'analyzeImageBatch',
          requestBody: {
            required: true,
            content: {
              'application/json': {
                schema: { $ref: '#/components/schemas/BatchRequest' },
              },
            },
          },
          responses: {
            '200': { description: 'Batch results' },
            '422': { description: 'Validation error' },
          },
        },
      },
      '/v1/analyze/jobs/{job_id}': {
        get: {
          summary: 'Poll async job status',
          operationId: 'getJob',
          parameters: [
            { name: 'job_id', in: 'path', required: true, schema: { type: 'string' } },
          ],
          responses: {
            '200': { description: 'Job status and result' },
            '404': { description: 'Job not found' },
          },
        },
      },
    },
    components: {
      schemas: {
        AnalyzeRequest: {
          type: 'object',
          required: ['image'],
          properties: {
            image: { type: 'string', description: 'Base64-encoded image or HTTPS URL' },
            image_format: { type: 'string', enum: ['jpeg', 'png', 'webp', 'gif'] },
            modules: {
              type: 'array',
              items: { type: 'string', enum: ['caption', 'summary', 'tags', 'metadata', 'sentiment', 'ocr'] },
              default: ['caption', 'summary', 'tags', 'metadata'],
            },
            language: { type: 'string', default: 'en' },
            max_tags: { type: 'integer', minimum: 1, maximum: 50, default: 10 },
            caption_style: { type: 'string', enum: ['brief', 'detailed', 'alt-text'], default: 'detailed' },
            async: { type: 'boolean', default: false },
            webhook_url: { type: 'string', format: 'uri' },
          },
        },
        AnalyzeResponse: {
          type: 'object',
          properties: {
            id: { type: 'string', example: 'req_abc123' },
            status: { type: 'string', enum: ['success', 'error', 'pending'] },
            model: { type: 'string', example: 'claude-sonnet-4-20250514' },
            caption: {
              type: 'object',
              properties: {
                text: { type: 'string' },
                confidence: { type: 'number', minimum: 0, maximum: 1 },
                style: { type: 'string' },
              },
            },
            summary: {
              type: 'object',
              properties: {
                short: { type: 'string' },
                detailed: { type: 'string' },
                bullets: { type: 'array', items: { type: 'string' } },
              },
            },
            tags: {
              type: 'array',
              items: {
                type: 'object',
                properties: {
                  label: { type: 'string' },
                  confidence: { type: 'number' },
                  category: { type: 'string', enum: ['object', 'scene', 'color', 'mood', 'style', 'action'] },
                },
              },
            },
            metadata: {
              type: 'object',
              properties: {
                scene_type: { type: 'string' },
                setting: { type: 'string', enum: ['indoor', 'outdoor', 'studio', 'unknown'] },
                time_of_day: { type: 'string' },
                dominant_colors: { type: 'array', items: { type: 'string' } },
                objects_detected: { type: 'array', items: { type: 'string' } },
                people_count: { type: 'integer' },
                has_text: { type: 'boolean' },
                aspect_ratio_guess: { type: 'string', enum: ['landscape', 'portrait', 'square'] },
              },
            },
            sentiment: {
              type: 'object',
              properties: {
                tone: { type: 'string', enum: ['positive', 'neutral', 'negative', 'mixed'] },
                score: { type: 'number', minimum: -1, maximum: 1 },
                emotions: { type: 'array', items: { type: 'string' } },
              },
            },
            ocr: {
              type: 'object',
              properties: {
                text: { type: 'string' },
                blocks: { type: 'array', items: { type: 'object', properties: { text: { type: 'string' }, confidence: { type: 'number' } } } },
                language_detected: { type: 'string' },
              },
            },
            latency_ms: { type: 'integer', example: 5585 },
            usage: {
              type: 'object',
              properties: {
                input_tokens: { type: 'integer' },
                output_tokens: { type: 'integer' },
              },
            },
            created_at: { type: 'string', format: 'date-time' },
          },
        },
        BatchRequest: {
          type: 'object',
          required: ['images'],
          properties: {
            images: {
              type: 'array',
              items: { $ref: '#/components/schemas/AnalyzeRequest' },
              minItems: 1,
              maxItems: 20,
            },
          },
        },
        Job: {
          type: 'object',
          properties: {
            job_id: { type: 'string' },
            status: { type: 'string', enum: ['pending', 'processing', 'success', 'error'] },
            created_at: { type: 'string', format: 'date-time' },
            completed_at: { type: 'string', format: 'date-time' },
            result: { $ref: '#/components/schemas/AnalyzeResponse' },
            error: { type: 'string' },
          },
        },
      },
    },
  });
});