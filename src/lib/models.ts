export interface ModelConfig {
  id: string;
  name: string;
  provider: string;
  description: string;
  qualityNote: string; // Helps user understand what quality level means
  sizes: string[];
  qualities: string[];
  pricing: { [key: string]: number }; // "size-quality" => cost per image
  defaultSize: string;
  defaultQuality: string;
  recommended?: boolean;
}

export const MODELS: { [key: string]: ModelConfig } = {
  'gpt-image-2': {
    id: 'gpt-image-2',
    name: 'GPT Image 2',
    provider: 'openai',
    description: 'Latest flagship model. Best quality, strongest prompt following, photorealistic results.',
    qualityNote: 'Low = fast drafts, Medium = good balance, High = photorealistic detail',
    sizes: ['1024x1024', '1536x1024', '1024x1536', 'auto'],
    qualities: ['low', 'medium', 'high'],
    pricing: {
      '1024x1024-low': 0.006,
      '1024x1024-medium': 0.053,
      '1024x1024-high': 0.211,
      '1536x1024-low': 0.005,
      '1536x1024-medium': 0.041,
      '1536x1024-high': 0.165,
      '1024x1536-low': 0.005,
      '1024x1536-medium': 0.041,
      '1024x1536-high': 0.165,
      'auto-low': 0.006,
      'auto-medium': 0.053,
      'auto-high': 0.211,
    },
    defaultSize: '1024x1024',
    defaultQuality: 'medium',
    recommended: true,
  },
  'gpt-image-1.5': {
    id: 'gpt-image-1.5',
    name: 'GPT Image 1.5 (retiring Dec 1, 2026)',
    provider: 'openai',
    description: 'Previous flagship. OpenAI shuts this model down on Dec 1, 2026 — switch to GPT Image 2.',
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
  },
  'gpt-image-1': {
    id: 'gpt-image-1',
    name: 'GPT Image 1 (retiring Oct 23, 2026)',
    provider: 'openai',
    description: 'Older model. OpenAI shuts this model down on Oct 23, 2026 — switch to GPT Image 2.',
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
    name: 'GPT Image 1 Mini (retiring Dec 1, 2026)',
    provider: 'openai',
    description: 'Cheapest option for bulk/batch, but OpenAI shuts it down on Dec 1, 2026 — switch to GPT Image 2.',
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
