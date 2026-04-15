import { NextRequest, NextResponse } from 'next/server';
import { getServerSession } from 'next-auth';
import { authOptions } from '@/lib/auth';
import { prisma } from '@/lib/prisma';

export async function GET(request: NextRequest) {
  try {
    const session = await getServerSession(authOptions);

    if (!session?.user?.id) {
      return NextResponse.json({ error: 'Unauthorized' }, { status: 401 });
    }

    const url = new URL(request.url);
    const page = parseInt(url.searchParams.get('page') || '1');
    const pageSize = parseInt(url.searchParams.get('pageSize') || '20');
    const batchId = url.searchParams.get('batchId');

    const skip = (page - 1) * pageSize;

    const where: any = { userId: session.user.id };
    if (batchId) {
      where.batchId = batchId;
    }

    const [images, total] = await Promise.all([
      prisma.generatedImage.findMany({
        where,
        orderBy: { createdAt: 'desc' },
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
          createdAt: true,
        },
      }),
      prisma.generatedImage.count({ where }),
    ]);

    return NextResponse.json({
      images,
      total,
      page,
      pageSize,
      pages: Math.ceil(total / pageSize),
    });
  } catch (error) {
    console.error('Get images error:', error);
    return NextResponse.json(
      { error: 'Failed to fetch images' },
      { status: 500 }
    );
  }
}
