export interface ModelConfig {
  id: string;
  name: string;
  provider: string;
  description: string;
  sizes: string[];
  qualities: string[];
  styles?: string[];
  pricing: { [key: string]: number }; // "size-quality" => cost
  defaultSize: string;
  defaultQuality: string;
  deprecated?: boolean;
}

export const MODELS: { [key: string]: ModelConfig } = {
  'gpt-image-1': {
    id: 'gpt-image-1',
    name: 'GPT Image (gpt-image-1)',
    provider: 'openai',
    description: 'Latest OpenAI image model. Best quality, flexible pricing by quality tier.',
    sizes: ['1024x1024', '1536x1024', '1024x1536', 'auto'],
    qualities: ['low', 'medium', 'high'],
    pricing: {
      // Square 1024x1024
      '1024x1024-low': 0.011,
      '1024x1024-medium': 0.042,
      '1024x1024-high': 0.167,
      // Landscape 1536x1024
      '1536x1024-low': 0.011,
      '1536x1024-medium': 0.042,
      '1536x1024-high': 0.167,
      // Portrait 1024x1536
      '1024x1536-low': 0.011,
      '1024x1536-medium': 0.042,
      '1024x1536-high': 0.167,
      // Auto
      'auto-low': 0.011,
      'auto-medium': 0.042,
      'auto-high': 0.167,
    },
    defaultSize: '1024x1024',
    defaultQuality: 'medium',
  },
  'dall-e-3': {
    id: 'dall-e-3',
    name: 'DALL-E 3',
    provider: 'openai',
    description: 'High-quality image generation with strong prompt following.',
    sizes: ['1024x1024', '1792x1024', '1024x1792'],
    qualities: ['standard', 'hd'],
    styles: ['natural', 'vivid'],
    pricing: {
      '1024x1024-standard': 0.040,
      '1024x1024-hd': 0.080,
      '1792x1024-standard': 0.080,
      '1792x1024-hd': 0.120,
      '1024x1792-standard': 0.080,
      '1024x1792-hd': 0.120,
    },
    defaultSize: '1024x1024',
    defaultQuality: 'standard',
  },
  'dall-e-2': {
    id: 'dall-e-2',
    name: 'DALL-E 2',
    provider: 'openai',
    description: 'Fast and cost-effective. Good for bulk generation on a budget.',
    sizes: ['256x256', '512x512', '1024x1024'],
    qualities: ['standard'],
    pricing: {
      '256x256-standard': 0.016,
      '512x512-standard': 0.018,
      '1024x1024-standard': 0.020,
    },
    defaultSize: '1024x1024',
    defaultQuality: 'standard',
    deprecated: true,
  },
};

export function calculateCost(
  modelId: string,
  size: string,
  quality?: string
): number {
  const model = MODELS[modelId];
  if (!model) return 0;

  const q = quality || model.defaultQuality;
  const key = `${size}-${q}`;

  return model.pricing[key] || 0;
}

export function getModelSizes(modelId: string): string[] {
  const model = MODELS[modelId];
  return model ? model.sizes : [];
}

export function getModelQualities(modelId: string): string[] {
  const model = MODELS[modelId];
  return model ? model.qualities : [];
}

export function getModelStyles(modelId: string): string[] {
  const model = MODELS[modelId];
  return model?.styles || [];
}

// Get a human-readable cost summary for display
export function getCostSummary(modelId: string): string {
  const model = MODELS[modelId];
  if (!model) return '';

  const prices = Object.values(model.pricing);
  const min = Math.min(...prices);
  const max = Math.max(...prices);

  if (min === max) return `$${min.toFixed(3)} per image`;
  return `$${min.toFixed(3)} - $${max.toFixed(3)} per image`;
}
