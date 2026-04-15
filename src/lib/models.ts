export interface ModelConfig {
  id: string;
  name: string;
  provider: string;
  description: string;
  qualityNote: string; // Helps user understand what quality level means
  sizes: string[];
  qualities: string[];
  styles?: string[];
  pricing: { [key: string]: number }; // "size-quality" => cost per image
  defaultSize: string;
  defaultQuality: string;
  deprecated?: boolean;
  deprecationDate?: string;
  recommended?: boolean;
}

export const MODELS: { [key: string]: ModelConfig } = {
  'gpt-image-1.5': {
    id: 'gpt-image-1.5',
    name: 'GPT Image 1.5',
    provider: 'openai',
    description: 'Latest flagship model. Best quality, strongest prompt following, photorealistic results.',
    qualityNote: 'Low = fast drafts, Medium = good balance, High = photorealistic detail',
    sizes: ['1024x1024', '1536x1024', '1024x1536', 'auto'],
    qualities: ['low', 'medium', 'high'],
    pricing: {
      '1024x1024-low': 0.009,
      '1024x1024-medium': 0.034,
      '1024x1024-high': 0.133,
      '1536x1024-low': 0.013,
      '1536x1024-medium': 0.050,
      '1536x1024-high': 0.200,
      '1024x1536-low': 0.013,
      '1024x1536-medium': 0.050,
      '1024x1536-high': 0.200,
      'auto-low': 0.013,
      'auto-medium': 0.050,
      'auto-high': 0.200,
    },
    defaultSize: '1024x1024',
    defaultQuality: 'medium',
    recommended: true,
  },
  'gpt-image-1': {
    id: 'gpt-image-1',
    name: 'GPT Image 1',
    provider: 'openai',
    description: 'Previous flagship. High quality with flexible pricing tiers. Great all-rounder.',
    qualityNote: 'Low = basic output, Medium = detailed, High = maximum fidelity (expensive)',
    sizes: ['1024x1024', '1536x1024', '1024x1536', 'auto'],
    qualities: ['low', 'medium', 'high'],
    pricing: {
      '1024x1024-low': 0.011,
      '1024x1024-medium': 0.042,
      '1024x1024-high': 0.167,
      '1536x1024-low': 0.011,
      '1536x1024-medium': 0.042,
      '1536x1024-high': 0.167,
      '1024x1536-low': 0.011,
      '1024x1536-medium': 0.042,
      '1024x1536-high': 0.167,
      'auto-low': 0.011,
      'auto-medium': 0.042,
      'auto-high': 0.167,
    },
    defaultSize: '1024x1024',
    defaultQuality: 'medium',
  },
  'gpt-image-1-mini': {
    id: 'gpt-image-1-mini',
    name: 'GPT Image 1 Mini',
    provider: 'openai',
    description: 'Budget-friendly model. 55-78% cheaper than GPT Image 1. Best for bulk/batch generation.',
    qualityNote: 'Low = cheapest ($0.005!), Medium = decent quality, High = good but not as sharp as full models',
    sizes: ['1024x1024', '1536x1024', '1024x1536', 'auto'],
    qualities: ['low', 'medium', 'high'],
    pricing: {
      '1024x1024-low': 0.005,
      '1024x1024-medium': 0.011,
      '1024x1024-high': 0.036,
      '1536x1024-low': 0.007,
      '1536x1024-medium': 0.016,
      '1536x1024-high': 0.054,
      '1024x1536-low': 0.007,
      '1024x1536-medium': 0.016,
      '1024x1536-high': 0.054,
      'auto-low': 0.007,
      'auto-medium': 0.016,
      'auto-high': 0.054,
    },
    defaultSize: '1024x1024',
    defaultQuality: 'medium',
  },
  'dall-e-3': {
    id: 'dall-e-3',
    name: 'DALL-E 3',
    provider: 'openai',
    description: 'Strong prompt following with vivid/natural styles. Being deprecated May 12, 2026.',
    qualityNote: 'Standard = good quality, HD = more detail & sharper (2x cost)',
    sizes: ['1024x1024', '1792x1024', '1024x1792'],
    qualities: ['standard', 'hd'],
    styles: ['vivid', 'natural'],
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
    deprecated: true,
    deprecationDate: '2026-05-12',
  },
  'dall-e-2': {
    id: 'dall-e-2',
    name: 'DALL-E 2',
    provider: 'openai',
    description: 'Legacy model. Cheapest DALL-E option but lower quality. Deprecated May 12, 2026.',
    qualityNote: 'Single quality level. Smaller sizes are slightly cheaper.',
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
    deprecationDate: '2026-05-12',
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

// Format price for display
export function formatPrice(price: number): string {
  if (price < 0.01) return `$${price.toFixed(4)}`;
  if (price < 0.10) return `$${price.toFixed(3)}`;
  return `$${price.toFixed(2)}`;
}

// Get cost for a batch of images
export function calculateBatchCost(
  modelId: string,
  size: string,
  quality: string,
  count: number
): number {
  return calculateCost(modelId, size, quality) * count;
}
