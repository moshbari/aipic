import { NextRequest, NextResponse } from 'next/server';
import { getServerSession } from 'next-auth';
import { authOptions } from '@/lib/auth';
import { prisma } from '@/lib/prisma';
import { decryptApiKey } from '@/lib/encryption';
import { calculateCost } from '@/lib/models';
import { isGHLConfigured, uploadFromUrlToGHL, uploadBase64ToGHL } from '@/lib/ghl';
import { v4 as uuidv4 } from 'uuid';
import OpenAI from 'openai';

export const maxDuration = 300; // 5 minute timeout for large batches

export async function POST(request: NextRequest) {
  try {
    const session = await getServerSession(authOptions);

    if (!session?.user?.id) {
      return NextResponse.json({ error: 'Unauthorized' }, { status: 401 });
    }

    const { prompts, model, quality, size } = await request.json();

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

    // Get the user's active OpenAI API key
    const apiKeys = await prisma.apiKey.findMany({
      where: {
        userId: session.user.id,
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

    const apiKeyRecord = apiKeys[0];
    const apiKey = decryptApiKey(apiKeyRecord.encryptedKey);

    const openai = new OpenAI({ apiKey });

    const batchId = uuidv4();

    // Generate images concurrently with controlled concurrency
    const CONCURRENCY_LIMIT = 5; // Avoid rate limits
    const allResults: any[] = new Array(prompts.length);

    for (let i = 0; i < prompts.length; i += CONCURRENCY_LIMIT) {
      const batch = prompts.slice(i, i + CONCURRENCY_LIMIT);
      const batchPromises = batch.map((prompt: string, batchIndex: number) =>
        generateSingleImage(openai, {
          prompt,
          model,
          quality,
          size,
          batchId,
          userId: session.user.id,
          index: i + batchIndex,
        })
      );

      const batchResults = await Promise.allSettled(batchPromises);

      batchResults.forEach((result, batchIndex) => {
        const globalIndex = i + batchIndex;
        if (result.status === 'fulfilled') {
          allResults[globalIndex] = result.value;
        } else {
          allResults[globalIndex] = {
            prompt: prompts[globalIndex],
            status: 'failed',
            errorMessage: result.reason?.message || 'Generation failed',
            cost: calculateCost(model, size || '1024x1024', quality),
          };
        }
      });
    }

    const successCount = allResults.filter((r) => r.status === 'done').length;
    const totalCost = allResults.reduce((sum, r) => sum + (r.cost || 0), 0);

    return NextResponse.json({
      batchId,
      totalPrompts: prompts.length,
      successCount,
      failureCount: prompts.length - successCount,
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

// Valid sizes for GPT Image models
const VALID_PIXEL_SIZES = ['1024x1024', '1536x1024', '1024x1536', 'auto'];

/**
 * Smart dimension extraction from prompt text.
 * Handles:
 *  1. Pixel dimensions: "1024x1536", "1536 x 1024"
 *  2. Inch dimensions: "6x3.5 inches", "5x5 inches", "6 x 4 inches"
 *  3. Keywords: "landscape", "portrait", "square"
 *  4. Size labels: "Size: landscape 6x3.5 inches"
 *
 * Inch-based logic: compares width vs height aspect ratio
 *   - width > height (landscape) → 1536x1024
 *   - width < height (portrait)  → 1024x1536
 *   - width ≈ height (square)    → 1024x1024
 */
function extractSizeFromPrompt(prompt: string): string | null {
  const lower = prompt.toLowerCase();

  // 1. Check for exact pixel dimensions first (e.g. "1024x1536")
  const pixelMatch = prompt.match(/\b(\d{3,4})\s*[xX×]\s*(\d{3,4})\b/);
  if (pixelMatch) {
    const extracted = `${pixelMatch[1]}x${pixelMatch[2]}`;
    if (VALID_PIXEL_SIZES.includes(extracted)) {
      return extracted;
    }
  }

  // 2. Check for inch dimensions (e.g. "6x3.5 inches", "5 x 5 inches", "6x3.5"")
  //    Matches patterns like: 6x3.5, 5x5, 6 x 4, 6×3.5 — with optional "inches"/"in" after
  const inchMatch = prompt.match(/\b(\d+(?:\.\d+)?)\s*[xX×]\s*(\d+(?:\.\d+)?)\s*(?:inches|inch|in\b|")?/i);
  if (inchMatch) {
    const w = parseFloat(inchMatch[1]);
    const h = parseFloat(inchMatch[2]);
    if (w > 0 && h > 0) {
      const ratio = w / h;
      if (ratio > 1.15) return '1536x1024';      // landscape
      if (ratio < 0.87) return '1024x1536';       // portrait
      return '1024x1024';                          // square-ish
    }
  }

  // 3. Check for orientation keywords as fallback
  if (lower.includes('landscape')) return '1536x1024';
  if (lower.includes('portrait')) return '1024x1536';
  if (lower.includes('square')) return '1024x1024';

  return null;
}

async function generateSingleImage(
  openai: OpenAI,
  params: {
    prompt: string;
    model: string;
    quality?: string;
    size?: string;
    batchId: string;
    userId: string;
    index: number;
  }
) {
  const { prompt, model, quality, size, batchId, userId, index } = params;

  // Check if the prompt contains a dimension — if so, it overrides the global size setting
  const promptSize = extractSizeFromPrompt(prompt);
  const effectiveSize = promptSize || size || '1024x1024';

  const cost = calculateCost(model, effectiveSize, quality);

  // Create record in DB
  let imageRecord = await prisma.generatedImage.create({
    data: {
      userId,
      prompt,
      model,
      quality,
      size: effectiveSize,
      cost,
      imageUrl: '',
      batchId,
      status: 'generating',
    },
  });

  try {
    let imageUrl = '';

    // GPT Image models (gpt-image-1.5, gpt-image-1, gpt-image-1-mini)
    const response = await openai.images.generate({
      model: model as any,
      prompt,
      size: effectiveSize as '1024x1024' | '1536x1024' | '1024x1536' | 'auto',
      quality: (quality || 'medium') as 'low' | 'medium' | 'high',
      n: 1,
    });

    // GPT Image models may return base64 or URL
    if (response.data[0]?.url) {
      imageUrl = response.data[0].url;
    } else if (response.data[0]?.b64_json) {
      imageUrl = `data:image/png;base64,${response.data[0].b64_json}`;
    }

    if (!imageUrl) {
      throw new Error('No image URL returned from API');
    }

    // Upload to GHL for permanent hosting
    const permanentUrl = await uploadImageToGHL(imageUrl, imageRecord.id);

    // Update record with result
    imageRecord = await prisma.generatedImage.update({
      where: { id: imageRecord.id },
      data: {
        imageUrl: permanentUrl,
        status: 'done',
      },
    });

    return {
      id: imageRecord.id,
      prompt,
      imageUrl: permanentUrl,
      status: 'done',
      cost,
    };
  } catch (error: any) {
    const errorMessage = error?.message || 'Image generation failed';

    // Handle rate limiting with retry
    if (error?.status === 429) {
      // Wait and retry once
      const retryAfter = parseInt(error?.headers?.['retry-after'] || '5', 10);
      await new Promise((resolve) => setTimeout(resolve, retryAfter * 1000));

      try {
        const retryResponse = await openai.images.generate({
          model: model as any,
          prompt,
          size: (size || '1024x1024') as any,
          n: 1,
        });

        let retryUrl = retryResponse.data[0]?.url || '';
        if (!retryUrl && retryResponse.data[0]?.b64_json) {
          retryUrl = `data:image/png;base64,${retryResponse.data[0].b64_json}`;
        }
        if (retryUrl) {
          const retryPermanentUrl = await uploadImageToGHL(retryUrl, imageRecord.id);
          imageRecord = await prisma.generatedImage.update({
            where: { id: imageRecord.id },
            data: { imageUrl: retryPermanentUrl, status: 'done' },
          });
          return {
            id: imageRecord.id,
            prompt,
            imageUrl: retryPermanentUrl,
            status: 'done',
            cost,
          };
        }
      } catch {
        // Retry also failed
      }
    }

    await prisma.generatedImage.update({
      where: { id: imageRecord.id },
      data: { status: 'failed', errorMessage },
    });

    return {
      id: imageRecord.id,
      prompt,
      status: 'failed',
      errorMessage,
      cost,
    };
  }
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
