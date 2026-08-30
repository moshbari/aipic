import { NextRequest, NextResponse } from 'next/server';
import { getServerSession } from 'next-auth';
import { authOptions } from '@/lib/auth';
import { prisma } from '@/lib/prisma';
import { Prisma } from '@prisma/client';

/**
 * The runs (batches) this user has generated, newest first.
 *
 * People don't remember an image by its page number — they remember the batch
 * they made it in ("the twenty I ran this morning"). This powers the Runs rail
 * in the gallery, so finding an image is one click instead of 56 pages.
 */
export async function GET(request: NextRequest) {
  try {
    const session = await getServerSession(authOptions);
    if (!session?.user?.id) {
      return NextResponse.json({ error: 'Unauthorized' }, { status: 401 });
    }

    const userId = session.user.id;
    const limit = Math.min(
      100,
      Math.max(1, parseInt(new URL(request.url).searchParams.get('limit') || '40') || 40)
    );

    const grouped = await prisma.generatedImage.groupBy({
      by: ['batchId'],
      where: { userId },
      _count: { _all: true },
      _min: { createdAt: true },
      _sum: { cost: true },
      orderBy: { _min: { createdAt: 'desc' } },
      take: limit,
    });

    const batchIds = grouped.map((g) => g.batchId);

    if (batchIds.length === 0) {
      return NextResponse.json({ batches: [] });
    }

    const [byStatus, covers] = await Promise.all([
      prisma.generatedImage.groupBy({
        by: ['batchId', 'status'],
        where: { userId, batchId: { in: batchIds } },
        _count: { _all: true },
      }),
      // One thumbnail per run — the first picture that worked.
      // Done as a window function so MySQL returns exactly one row per run;
      // Prisma's `distinct` would pull every image of every run into memory
      // first, and imageUrl can hold a full base64 picture.
      prisma.$queryRaw<{ batchId: string; imageUrl: string; prompt: string }[]>(
        Prisma.sql`
          SELECT batchId, imageUrl, prompt FROM (
            SELECT batchId, imageUrl, prompt,
                   ROW_NUMBER() OVER (PARTITION BY batchId ORDER BY createdAt ASC) AS rn
            FROM GeneratedImage
            WHERE userId = ${userId}
              AND status = 'done'
              AND batchId IN (${Prisma.join(batchIds)})
          ) ranked WHERE rn = 1
        `
      ),
    ]);

    const doneCounts = new Map<string, number>();
    const failedCounts = new Map<string, number>();
    for (const row of byStatus) {
      const target = row.status === 'done' ? doneCounts : failedCounts;
      target.set(row.batchId, (target.get(row.batchId) || 0) + row._count._all);
    }

    const coverByBatch = new Map(covers.map((c) => [c.batchId, c]));

    return NextResponse.json({
      batches: grouped.map((g) => ({
        batchId: g.batchId,
        startedAt: g._min.createdAt,
        total: g._count._all,
        doneCount: doneCounts.get(g.batchId) || 0,
        failedCount: failedCounts.get(g.batchId) || 0,
        cost: g._sum.cost || 0,
        cover: coverByBatch.get(g.batchId)?.imageUrl || null,
        sample: coverByBatch.get(g.batchId)?.prompt || null,
      })),
    });
  } catch (error) {
    console.error('Get batches error:', error);
    return NextResponse.json({ error: 'Failed to fetch runs' }, { status: 500 });
  }
}
