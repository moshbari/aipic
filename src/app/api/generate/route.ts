import { NextRequest, NextResponse } from 'next/server';
import { getServerSession } from 'next-auth';
import { authOptions } from '@/lib/auth';
import { prisma } from '@/lib/prisma';
import { decryptApiKey } from '@/lib/encryption';
import { calculateCost, MODELS } from '@/lib/models';
import { isGHLConfigured, uploadFromUrlToGHL, uploadBase64ToGHL } from '@/lib/ghl';
import { v4 as uuidv4 } from 'uuid';
import OpenAI from 'openai';

export const maxDuration = 900; // long batches: nginx allows 900s too

// A row left in 'generating' for longer than this is treated as dead (the
// container restarted, or the request was cut off) and may be retried.
// Anything younger is assumed to still be running, so we never start a second
// paid generation on top of one that may still land.
const STALE_GENERATING_MS = 10 * 60 * 1000;

type ImageRow = {
  id: string;
  prompt: string;
  model: string;
  quality: string | null;
  size: string | null;
  cost: number;
  imageUrl: string;
  batchId: string;
  status: string;
  errorMessage: string | null;
  updatedAt: Date;
};

/**
 * Auth: a browser session OR a service token (for trusted backends like the
 * Book Robot Factory). The service token runs as the configured owner, so it
 * uses that owner's stored OpenAI key. Inert unless AIPIC_SERVICE_TOKEN is set.
 */
async function resolveUserId(request: NextRequest): Promise<string | undefined> {
  const authHeader = request.headers.get('authorization') || '';
  if (
    process.env.AIPIC_SERVICE_TOKEN &&
    authHeader === `Bearer ${process.env.AIPIC_SERVICE_TOKEN}`
  ) {
    const owner = await prisma.user.findFirst({
      where: process.env.AIPIC_SERVICE_USER_EMAIL
        ? { email: process.env.AIPIC_SERVICE_USER_EMAIL }
        : undefined,
      orderBy: { createdAt: 'asc' },
    });
    return owner?.id;
  }
  const session = await getServerSession(authOptions);
  return session?.user?.id;
}

const ROW_SELECT = {
  id: true,
  prompt: true,
  model: true,
  quality: true,
  size: true,
  cost: true,
  imageUrl: true,
  batchId: true,
  status: true,
  errorMessage: true,
  updatedAt: true,
} as const;

function rowToResult(row: ImageRow) {
  return {
    id: row.id,
    prompt: row.prompt,
    imageUrl: row.imageUrl || undefined,
    status: row.status,
    errorMessage: row.errorMessage || undefined,
    cost: row.cost,
  };
}

function isAlive(row: ImageRow) {
  return (
    row.status === 'generating' &&
    Date.now() - new Date(row.updatedAt).getTime() < STALE_GENERATING_MS
  );
}

/**
 * Recover a batch after a lost response.
 *
 * The browser only learns what happened from the POST reply. If that reply
 * never arrives (proxy timeout, laptop sleep, dropped wifi) the images may
 * still have been made and paid for. This lets the page ask the database what
 * really happened instead of assuming the worst and paying twice.
 *
 *   GET /api/generate?batchId=<id>
 */
export async function GET(request: NextRequest) {
  try {
    const userId = await resolveUserId(request);
    if (!userId) {
      return NextResponse.json({ error: 'Unauthorized' }, { status: 401 });
    }

    const batchId = new URL(request.url).searchParams.get('batchId');
    if (!batchId) {
      return NextResponse.json({ error: 'batchId is required' }, { status: 400 });
    }

    const rows = (await prisma.generatedImage.findMany({
      where: { userId, batchId },
      orderBy: { createdAt: 'asc' },
      select: ROW_SELECT,
    })) as ImageRow[];

    return NextResponse.json({
      batchId,
      results: rows.map(rowToResult),
      stillRunning: rows.some(isAlive),
    });
  } catch (error: any) {
    console.error('Batch status error:', error);
    return NextResponse.json(
      { error: error?.message || 'Failed to read batch status' },
      { status: 500 }
    );
  }
}

export async function POST(request: NextRequest) {
  try {
    const userId = await resolveUserId(request);
    if (!userId) {
      return NextResponse.json({ error: 'Unauthorized' }, { status: 401 });
    }

    const body = await request.json();
    const { prompts, model, quality, size } = body;
    const retryImageIds: string[] | undefined = Array.isArray(body.retryImageIds)
      ? body.retryImageIds.filter((id: unknown) => typeof id === 'string').slice(0, 100)
      : undefined;
    const clientBatchId: string | undefined =
      typeof body.batchId === 'string' && body.batchId.length > 0 && body.batchId.length <= 64
        ? body.batchId
        : undefined;

    if (!retryImageIds) {
      if (!prompts || !Array.isArray(prompts) || prompts.length === 0) {
        return NextResponse.json(
          { error: 'Prompts array is required' },
          { status: 400 }
        );
      }
      if (!model) {
        return NextResponse.json(
          { error: 'Model selection is required' },
          { status: 400 }
        );
      }
    }

    // Get the user's active OpenAI API key
    const apiKeys = await prisma.apiKey.findMany({
      where: {
        userId,
        provider: 'OPENAI',
        isActive: true,
      },
    });

    if (apiKeys.length === 0) {
      return NextResponse.json(
        { error: 'No active OpenAI API key found. Please add one in Settings.' },
        { status: 400 }
      );
    }

    const apiKey = decryptApiKey(apiKeys[0].encryptedKey);
    const openai = new OpenAI({ apiKey });

    const plan = retryImageIds
      ? await planRetry(userId, retryImageIds)
      : await planFresh(userId, {
          prompts,
          model,
          quality,
          size,
          batchId: clientBatchId || uuidv4(),
        });

    if ('error' in plan) {
      return NextResponse.json({ error: plan.error }, { status: 400 });
    }

    const { batchId, items } = plan;
    const allResults: any[] = new Array(items.length);

    // Anything already finished (or still running from an earlier attempt) is
    // returned as-is — never regenerated, so a retry can't be charged twice.
    items.forEach((item, i) => {
      if (item.kind === 'existing') allResults[i] = rowToResult(item.row);
    });

    const toRun = items
      .map((item, index) => ({ item, index }))
      .filter((entry) => entry.item.kind === 'run');

    // Generate images concurrently with controlled concurrency
    const CONCURRENCY_LIMIT = 5; // Avoid rate limits

    for (let i = 0; i < toRun.length; i += CONCURRENCY_LIMIT) {
      const slice = toRun.slice(i, i + CONCURRENCY_LIMIT);
      const settled = await Promise.allSettled(
        slice.map((entry) => runImage(openai, (entry.item as RunItem).row))
      );

      settled.forEach((result, sliceIndex) => {
        const { index, item } = slice[sliceIndex];
        if (result.status === 'fulfilled') {
          allResults[index] = result.value;
        } else {
          const row = (item as RunItem).row;
          allResults[index] = {
            id: row.id,
            prompt: row.prompt,
            status: 'failed',
            errorMessage: result.reason?.message || 'Generation failed',
            cost: 0,
          };
        }
      });
    }

    const successCount = allResults.filter((r) => r.status === 'done').length;
    const totalCost = allResults.reduce((sum, r) => sum + (r.cost || 0), 0);

    return NextResponse.json({
      batchId,
      totalPrompts: items.length,
      successCount,
      failureCount: items.length - successCount,
      reusedCount: items.filter((it) => it.kind === 'existing').length,
      totalCost,
      results: allResults,
    });
  } catch (error: any) {
    console.error('Batch generation error:', error);
    return NextResponse.json(
      { error: error?.message || 'Batch generation failed' },
      { status: 500 }
    );
  }
}

type RunItem = { kind: 'run'; row: ImageRow };
type PlanItem = RunItem | { kind: 'existing'; row: ImageRow };
type Plan = { batchId: string; items: PlanItem[] } | { error: string };

/**
 * Retry specific rows, in place.
 *
 * The row keeps its id, so the gallery never fills up with half-finished
 * duplicates of the same prompt, and the page can slot the result straight
 * back into the card the user pressed Retry on.
 */
async function planRetry(userId: string, imageIds: string[]): Promise<Plan> {
  const rows = (await prisma.generatedImage.findMany({
    where: { id: { in: imageIds }, userId },
    select: ROW_SELECT,
  })) as ImageRow[];

  if (rows.length === 0) {
    return { error: 'Nothing to retry — those images were not found.' };
  }

  const byId = new Map(rows.map((row) => [row.id, row]));
  const items: PlanItem[] = [];

  for (const id of imageIds) {
    const row = byId.get(id);
    if (!row) continue;
    // Already finished, or still running from the first attempt: hand it back
    // untouched rather than paying OpenAI for a second copy.
    if ((row.status === 'done' && row.imageUrl) || isAlive(row)) {
      items.push({ kind: 'existing', row });
    } else {
      items.push({ kind: 'run', row: await claimRow(row) });
    }
  }

  return { batchId: rows[0].batchId, items };
}

/**
 * A fresh run. If the page supplies its own batchId (it does), rows already in
 * that batch are matched to the prompts before anything is generated — so
 * re-sending a group whose reply got lost picks up the finished images instead
 * of making a second set.
 *
 * Identical prompts are matched in order; they're interchangeable, so which
 * copy lands on which card doesn't matter.
 */
async function planFresh(
  userId: string,
  params: {
    prompts: string[];
    model: string;
    quality?: string;
    size?: string;
    batchId: string;
  }
): Promise<Plan> {
  const { prompts, model, quality, size, batchId } = params;

  const existing = (await prisma.generatedImage.findMany({
    where: { userId, batchId },
    orderBy: { createdAt: 'asc' },
    select: ROW_SELECT,
  })) as ImageRow[];

  const unclaimed = new Map<string, ImageRow[]>();
  for (const row of existing) {
    const list = unclaimed.get(row.prompt) || [];
    list.push(row);
    unclaimed.set(row.prompt, list);
  }

  const items: PlanItem[] = [];

  for (const prompt of prompts) {
    const match = (unclaimed.get(prompt) || []).shift();

    if (match && ((match.status === 'done' && match.imageUrl) || isAlive(match))) {
      items.push({ kind: 'existing', row: match });
      continue;
    }

    if (match) {
      // A failed or abandoned row for this exact prompt — reuse the row.
      items.push({ kind: 'run', row: await claimRow(match) });
      continue;
    }

    const effectiveSize = extractSizeFromPrompt(prompt, model) || size || '1024x1024';
    const row = (await prisma.generatedImage.create({
      data: {
        userId,
        prompt,
        model,
        quality,
        size: effectiveSize,
        cost: calculateCost(model, effectiveSize, quality),
        imageUrl: '',
        batchId,
        status: 'generating',
      },
      select: ROW_SELECT,
    })) as ImageRow;
    items.push({ kind: 'run', row });
  }

  return { batchId, items };
}

/** Mark a row as mine before starting work on it, clearing the old error. */
async function claimRow(row: ImageRow): Promise<ImageRow> {
  return (await prisma.generatedImage.update({
    where: { id: row.id },
    data: {
      status: 'generating',
      errorMessage: null,
      cost: calculateCost(row.model, row.size || '1024x1024', row.quality || undefined),
    },
    select: ROW_SELECT,
  })) as ImageRow;
}

/**
 * Smart dimension extraction from prompt text.
 * Handles:
 *  1. Pixel dimensions: "1024x1536", "1536 x 1024"
 *  2. Aspect ratios: "16:9", "widescreen"
 *  3. Inch dimensions: "6x3.5 inches", "5x5 inches", "6 x 4 inches"
 *  4. Keywords: "landscape", "portrait", "square"
 *  5. Size labels: "Size: landscape 6x3.5 inches"
 *
 * Inch-based logic: compares width vs height aspect ratio
 *   - width > height (landscape) → 1536x1024
 *   - width < height (portrait)  → 1024x1536
 *   - width ≈ height (square)    → 1024x1024
 *
 * Only sizes the chosen model actually accepts are returned — 16:9 exists on
 * gpt-image-2 but not on the older models, and asking one of them for a size
 * it doesn't offer is a hard API error.
 */
function extractSizeFromPrompt(prompt: string, model: string): string | null {
  const lower = prompt.toLowerCase();
  const allowed = MODELS[model]?.sizes || ['1024x1024', '1536x1024', '1024x1536', 'auto'];
  const pick = (size: string) => (allowed.includes(size) ? size : null);

  // 1. Check for exact pixel dimensions first (e.g. "1024x1536")
  const pixelMatch = prompt.match(/\b(\d{3,4})\s*[xX×]\s*(\d{3,4})\b/);
  if (pixelMatch) {
    const extracted = `${pixelMatch[1]}x${pixelMatch[2]}`;
    if (allowed.includes(extracted)) {
      return extracted;
    }
  }

  // 2. Widescreen requests — "16:9", "16x9", "widescreen"
  if (/\b16\s*[:x×]\s*9\b/.test(lower) || lower.includes('widescreen')) {
    const wide = pick('1536x864');
    if (wide) return wide;
    // Model has no true 16:9 — nearest available is the 3:2 landscape
    return pick('1536x1024');
  }

  // 3. Check for inch dimensions (e.g. "6x3.5 inches", "5 x 5 inches", "6x3.5"")
  //    Matches patterns like: 6x3.5, 5x5, 6 x 4, 6×3.5 — with optional "inches"/"in" after
  const inchMatch = prompt.match(/\b(\d+(?:\.\d+)?)\s*[xX×]\s*(\d+(?:\.\d+)?)\s*(?:inches|inch|in\b|")?/i);
  if (inchMatch) {
    const w = parseFloat(inchMatch[1]);
    const h = parseFloat(inchMatch[2]);
    if (w > 0 && h > 0) {
      const ratio = w / h;
      // Close to 16:9 (1.78) gets the true widescreen size when available
      if (ratio > 1.65 && ratio < 1.9) {
        const wide = pick('1536x864');
        if (wide) return wide;
      }
      if (ratio > 1.15) return pick('1536x1024');  // landscape
      if (ratio < 0.87) return pick('1024x1536');   // portrait
      return pick('1024x1024');                      // square-ish
    }
  }

  // 4. Check for orientation keywords as fallback
  if (lower.includes('landscape')) return pick('1536x1024');
  if (lower.includes('portrait')) return pick('1024x1536');
  if (lower.includes('square')) return pick('1024x1024');

  return null;
}

/** Errors worth trying again on their own — the request never produced an image. */
function isTransient(error: any): boolean {
  const status = error?.status;
  if (status === 429 || status === 408 || (typeof status === 'number' && status >= 500)) return true;
  const code = String(error?.code || '').toLowerCase();
  return ['econnreset', 'etimedout', 'econnrefused', 'epipe', 'enotfound'].includes(code);
}

/**
 * Generate one image into an existing row.
 *
 * A row is always written before the OpenAI call, so an image the user was
 * charged for can always be traced back — even if the reply to the browser
 * never arrives.
 */
async function runImage(openai: OpenAI, row: ImageRow) {
  const { id, prompt, model, quality } = row;
  const effectiveSize = row.size || '1024x1024';
  const cost = calculateCost(model, effectiveSize, quality || undefined);

  const ATTEMPTS = 2;
  let lastError: any;

  for (let attempt = 1; attempt <= ATTEMPTS; attempt++) {
    try {
      // GPT Image models (gpt-image-2, gpt-image-1.5, gpt-image-1, gpt-image-1-mini)
      const response = await openai.images.generate({
        model: model as any,
        prompt,
        // gpt-image-2 accepts any size meeting OpenAI's constraints (multiples of
        // 16, max edge 3840, ratio within 3:1), which is wider than the SDK's union
        size: effectiveSize as any,
        quality: (quality || 'medium') as 'low' | 'medium' | 'high',
        n: 1,
      });

      // GPT Image models may return base64 or URL
      const first = response.data?.[0];
      let imageUrl = '';
      if (first?.url) {
        imageUrl = first.url;
      } else if (first?.b64_json) {
        imageUrl = `data:image/png;base64,${first.b64_json}`;
      }

      if (!imageUrl) {
        throw new Error('No image URL returned from API');
      }

      // Upload to GHL for permanent hosting
      const permanentUrl = await uploadImageToGHL(imageUrl, id);

      await prisma.generatedImage.update({
        where: { id },
        data: { imageUrl: permanentUrl, status: 'done', errorMessage: null, cost },
      });

      return { id, prompt, imageUrl: permanentUrl, status: 'done', cost };
    } catch (error: any) {
      lastError = error;
      if (attempt < ATTEMPTS && isTransient(error)) {
        const retryAfter = parseInt(error?.headers?.['retry-after'] || '5', 10);
        await new Promise((resolve) =>
          setTimeout(resolve, Math.min(Number.isFinite(retryAfter) ? retryAfter : 5, 20) * 1000)
        );
        continue;
      }
      break;
    }
  }

  const errorMessage = lastError?.message || 'Image generation failed';

  // No image means OpenAI charged nothing, so the row's cost goes to zero —
  // a failed card must never inflate what the user thinks they spent.
  await prisma.generatedImage.update({
    where: { id },
    data: { status: 'failed', errorMessage, cost: 0 },
  });

  return { id, prompt, status: 'failed', errorMessage, cost: 0 };
}

async function uploadImageToGHL(imageUrl: string, imageId: string): Promise<string> {
  if (!isGHLConfigured()) return imageUrl;
  try {
    const filename = `aipic-${imageId}.png`;
    if (imageUrl.startsWith('data:image/')) {
      return await uploadBase64ToGHL(imageUrl, filename);
    } else {
      return await uploadFromUrlToGHL(imageUrl, filename);
    }
  } catch (error) {
    console.error('GHL upload failed, using original URL:', error);
    return imageUrl;
  }
}
