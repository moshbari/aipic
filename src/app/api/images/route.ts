import { NextRequest, NextResponse } from 'next/server';
import { getServerSession } from 'next-auth';
import { authOptions } from '@/lib/auth';
import { prisma } from '@/lib/prisma';

const MAX_PAGE_SIZE = 100;

export async function GET(request: NextRequest) {
  try {
    const session = await getServerSession(authOptions);

    if (!session?.user?.id) {
      return NextResponse.json({ error: 'Unauthorized' }, { status: 401 });
    }

    const url = new URL(request.url);
    const page = Math.max(1, parseInt(url.searchParams.get('page') || '1') || 1);
    const pageSize = Math.min(
      MAX_PAGE_SIZE,
      Math.max(1, parseInt(url.searchParams.get('pageSize') || '24') || 24)
    );
    const batchId = url.searchParams.get('batchId');
    const q = (url.searchParams.get('q') || '').trim();
    const status = url.searchParams.get('status'); // done | failed | all
    const sort = url.searchParams.get('sort') === 'oldest' ? 'asc' : 'desc';

    const skip = (page - 1) * pageSize;

    const where: any = { userId: session.user.id };
    if (batchId) where.batchId = batchId;
    if (q) where.prompt = { contains: q };
    if (status === 'done') where.status = 'done';
    // "Needs attention" — anything that didn't produce a picture
    if (status === 'failed') where.status = { not: 'done' };

    const [images, total, spend] = await Promise.all([
      prisma.generatedImage.findMany({
        where,
        orderBy: { createdAt: sort },
        skip,
        take: pageSize,
        select: {
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
          createdAt: true,
        },
      }),
      prisma.generatedImage.count({ where }),
      prisma.generatedImage.aggregate({ where, _sum: { cost: true } }),
    ]);

    return NextResponse.json({
      images,
      total,
      page,
      pageSize,
      pages: Math.ceil(total / pageSize),
      hasMore: skip + images.length < total,
      totalCost: spend._sum.cost || 0,
    });
  } catch (error) {
    console.error('Get images error:', error);
    return NextResponse.json(
      { error: 'Failed to fetch images' },
      { status: 500 }
    );
  }
}
