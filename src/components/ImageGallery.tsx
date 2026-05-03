'use client';

import { useEffect, useState } from 'react';
import { useSession } from 'next-auth/react';

interface ImageItem {
  id: string;
  prompt: string;
  model: string;
  quality?: string;
  size?: string;
  cost: number;
  imageUrl: string;
  batchId: string;
  status: string;
  createdAt: string;
}

interface PaginationData {
  images: ImageItem[];
  total: number;
  page: number;
  pageSize: number;
  pages: number;
}

export function ImageGallery() {
  const { data: session } = useSession();
  const [images, setImages] = useState<ImageItem[]>([]);
  const [pagination, setPagination] = useState<PaginationData | null>(null);
  const [currentPage, setCurrentPage] = useState(1);
  const [isLoading, setIsLoading] = useState(false);
  const [selectedImage, setSelectedImage] = useState<ImageItem | null>(null);

  const fetchImages = async (page: number) => {
    if (!session?.user?.id) return;

    setIsLoading(true);
    try {
      const response = await fetch(`/api/images?page=${page}&pageSize=12`);
      if (!response.ok) throw new Error('Failed to fetch images');

      const data = await response.json();
      setImages(data.images);
      setPagination(data);
    } catch (error) {
      console.error('Fetch error:', error);
    } finally {
      setIsLoading(false);
    }
  };

  useEffect(() => {
    fetchImages(currentPage);
  }, [currentPage]);

  const handleDownload = async (imageUrl: string, prompt: string) => {
    try {
      const response = await fetch(imageUrl);
      const blob = await response.blob();
      const url = window.URL.createObjectURL(blob);
      const a = document.createElement('a');
      a.href = url;
      a.download = `image-${Date.now()}.png`;
      document.body.appendChild(a);
      a.click();
      window.URL.revokeObjectURL(url);
      document.body.removeChild(a);
    } catch (error) {
      console.error('Download error:', error);
      alert('Failed to download image');
    }
  };

  return (
    <div className="space-y-6">
      <div className="bg-surface rounded-xl border border-champagne p-8">
        <h2 className="text-3xl font-bold text-bone mb-2">Image Gallery</h2>
        <p className="text-taupe">
          {pagination?.total || 0} total images
        </p>
      </div>

      {isLoading ? (
        <div className="text-center py-12">
          <p className="text-bone-muted text-lg">Loading images...</p>
        </div>
      ) : images.length === 0 ? (
        <div className="text-center py-12 bg-surface border border-champagne rounded-lg">
          <p className="text-taupe text-lg">No images yet. Generate some!</p>
        </div>
      ) : (
        <>
          <div className="grid grid-cols-1 md:grid-cols-2 lg:grid-cols-3 xl:grid-cols-4 gap-4">
            {images.map((image) => (
              <div
                key={image.id}
                className="bg-surface border border-champagne rounded-lg overflow-hidden hover:border-blue-500 cursor-pointer transition group"
                onClick={() => setSelectedImage(image)}
              >
                <div className="relative overflow-hidden bg-surface-2 h-48">
                  <img
                    src={image.imageUrl}
                    alt={image.prompt}
                    className="w-full h-full object-cover group-hover:scale-105 transition"
                  />
                </div>
                <div className="p-3">
                  <p className="text-bone-muted text-xs line-clamp-2">
                    {image.prompt}
                  </p>
                  <p className="text-champagne text-xs mt-2">
                    {image.model} • ${image.cost.toFixed(4)}
                  </p>
                </div>
              </div>
            ))}
          </div>

          {pagination && pagination.pages > 1 && (
            <div className="flex justify-center gap-2">
              <button
                onClick={() => setCurrentPage(Math.max(1, currentPage - 1))}
                disabled={currentPage === 1}
                className="px-4 py-2 bg-champagne text-canvas hover:bg-champagne-lo disabled:opacity-50 text-bone rounded-lg transition"
              >
                Previous
              </button>
              <div className="flex items-center gap-1">
                {Array.from({ length: pagination.pages }).map((_, i) => (
                  <button
                    key={i + 1}
                    onClick={() => setCurrentPage(i + 1)}
                    className={`px-3 py-2 rounded-lg transition ${
                      currentPage === i + 1
                        ? 'bg-champagne text-canvas text-bone'
                        : 'bg-surface text-bone-muted hover:bg-surface-2'
                    }`}
                  >
                    {i + 1}
                  </button>
                ))}
              </div>
              <button
                onClick={() =>
                  setCurrentPage(Math.min(pagination.pages, currentPage + 1))
                }
                disabled={currentPage === pagination.pages}
                className="px-4 py-2 bg-champagne text-canvas hover:bg-champagne-lo disabled:opacity-50 text-bone rounded-lg transition"
              >
                Next
              </button>
            </div>
          )}
        </>
      )}

      {selectedImage && (
        <div
          className="fixed inset-0 bg-canvas/80 flex items-center justify-center p-4 z-50"
          onClick={() => setSelectedImage(null)}
        >
          <div
            className="bg-surface border border-champagne rounded-lg max-w-2xl w-full max-h-96 overflow-auto"
            onClick={(e) => e.stopPropagation()}
          >
            <div className="p-6 space-y-4">
              <div className="flex justify-between items-start">
                <h3 className="text-xl font-bold text-bone">Image Details</h3>
                <button
                  onClick={() => setSelectedImage(null)}
                  className="text-taupe hover:text-bone transition"
                >
                  ✕
                </button>
              </div>

              <img
                src={selectedImage.imageUrl}
                alt={selectedImage.prompt}
                className="w-full rounded-lg"
              />

              <div className="space-y-2">
                <p className="text-bone-muted">
                  <span className="text-taupe">Prompt:</span> {selectedImage.prompt}
                </p>
                <p className="text-bone-muted">
                  <span className="text-taupe">Model:</span> {selectedImage.model}
                </p>
                {selectedImage.quality && (
                  <p className="text-bone-muted">
                    <span className="text-taupe">Quality:</span> {selectedImage.quality}
                  </p>
                )}
                {selectedImage.size && (
                  <p className="text-bone-muted">
                    <span className="text-taupe">Size:</span> {selectedImage.size}
                  </p>
                )}
                <p className="text-bone-muted">
                  <span className="text-taupe">Cost:</span> ${selectedImage.cost.toFixed(4)}
                </p>
                <p className="text-taupe text-sm">
                  {new Date(selectedImage.createdAt).toLocaleString()}
                </p>
              </div>

              <button
                onClick={() =>
                  handleDownload(selectedImage.imageUrl, selectedImage.prompt)
                }
                className="w-full bg-champagne text-canvas hover:bg-champagne-lo text-bone font-bold py-2 px-4 rounded-lg transition"
              >
                Download Image
              </button>
            </div>
          </div>
        </div>
      )}
    </div>
  );
}
