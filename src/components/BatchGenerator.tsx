'use client';

import { useState, useMemo, useCallback } from 'react';
import { useSession } from 'next-auth/react';
import { MODELS, calculateCost, getModelSizes, getModelQualities, getCostSummary, formatPrice } from '@/lib/models';

interface GenerationResult {
  id?: string;
  prompt: string;
  imageUrl?: string;
  status: string;
  errorMessage?: string;
  cost: number;
}

type SeparatorType =
  | 'double-newline'
  | 'single-newline'
  | 'numbered-header'
  | 'numbered-prefix'
  | 'custom'
  | 'triple-dash'
  | 'triple-asterisk';

const SEPARATOR_OPTIONS: { value: SeparatorType; label: string; description: string }[] = [
  {
    value: 'double-newline',
    label: 'Double Line Break',
    description: 'Prompts separated by a blank line',
  },
  {
    value: 'single-newline',
    label: 'Single Line Break',
    description: 'Each line is a separate prompt',
  },
  {
    value: 'numbered-header',
    label: 'Numbered Headers',
    description: 'Detect "Prompt #1", "Prompt #2", etc.',
  },
  {
    value: 'numbered-prefix',
    label: 'Numbered Prefix (1. 2. 3.)',
    description: 'Lines starting with 1., 2., 3., etc.',
  },
  {
    value: 'triple-dash',
    label: 'Triple Dash (---)',
    description: 'Separated by --- on its own line',
  },
  {
    value: 'triple-asterisk',
    label: 'Triple Asterisk (***)',
    description: 'Separated by *** on its own line',
  },
  {
    value: 'custom',
    label: 'Custom Separator',
    description: 'Define your own separator string',
  },
];

function parsePrompts(text: string, separator: SeparatorType, customSeparator: string): string[] {
  if (!text.trim()) return [];

  let prompts: string[] = [];

  switch (separator) {
    case 'double-newline':
      prompts = text.split(/\n\s*\n/).map((p) => p.trim());
      break;

    case 'single-newline':
      prompts = text.split('\n').map((p) => p.trim());
      break;

    case 'numbered-header':
      // Match "Prompt #1", "Prompt #2", "Image #1", etc. with optional dash/colon after
      const headerParts = text.split(/(?=(?:Prompt|Image)\s*#?\s*\d+\s*[—–\-:.]?\s)/i);
      prompts = headerParts.map((p) => p.trim());
      break;

    case 'numbered-prefix':
      // Match lines starting with "1.", "2.", etc. and collect everything until next number
      const numberedParts = text.split(/(?=^\d+\.\s)/m);
      prompts = numberedParts.map((p) => p.trim());
      break;

    case 'triple-dash':
      prompts = text.split(/^---+$/m).map((p) => p.trim());
      break;

    case 'triple-asterisk':
      prompts = text.split(/^\*\*\*+$/m).map((p) => p.trim());
      break;

    case 'custom':
      if (customSeparator) {
        prompts = text.split(customSeparator).map((p) => p.trim());
      } else {
        prompts = [text.trim()];
      }
      break;
  }

  return prompts.filter((p) => p.length > 0);
}

export function BatchGenerator() {
  const { data: session } = useSession();
  const [rawText, setRawText] = useState('');
  const [separator, setSeparator] = useState<SeparatorType>('double-newline');
  const [customSeparator, setCustomSeparator] = useState('');
  const [selectedModel, setSelectedModel] = useState('gpt-image-1.5');
  const [quality, setQuality] = useState('medium');
  const [size, setSize] = useState('1024x1024');
  const [isLoading, setIsLoading] = useState(false);
  const [results, setResults] = useState<GenerationResult[]>([]);
  const [progress, setProgress] = useState({ current: 0, total: 0 });
  const [showPreview, setShowPreview] = useState(true);
  const [autoDownload, setAutoDownload] = useState(true);

  // Parse prompts based on selected separator
  const parsedPrompts = useMemo(
    () => parsePrompts(rawText, separator, customSeparator),
    [rawText, separator, customSeparator]
  );

  const costPerImage = calculateCost(selectedModel, size, quality);
  const totalCost = parsedPrompts.length * costPerImage;

  const qualities = getModelQualities(selectedModel);
  const sizes = getModelSizes(selectedModel);

  // Reset quality/size when model changes
  const handleModelChange = (modelId: string) => {
    setSelectedModel(modelId);
    const model = MODELS[modelId];
    if (model.defaultSize) setSize(model.defaultSize);
    if (model.defaultQuality) setQuality(model.defaultQuality);
    else setQuality('standard');
  };

  const downloadImage = useCallback(async (imageUrl: string, promptText: string, index: number) => {
    try {
      // Use our proxy endpoint to avoid CORS issues
      const response = await fetch(`/api/images/download?url=${encodeURIComponent(imageUrl)}`);
      const blob = await response.blob();
      const url = window.URL.createObjectURL(blob);
      const a = document.createElement('a');
      a.href = url;
      // Create a clean filename from the first ~40 chars of the prompt
      const cleanName = promptText
        .replace(/[^a-zA-Z0-9\s]/g, '')
        .trim()
        .substring(0, 40)
        .trim()
        .replace(/\s+/g, '-');
      a.download = `${cleanName}-${index + 1}.png`;
      document.body.appendChild(a);
      a.click();
      window.URL.revokeObjectURL(url);
      document.body.removeChild(a);
    } catch (error) {
      console.error('Download error:', error);
    }
  }, []);

  const handleGenerate = async () => {
    if (parsedPrompts.length === 0) {
      alert('Please enter at least one prompt');
      return;
    }

    setIsLoading(true);
    setProgress({ current: 0, total: parsedPrompts.length });
    setResults(
      parsedPrompts.map((p) => ({
        prompt: p,
        status: 'pending',
        cost: costPerImage,
      }))
    );

    try {
      const response = await fetch('/api/generate', {
        method: 'POST',
        headers: { 'Content-Type': 'application/json' },
        body: JSON.stringify({
          prompts: parsedPrompts,
          model: selectedModel,
          quality: quality || undefined,
          size,
        }),
      });

      if (!response.ok) {
        const error = await response.json();
        alert(`Error: ${error.error}`);
        setIsLoading(false);
        return;
      }

      const data = await response.json();
      setResults(data.results);
      setProgress({ current: data.successCount, total: data.totalPrompts });

      // Auto-download all successful images
      if (autoDownload) {
        for (let i = 0; i < data.results.length; i++) {
          const result = data.results[i];
          if (result.imageUrl && result.status === 'done') {
            await downloadImage(result.imageUrl, result.prompt, i);
            // Small delay between downloads so browser doesn't block them
            await new Promise((resolve) => setTimeout(resolve, 300));
          }
        }
      }
    } catch (error) {
      console.error('Generation error:', error);
      alert('Failed to generate images. Check your API key and try again.');
    } finally {
      setIsLoading(false);
    }
  };

  const downloadAll = async () => {
    const doneResults = results.filter((r) => r.status === 'done' && r.imageUrl);
    for (let i = 0; i < doneResults.length; i++) {
      await downloadImage(doneResults[i].imageUrl!, doneResults[i].prompt, i);
      await new Promise((resolve) => setTimeout(resolve, 300));
    }
  };

  return (
    <div className="space-y-6">
      {/* Main Generator Card */}
      <div className="bg-gradient-to-br from-slate-800 to-slate-900 rounded-2xl border border-purple-500/30 p-8 shadow-2xl shadow-purple-500/5">
        <div className="flex items-center gap-3 mb-8">
          <div className="w-10 h-10 bg-gradient-to-r from-purple-600 to-blue-600 rounded-lg flex items-center justify-center text-xl">
            🎨
          </div>
          <div>
            <h2 className="text-2xl font-bold text-white">Batch Image Generator</h2>
            <p className="text-gray-400 text-sm">Paste all your prompts, pick a separator, generate everything at once</p>
          </div>
        </div>

        {/* Model Selection */}
        <div className="mb-4">
          <label className="block text-gray-300 font-medium mb-2 text-sm">Model</label>
          <div className="grid grid-cols-1 sm:grid-cols-2 lg:grid-cols-3 gap-2">
            {Object.entries(MODELS).map(([key, model]) => (
              <button
                key={key}
                onClick={() => handleModelChange(key)}
                className={`text-left p-3 rounded-xl border transition-all ${
                  selectedModel === key
                    ? 'bg-purple-600/20 border-purple-500 ring-1 ring-purple-500/50'
                    : 'bg-slate-700/40 border-slate-600/50 hover:border-purple-500/40'
                }`}
              >
                <div className="flex items-center gap-2 mb-1">
                  <span className="text-sm font-semibold text-white">{model.name}</span>
                  {model.recommended && (
                    <span className="text-[10px] bg-green-500/20 text-green-400 px-1.5 py-0.5 rounded-full font-medium">BEST</span>
                  )}
                </div>
                <p className="text-[11px] text-gray-400 leading-tight mb-1.5">{model.description}</p>
                <p className="text-[11px] text-purple-400 font-medium">{getCostSummary(key)}</p>
              </button>
            ))}
          </div>
        </div>

        {/* Model Info Banner */}
        <div className="bg-slate-700/30 rounded-lg border border-slate-600/30 px-4 py-2.5 mb-4 flex flex-wrap items-center gap-x-4 gap-y-1 text-xs">
          <span className="text-gray-400">{MODELS[selectedModel]?.qualityNote}</span>
        </div>

        {/* Settings Row: Size, Quality, Style */}
        <div className="grid grid-cols-1 md:grid-cols-2 gap-4 mb-4">
          {sizes.length > 0 && (
            <div>
              <label className="block text-gray-300 font-medium mb-1.5 text-sm">Size</label>
              <select
                value={size}
                onChange={(e) => setSize(e.target.value)}
                className="w-full bg-slate-700/80 border border-slate-600 rounded-lg px-3 py-2.5 text-white focus:outline-none focus:ring-2 focus:ring-purple-500 focus:border-transparent text-sm"
              >
                {sizes.map((s) => (
                  <option key={s} value={s}>
                    {s === 'auto' ? 'Auto (let AI decide)' : s}
                  </option>
                ))}
              </select>
            </div>
          )}

          {qualities.length > 0 && (
            <div>
              <label className="block text-gray-300 font-medium mb-1.5 text-sm">Quality</label>
              <select
                value={quality}
                onChange={(e) => setQuality(e.target.value)}
                className="w-full bg-slate-700/80 border border-slate-600 rounded-lg px-3 py-2.5 text-white focus:outline-none focus:ring-2 focus:ring-purple-500 focus:border-transparent text-sm"
              >
                {qualities.map((q) => {
                  const price = calculateCost(selectedModel, size, q);
                  return (
                    <option key={q} value={q}>
                      {q.charAt(0).toUpperCase() + q.slice(1)} — {formatPrice(price)}/image
                    </option>
                  );
                })}
              </select>
            </div>
          )}

        </div>

        {/* Live Price Per Image */}
        <div className="bg-purple-500/10 border border-purple-500/20 rounded-lg px-4 py-2.5 mb-6 flex items-center justify-between">
          <span className="text-sm text-purple-300">Price per image with current settings:</span>
          <span className="text-lg font-bold text-purple-400">{formatPrice(calculateCost(selectedModel, size, quality))}</span>
        </div>

        {/* Separator Selection */}
        <div className="bg-slate-700/40 rounded-xl border border-slate-600/50 p-4 mb-6">
          <div className="flex items-center justify-between mb-3">
            <label className="text-gray-300 font-medium text-sm">Prompt Separator</label>
            <span className="text-xs text-gray-500">How should we split your prompts?</span>
          </div>
          <div className="grid grid-cols-2 md:grid-cols-4 gap-2 mb-3">
            {SEPARATOR_OPTIONS.map((opt) => (
              <button
                key={opt.value}
                onClick={() => setSeparator(opt.value)}
                className={`px-3 py-2 rounded-lg text-xs font-medium transition-all ${
                  separator === opt.value
                    ? 'bg-purple-600 text-white border border-purple-400'
                    : 'bg-slate-600/50 text-gray-300 border border-slate-500/50 hover:border-purple-500/50'
                }`}
                title={opt.description}
              >
                {opt.label}
              </button>
            ))}
          </div>
          {separator === 'custom' && (
            <input
              type="text"
              value={customSeparator}
              onChange={(e) => setCustomSeparator(e.target.value)}
              placeholder="Enter your custom separator (e.g., |||, ###, ===)"
              className="w-full bg-slate-700 border border-slate-500 rounded-lg px-3 py-2 text-white text-sm placeholder-gray-400 focus:outline-none focus:ring-2 focus:ring-purple-500"
            />
          )}
        </div>

        {/* Text Area */}
        <div className="mb-4">
          <div className="flex items-center justify-between mb-2">
            <label className="text-gray-300 font-medium text-sm">
              Paste Your Prompts
            </label>
            <div className="flex items-center gap-4">
              <label className="flex items-center gap-2 cursor-pointer">
                <input
                  type="checkbox"
                  checked={autoDownload}
                  onChange={(e) => setAutoDownload(e.target.checked)}
                  className="w-4 h-4 rounded border-slate-500 text-purple-600 focus:ring-purple-500 bg-slate-700"
                />
                <span className="text-xs text-gray-400">Auto-download images</span>
              </label>
              <label className="flex items-center gap-2 cursor-pointer">
                <input
                  type="checkbox"
                  checked={showPreview}
                  onChange={(e) => setShowPreview(e.target.checked)}
                  className="w-4 h-4 rounded border-slate-500 text-purple-600 focus:ring-purple-500 bg-slate-700"
                />
                <span className="text-xs text-gray-400">Show prompt preview</span>
              </label>
            </div>
          </div>
          <textarea
            value={rawText}
            onChange={(e) => setRawText(e.target.value)}
            placeholder={`Paste all your prompts here...\n\nExample with double line breaks:\n\nA beautiful sunset over mountains with golden light...\n\nA futuristic city skyline at night with neon lights...\n\nA serene Japanese garden with cherry blossoms...`}
            className="w-full h-56 bg-slate-700/60 border border-slate-600 rounded-xl px-4 py-3 text-white placeholder-gray-500 focus:outline-none focus:ring-2 focus:ring-purple-500 focus:border-transparent font-mono text-sm leading-relaxed resize-y"
          />
        </div>

        {/* Parsed Prompts Preview */}
        {showPreview && parsedPrompts.length > 0 && (
          <div className="mb-6 bg-slate-700/30 rounded-xl border border-slate-600/30 p-4 max-h-64 overflow-y-auto">
            <div className="flex items-center justify-between mb-3">
              <p className="text-sm font-medium text-purple-400">
                Detected {parsedPrompts.length} prompt{parsedPrompts.length !== 1 ? 's' : ''}
              </p>
              <span className="text-xs text-gray-500">Scroll to verify all prompts</span>
            </div>
            <div className="space-y-2">
              {parsedPrompts.map((prompt, i) => (
                <div
                  key={i}
                  className="flex gap-3 items-start bg-slate-800/60 rounded-lg px-3 py-2 border border-slate-600/20"
                >
                  <span className="text-purple-400 font-bold text-xs mt-0.5 shrink-0 w-6 h-6 bg-purple-600/20 rounded flex items-center justify-center">
                    {i + 1}
                  </span>
                  <p className="text-gray-300 text-xs leading-relaxed line-clamp-3">
                    {prompt}
                  </p>
                </div>
              ))}
            </div>
          </div>
        )}

        {/* Cost Summary */}
        <div className="bg-slate-700/40 rounded-xl border border-slate-600/50 p-4 mb-6">
          <div className="grid grid-cols-3 gap-4 text-center">
            <div>
              <p className="text-gray-400 text-xs mb-1">Images</p>
              <p className="text-xl font-bold text-white">{parsedPrompts.length}</p>
            </div>
            <div>
              <p className="text-gray-400 text-xs mb-1">Cost Per Image</p>
              <p className="text-xl font-bold text-green-400">${costPerImage.toFixed(4)}</p>
            </div>
            <div>
              <p className="text-gray-400 text-xs mb-1">Total Estimated</p>
              <p className="text-xl font-bold text-purple-400">${totalCost.toFixed(3)}</p>
            </div>
          </div>
        </div>

        {/* Progress Bar */}
        {isLoading && progress.total > 0 && (
          <div className="mb-6">
            <div className="flex justify-between items-center mb-2">
              <p className="text-gray-300 text-sm">
                Generating: {progress.current}/{progress.total}
              </p>
              <p className="text-purple-400 text-sm font-medium">
                {Math.round((progress.current / progress.total) * 100)}%
              </p>
            </div>
            <div className="w-full bg-slate-700 rounded-full h-2.5">
              <div
                className="bg-gradient-to-r from-purple-600 to-blue-500 h-2.5 rounded-full transition-all duration-500 ease-out"
                style={{
                  width: `${(progress.current / progress.total) * 100}%`,
                }}
              />
            </div>
          </div>
        )}

        {/* Generate Button */}
        <button
          onClick={handleGenerate}
          disabled={isLoading || parsedPrompts.length === 0}
          className="w-full bg-gradient-to-r from-purple-600 to-blue-600 hover:from-purple-500 hover:to-blue-500 disabled:opacity-40 disabled:cursor-not-allowed text-white font-bold py-4 px-6 rounded-xl transition-all duration-200 text-lg shadow-lg shadow-purple-600/20 hover:shadow-purple-600/40"
        >
          {isLoading
            ? `Generating... (${progress.current}/${progress.total})`
            : parsedPrompts.length > 0
            ? `Generate All ${parsedPrompts.length} Images — $${totalCost.toFixed(3)}`
            : 'Paste prompts above to get started'}
        </button>
      </div>

      {/* Results Grid */}
      {results.length > 0 && (
        <div>
          <div className="flex items-center justify-between mb-4">
            <h3 className="text-xl font-bold text-white">
              Generated Images ({results.filter((r) => r.status === 'done').length}/{results.length})
            </h3>
            {results.some((r) => r.status === 'done') && (
              <button
                onClick={downloadAll}
                className="bg-slate-700 hover:bg-slate-600 text-white px-4 py-2 rounded-lg text-sm font-medium transition border border-slate-600"
              >
                Download All
              </button>
            )}
          </div>
          <div className="grid grid-cols-1 md:grid-cols-2 lg:grid-cols-3 gap-4">
            {results.map((result, index) => (
              <div
                key={index}
                className="bg-slate-800/80 border border-slate-700 rounded-xl overflow-hidden hover:border-purple-500/50 transition-all group"
              >
                {result.imageUrl && result.status === 'done' ? (
                  <div className="relative">
                    <img
                      src={result.imageUrl}
                      alt={result.prompt}
                      className="w-full h-52 object-cover"
                    />
                    <div className="absolute top-2 right-2 bg-green-600/90 text-white px-2 py-1 rounded-md text-xs font-bold backdrop-blur-sm">
                      Done
                    </div>
                    <button
                      onClick={() => downloadImage(result.imageUrl!, result.prompt, index)}
                      className="absolute bottom-2 right-2 bg-slate-900/80 text-white p-2 rounded-lg opacity-0 group-hover:opacity-100 transition backdrop-blur-sm hover:bg-purple-600"
                      title="Download"
                    >
                      <svg className="w-4 h-4" fill="none" stroke="currentColor" viewBox="0 0 24 24">
                        <path strokeLinecap="round" strokeLinejoin="round" strokeWidth={2} d="M12 10v6m0 0l-3-3m3 3l3-3m2 8H7a2 2 0 01-2-2V5a2 2 0 012-2h5.586a1 1 0 01.707.293l5.414 5.414a1 1 0 01.293.707V19a2 2 0 01-2 2z" />
                      </svg>
                    </button>
                  </div>
                ) : result.status === 'pending' ? (
                  <div className="w-full h-52 bg-slate-700/50 flex items-center justify-center">
                    <p className="text-gray-500 text-sm">Waiting...</p>
                  </div>
                ) : result.status === 'generating' ? (
                  <div className="w-full h-52 bg-slate-700/50 flex items-center justify-center">
                    <div className="text-center">
                      <div className="w-8 h-8 border-2 border-purple-500 border-t-transparent rounded-full animate-spin mx-auto mb-2" />
                      <p className="text-gray-400 text-sm">Generating...</p>
                    </div>
                  </div>
                ) : (
                  <div className="w-full h-52 bg-red-900/20 flex items-center justify-center border-b border-red-800/30">
                    <div className="text-center px-4">
                      <p className="text-red-400 font-medium text-sm mb-1">Failed</p>
                      <p className="text-red-300/70 text-xs">{result.errorMessage}</p>
                    </div>
                  </div>
                )}
                <div className="p-3">
                  <p className="text-gray-300 text-xs line-clamp-2 leading-relaxed">{result.prompt}</p>
                  <div className="flex justify-between items-center mt-2">
                    <p className="text-purple-400/70 text-xs">
                      ${result.cost.toFixed(4)}
                    </p>
                    <span className={`text-xs px-2 py-0.5 rounded-full ${
                      result.status === 'done' ? 'bg-green-600/20 text-green-400' :
                      result.status === 'failed' ? 'bg-red-600/20 text-red-400' :
                      'bg-yellow-600/20 text-yellow-400'
                    }`}>
                      {result.status}
                    </span>
                  </div>
                </div>
              </div>
            ))}
          </div>
        </div>
      )}
    </div>
  );
}
