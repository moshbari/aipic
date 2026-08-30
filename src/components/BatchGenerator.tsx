'use client';

import { useState, useMemo, useCallback } from 'react';
import { useSession } from 'next-auth/react';
import { MODELS, calculateCost, getModelSizes, getModelQualities, getCostSummary, formatPrice, sizeLabel } from '@/lib/models';

// Big batches are split into groups this size and sent one group at a time.
// Keeps every request comfortably inside the server's 5 minute limit, so the
// user can paste 50 prompts and walk away.
const GROUP_SIZE = 10;

// Client-side mirror of the server's smart dimension detection.
// Keep in sync with extractSizeFromPrompt in src/app/api/generate/route.ts —
// this one only drives the cost preview, the server's is authoritative.
function detectSizeFromPrompt(prompt: string, model: string): string | null {
  const lower = prompt.toLowerCase();
  const allowed = MODELS[model]?.sizes || ['1024x1024', '1536x1024', '1024x1536', 'auto'];
  const pick = (size: string) => (allowed.includes(size) ? size : null);

  // 1. Exact pixel dimensions (e.g. "1024x1536")
  const pixelMatch = prompt.match(/\b(\d{3,4})\s*[xX×]\s*(\d{3,4})\b/);
  if (pixelMatch) {
    const extracted = `${pixelMatch[1]}x${pixelMatch[2]}`;
    if (allowed.includes(extracted)) {
      return extracted;
    }
  }

  // 2. Widescreen requests — "16:9", "16x9", "widescreen"
  if (/\b16\s*[:x×]\s*9\b/.test(lower) || lower.includes('widescreen')) {
    return pick('1536x864') || pick('1536x1024');
  }

  // 3. Inch dimensions (e.g. "6x3.5 inches", "5x5 inches")
  const inchMatch = prompt.match(/\b(\d+(?:\.\d+)?)\s*[xX×]\s*(\d+(?:\.\d+)?)\s*(?:inches|inch|in\b|")?/i);
  if (inchMatch) {
    const w = parseFloat(inchMatch[1]);
    const h = parseFloat(inchMatch[2]);
    if (w > 0 && h > 0) {
      const ratio = w / h;
      if (ratio > 1.65 && ratio < 1.9) {
        const wide = pick('1536x864');
        if (wide) return wide;
      }
      if (ratio > 1.15) return pick('1536x1024');
      if (ratio < 0.87) return pick('1024x1536');
      return pick('1024x1024');
    }
  }

  // 4. Orientation keywords
  if (lower.includes('landscape')) return pick('1536x1024');
  if (lower.includes('portrait')) return pick('1024x1536');
  if (lower.includes('square')) return pick('1024x1024');

  return null;
}

/**
 * Extract a meaningful filename from a prompt. Detects:
 *   "1. Title", "1) Title", "Prompt #1 — Title", "Image #1 - Title"
 * and produces "01 — Title". Falls back to the first 40 chars
 * of the prompt body if no header is found.
 */
function extractFilename(promptText: string, fallbackIndex: number): string {
  const trimmed = promptText.trim();

  // Sanitise a title for safe filenames (Win/macOS/Linux).
  const sanitiseTitle = (raw: string) =>
    raw
      .split(/[.\n]/)[0]
      .replace(/[<>:"/\\|?*\x00-\x1f]/g, '')
      .replace(/\s+/g, ' ')
      .trim()
      .substring(0, 80);

  // Pattern A: "Prompt #1 — Title" or "Image #2 - Title"
  const headerMatch = trimmed.match(
    /^(?:Prompt|Image)\s*#?\s*(\d+)\s*[—–\-:.]\s*([^\n]+)/i
  );
  if (headerMatch) {
    const num = headerMatch[1].padStart(2, '0');
    const title = sanitiseTitle(headerMatch[2]);
    if (title) return `${num} — ${title}`;
  }

  // Pattern B: "1. Title" or "1) Title" on the first line
  const numberedMatch = trimmed.match(/^(\d+)[\.\)]\s+([^\n]+)/);
  if (numberedMatch) {
    const num = numberedMatch[1].padStart(2, '0');
    const title = sanitiseTitle(numberedMatch[2]);
    if (title) return `${num} — ${title}`;
  }

  // Fallback: first 40 alphanumeric chars of the prompt body
  const fallback = trimmed
    .replace(/[^a-zA-Z0-9\s]/g, '')
    .trim()
    .substring(0, 40)
    .trim()
    .replace(/\s+/g, '-');
  return `${fallback}-${fallbackIndex + 1}`;
}

/**
 * Extract a short, human-readable title for an image:
 * the first 5 words of the prompt (after stripping any leading
 * number prefix like "1." or "Prompt #1 —").
 */
function extractTitle(promptText: string): string {
  let trimmed = promptText.trim();
  // Strip "Prompt #N — " or "Image #N - " style headers
  trimmed = trimmed.replace(/^(?:Prompt|Image)\s*#?\s*\d+\s*[—–\-:.]\s*/i, "");
  // Strip leading "N." or "N)" numeric prefix
  trimmed = trimmed.replace(/^\d+[\.\)]\s*/, "");
  const words = trimmed.split(/\s+/).filter(Boolean).slice(0, 5);
  return words.join(" ") || "Untitled";
}

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
  const [selectedModel, setSelectedModel] = useState('gpt-image-2');
  const [quality, setQuality] = useState('medium');
  const [size, setSize] = useState('1024x1024');
  const [isLoading, setIsLoading] = useState(false);
  const [results, setResults] = useState<GenerationResult[]>([]);
  const [progress, setProgress] = useState({ current: 0, total: 0 });
  const [groupProgress, setGroupProgress] = useState({ current: 0, total: 0 });
  const [showPreview, setShowPreview] = useState(true);
  const [autoDownload, setAutoDownload] = useState(true);
  const [selectedIndices, setSelectedIndices] = useState<Set<number>>(new Set());
  const [copiedKey, setCopiedKey] = useState<string | null>(null);
  // The page owns the batch id so a run can always be traced back to its rows
  const [batchId, setBatchId] = useState<string | null>(null);
  const [isRetrying, setIsRetrying] = useState(false);
  const [retryProgress, setRetryProgress] = useState({ current: 0, total: 0 });
  const [recoveryNotice, setRecoveryNotice] = useState<string | null>(null);

  // Parse prompts based on selected separator
  const parsedPrompts = useMemo(
    () => parsePrompts(rawText, separator, customSeparator),
    [rawText, separator, customSeparator]
  );

  // Calculate cost per prompt (accounting for per-prompt dimension overrides)
  const promptCosts = useMemo(() => {
    return parsedPrompts.map((prompt) => {
      const detectedSize = detectSizeFromPrompt(prompt, selectedModel);
      const effectiveSize = detectedSize || size;
      return {
        detectedSize,
        effectiveSize,
        cost: calculateCost(selectedModel, effectiveSize, quality),
      };
    });
  }, [parsedPrompts, selectedModel, size, quality]);

  const costPerImage = calculateCost(selectedModel, size, quality);
  const totalCost = promptCosts.reduce((sum, p) => sum + p.cost, 0) || 0;

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
      let response: Response;

      if (imageUrl.startsWith('data:')) {
        // Base64 data URL — convert directly to blob, no proxy needed
        response = await fetch(imageUrl);
      } else {
        // External URL — use our proxy endpoint to avoid CORS issues
        response = await fetch(`/api/images/download?url=${encodeURIComponent(imageUrl)}`);
      }
      const blob = await response.blob();
      const url = window.URL.createObjectURL(blob);
      const a = document.createElement('a');
      a.href = url;
      a.download = `${extractFilename(promptText, index)}.png`;
      document.body.appendChild(a);
      a.click();
      window.URL.revokeObjectURL(url);
      document.body.removeChild(a);
    } catch (error) {
      console.error('Download error:', error);
    }
  }, []);


  const showCopiedBadge = (key: string) => {
    setCopiedKey(key);
    setTimeout(() => {
      setCopiedKey((prev) => (prev === key ? null : prev));
    }, 1500);
  };

  const copyToClipboard = useCallback(async (text: string, key: string) => {
    try {
      if (navigator.clipboard && window.isSecureContext) {
        await navigator.clipboard.writeText(text);
      } else {
        const ta = document.createElement("textarea");
        ta.value = text;
        ta.style.position = "fixed";
        ta.style.opacity = "0";
        document.body.appendChild(ta);
        ta.select();
        document.execCommand("copy");
        document.body.removeChild(ta);
      }
      showCopiedBadge(key);
    } catch (err) {
      console.error("Copy failed:", err);
      alert("Copy failed. Please copy manually.");
    }
  }, []);

  const copySingleImage = useCallback(
    (result: GenerationResult) => {
      if (!result.imageUrl) return;
      const title = extractTitle(result.prompt);
      const text = `${title}\n${result.imageUrl}`;
      copyToClipboard(text, `single-${title}-${result.imageUrl}`);
    },
    [copyToClipboard]
  );

  const toggleSelected = useCallback((index: number) => {
    setSelectedIndices((prev) => {
      const next = new Set(prev);
      if (next.has(index)) next.delete(index);
      else next.add(index);
      return next;
    });
  }, []);

  const selectAllDone = useCallback(() => {
    setSelectedIndices((prev) => {
      const next = new Set(prev);
      results.forEach((r, i) => {
        if (r.status === "done" && r.imageUrl) next.add(i);
      });
      return next;
    });
  }, [results]);

  const clearSelection = useCallback(() => {
    setSelectedIndices(new Set());
  }, []);

  const copySelected = useCallback(() => {
    const ordered = Array.from(selectedIndices)
      .sort((a, b) => a - b)
      .map((i) => results[i])
      .filter((r): r is GenerationResult => !!r && !!r.imageUrl && r.status === "done");

    if (ordered.length === 0) {
      alert("Select at least one finished image first.");
      return;
    }
    const text = ordered
      .map((r) => `${extractTitle(r.prompt)}\n${r.imageUrl}`)
      .join("\n\n");
    copyToClipboard(text, "multi");
  }, [selectedIndices, results, copyToClipboard]);

  // Match rows coming back from the database onto the cards on screen. Rows
  // are created in prompt order and two identical prompts are interchangeable,
  // so lining them up by prompt text, in order, is exact.
  const applyRows = (cards: GenerationResult[], rows: GenerationResult[]): GenerationResult[] => {
    const pool = new Map<string, GenerationResult[]>();
    rows.forEach((row) => {
      const list = pool.get(row.prompt) || [];
      list.push(row);
      pool.set(row.prompt, list);
    });
    return cards.map((card) => {
      const match = (pool.get(card.prompt) || []).shift();
      if (!match) return card;
      // A card that already has its picture is never downgraded
      if (card.status === 'done' && card.imageUrl) return card;
      return { ...card, ...match };
    });
  };

  /**
   * The reply to a group can go missing — a proxy timeout, a sleeping laptop,
   * dropped wifi — while the images are made and paid for anyway. Ask the
   * server what actually landed instead of writing the group off and paying
   * for the same pictures a second time.
   */
  const reconcile = async (
    id: string,
    cards: GenerationResult[],
    { wait = false }: { wait?: boolean } = {}
  ): Promise<GenerationResult[]> => {
    const attempts = wait ? 12 : 1; // up to ~3 minutes of waiting
    let current = cards;
    for (let attempt = 0; attempt < attempts; attempt++) {
      try {
        const res = await fetch(`/api/generate?batchId=${encodeURIComponent(id)}`);
        if (!res.ok) break;
        const data = await res.json();
        current = applyRows(current, (data.results || []) as GenerationResult[]);
        setResults(current);
        if (!data.stillRunning) break;
      } catch (err) {
        console.error('Could not read batch status:', err);
        break;
      }
      if (attempt < attempts - 1) {
        setRecoveryNotice('A group timed out — checking which of those images were finished anyway...');
        await new Promise((r) => setTimeout(r, 15000));
      }
    }
    setRecoveryNotice(null);
    return current;
  };

  const handleGenerate = async () => {
    if (parsedPrompts.length === 0) {
      alert('Please enter at least one prompt');
      return;
    }

    // The page owns the batch id, so a lost reply can still be traced back to
    // exactly these images.
    const runBatchId =
      typeof crypto !== 'undefined' && crypto.randomUUID
        ? crypto.randomUUID()
        : `b-${Date.now()}-${Math.random().toString(36).slice(2)}`;
    setBatchId(runBatchId);

    // Split into groups of GROUP_SIZE and run them back to back
    const groups: { prompts: string[]; offset: number }[] = [];
    for (let i = 0; i < parsedPrompts.length; i += GROUP_SIZE) {
      groups.push({ prompts: parsedPrompts.slice(i, i + GROUP_SIZE), offset: i });
    }

    setIsLoading(true);
    setProgress({ current: 0, total: parsedPrompts.length });
    setSelectedIndices(new Set());
    setGroupProgress({ current: 1, total: groups.length });

    // One local copy of the cards for the whole run, mirrored into state after
    // every change — so recovery and retries always work from what is real.
    let cards: GenerationResult[] = parsedPrompts.map((p) => ({
      prompt: p,
      status: 'pending',
      cost: costPerImage,
    }));
    setResults(cards);

    const write = (next: GenerationResult[]) => {
      cards = next;
      setResults(next);
    };

    let processed = 0;

    for (let g = 0; g < groups.length; g++) {
      const group = groups[g];
      setGroupProgress({ current: g + 1, total: groups.length });

      // Mark this group as in-flight so the user can see where we are
      write(
        cards.map((card, i) =>
          i >= group.offset && i < group.offset + group.prompts.length
            ? { ...card, status: 'generating' }
            : card
        )
      );

      try {
        const response = await fetch('/api/generate', {
          method: 'POST',
          headers: { 'Content-Type': 'application/json' },
          body: JSON.stringify({
            batchId: runBatchId,
            prompts: group.prompts,
            model: selectedModel,
            quality: quality || undefined,
            size,
          }),
        });

        if (!response.ok) {
          const error = await response.json().catch(() => ({ error: 'Request failed' }));

          // A rejected key or bad setup will fail every remaining group too —
          // stop now instead of burning through the rest.
          if (response.status === 400 || response.status === 401) {
            alert(`Error: ${error.error}`);
            write(
              cards.map((card, i) =>
                i >= group.offset && (card.status === 'pending' || card.status === 'generating')
                  ? { ...card, status: 'failed', errorMessage: error.error, cost: 0 }
                  : card
              )
            );
            setIsLoading(false);
            return;
          }

          throw new Error(error.error || 'Group failed');
        }

        const data = await response.json();
        const groupResults = (data.results || []) as GenerationResult[];
        write(
          cards.map((card, i) => {
            const inGroup = i >= group.offset && i < group.offset + group.prompts.length;
            const r = inGroup ? groupResults[i - group.offset] : undefined;
            return r ? { ...card, ...r } : card;
          })
        );
      } catch (error: any) {
        // This group broke. Before calling anything failed, ask the database
        // what really happened — then carry on with the next group so a single
        // hiccup doesn't throw away a 50 image run.
        console.error(`Group ${g + 1} error:`, error);
        const message = error?.message || 'Generation failed';
        write(await reconcile(runBatchId, cards, { wait: true }));
        write(
          cards.map((card, i) =>
            i >= group.offset &&
            i < group.offset + group.prompts.length &&
            card.status !== 'done'
              ? { ...card, status: 'failed', errorMessage: card.errorMessage || message, cost: 0 }
              : card
          )
        );
      }

      processed += group.prompts.length;
      setProgress({ current: processed, total: parsedPrompts.length });

      // Download this group's images now rather than waiting for every group
      if (autoDownload) {
        for (let i = group.offset; i < group.offset + group.prompts.length; i++) {
          const result = cards[i];
          if (result?.imageUrl && result.status === 'done') {
            await downloadImage(result.imageUrl, result.prompt, i);
            // Small delay between downloads so browser doesn't block them
            await new Promise((resolve) => setTimeout(resolve, 300));
          }
        }
      }
    }

    setIsLoading(false);
  };

  /**
   * Try the failed cards again — in place.
   *
   * Rows that already have an image are handed straight back by the server, so
   * pressing this can never make a second copy of a picture that worked, and
   * never charges for one twice. Nothing new is appended: each card is filled
   * in where it already sits.
   */
  const retryIndices = useCallback(
    async (indices: number[]) => {
      const targets = indices.filter(
        (i) => results[i] && results[i].status === 'failed'
      );
      if (targets.length === 0 || isRetrying || isLoading) return;

      setIsRetrying(true);
      setRetryProgress({ current: 0, total: targets.length });

      let cards = results.map((card, i) =>
        targets.includes(i) ? { ...card, status: 'generating', errorMessage: undefined } : card
      );
      setResults(cards);

      const write = (next: GenerationResult[]) => {
        cards = next;
        setResults(next);
      };

      // Cards the server already knows about are retried by id, so the same
      // database row is reused. Cards that never reached the server (the whole
      // request died) go back through the normal path, where the batch id stops
      // any duplicate being created.
      const withId = targets.filter((i) => results[i].id);
      const withoutId = targets.filter((i) => !results[i].id);
      const runs: { indices: number[]; body: any }[] = [];

      for (let i = 0; i < withId.length; i += GROUP_SIZE) {
        const slice = withId.slice(i, i + GROUP_SIZE);
        runs.push({
          indices: slice,
          body: { retryImageIds: slice.map((idx) => results[idx].id) },
        });
      }
      for (let i = 0; i < withoutId.length; i += GROUP_SIZE) {
        const slice = withoutId.slice(i, i + GROUP_SIZE);
        runs.push({
          indices: slice,
          body: {
            batchId: batchId || undefined,
            prompts: slice.map((idx) => results[idx].prompt),
            model: selectedModel,
            quality: quality || undefined,
            size,
          },
        });
      }

      let done = 0;

      for (const run of runs) {
        try {
          const response = await fetch('/api/generate', {
            method: 'POST',
            headers: { 'Content-Type': 'application/json' },
            body: JSON.stringify(run.body),
          });
          if (!response.ok) {
            const error = await response.json().catch(() => ({ error: 'Request failed' }));
            throw new Error(error.error || 'Retry failed');
          }
          const data = await response.json();
          const rows = (data.results || []) as GenerationResult[];
          write(
            cards.map((card, i) => {
              const pos = run.indices.indexOf(i);
              return pos === -1 || !rows[pos] ? card : { ...card, ...rows[pos] };
            })
          );
        } catch (error: any) {
          const message = error?.message || 'Retry failed';
          if (batchId) write(await reconcile(batchId, cards, { wait: true }));
          write(
            cards.map((card, i) =>
              run.indices.includes(i) && card.status !== 'done'
                ? { ...card, status: 'failed', errorMessage: message, cost: 0 }
                : card
            )
          );
        }

        done += run.indices.length;
        setRetryProgress({ current: done, total: targets.length });

        if (autoDownload) {
          for (const i of run.indices) {
            const card = cards[i];
            if (card?.imageUrl && card.status === 'done') {
              await downloadImage(card.imageUrl, card.prompt, i);
              await new Promise((resolve) => setTimeout(resolve, 300));
            }
          }
        }
      }

      // A card can come back still marked "generating" when the first attempt is
      // genuinely still running on the server — wait it out rather than leaving
      // a spinner on screen forever.
      if (batchId && targets.some((i) => cards[i]?.status === 'generating')) {
        write(await reconcile(batchId, cards, { wait: true }));
        write(
          cards.map((card, i) =>
            targets.includes(i) && card.status === 'generating'
              ? {
                  ...card,
                  status: 'failed',
                  errorMessage: 'Still running on the server — try again in a few minutes.',
                  cost: 0,
                }
              : card
          )
        );
      }

      setIsRetrying(false);
      setRetryProgress({ current: 0, total: 0 });
    },
    [results, isRetrying, isLoading, batchId, selectedModel, quality, size, autoDownload, downloadImage]
  );

  const failedIndices = useMemo(
    () => results.map((r, i) => (r.status === 'failed' ? i : -1)).filter((i) => i !== -1),
    [results]
  );

  const retryAllFailed = useCallback(() => retryIndices(failedIndices), [retryIndices, failedIndices]);

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
      <div className="bg-surface rounded-2xl border border-champagne/30 p-8 shadow-2xl ">
        <div className="flex items-center gap-3 mb-8">
          <div className="w-10 h-10 bg-champagne rounded-lg flex items-center justify-center text-xl">
            🎨
          </div>
          <div>
            <h2 className="text-2xl font-bold text-bone">Batch Image Generator</h2>
            <p className="text-taupe text-sm">Paste all your prompts, pick a separator, generate everything at once</p>
          </div>
        </div>

        {/* Model Selection */}
        <div className="mb-4">
          <label className="block text-bone-muted font-medium mb-2 text-sm">Model</label>
          <div className="grid grid-cols-1 sm:grid-cols-2 lg:grid-cols-3 gap-2">
            {Object.entries(MODELS).map(([key, model]) => (
              <button
                key={key}
                onClick={() => handleModelChange(key)}
                className={`text-left p-3 rounded-xl border transition-all ${
                  selectedModel === key
                    ? 'bg-champagne/15 border-champagne ring-1 ring-champagne/40'
                    : 'bg-surface-2/60 border-border-soft hover:border-champagne/30'
                }`}
              >
                <div className="flex items-center gap-2 mb-1">
                  <span className="text-sm font-semibold text-bone">{model.name}</span>
                  {model.recommended && (
                    <span className="text-[10px] bg-success/15 text-success px-1.5 py-0.5 rounded-full font-medium">BEST</span>
                  )}
                </div>
                <p className="text-[11px] text-taupe leading-tight mb-1.5">{model.description}</p>
                <p className="text-[11px] text-champagne font-medium">{getCostSummary(key)}</p>
              </button>
            ))}
          </div>
        </div>

        {/* Model Info Banner */}
        <div className="bg-surface-2/40 rounded-lg border border-border-soft px-4 py-2.5 mb-4 flex flex-wrap items-center gap-x-4 gap-y-1 text-xs">
          <span className="text-taupe">{MODELS[selectedModel]?.qualityNote}</span>
        </div>

        {/* Settings Row: Size, Quality, Style */}
        <div className="grid grid-cols-1 md:grid-cols-2 gap-4 mb-4">
          {sizes.length > 0 && (
            <div>
              <label className="block text-bone-muted font-medium mb-1.5 text-sm">Size</label>
              <select
                value={size}
                onChange={(e) => setSize(e.target.value)}
                className="w-full bg-surface-2/90 border border-border-soft rounded-lg px-3 py-2.5 text-bone focus:outline-none focus:ring-2 focus:ring-champagne focus:border-transparent text-sm"
              >
                {sizes.map((s) => (
                  <option key={s} value={s}>
                    {sizeLabel(s)}
                  </option>
                ))}
              </select>
            </div>
          )}

          {qualities.length > 0 && (
            <div>
              <label className="block text-bone-muted font-medium mb-1.5 text-sm">Quality</label>
              <select
                value={quality}
                onChange={(e) => setQuality(e.target.value)}
                className="w-full bg-surface-2/90 border border-border-soft rounded-lg px-3 py-2.5 text-bone focus:outline-none focus:ring-2 focus:ring-champagne focus:border-transparent text-sm"
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
        <div className="bg-champagne/10 border border-champagne/20 rounded-lg px-4 py-2.5 mb-6 flex items-center justify-between">
          <span className="text-sm text-champagne-hi">Price per image with current settings:</span>
          <span className="text-lg font-bold text-champagne">{formatPrice(calculateCost(selectedModel, size, quality))}</span>
        </div>

        {/* Separator Selection */}
        <div className="bg-surface-2/60 rounded-xl border border-border-soft p-4 mb-6">
          <div className="flex items-center justify-between mb-3">
            <label className="text-bone-muted font-medium text-sm">Prompt Separator</label>
            <span className="text-xs text-taupe">How should we split your prompts?</span>
          </div>
          <div className="grid grid-cols-2 md:grid-cols-4 gap-2 mb-3">
            {SEPARATOR_OPTIONS.map((opt) => (
              <button
                key={opt.value}
                onClick={() => setSeparator(opt.value)}
                className={`px-3 py-2 rounded-lg text-xs font-medium transition-all ${
                  separator === opt.value
                    ? 'bg-champagne text-canvas text-bone border border-champagne-hi'
                    : 'bg-surface-2/80 text-bone-muted border border-border-soft hover:border-champagne/40'
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
              className="w-full bg-surface-2 border border-border-soft rounded-lg px-3 py-2 text-bone text-sm placeholder-taupe focus:outline-none focus:ring-2 focus:ring-champagne"
            />
          )}
        </div>

        {/* Usage Tip */}
        <div className="mb-3 bg-champagne/10 border border-champagne/30 rounded-lg px-4 py-3">
          <p className="text-bone font-bold text-base leading-snug">
            Paste as many prompts as you like — we run them in groups of {GROUP_SIZE} automatically.
          </p>
          <p className="text-bone-muted text-xs mt-1 leading-relaxed">
            Nothing for you to split up. Hit generate once and leave it running.
          </p>
        </div>

        {/* Text Area */}
        <div className="mb-4">
          <div className="flex items-center justify-between mb-2">
            <label className="text-bone-muted font-medium text-sm">
              Paste Your Prompts
            </label>
            <div className="flex items-center gap-4">
              <label className="flex items-center gap-2 cursor-pointer">
                <input
                  type="checkbox"
                  checked={autoDownload}
                  onChange={(e) => setAutoDownload(e.target.checked)}
                  className="w-4 h-4 rounded border-border-soft text-champagne focus:ring-champagne bg-surface-2"
                />
                <span className="text-xs text-taupe">Auto-download images</span>
              </label>
              <label className="flex items-center gap-2 cursor-pointer">
                <input
                  type="checkbox"
                  checked={showPreview}
                  onChange={(e) => setShowPreview(e.target.checked)}
                  className="w-4 h-4 rounded border-border-soft text-champagne focus:ring-champagne bg-surface-2"
                />
                <span className="text-xs text-taupe">Show prompt preview</span>
              </label>
            </div>
          </div>
          <textarea
            value={rawText}
            onChange={(e) => setRawText(e.target.value)}
            placeholder={`HOW TO FORMAT YOUR PROMPTS
============================

Use this exact pattern for every image:

  <serial>. <Title Of The Image>
  <your full prompt on the very next line>

Rules:
  • Press Enter ONCE between the title and the prompt.
  • Do NOT press Enter twice inside a single prompt — keep the prompt as one paragraph.
  • Press Enter TWICE only to separate one image from the next.

────────  EXAMPLE  ────────

1. The Golden Sunset
A serene mountain lake at golden hour with snow-capped peaks reflected in the still water, cinematic lighting, ultra-detailed, 1536x1024.

2. Neon Tokyo Night
A futuristic Tokyo street at night drenched in neon, rain-soaked pavement, cyberpunk mood, photorealistic, 1024x1536.

3. Cherry Blossom Garden
A serene Japanese garden in full bloom with a koi pond and stone lantern, soft morning light, painterly style, 1024x1024.

────────────────────────────

Tip: Screenshot these instructions and paste them into ChatGPT or Claude — they will format your batch in this exact structure automatically.

Each image will download as:  01 — The Golden Sunset.png, 02 — Neon Tokyo Night.png, ...`}
            className="w-full h-56 bg-surface-2/80 border border-border-soft rounded-xl px-4 py-3 text-bone placeholder-taupe focus:outline-none focus:ring-2 focus:ring-champagne focus:border-transparent font-mono text-sm leading-relaxed resize-y"
          />
        </div>

        {/* Parsed Prompts Preview */}
        {showPreview && parsedPrompts.length > 0 && (
          <div className="mb-6 bg-surface-2/40 rounded-xl border border-border-soft p-4 max-h-64 overflow-y-auto">
            <div className="flex items-center justify-between mb-3">
              <p className="text-sm font-medium text-champagne">
                Detected {parsedPrompts.length} prompt{parsedPrompts.length !== 1 ? 's' : ''}
              </p>
              <span className="text-xs text-taupe">Scroll to verify all prompts</span>
            </div>
            <div className="space-y-2">
              {parsedPrompts.map((prompt, i) => (
                <div
                  key={i}
                  className="flex gap-3 items-start bg-surface/70 rounded-lg px-3 py-2 border border-border-soft"
                >
                  <span className="text-champagne font-bold text-xs mt-0.5 shrink-0 w-6 h-6 bg-champagne/15 rounded flex items-center justify-center">
                    {i + 1}
                  </span>
                  <div className="flex-1 min-w-0">
                    <p className="text-bone-muted text-xs leading-relaxed line-clamp-3">
                      {prompt}
                    </p>
                    {promptCosts[i]?.detectedSize && (
                      <span className="inline-block mt-1 text-[10px] bg-champagne/10 text-champagne-hi px-1.5 py-0.5 rounded font-medium">
                        Size from prompt: {promptCosts[i].detectedSize} — {formatPrice(promptCosts[i].cost)}/image
                      </span>
                    )}
                  </div>
                </div>
              ))}
            </div>
          </div>
        )}

        {/* Cost Summary */}
        <div className="bg-surface-2/60 rounded-xl border border-border-soft p-4 mb-6">
          <div className="grid grid-cols-3 gap-4 text-center">
            <div>
              <p className="text-taupe text-xs mb-1">Images</p>
              <p className="text-xl font-bold text-bone">{parsedPrompts.length}</p>
            </div>
            <div>
              <p className="text-taupe text-xs mb-1">{promptCosts.some(p => p.detectedSize) ? 'Avg Cost/Image' : 'Cost Per Image'}</p>
              <p className="text-xl font-bold text-success">${parsedPrompts.length > 0 ? (totalCost / parsedPrompts.length).toFixed(4) : costPerImage.toFixed(4)}</p>
            </div>
            <div>
              <p className="text-taupe text-xs mb-1">Total Estimated</p>
              <p className="text-xl font-bold text-champagne">${totalCost.toFixed(3)}</p>
            </div>
          </div>
        </div>

        {/* Progress Bar */}
        {isLoading && progress.total > 0 && (
          <div className="mb-6">
            <div className="flex justify-between items-center mb-2">
              <p className="text-bone-muted text-sm">
                Generating: {progress.current}/{progress.total}
                {groupProgress.total > 1 && (
                  <span className="text-taupe">
                    {' '}— group {groupProgress.current} of {groupProgress.total}
                  </span>
                )}
              </p>
              <p className="text-champagne text-sm font-medium">
                {Math.round((progress.current / progress.total) * 100)}%
              </p>
            </div>
            <div className="w-full bg-surface-2 rounded-full h-2.5">
              <div
                className="bg-champagne h-2.5 rounded-full transition-all duration-500 ease-out"
                style={{
                  width: `${(progress.current / progress.total) * 100}%`,
                }}
              />
            </div>
          </div>
        )}

        {/* Recovery notice — a group's reply went missing and we're checking
            the server for images that were finished anyway */}
        {recoveryNotice && (
          <div className="mb-4 bg-warning/10 border border-warning/30 rounded-lg px-4 py-3 flex items-start gap-3">
            <span className="w-4 h-4 mt-0.5 border-2 border-warning border-t-transparent rounded-full animate-spin shrink-0" />
            <div>
              <p className="text-bone font-bold text-sm leading-snug">{recoveryNotice}</p>
              <p className="text-bone-muted text-xs mt-0.5 leading-relaxed">
                Anything already made is picked up here — you are not charged for it again. Keep this tab open.
              </p>
            </div>
          </div>
        )}

        {/* Auto-split notice */}
        {parsedPrompts.length > GROUP_SIZE && (
          <div className="mb-4 bg-champagne/10 border border-champagne/30 rounded-lg px-4 py-3 flex items-start gap-3">
            <svg className="w-5 h-5 text-champagne shrink-0 mt-0.5" fill="none" stroke="currentColor" viewBox="0 0 24 24" aria-hidden="true">
              <path strokeLinecap="round" strokeLinejoin="round" strokeWidth={2} d="M9 12l2 2 4-4m6 2a9 9 0 11-18 0 9 9 0 0118 0z" />
            </svg>
            <div>
              <p className="text-bone font-bold text-sm leading-snug">
                {parsedPrompts.length} prompts — running as {Math.ceil(parsedPrompts.length / GROUP_SIZE)} groups of up to {GROUP_SIZE}
              </p>
              <p className="text-bone-muted text-xs mt-0.5 leading-relaxed">
                Handled for you, one group after another. Keep this tab open and images will keep arriving.
              </p>
            </div>
          </div>
        )}

        {/* Generate Button */}
        <button
          onClick={handleGenerate}
          disabled={isLoading || parsedPrompts.length === 0}
          className="w-full bg-champagne hover:bg-champagne-hi text-canvas disabled:opacity-40 disabled:cursor-not-allowed text-bone font-bold py-4 px-6 rounded-xl transition-all duration-200 text-lg shadow-lg shadow-champagne/15 hover:shadow-champagne/30"
        >
          {isLoading
            ? groupProgress.total > 1
              ? `Generating... (${progress.current}/${progress.total} — group ${groupProgress.current} of ${groupProgress.total})`
              : `Generating... (${progress.current}/${progress.total})`
            : parsedPrompts.length > 0
            ? `Generate All ${parsedPrompts.length} Images — $${totalCost.toFixed(3)}`
            : 'Paste prompts above to get started'}
        </button>
      </div>

      {/* Results Grid */}
      {results.length > 0 && (
        <div>
          <div className="flex flex-wrap items-center justify-between gap-3 mb-4">
            <h3 className="text-xl font-bold text-bone">
              Generated Images ({results.filter((r) => r.status === 'done').length}/{results.length})
              {selectedIndices.size > 0 && (
                <span className="text-champagne text-sm font-medium ml-2">
                  · {selectedIndices.size} selected
                </span>
              )}
            </h3>
            <div className="flex flex-wrap items-center gap-2">
              {failedIndices.length > 0 && (
                <button
                  onClick={retryAllFailed}
                  disabled={isRetrying || isLoading}
                  className="bg-danger/15 hover:bg-danger/25 text-danger border border-danger/40 disabled:opacity-40 disabled:cursor-not-allowed px-4 py-2 rounded-lg text-sm font-bold transition flex items-center gap-2"
                  title="Generate the failed ones again. Images that already worked are left alone — you are never charged twice."
                >
                  {isRetrying ? (
                    <>
                      <span className="w-3.5 h-3.5 border-2 border-danger border-t-transparent rounded-full animate-spin" />
                      Retrying {retryProgress.current}/{retryProgress.total}...
                    </>
                  ) : (
                    <>
                      <svg className="w-4 h-4" fill="none" stroke="currentColor" viewBox="0 0 24 24"><path strokeLinecap="round" strokeLinejoin="round" strokeWidth={2} d="M4 4v5h.582m15.356 2A8.001 8.001 0 004.582 9m0 0H9m11 11v-5h-.581m0 0a8.003 8.003 0 01-15.357-2m15.357 2H15" /></svg>
                      Retry {failedIndices.length} failed
                    </>
                  )}
                </button>
              )}
              {results.some((r) => r.status === 'done') && (
              <>
                <button
                  onClick={selectAllDone}
                  className="bg-surface-2 hover:bg-surface-2 text-bone-muted hover:text-bone px-3 py-2 rounded-lg text-xs font-medium transition border border-border-soft"
                >
                  Select All
                </button>
                {selectedIndices.size > 0 && (
                  <button
                    onClick={clearSelection}
                    className="bg-surface-2 hover:bg-surface-2 text-bone-muted hover:text-bone px-3 py-2 rounded-lg text-xs font-medium transition border border-border-soft"
                  >
                    Clear
                  </button>
                )}
                <button
                  onClick={copySelected}
                  disabled={selectedIndices.size === 0}
                  className="bg-champagne hover:bg-champagne-hi text-canvas disabled:opacity-40 disabled:cursor-not-allowed text-bone px-4 py-2 rounded-lg text-sm font-bold transition flex items-center gap-2"
                  title="Copy titles + links of selected images"
                >
                  {copiedKey === 'multi' ? (
                    <>
                      <svg className="w-4 h-4" fill="none" stroke="currentColor" viewBox="0 0 24 24"><path strokeLinecap="round" strokeLinejoin="round" strokeWidth={2} d="M5 13l4 4L19 7" /></svg>
                      Copied {selectedIndices.size}!
                    </>
                  ) : (
                    <>
                      <svg className="w-4 h-4" fill="none" stroke="currentColor" viewBox="0 0 24 24"><path strokeLinecap="round" strokeLinejoin="round" strokeWidth={2} d="M8 16H6a2 2 0 01-2-2V6a2 2 0 012-2h8a2 2 0 012 2v2m-6 12h8a2 2 0 002-2v-8a2 2 0 00-2-2h-8a2 2 0 00-2 2v8a2 2 0 002 2z" /></svg>
                      Copy Selected ({selectedIndices.size})
                    </>
                  )}
                </button>
                <button
                  onClick={downloadAll}
                  className="bg-surface-2 hover:bg-surface-2 text-bone px-4 py-2 rounded-lg text-sm font-medium transition border border-border-soft"
                >
                  Download All
                </button>
              </>
              )}
            </div>
          </div>
          <div className="grid grid-cols-1 md:grid-cols-2 lg:grid-cols-3 gap-4">
            {results.map((result, index) => {
              const title = extractTitle(result.prompt);
              const isSelected = selectedIndices.has(index);
              const isDone = result.status === 'done' && !!result.imageUrl;
              const singleCopyKey = `single-${title}-${result.imageUrl}`;
              return (
              <div
                key={index}
                className={`bg-surface/90 border rounded-xl overflow-hidden transition-all group ${
                  isSelected
                    ? 'border-champagne ring-2 ring-champagne/40'
                    : 'border-border-soft hover:border-champagne/40'
                }`}
              >
                {isDone ? (
                  <div className="relative">
                    <img
                      src={result.imageUrl}
                      alt={result.prompt}
                      className="w-full h-52 object-cover"
                    />
                    <label
                      className="absolute top-2 left-2 flex items-center gap-1.5 bg-canvas/80 backdrop-blur-sm rounded-md px-2 py-1 cursor-pointer select-none"
                      title="Select this image"
                    >
                      <input
                        type="checkbox"
                        checked={isSelected}
                        onChange={() => toggleSelected(index)}
                        className="w-4 h-4 rounded border-border-soft text-champagne focus:ring-champagne bg-surface-2"
                      />
                      <span className="text-[11px] text-bone font-medium">Select</span>
                    </label>
                    <div className="absolute top-2 right-2 bg-success/90 text-bone px-2 py-1 rounded-md text-xs font-bold backdrop-blur-sm">
                      Done
                    </div>
                    <button
                      onClick={() => downloadImage(result.imageUrl!, result.prompt, index)}
                      className="absolute bottom-2 right-2 bg-canvas/80 text-bone p-2 rounded-lg opacity-0 group-hover:opacity-100 transition backdrop-blur-sm hover:bg-champagne text-canvas"
                      title="Download"
                    >
                      <svg className="w-4 h-4" fill="none" stroke="currentColor" viewBox="0 0 24 24">
                        <path strokeLinecap="round" strokeLinejoin="round" strokeWidth={2} d="M12 10v6m0 0l-3-3m3 3l3-3m2 8H7a2 2 0 01-2-2V5a2 2 0 012-2h5.586a1 1 0 01.707.293l5.414 5.414a1 1 0 01.293.707V19a2 2 0 01-2 2z" />
                      </svg>
                    </button>
                  </div>
                ) : result.status === 'pending' ? (
                  <div className="w-full h-52 bg-surface-2/70 flex items-center justify-center">
                    <p className="text-taupe text-sm">Waiting...</p>
                  </div>
                ) : result.status === 'generating' ? (
                  <div className="w-full h-52 bg-surface-2/70 flex items-center justify-center">
                    <div className="text-center">
                      <div className="w-8 h-8 border-2 border-champagne border-t-transparent rounded-full animate-spin mx-auto mb-2" />
                      <p className="text-taupe text-sm">Generating...</p>
                    </div>
                  </div>
                ) : (
                  <div className="w-full h-52 bg-danger/10 flex items-center justify-center border-b border-danger/30">
                    <div className="text-center px-4">
                      <p className="text-danger font-medium text-sm mb-1">Failed</p>
                      <p className="text-danger/80 text-xs line-clamp-3">{result.errorMessage}</p>
                      <p className="text-taupe text-[11px] mt-1">Nothing was charged for this one.</p>
                      <button
                        onClick={() => retryIndices([index])}
                        disabled={isRetrying || isLoading}
                        className="mt-2 bg-surface-2 hover:bg-champagne hover:text-canvas text-bone border border-border-soft disabled:opacity-40 disabled:cursor-not-allowed rounded-lg px-3 py-1.5 text-xs font-semibold transition"
                      >
                        Try again
                      </button>
                    </div>
                  </div>
                )}
                <div className="p-3">
                  <p className="text-bone font-semibold text-sm leading-snug line-clamp-1" title={title}>
                    {title}
                  </p>
                  <p className="text-bone-muted text-xs line-clamp-2 leading-relaxed mt-1">{result.prompt}</p>
                  <div className="flex justify-between items-center mt-2">
                    <p className="text-champagne/80 text-xs">
                      {result.status === 'failed' ? 'not charged' : `$${result.cost.toFixed(4)}`}
                    </p>
                    <span className={`text-xs px-2 py-0.5 rounded-full ${
                      result.status === 'done' ? 'bg-success/15 text-success' :
                      result.status === 'failed' ? 'bg-danger/15 text-danger' :
                      'bg-warning/15 text-warning'
                    }`}>
                      {result.status}
                    </span>
                  </div>
                  {isDone && (
                    <button
                      onClick={() => copySingleImage(result)}
                      className="mt-2 w-full bg-surface-2 hover:bg-champagne hover:text-canvas text-bone-muted border border-border-soft rounded-lg px-3 py-1.5 text-xs font-semibold transition flex items-center justify-center gap-1.5"
                      title="Copy title + link"
                    >
                      {copiedKey === singleCopyKey ? (
                        <>
                          <svg className="w-3.5 h-3.5" fill="none" stroke="currentColor" viewBox="0 0 24 24"><path strokeLinecap="round" strokeLinejoin="round" strokeWidth={2} d="M5 13l4 4L19 7" /></svg>
                          Copied!
                        </>
                      ) : (
                        <>
                          <svg className="w-3.5 h-3.5" fill="none" stroke="currentColor" viewBox="0 0 24 24"><path strokeLinecap="round" strokeLinejoin="round" strokeWidth={2} d="M8 16H6a2 2 0 01-2-2V6a2 2 0 012-2h8a2 2 0 012 2v2m-6 12h8a2 2 0 002-2v-8a2 2 0 00-2-2h-8a2 2 0 00-2 2v8a2 2 0 002 2z" /></svg>
                          Copy title + link
                        </>
                      )}
                    </button>
                  )}
                </div>
              </div>
              );
            })}
          </div>
        </div>
      )}
    </div>
  );
}
