import { NextRequest, NextResponse } from 'next/server';
import { getServerSession } from 'next-auth';
import { authOptions } from '@/lib/auth';
import { prisma } from '@/lib/prisma';
import { decryptApiKey } from '@/lib/encryption';
import { calculateCost } from '@/lib/models';
import { v4 as uuidv4 } from 'uuid';
import OpenAI from 'openai';

export const maxDuration = 300; // 5 minute timeout for large batches

export async function POST(request: NextRequest) {
  try {
    const session = await getServerSession(authOptions);

    if (!session?.user?.id) {
      return NextResponse.json({ error: 'Unauthorized' }, { status: 401 });
    }

    const { prompts, model, quality, size, style } = await request.json();

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
          style,
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

async function generateSingleImage(
  openai: OpenAI,
  params: {
    prompt: string;
    model: string;
    quality?: string;
    size?: string;
    style?: string;
    batchId: string;
    userId: string;
    index: number;
  }
) {
  const { prompt, model, quality, size, style, batchId, userId, index } = params;
  const cost = calculateCost(model, size || '1024x1024', quality);

  // Create record in DB
  let imageRecord = await prisma.generatedImage.create({
    data: {
      userId,
      prompt,
      model,
      quality,
      size: size || '1024x1024',
      style,
      cost,
      imageUrl: '',
      batchId,
      status: 'generating',
    },
  });

  try {
    let imageUrl = '';

    if (model === 'gpt-image-1') {
      // GPT Image model uses the newer images API
      const response = await openai.images.generate({
        model: 'gpt-image-1',
        prompt,
        size: (size || '1024x1024') as '1024x1024' | '1536x1024' | '1024x1536' | 'auto',
        quality: (quality || 'medium') as 'low' | 'medium' | 'high',
        n: 1,
      });

      // gpt-image-1 returns base64 by default, or URL
      if (response.data[0]?.url) {
        imageUrl = response.data[0].url;
      } else if (response.data[0]?.b64_json) {
        // Convert base64 to a data URL for display
        imageUrl = `data:image/png;base64,${response.data[0].b64_json}`;
      }
    } else if (model === 'dall-e-3') {
      // Clean size for DALL-E 3 (remove -hd suffix if present)
      const cleanSize = size?.replace('-hd', '') || '1024x1024';
      const response = await openai.images.generate({
        model: 'dall-e-3',
        prompt,
        size: cleanSize as '1024x1024' | '1792x1024' | '1024x1792',
        quality: quality === 'hd' ? 'hd' : 'standard',
        style: (style || 'natural') as 'natural' | 'vivid',
        n: 1,
      });

      imageUrl = response.data[0]?.url || '';
    } else if (model === 'dall-e-2') {
      const response = await openai.images.generate({
        model: 'dall-e-2',
        prompt,
        size: (size || '1024x1024') as '256x256' | '512x512' | '1024x1024',
        n: 1,
      });

      imageUrl = response.data[0]?.url || '';
    }

    if (!imageUrl) {
      throw new Error('No image URL returned from API');
    }

    // Update record with result
    imageRecord = await prisma.generatedImage.update({
      where: { id: imageRecord.id },
      data: {
        imageUrl,
        status: 'done',
      },
    });

    return {
      id: imageRecord.id,
      prompt,
      imageUrl,
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

        const retryUrl = retryResponse.data[0]?.url || '';
        if (retryUrl) {
          imageRecord = await prisma.generatedImage.update({
            where: { id: imageRecord.id },
            data: { imageUrl: retryUrl, status: 'done' },
          });
          return {
            id: imageRecord.id,
            prompt,
            imageUrl: retryUrl,
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
