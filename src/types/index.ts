export type Module = 'caption' | 'summary' | 'tags' | 'metadata' | 'sentiment' | 'ocr' | 'faces';
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
export interface FaceDetail {
  emotion: string;
  age_range: string;
  gender: string;
  lighting_quality: 'excellent' | 'good' | 'fair' | 'poor';
  is_looking_at_camera: boolean;
}

export interface FacesResult {
  count: number;
  details: FaceDetail[];
  profile_score?: number;
  profile_suggestions?: string[];
  suitable_for_professional?: boolean;
  suitable_for_social?: boolean;
}
export interface AnalyzeResponse { id: string; status: JobStatus; model: string; caption?: CaptionResult; summary?: SummaryResult; tags?: TagResult[]; metadata?: MetadataResult; sentiment?: SentimentResult; ocr?: OcrResult; faces?: FacesResult; latency_ms: number; usage: UsageResult; created_at: string; }
export interface Job { job_id: string; status: JobStatus; created_at: string; completed_at?: string; result?: AnalyzeResponse; error?: string; }
export interface BatchRequest { images: AnalyzeRequest[]; }
