/**
 * Gemini model names and their corresponding API paths
 */
export const GEMINI_MODELS = {
  'gemini-1.0-pro': 'models/gemini-1.0-pro',
  'gemini-1.5-flash': 'models/gemini-1.5-flash',
  'gemini-1.5-pro': 'models/gemini-1.5-pro',
  'gemini-2.0-flash': 'models/gemini-2.0-flash',
  'gemini-2.0-flash-lite': 'models/gemini-2.0-flash-lite',
  'gemini-2.5-flash-preview-04-17': 'gemini-2.5-flash-preview-04-17',
} as const;

export const DEFAULT_GEMINI_MODEL = 'gemini-2.5-flash-preview-04-17' as const;
export const DEFAULT_GEMINI_MODEL_LITE = 'gemini-2.0-flash-lite' as const;

export type GeminiModelName = keyof typeof GEMINI_MODELS; 