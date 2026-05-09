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

/**
 * Extract a short, human-readable title for an image:
 * the first 5 words of the prompt (after stripping any leading
 * number prefix like "1." or "Prompt #1 —").
 */
function extractTitle(promptText: string): string {
  let trimmed = promptText.trim();
  trimmed = trimmed.replace(/^(?:Prompt|Image)\s*#?\s*\d+\s*[—–\-:.]\s*/i, "");
  trimmed = trimmed.replace(/^\d+[\.\)]\s*/, "");
  const words = trimmed.split(/\s+/).filter(Boolean).slice(0, 5);
  return words.join(" ") || "Untitled";
}

async function copyTextToClipboard(text: string): Promise<boolean> {
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
    return true;
  } catch (err) {
    console.error("Copy failed:", err);
    return false;
  }
}

export function ImageGallery() {
  const { data: session } = useSession();
  const [images, setImages] = useState<ImageItem[]>([]);
  const [pagination, setPagination] = useState<PaginationData | null>(null);
  const [currentPage, setCurrentPage] = useState(1);
  const [isLoading, setIsLoading] = useState(false);
  const [selectedImage, setSelectedImage] = useState<ImageItem | null>(null);
  const [selectedIds, setSelectedIds] = useState<Set<string>>(new Set());
  const [copiedKey, setCopiedKey] = useState<string | null>(null);

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
    setSelectedIds(new Set());
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


  const flashCopied = (key: string) => {
    setCopiedKey(key);
    setTimeout(() => {
      setCopiedKey((prev) => (prev === key ? null : prev));
    }, 1500);
  };

  const toggleSelected = (id: string) => {
    setSelectedIds((prev) => {
      const next = new Set(prev);
      if (next.has(id)) next.delete(id);
      else next.add(id);
      return next;
    });
  };

  const selectAllOnPage = () => {
    setSelectedIds((prev) => {
      const next = new Set(prev);
      images.forEach((img) => next.add(img.id));
      return next;
    });
  };

  const clearSelection = () => setSelectedIds(new Set());

  const copySingle = async (image: ImageItem) => {
    const text = `${extractTitle(image.prompt)}\n${image.imageUrl}`;
    const ok = await copyTextToClipboard(text);
    if (ok) flashCopied(`single-${image.id}`);
    else alert("Copy failed. Please try again.");
  };

  const copySelected = async () => {
    const ordered = images.filter((img) => selectedIds.has(img.id));
    if (ordered.length === 0) {
      alert("Select at least one image first.");
      return;
    }
    const text = ordered
      .map((img) => `${extractTitle(img.prompt)}\n${img.imageUrl}`)
      .join("\n\n");
    const ok = await copyTextToClipboard(text);
    if (ok) flashCopied("multi");
    else alert("Copy failed. Please try again.");
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
          <div className="flex flex-wrap items-center justify-between gap-3 mb-2">
            <div className="text-sm text-taupe">
              {selectedIds.size > 0 ? (
                <span className="text-champagne font-medium">{selectedIds.size} selected</span>
              ) : (
                <span>Tip: select images to copy their titles + links</span>
              )}
            </div>
            <div className="flex flex-wrap items-center gap-2">
              <button
                onClick={selectAllOnPage}
                className="bg-surface-2 hover:bg-surface-2 text-bone-muted hover:text-bone px-3 py-2 rounded-lg text-xs font-medium transition border border-border-soft"
              >
                Select All on Page
              </button>
              {selectedIds.size > 0 && (
                <button
                  onClick={clearSelection}
                  className="bg-surface-2 hover:bg-surface-2 text-bone-muted hover:text-bone px-3 py-2 rounded-lg text-xs font-medium transition border border-border-soft"
                >
                  Clear
                </button>
              )}
              <button
                onClick={copySelected}
                disabled={selectedIds.size === 0}
                className="bg-champagne hover:bg-champagne-hi text-canvas disabled:opacity-40 disabled:cursor-not-allowed text-bone px-4 py-2 rounded-lg text-sm font-bold transition flex items-center gap-2"
                title="Copy titles + links of selected images"
              >
                {copiedKey === 'multi' ? (
                  <>
                    <svg className="w-4 h-4" fill="none" stroke="currentColor" viewBox="0 0 24 24"><path strokeLinecap="round" strokeLinejoin="round" strokeWidth={2} d="M5 13l4 4L19 7" /></svg>
                    Copied {selectedIds.size}!
                  </>
                ) : (
                  <>
                    <svg className="w-4 h-4" fill="none" stroke="currentColor" viewBox="0 0 24 24"><path strokeLinecap="round" strokeLinejoin="round" strokeWidth={2} d="M8 16H6a2 2 0 01-2-2V6a2 2 0 012-2h8a2 2 0 012 2v2m-6 12h8a2 2 0 002-2v-8a2 2 0 00-2-2h-8a2 2 0 00-2 2v8a2 2 0 002 2z" /></svg>
                    Copy Selected ({selectedIds.size})
                  </>
                )}
              </button>
            </div>
          </div>
          <div className="grid grid-cols-1 md:grid-cols-2 lg:grid-cols-3 xl:grid-cols-4 gap-4">
            {images.map((image) => {
              const title = extractTitle(image.prompt);
              const isSelected = selectedIds.has(image.id);
              const singleKey = `single-${image.id}`;
              return (
                <div
                  key={image.id}
                  className={`bg-surface border rounded-lg overflow-hidden transition group ${
                    isSelected
                      ? 'border-champagne ring-2 ring-champagne/40'
                      : 'border-champagne hover:border-blue-500'
                  }`}
                >
                  <div
                    className="relative overflow-hidden bg-surface-2 h-48 cursor-pointer"
                    onClick={() => setSelectedImage(image)}
                  >
                    <img
                      src={image.imageUrl}
                      alt={image.prompt}
                      className="w-full h-full object-cover group-hover:scale-105 transition"
                    />
                    <label
                      className="absolute top-2 left-2 flex items-center gap-1.5 bg-canvas/80 backdrop-blur-sm rounded-md px-2 py-1 cursor-pointer select-none"
                      onClick={(e) => e.stopPropagation()}
                      title="Select this image"
                    >
                      <input
                        type="checkbox"
                        checked={isSelected}
                        onChange={() => toggleSelected(image.id)}
                        className="w-4 h-4 rounded border-border-soft text-champagne focus:ring-champagne bg-surface-2"
                      />
                      <span className="text-[11px] text-bone font-medium">Select</span>
                    </label>
                  </div>
                  <div className="p-3">
                    <p className="text-bone font-semibold text-sm leading-snug line-clamp-1" title={title}>
                      {title}
                    </p>
                    <p className="text-bone-muted text-xs line-clamp-2 mt-1">
                      {image.prompt}
                    </p>
                    <p className="text-champagne text-xs mt-2">
                      {image.model} • ${image.cost.toFixed(4)}
                    </p>
                    <button
                      onClick={(e) => {
                        e.stopPropagation();
                        copySingle(image);
                      }}
                      className="mt-2 w-full bg-surface-2 hover:bg-champagne hover:text-canvas text-bone-muted border border-border-soft rounded-lg px-3 py-1.5 text-xs font-semibold transition flex items-center justify-center gap-1.5"
                      title="Copy title + link"
                    >
                      {copiedKey === singleKey ? (
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
                  </div>
                </div>
              );
            })}
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
