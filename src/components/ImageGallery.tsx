'use client';

import { useCallback, useEffect, useMemo, useRef, useState } from 'react';
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
  errorMessage?: string;
  createdAt: string;
}

interface BatchItem {
  batchId: string;
  startedAt: string;
  total: number;
  doneCount: number;
  failedCount: number;
  cost: number;
  cover: string | null;
  sample: string | null;
}

type StatusFilter = 'all' | 'done' | 'failed';
type SortOrder = 'newest' | 'oldest';
type Density = 'comfortable' | 'compact';

const PAGE_SIZE = 24;
const RUNS_COLLAPSED = 8;

/**
 * Extract a short, human-readable title for an image:
 * the first 5 words of the prompt (after stripping any leading
 * number prefix like "1." or "Prompt #1 —").
 */
function extractTitle(promptText: string): string {
  let trimmed = promptText.trim();
  trimmed = trimmed.replace(/^(?:Prompt|Image)\s*#?\s*\d+\s*[—–\-:.]\s*/i, '');
  trimmed = trimmed.replace(/^\d+[\.\)]\s*/, '');
  const words = trimmed.split(/\s+/).filter(Boolean).slice(0, 5);
  return words.join(' ') || 'Untitled';
}

async function copyTextToClipboard(text: string): Promise<boolean> {
  try {
    if (navigator.clipboard && window.isSecureContext) {
      await navigator.clipboard.writeText(text);
    } else {
      const ta = document.createElement('textarea');
      ta.value = text;
      ta.style.position = 'fixed';
      ta.style.opacity = '0';
      document.body.appendChild(ta);
      ta.select();
      document.execCommand('copy');
      document.body.removeChild(ta);
    }
    return true;
  } catch (err) {
    console.error('Copy failed:', err);
    return false;
  }
}

function startOfDay(d: Date) {
  return new Date(d.getFullYear(), d.getMonth(), d.getDate()).getTime();
}

/** "Today", "Yesterday", "Monday", or a plain date for anything older. */
function dayLabel(date: Date): string {
  const days = Math.round((startOfDay(new Date()) - startOfDay(date)) / 86400000);
  if (days === 0) return 'Today';
  if (days === 1) return 'Yesterday';
  if (days < 7) return date.toLocaleDateString(undefined, { weekday: 'long' });
  if (date.getFullYear() === new Date().getFullYear()) {
    return date.toLocaleDateString(undefined, { day: 'numeric', month: 'long' });
  }
  return date.toLocaleDateString(undefined, { day: 'numeric', month: 'long', year: 'numeric' });
}

/** "Today, 10:12" — the way a person remembers which run was which. */
function runLabel(startedAt: string): string {
  const date = new Date(startedAt);
  const time = date.toLocaleTimeString(undefined, { hour: 'numeric', minute: '2-digit' });
  return `${dayLabel(date)}, ${time}`;
}

export function ImageGallery() {
  const { data: session } = useSession();

  // ── What the user is looking for ──────────────────────────────────────────
  const [query, setQuery] = useState('');
  const [search, setSearch] = useState('');
  const [status, setStatus] = useState<StatusFilter>('all');
  const [activeBatch, setActiveBatch] = useState<string | null>(null);
  const [sort, setSort] = useState<SortOrder>('newest');
  const [density, setDensity] = useState<Density>('comfortable');

  // ── What came back ────────────────────────────────────────────────────────
  const [items, setItems] = useState<ImageItem[]>([]);
  const [total, setTotal] = useState(0);
  const [totalCost, setTotalCost] = useState(0);
  const [page, setPage] = useState(1);
  const [hasMore, setHasMore] = useState(false);
  const [isLoading, setIsLoading] = useState(true);
  const [isLoadingMore, setIsLoadingMore] = useState(false);
  const [batches, setBatches] = useState<BatchItem[]>([]);
  const [showAllRuns, setShowAllRuns] = useState(false);
  const [libraryTotal, setLibraryTotal] = useState(0);

  // ── Screen state ──────────────────────────────────────────────────────────
  const [selectedIds, setSelectedIds] = useState<Set<string>>(new Set());
  const [lightboxId, setLightboxId] = useState<string | null>(null);
  const [copiedKey, setCopiedKey] = useState<string | null>(null);
  const [retryingIds, setRetryingIds] = useState<Set<string>>(new Set());
  const [runsOpen, setRunsOpen] = useState(false);

  const searchRef = useRef<HTMLInputElement>(null);
  const sentinelRef = useRef<HTMLDivElement>(null);
  const requestId = useRef(0);

  // Typing shouldn't fire a request per keystroke
  useEffect(() => {
    const t = setTimeout(() => setSearch(query.trim()), 300);
    return () => clearTimeout(t);
  }, [query]);

  const fetchPage = useCallback(
    async (pageNum: number, replace: boolean) => {
      if (!session?.user?.id) return;

      const ticket = ++requestId.current;
      if (replace) setIsLoading(true);
      else setIsLoadingMore(true);

      try {
        const params = new URLSearchParams({
          page: String(pageNum),
          pageSize: String(PAGE_SIZE),
          sort: sort === 'oldest' ? 'oldest' : 'newest',
        });
        if (search) params.set('q', search);
        if (status !== 'all') params.set('status', status);
        if (activeBatch) params.set('batchId', activeBatch);

        const response = await fetch(`/api/images?${params.toString()}`);
        if (!response.ok) throw new Error('Failed to fetch images');
        const data = await response.json();

        // A slower earlier request must never overwrite a newer one
        if (ticket !== requestId.current) return;

        setItems((prev) => (replace ? data.images : [...prev, ...data.images]));
        setTotal(data.total || 0);
        setTotalCost(data.totalCost || 0);
        setHasMore(Boolean(data.hasMore));
        setPage(pageNum);
      } catch (error) {
        console.error('Fetch error:', error);
        if (ticket === requestId.current && replace) setItems([]);
      } finally {
        if (ticket === requestId.current) {
          setIsLoading(false);
          setIsLoadingMore(false);
        }
      }
    },
    [session?.user?.id, search, status, activeBatch, sort]
  );

  // Any change of filter starts a fresh list
  useEffect(() => {
    setSelectedIds(new Set());
    fetchPage(1, true);
  }, [fetchPage]);

  const loadRuns = useCallback(async () => {
    if (!session?.user?.id) return;
    try {
      const [runsRes, allRes] = await Promise.all([
        fetch('/api/images/batches?limit=60'),
        fetch('/api/images?page=1&pageSize=1'),
      ]);
      if (runsRes.ok) {
        const data = await runsRes.json();
        setBatches(data.batches || []);
      }
      if (allRes.ok) {
        const data = await allRes.json();
        setLibraryTotal(data.total || 0);
      }
    } catch (error) {
      console.error('Runs error:', error);
    }
  }, [session?.user?.id]);

  useEffect(() => {
    loadRuns();
  }, [loadRuns]);

  // Endless scroll — no page numbers to hunt through
  useEffect(() => {
    const node = sentinelRef.current;
    if (!node || !hasMore || isLoading || isLoadingMore) return;

    const observer = new IntersectionObserver(
      (entries) => {
        if (entries[0]?.isIntersecting) fetchPage(page + 1, false);
      },
      { rootMargin: '600px 0px' }
    );
    observer.observe(node);
    return () => observer.disconnect();
  }, [hasMore, isLoading, isLoadingMore, page, fetchPage]);

  const flashCopied = (key: string) => {
    setCopiedKey(key);
    setTimeout(() => setCopiedKey((prev) => (prev === key ? null : prev)), 1500);
  };

  const doneItems = useMemo(
    () => items.filter((i) => i.status === 'done' && i.imageUrl),
    [items]
  );
  const failedItems = useMemo(
    () => items.filter((i) => i.status !== 'done' || !i.imageUrl),
    [items]
  );

  // Images arrive newest-first, so walking the list in order gives clean
  // "Today / Yesterday / 12 August" headings for free.
  const groups = useMemo(() => {
    const out: { label: string; items: ImageItem[] }[] = [];
    for (const item of items) {
      const label = dayLabel(new Date(item.createdAt));
      const last = out[out.length - 1];
      if (last && last.label === label) last.items.push(item);
      else out.push({ label, items: [item] });
    }
    return out;
  }, [items]);

  const lightboxIndex = useMemo(
    () => (lightboxId ? items.findIndex((i) => i.id === lightboxId) : -1),
    [lightboxId, items]
  );
  const lightboxImage = lightboxIndex >= 0 ? items[lightboxIndex] : null;

  const stepLightbox = useCallback(
    (delta: number) => {
      setLightboxId((current) => {
        if (!current) return current;
        const index = items.findIndex((i) => i.id === current);
        const next = items[index + delta];
        return next ? next.id : current;
      });
    },
    [items]
  );

  // Keyboard: "/" jumps to search, arrows move through the big view
  useEffect(() => {
    const onKey = (e: KeyboardEvent) => {
      const target = e.target as HTMLElement | null;
      const typing =
        target &&
        (target.tagName === 'INPUT' ||
          target.tagName === 'TEXTAREA' ||
          target.isContentEditable);

      if (e.key === '/' && !typing) {
        e.preventDefault();
        searchRef.current?.focus();
        return;
      }
      if (e.key === 'Escape') {
        if (lightboxId) setLightboxId(null);
        else if (selectedIds.size) setSelectedIds(new Set());
        else if (typing) searchRef.current?.blur();
        return;
      }
      if (!lightboxId) return;
      if (e.key === 'ArrowRight') {
        e.preventDefault();
        stepLightbox(1);
      }
      if (e.key === 'ArrowLeft') {
        e.preventDefault();
        stepLightbox(-1);
      }
    };
    window.addEventListener('keydown', onKey);
    return () => window.removeEventListener('keydown', onKey);
  }, [lightboxId, selectedIds.size, stepLightbox]);

  const toggleSelected = (id: string) => {
    setSelectedIds((prev) => {
      const next = new Set(prev);
      if (next.has(id)) next.delete(id);
      else next.add(id);
      return next;
    });
  };

  const selectAllLoaded = () =>
    setSelectedIds(new Set(doneItems.map((i) => i.id)));

  const copySingle = async (image: ImageItem) => {
    const ok = await copyTextToClipboard(`${extractTitle(image.prompt)}\n${image.imageUrl}`);
    if (ok) flashCopied(`single-${image.id}`);
    else alert('Copy failed. Please try again.');
  };

  const copySelected = async () => {
    const ordered = items.filter((i) => selectedIds.has(i.id) && i.imageUrl);
    if (ordered.length === 0) return;
    const text = ordered
      .map((img) => `${extractTitle(img.prompt)}\n${img.imageUrl}`)
      .join('\n\n');
    const ok = await copyTextToClipboard(text);
    if (ok) flashCopied('multi');
    else alert('Copy failed. Please try again.');
  };

  const handleDownload = async (imageUrl: string, promptText: string) => {
    try {
      const response = imageUrl.startsWith('data:')
        ? await fetch(imageUrl)
        : await fetch(`/api/images/download?url=${encodeURIComponent(imageUrl)}`);
      const blob = await response.blob();
      const url = window.URL.createObjectURL(blob);
      const a = document.createElement('a');
      a.href = url;
      a.download = `${extractTitle(promptText).replace(/[<>:"/\\|?*\x00-\x1f]/g, '')}.png`;
      document.body.appendChild(a);
      a.click();
      window.URL.revokeObjectURL(url);
      document.body.removeChild(a);
    } catch (error) {
      console.error('Download error:', error);
      alert('Failed to download image');
    }
  };

  const downloadSelected = async () => {
    const ordered = items.filter((i) => selectedIds.has(i.id) && i.imageUrl);
    for (const image of ordered) {
      await handleDownload(image.imageUrl, image.prompt);
      await new Promise((r) => setTimeout(r, 300));
    }
  };

  /**
   * Try failed pictures again, in place.
   *
   * The server reuses the same row, and hands back any picture that actually
   * worked instead of making it again — so this can never leave two copies
   * behind, and never bills for the same picture twice.
   */
  const retryImages = async (ids: string[]) => {
    const targets = ids.filter((id) => !retryingIds.has(id));
    if (targets.length === 0) return;

    setRetryingIds((prev) => new Set([...prev, ...targets]));
    try {
      const response = await fetch('/api/generate', {
        method: 'POST',
        headers: { 'Content-Type': 'application/json' },
        body: JSON.stringify({ retryImageIds: targets }),
      });
      const data = await response.json().catch(() => ({}));
      if (!response.ok) throw new Error(data?.error || 'Retry failed');

      const byId = new Map<string, any>((data.results || []).map((r: any) => [r.id, r]));
      setItems((prev) =>
        prev.map((img) => {
          const row = byId.get(img.id);
          return row
            ? {
                ...img,
                status: row.status,
                imageUrl: row.imageUrl || '',
                cost: row.cost ?? img.cost,
                errorMessage: row.errorMessage,
              }
            : img;
        })
      );
      loadRuns();
    } catch (error: any) {
      console.error('Retry error:', error);
      alert(error?.message || 'Retry failed. Please try again in a moment.');
    } finally {
      setRetryingIds((prev) => {
        const next = new Set(prev);
        targets.forEach((id) => next.delete(id));
        return next;
      });
    }
  };

  const clearFilters = () => {
    setQuery('');
    setSearch('');
    setStatus('all');
    setActiveBatch(null);
  };

  const isFiltered = Boolean(search || status !== 'all' || activeBatch);
  const activeRun = batches.find((b) => b.batchId === activeBatch) || null;
  const visibleRuns = showAllRuns ? batches : batches.slice(0, RUNS_COLLAPSED);
  const gridClass =
    density === 'compact'
      ? 'grid grid-cols-2 sm:grid-cols-3 lg:grid-cols-5 xl:grid-cols-6 gap-3'
      : 'grid grid-cols-1 sm:grid-cols-2 lg:grid-cols-3 xl:grid-cols-4 gap-4';

  // ── Runs rail ─────────────────────────────────────────────────────────────
  const runsList = (
    <div className="space-y-1">
      <button
        onClick={() => {
          setActiveBatch(null);
          setRunsOpen(false);
        }}
        className={`w-full text-left rounded-xl px-3 py-2.5 transition border ${
          activeBatch === null
            ? 'bg-champagne/15 border-champagne/50'
            : 'bg-transparent border-transparent hover:bg-surface-2/70'
        }`}
      >
        <span className="block text-sm font-semibold text-bone">All images</span>
        <span className="block text-xs text-taupe mt-0.5">
          {libraryTotal.toLocaleString()} in your library
        </span>
      </button>

      {visibleRuns.map((run) => {
        const isActive = run.batchId === activeBatch;
        return (
          <button
            key={run.batchId}
            onClick={() => {
              setActiveBatch(run.batchId);
              setRunsOpen(false);
            }}
            className={`w-full text-left rounded-xl px-2.5 py-2 transition border flex items-center gap-3 ${
              isActive
                ? 'bg-champagne/15 border-champagne/50'
                : 'bg-transparent border-transparent hover:bg-surface-2/70'
            }`}
          >
            {run.cover ? (
              <img
                src={run.cover}
                alt=""
                loading="lazy"
                className="w-10 h-10 rounded-lg object-cover shrink-0 border border-border-soft"
              />
            ) : (
              <div className="w-10 h-10 rounded-lg bg-surface-2 shrink-0 border border-border-soft" />
            )}
            <span className="min-w-0 flex-1">
              <span className="block text-sm font-medium text-bone truncate">
                {runLabel(run.startedAt)}
              </span>
              <span className="block text-[11px] text-taupe truncate">
                {run.total} image{run.total === 1 ? '' : 's'}
                {run.failedCount > 0 && (
                  <span className="text-danger"> · {run.failedCount} failed</span>
                )}
              </span>
            </span>
          </button>
        );
      })}

      {batches.length > RUNS_COLLAPSED && (
        <button
          onClick={() => setShowAllRuns((v) => !v)}
          className="w-full text-left px-3 py-2 text-xs font-semibold text-champagne hover:text-champagne-hi transition"
        >
          {showAllRuns ? 'Show fewer runs' : `Show all ${batches.length} runs`}
        </button>
      )}
    </div>
  );

  return (
    <div className="lg:grid lg:grid-cols-[248px_minmax(0,1fr)] lg:gap-8">
      {/* ── Runs rail (desktop) ───────────────────────────────────────────── */}
      <aside className="hidden lg:block">
        <div className="sticky top-6">
          <h2 className="text-xs font-bold uppercase tracking-wider text-taupe px-3 mb-2">
            Your runs
          </h2>
          <div className="max-h-[calc(100vh-8rem)] overflow-y-auto pr-1">{runsList}</div>
        </div>
      </aside>

      <div className="min-w-0">
        {/* ── Sticky toolbar ─────────────────────────────────────────────── */}
        <div className="sticky top-0 z-30 -mx-4 px-4 pt-4 pb-3 bg-canvas/90 backdrop-blur-md border-b border-border-soft">
          <div className="flex flex-wrap items-center gap-2">
            {/* Search */}
            <div className="relative flex-1 min-w-[220px]">
              <svg
                className="w-4 h-4 text-taupe absolute left-3 top-1/2 -translate-y-1/2 pointer-events-none"
                fill="none"
                stroke="currentColor"
                viewBox="0 0 24 24"
              >
                <path strokeLinecap="round" strokeLinejoin="round" strokeWidth={2} d="M21 21l-4.35-4.35M17 11a6 6 0 11-12 0 6 6 0 0112 0z" />
              </svg>
              <input
                ref={searchRef}
                value={query}
                onChange={(e) => setQuery(e.target.value)}
                placeholder="Search your images by prompt..."
                className="w-full bg-surface-2/80 border border-border-soft rounded-xl pl-9 pr-16 py-2.5 text-sm text-bone placeholder:text-taupe focus:outline-none focus:ring-2 focus:ring-champagne focus:border-transparent"
              />
              {query ? (
                <button
                  onClick={() => setQuery('')}
                  className="absolute right-2 top-1/2 -translate-y-1/2 text-taupe hover:text-bone px-2 py-1 text-sm"
                  title="Clear search"
                >
                  ✕
                </button>
              ) : (
                <kbd className="absolute right-3 top-1/2 -translate-y-1/2 text-[10px] text-taupe border border-border-soft rounded px-1.5 py-0.5 pointer-events-none">
                  /
                </kbd>
              )}
            </div>

            {/* Status pills */}
            <div className="flex items-center bg-surface-2/60 border border-border-soft rounded-xl p-1">
              {([
                { key: 'all', label: 'All' },
                { key: 'done', label: 'Ready' },
                { key: 'failed', label: 'Failed' },
              ] as { key: StatusFilter; label: string }[]).map((pill) => (
                <button
                  key={pill.key}
                  onClick={() => setStatus(pill.key)}
                  className={`px-3 py-1.5 rounded-lg text-xs font-semibold transition ${
                    status === pill.key
                      ? 'bg-champagne text-canvas'
                      : 'text-bone-muted hover:text-bone'
                  }`}
                >
                  {pill.label}
                </button>
              ))}
            </div>

            {/* Runs (mobile) */}
            <div className="relative lg:hidden">
              <button
                onClick={() => setRunsOpen((v) => !v)}
                className="px-3 py-2.5 rounded-xl border border-border-soft bg-surface-2/60 text-xs font-semibold text-bone flex items-center gap-1.5"
              >
                {activeRun ? runLabel(activeRun.startedAt) : 'All runs'}
                <svg className="w-3.5 h-3.5" fill="none" stroke="currentColor" viewBox="0 0 24 24">
                  <path strokeLinecap="round" strokeLinejoin="round" strokeWidth={2} d="M19 9l-7 7-7-7" />
                </svg>
              </button>
              {runsOpen && (
                <div className="absolute right-0 mt-2 w-72 max-h-80 overflow-y-auto bg-surface border border-border-soft rounded-xl shadow-2xl p-2 z-40">
                  {runsList}
                </div>
              )}
            </div>

            {/* Sort */}
            <select
              value={sort}
              onChange={(e) => setSort(e.target.value as SortOrder)}
              className="bg-surface-2/60 border border-border-soft rounded-xl px-3 py-2.5 text-xs font-semibold text-bone focus:outline-none focus:ring-2 focus:ring-champagne"
              title="Sort order"
            >
              <option value="newest">Newest first</option>
              <option value="oldest">Oldest first</option>
            </select>

            {/* Density */}
            <button
              onClick={() => setDensity((d) => (d === 'compact' ? 'comfortable' : 'compact'))}
              className="px-3 py-2.5 rounded-xl border border-border-soft bg-surface-2/60 text-bone-muted hover:text-bone transition"
              title={density === 'compact' ? 'Bigger cards' : 'Fit more on screen'}
            >
              {density === 'compact' ? (
                <svg className="w-4 h-4" fill="none" stroke="currentColor" viewBox="0 0 24 24"><path strokeLinecap="round" strokeLinejoin="round" strokeWidth={2} d="M4 6h7v7H4zM13 6h7v7h-7zM4 15h7v3H4zM13 15h7v3h-7z" /></svg>
              ) : (
                <svg className="w-4 h-4" fill="none" stroke="currentColor" viewBox="0 0 24 24"><path strokeLinecap="round" strokeLinejoin="round" strokeWidth={2} d="M4 5h5v5H4zM11 5h5v5h-5zM18 5h2v5h-2zM4 12h5v5H4zM11 12h5v5h-5zM18 12h2v5h-2z" /></svg>
              )}
            </button>
          </div>

          {/* Result line */}
          <div className="flex flex-wrap items-center gap-x-3 gap-y-1 mt-2.5 text-xs">
            <span className="text-bone-muted">
              {isLoading ? (
                'Loading...'
              ) : (
                <>
                  <span className="text-bone font-semibold">{total.toLocaleString()}</span>{' '}
                  {total === 1 ? 'image' : 'images'}
                  {isFiltered && <span className="text-taupe"> match your filters</span>}
                  {totalCost > 0 && (
                    <span className="text-taupe"> · ${totalCost.toFixed(2)} spent</span>
                  )}
                </>
              )}
            </span>
            {activeRun && (
              <span className="inline-flex items-center gap-1.5 bg-champagne/15 border border-champagne/40 text-champagne rounded-full pl-2.5 pr-1.5 py-0.5 font-semibold">
                Run · {runLabel(activeRun.startedAt)}
                <button onClick={() => setActiveBatch(null)} className="hover:text-bone" title="Show all runs">✕</button>
              </span>
            )}
            {search && (
              <span className="inline-flex items-center gap-1.5 bg-surface-2 border border-border-soft text-bone-muted rounded-full pl-2.5 pr-1.5 py-0.5">
                “{search}”
                <button onClick={() => setQuery('')} className="hover:text-bone" title="Clear search">✕</button>
              </span>
            )}
            {failedItems.length > 0 && (
              <button
                onClick={() => retryImages(failedItems.map((i) => i.id))}
                disabled={retryingIds.size > 0}
                className="ml-auto bg-danger/15 hover:bg-danger/25 text-danger border border-danger/40 disabled:opacity-40 disabled:cursor-not-allowed px-3 py-1.5 rounded-lg font-bold transition"
                title="Generate the failed ones again. Pictures that already worked are left alone — you are never charged twice."
              >
                {retryingIds.size > 0
                  ? `Retrying ${retryingIds.size}...`
                  : `Retry ${failedItems.length} failed`}
              </button>
            )}
          </div>
        </div>

        {/* ── Grid ───────────────────────────────────────────────────────── */}
        {isLoading ? (
          <div className={`${gridClass} mt-6`}>
            {Array.from({ length: 8 }).map((_, i) => (
              <div
                key={i}
                className="rounded-xl border border-border-soft bg-surface/60 overflow-hidden animate-pulse"
              >
                <div className="aspect-square bg-surface-2/70" />
                <div className="p-3 space-y-2">
                  <div className="h-3 bg-surface-2 rounded w-2/3" />
                  <div className="h-2.5 bg-surface-2 rounded w-1/3" />
                </div>
              </div>
            ))}
          </div>
        ) : items.length === 0 ? (
          <div className="text-center py-20 mt-6 bg-surface/60 border border-border-soft rounded-2xl">
            <p className="text-bone text-lg font-semibold">
              {isFiltered ? 'Nothing matches that' : 'No images yet'}
            </p>
            <p className="text-taupe text-sm mt-1">
              {isFiltered
                ? 'Try a different word, or clear the filters.'
                : 'Generate a batch and it will show up here.'}
            </p>
            {isFiltered && (
              <button
                onClick={clearFilters}
                className="mt-4 bg-champagne hover:bg-champagne-hi text-canvas font-bold px-4 py-2 rounded-lg text-sm transition"
              >
                Clear filters
              </button>
            )}
          </div>
        ) : (
          <div className="mt-6 space-y-8">
            {groups.map((group) => (
              <section key={group.label}>
                <div className="flex items-center gap-3 mb-3">
                  <h3 className="text-sm font-bold text-bone">{group.label}</h3>
                  <span className="text-xs text-taupe">
                    {group.items.length} {group.items.length === 1 ? 'image' : 'images'}
                  </span>
                  <div className="flex-1 h-px bg-border-soft" />
                </div>

                <div className={gridClass}>
                  {group.items.map((image) => {
                    const title = extractTitle(image.prompt);
                    const isSelected = selectedIds.has(image.id);
                    const isFailed = image.status !== 'done' || !image.imageUrl;
                    const isRetrying = retryingIds.has(image.id);

                    return (
                      <div
                        key={image.id}
                        className={`group relative bg-surface/80 border rounded-xl overflow-hidden transition ${
                          isSelected
                            ? 'border-champagne ring-2 ring-champagne/40'
                            : 'border-border-soft hover:border-champagne/50'
                        }`}
                      >
                        {isFailed ? (
                          <div className="aspect-square bg-danger/10 flex items-center justify-center border-b border-danger/30 p-4">
                            <div className="text-center">
                              <p className="text-danger font-semibold text-sm mb-1">
                                {isRetrying
                                  ? 'Trying again...'
                                  : image.status === 'generating'
                                  ? 'Still working...'
                                  : 'Failed'}
                              </p>
                              {image.errorMessage && !isRetrying && (
                                <p className="text-danger/80 text-xs line-clamp-2">
                                  {image.errorMessage}
                                </p>
                              )}
                              <p className="text-taupe text-[11px] mt-1">Not charged.</p>
                              <button
                                onClick={() => retryImages([image.id])}
                                disabled={isRetrying}
                                className="mt-2 bg-surface-2 hover:bg-champagne hover:text-canvas text-bone border border-border-soft disabled:opacity-40 disabled:cursor-not-allowed rounded-lg px-3 py-1.5 text-xs font-semibold transition"
                              >
                                Try again
                              </button>
                            </div>
                          </div>
                        ) : (
                          <div
                            className="relative aspect-square overflow-hidden bg-surface-2 cursor-zoom-in"
                            onClick={() => setLightboxId(image.id)}
                          >
                            <img
                              src={image.imageUrl}
                              alt={image.prompt}
                              loading="lazy"
                              className="w-full h-full object-cover transition duration-300 group-hover:scale-105"
                            />

                            {/* Select — always visible once anything is selected */}
                            <label
                              className={`absolute top-2 left-2 flex items-center gap-1.5 bg-canvas/80 backdrop-blur-sm rounded-md px-2 py-1 cursor-pointer select-none transition ${
                                isSelected || selectedIds.size > 0
                                  ? 'opacity-100'
                                  : 'opacity-0 group-hover:opacity-100 focus-within:opacity-100'
                              }`}
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

                            {/* Hover actions */}
                            <div className="absolute bottom-2 right-2 flex gap-1.5 opacity-0 group-hover:opacity-100 transition">
                              <button
                                onClick={(e) => {
                                  e.stopPropagation();
                                  copySingle(image);
                                }}
                                className="bg-canvas/85 backdrop-blur-sm hover:bg-champagne hover:text-canvas text-bone p-2 rounded-lg transition"
                                title="Copy title + link"
                              >
                                {copiedKey === `single-${image.id}` ? (
                                  <svg className="w-4 h-4" fill="none" stroke="currentColor" viewBox="0 0 24 24"><path strokeLinecap="round" strokeLinejoin="round" strokeWidth={2} d="M5 13l4 4L19 7" /></svg>
                                ) : (
                                  <svg className="w-4 h-4" fill="none" stroke="currentColor" viewBox="0 0 24 24"><path strokeLinecap="round" strokeLinejoin="round" strokeWidth={2} d="M8 16H6a2 2 0 01-2-2V6a2 2 0 012-2h8a2 2 0 012 2v2m-6 12h8a2 2 0 002-2v-8a2 2 0 00-2-2h-8a2 2 0 00-2 2v8a2 2 0 002 2z" /></svg>
                                )}
                              </button>
                              <button
                                onClick={(e) => {
                                  e.stopPropagation();
                                  handleDownload(image.imageUrl, image.prompt);
                                }}
                                className="bg-canvas/85 backdrop-blur-sm hover:bg-champagne hover:text-canvas text-bone p-2 rounded-lg transition"
                                title="Download"
                              >
                                <svg className="w-4 h-4" fill="none" stroke="currentColor" viewBox="0 0 24 24"><path strokeLinecap="round" strokeLinejoin="round" strokeWidth={2} d="M12 10v6m0 0l-3-3m3 3l3-3m2 8H7a2 2 0 01-2-2V5a2 2 0 012-2h5.586a1 1 0 01.707.293l5.414 5.414a1 1 0 01.293.707V19a2 2 0 01-2 2z" /></svg>
                              </button>
                            </div>
                          </div>
                        )}

                        <div className="p-3">
                          <p
                            className="text-bone font-semibold text-sm leading-snug line-clamp-1"
                            title={image.prompt}
                          >
                            {title}
                          </p>
                          {density === 'comfortable' && (
                            <p className="text-bone-muted text-xs line-clamp-2 mt-1 leading-relaxed">
                              {image.prompt}
                            </p>
                          )}
                          <div className="flex items-center justify-between mt-2">
                            <span className="text-taupe text-[11px] truncate">
                              {new Date(image.createdAt).toLocaleTimeString(undefined, {
                                hour: 'numeric',
                                minute: '2-digit',
                              })}
                            </span>
                            <span className="text-champagne/80 text-[11px]">
                              {isFailed ? 'not charged' : `$${image.cost.toFixed(4)}`}
                            </span>
                          </div>
                        </div>
                      </div>
                    );
                  })}
                </div>
              </section>
            ))}

            {/* Endless scroll sentinel + a button for anyone who prefers clicking */}
            <div ref={sentinelRef} className="pt-2 pb-10 text-center">
              {isLoadingMore ? (
                <span className="inline-flex items-center gap-2 text-taupe text-sm">
                  <span className="w-4 h-4 border-2 border-champagne border-t-transparent rounded-full animate-spin" />
                  Loading more...
                </span>
              ) : hasMore ? (
                <button
                  onClick={() => fetchPage(page + 1, false)}
                  className="bg-surface-2 hover:bg-champagne hover:text-canvas text-bone border border-border-soft px-5 py-2.5 rounded-xl text-sm font-semibold transition"
                >
                  Load more
                </button>
              ) : (
                <span className="text-taupe text-xs">
                  That&apos;s everything — {items.length.toLocaleString()} shown
                </span>
              )}
            </div>
          </div>
        )}
      </div>

      {/* ── Selection bar ────────────────────────────────────────────────── */}
      {selectedIds.size > 0 && (
        <div className="fixed bottom-5 left-1/2 -translate-x-1/2 z-40 flex flex-wrap items-center justify-center gap-2 bg-surface/95 backdrop-blur-md border border-champagne/40 rounded-2xl px-3 py-2.5 shadow-2xl">
          <span className="text-sm text-bone font-semibold px-2">
            {selectedIds.size} selected
          </span>
          <button
            onClick={copySelected}
            className="bg-champagne hover:bg-champagne-hi text-canvas px-3.5 py-2 rounded-lg text-sm font-bold transition flex items-center gap-1.5"
          >
            {copiedKey === 'multi' ? 'Copied!' : 'Copy links'}
          </button>
          <button
            onClick={downloadSelected}
            className="bg-surface-2 hover:bg-surface-2/70 text-bone border border-border-soft px-3.5 py-2 rounded-lg text-sm font-semibold transition"
          >
            Download
          </button>
          <button
            onClick={selectAllLoaded}
            className="text-bone-muted hover:text-bone px-2 py-2 text-xs font-semibold transition"
          >
            Select all loaded
          </button>
          <button
            onClick={() => setSelectedIds(new Set())}
            className="text-taupe hover:text-bone px-2 py-2 text-xs font-semibold transition"
          >
            Clear
          </button>
        </div>
      )}

      {/* ── Lightbox ─────────────────────────────────────────────────────── */}
      {lightboxImage && (
        <div
          className="fixed inset-0 bg-canvas/95 backdrop-blur-sm z-50 flex items-center justify-center p-4"
          onClick={() => setLightboxId(null)}
        >
          <button
            onClick={(e) => {
              e.stopPropagation();
              stepLightbox(-1);
            }}
            disabled={lightboxIndex <= 0}
            className="absolute left-3 top-1/2 -translate-y-1/2 bg-surface/80 hover:bg-champagne hover:text-canvas text-bone border border-border-soft rounded-full p-3 disabled:opacity-30 disabled:cursor-not-allowed transition"
            title="Previous (←)"
          >
            <svg className="w-5 h-5" fill="none" stroke="currentColor" viewBox="0 0 24 24"><path strokeLinecap="round" strokeLinejoin="round" strokeWidth={2} d="M15 19l-7-7 7-7" /></svg>
          </button>

          <div
            className="bg-surface border border-border-soft rounded-2xl w-full max-w-5xl max-h-[90vh] overflow-hidden flex flex-col lg:flex-row"
            onClick={(e) => e.stopPropagation()}
          >
            <div className="flex-1 bg-canvas flex items-center justify-center min-h-0">
              {lightboxImage.imageUrl ? (
                <img
                  src={lightboxImage.imageUrl}
                  alt={lightboxImage.prompt}
                  className="max-h-[60vh] lg:max-h-[90vh] w-auto object-contain"
                />
              ) : (
                <div className="p-16 text-center">
                  <p className="text-danger font-semibold">This one failed</p>
                  <p className="text-taupe text-xs mt-1">Not charged.</p>
                </div>
              )}
            </div>

            <div className="w-full lg:w-80 shrink-0 p-5 overflow-y-auto space-y-4">
              <div className="flex items-start justify-between gap-3">
                <h3 className="text-lg font-bold text-bone leading-snug">
                  {extractTitle(lightboxImage.prompt)}
                </h3>
                <button
                  onClick={() => setLightboxId(null)}
                  className="text-taupe hover:text-bone transition shrink-0"
                  title="Close (Esc)"
                >
                  ✕
                </button>
              </div>

              <p className="text-bone-muted text-sm leading-relaxed whitespace-pre-wrap">
                {lightboxImage.prompt}
              </p>

              <dl className="text-xs space-y-1.5 border-t border-border-soft pt-3">
                <div className="flex justify-between gap-3">
                  <dt className="text-taupe">Model</dt>
                  <dd className="text-bone-muted">{lightboxImage.model}</dd>
                </div>
                {lightboxImage.size && (
                  <div className="flex justify-between gap-3">
                    <dt className="text-taupe">Size</dt>
                    <dd className="text-bone-muted">{lightboxImage.size}</dd>
                  </div>
                )}
                {lightboxImage.quality && (
                  <div className="flex justify-between gap-3">
                    <dt className="text-taupe">Quality</dt>
                    <dd className="text-bone-muted">{lightboxImage.quality}</dd>
                  </div>
                )}
                <div className="flex justify-between gap-3">
                  <dt className="text-taupe">Cost</dt>
                  <dd className="text-bone-muted">
                    {lightboxImage.status === 'done'
                      ? `$${lightboxImage.cost.toFixed(4)}`
                      : 'not charged'}
                  </dd>
                </div>
                <div className="flex justify-between gap-3">
                  <dt className="text-taupe">Made</dt>
                  <dd className="text-bone-muted">
                    {new Date(lightboxImage.createdAt).toLocaleString()}
                  </dd>
                </div>
              </dl>

              {lightboxImage.imageUrl ? (
                <div className="space-y-2">
                  <button
                    onClick={() => copySingle(lightboxImage)}
                    className="w-full bg-surface-2 hover:bg-champagne hover:text-canvas text-bone border border-border-soft py-2.5 rounded-lg text-sm font-semibold transition"
                  >
                    {copiedKey === `single-${lightboxImage.id}` ? 'Copied!' : 'Copy title + link'}
                  </button>
                  <button
                    onClick={() => handleDownload(lightboxImage.imageUrl, lightboxImage.prompt)}
                    className="w-full bg-champagne hover:bg-champagne-hi text-canvas font-bold py-2.5 rounded-lg text-sm transition"
                  >
                    Download image
                  </button>
                </div>
              ) : (
                <button
                  onClick={() => retryImages([lightboxImage.id])}
                  disabled={retryingIds.has(lightboxImage.id)}
                  className="w-full bg-champagne hover:bg-champagne-hi text-canvas font-bold py-2.5 rounded-lg text-sm transition disabled:opacity-40"
                >
                  {retryingIds.has(lightboxImage.id) ? 'Trying again...' : 'Try again'}
                </button>
              )}

              <button
                onClick={() => {
                  setActiveBatch(lightboxImage.batchId);
                  setLightboxId(null);
                }}
                className="w-full text-champagne hover:text-champagne-hi text-xs font-semibold transition"
              >
                See the whole run this came from →
              </button>
            </div>
          </div>

          <button
            onClick={(e) => {
              e.stopPropagation();
              stepLightbox(1);
            }}
            disabled={lightboxIndex >= items.length - 1}
            className="absolute right-3 top-1/2 -translate-y-1/2 bg-surface/80 hover:bg-champagne hover:text-canvas text-bone border border-border-soft rounded-full p-3 disabled:opacity-30 disabled:cursor-not-allowed transition"
            title="Next (→)"
          >
            <svg className="w-5 h-5" fill="none" stroke="currentColor" viewBox="0 0 24 24"><path strokeLinecap="round" strokeLinejoin="round" strokeWidth={2} d="M9 5l7 7-7 7" /></svg>
          </button>
        </div>
      )}
    </div>
  );
}
