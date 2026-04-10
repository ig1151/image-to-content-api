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
