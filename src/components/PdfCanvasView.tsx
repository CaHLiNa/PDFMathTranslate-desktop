import { invoke } from "@tauri-apps/api/core";
import {
  getDocument,
  GlobalWorkerOptions,
  type PDFDocumentProxy,
} from "pdfjs-dist";
import workerSrc from "pdfjs-dist/build/pdf.worker.min.mjs?url";
import { useEffect, useRef, useState, type WheelEvent } from "react";

GlobalWorkerOptions.workerSrc = workerSrc;

export interface ScrollSyncState {
  source: "left" | "right";
  x: number;
  y: number;
  topPx?: number;
  pageNo?: number;
  pageProgress?: number;
  nonce: number;
}

interface PdfCanvasViewProps {
  panelId: "left" | "right";
  path: string | null;
  title: string;
  onPageCount: (pageCount: number) => void;
  syncEnabled: boolean;
  sharedScrollRole?: "none" | "master" | "follower";
  syncScroll: ScrollSyncState | null;
  onPanelScroll: (
    panelId: "left" | "right",
    x: number,
    y: number,
    topPx?: number,
    pageNo?: number,
    pageProgress?: number,
  ) => void;
}

const MIN_ZOOM = 0.5;
const MAX_ZOOM = 3;
const ZOOM_STEP = 0.1;

function clampZoom(value: number): number {
  return Math.max(MIN_ZOOM, Math.min(MAX_ZOOM, value));
}

function clamp01(value: number): number {
  return Math.max(0, Math.min(1, value));
}

interface PageAnchor {
  pageNo: number;
  progress: number;
  absoluteTop: number;
}

const VIEWPORT_SYNC_RATIO = 0.5;

function getPageContentMetrics(shell: HTMLElement): { top: number; height: number } {
  const canvas = shell.querySelector<HTMLCanvasElement>("canvas");
  const contentTop = shell.offsetTop + (canvas?.offsetTop ?? 0);
  const contentHeight = Math.max(canvas?.offsetHeight ?? shell.offsetHeight, 1);
  return { top: contentTop, height: contentHeight };
}

function findPageAnchor(el: HTMLElement): PageAnchor | undefined {
  const pageShells = Array.from(el.querySelectorAll<HTMLElement>(".pdf-page-shell"));
  if (pageShells.length === 0) {
    return undefined;
  }

  const pivot = el.scrollTop + el.clientHeight * VIEWPORT_SYNC_RATIO;
  let active = pageShells[0];

  for (const shell of pageShells) {
    const metrics = getPageContentMetrics(shell);
    if (metrics.top <= pivot) {
      active = shell;
    } else {
      break;
    }
  }

  const parsedNo = Number(active.dataset.page ?? "1");
  const pageNo = Number.isFinite(parsedNo) ? Math.max(1, Math.floor(parsedNo)) : 1;
  const activeMetrics = getPageContentMetrics(active);
  const progress = clamp01((pivot - activeMetrics.top) / activeMetrics.height);

  return {
    pageNo,
    progress,
    absoluteTop: activeMetrics.top + progress * activeMetrics.height,
  };
}

function isRenderCancelled(error: unknown): boolean {
  if (!error || typeof error !== "object") {
    return false;
  }
  const name = (error as { name?: string }).name;
  return name === "RenderingCancelledException" || name === "AbortException";
}

export default function PdfCanvasView({
  panelId,
  path,
  title,
  onPageCount,
  syncEnabled,
  sharedScrollRole = "none",
  syncScroll,
  onPanelScroll,
}: PdfCanvasViewProps) {
  const containerRef = useRef<HTMLDivElement | null>(null);
  const canvasRefs = useRef<Array<HTMLCanvasElement | null>>([]);
  const applyingSyncRef = useRef(false);
  const renderPassRef = useRef(0);
  const renderTasksRef = useRef<Map<number, { cancel: () => void }>>(new Map());

  const [doc, setDoc] = useState<PDFDocumentProxy | null>(null);
  const [loading, setLoading] = useState(false);
  const [error, setError] = useState<string | null>(null);
  const [resizeNonce, setResizeNonce] = useState(0);
  const [renderPageCount, setRenderPageCount] = useState(0);
  const [zoom, setZoom] = useState(1);

  const cancelActiveRenders = () => {
    for (const task of renderTasksRef.current.values()) {
      task.cancel();
    }
    renderTasksRef.current.clear();
  };

  useEffect(() => {
    const el = containerRef.current;
    if (!el || typeof ResizeObserver === "undefined") {
      return;
    }

    let lastWidth = Math.floor(el.clientWidth);
    const observer = new ResizeObserver((entries) => {
      const entry = entries[0];
      if (!entry) {
        return;
      }
      const nextWidth = Math.floor(entry.contentRect.width);
      if (Math.abs(nextWidth - lastWidth) < 1) {
        return;
      }
      lastWidth = nextWidth;
      setResizeNonce((n) => n + 1);
    });

    observer.observe(el);
    return () => observer.disconnect();
  }, [path, renderPageCount]);

  useEffect(() => {
    const handleResize = () => setResizeNonce((n) => n + 1);
    window.addEventListener("resize", handleResize);
    return () => window.removeEventListener("resize", handleResize);
  }, []);

  useEffect(() => {
    let canceled = false;

    const load = async () => {
      cancelActiveRenders();
      renderPassRef.current += 1;

      if (!path) {
        if (doc) {
          await doc.destroy();
        }
        setDoc(null);
        setError(null);
        setRenderPageCount(0);
        onPageCount(0);
        return;
      }

      setLoading(true);
      setError(null);

      try {
        const base64 = await invoke<string>("read_pdf_base64", { path });
        const bytes = Uint8Array.from(atob(base64), (c) => c.charCodeAt(0));
        const loadingTask = getDocument({ data: bytes });
        const loaded = await loadingTask.promise;

        if (canceled) {
          await loaded.destroy();
          return;
        }

        if (doc) {
          await doc.destroy();
        }

        setDoc(loaded);
        setRenderPageCount(loaded.numPages);
        canvasRefs.current = Array(loaded.numPages).fill(null);
        onPageCount(loaded.numPages);
      } catch (err) {
        setError(err instanceof Error ? err.message : String(err));
        setRenderPageCount(0);
        onPageCount(0);
      } finally {
        setLoading(false);
      }
    };

    void load();

    return () => {
      canceled = true;
      cancelActiveRenders();
      renderPassRef.current += 1;
    };
    // eslint-disable-next-line react-hooks/exhaustive-deps
  }, [path]);

  useEffect(() => {
    setZoom(1);
  }, [path]);

  useEffect(() => {
    let canceled = false;
    const renderPassId = renderPassRef.current + 1;
    renderPassRef.current = renderPassId;
    cancelActiveRenders();

    const renderAllPages = async () => {
      if (!doc || !containerRef.current || renderPageCount === 0) {
        return;
      }

      const availableWidth = Math.max(containerRef.current.clientWidth - 24, 120);

      for (let pageNo = 1; pageNo <= renderPageCount; pageNo += 1) {
        if (canceled) {
          break;
        }

        const canvas = canvasRefs.current[pageNo - 1];
        if (!canvas) {
          continue;
        }

        const context = canvas.getContext("2d");
        if (!context) {
          continue;
        }

        const pdfPage = await doc.getPage(pageNo);
        if (canceled || renderPassRef.current !== renderPassId) {
          return;
        }

        const rawViewport = pdfPage.getViewport({ scale: 1 });
        const scale = Math.max((availableWidth / rawViewport.width) * zoom, 0.2);
        const viewport = pdfPage.getViewport({ scale });

        const ratio = window.devicePixelRatio || 1;
        canvas.width = Math.floor(viewport.width * ratio);
        canvas.height = Math.floor(viewport.height * ratio);
        canvas.style.width = `${Math.floor(viewport.width)}px`;
        canvas.style.height = `${Math.floor(viewport.height)}px`;

        context.setTransform(ratio, 0, 0, ratio, 0, 0);

        const renderTask = pdfPage.render({
          canvasContext: context,
          viewport,
        });
        renderTasksRef.current.set(pageNo, renderTask);

        try {
          await renderTask.promise;
        } catch (err) {
          if (!isRenderCancelled(err)) {
            throw err;
          }
        } finally {
          renderTasksRef.current.delete(pageNo);
        }

        if (canceled || renderPassRef.current !== renderPassId) {
          return;
        }
      }
    };

    void renderAllPages().catch((err) => {
      if (!isRenderCancelled(err)) {
        setError(err instanceof Error ? err.message : String(err));
      }
    });

    return () => {
      canceled = true;
      cancelActiveRenders();
      renderPassRef.current += 1;
    };
  }, [doc, renderPageCount, resizeNonce, zoom]);

  useEffect(() => {
    if (!syncEnabled || !syncScroll || syncScroll.source === panelId || !containerRef.current) {
      return;
    }

    const el = containerRef.current;
    const maxTop = Math.max(el.scrollHeight - el.clientHeight, 1);
    let targetTop: number | null = null;

    if (typeof syncScroll.topPx === "number" && Number.isFinite(syncScroll.topPx)) {
      targetTop = syncScroll.topPx;
    }

    if (typeof syncScroll.pageNo === "number" && Number.isFinite(syncScroll.pageNo)) {
      const safePageNo = Math.max(1, Math.floor(syncScroll.pageNo));
      const targetPage = el.querySelector<HTMLElement>(`.pdf-page-shell[data-page="${safePageNo}"]`);
      if (targetPage) {
        const progress = clamp01(syncScroll.pageProgress ?? 0);
        const targetMetrics = getPageContentMetrics(targetPage);
        if (targetTop === null) {
          targetTop = targetMetrics.top + progress * targetMetrics.height - el.clientHeight * VIEWPORT_SYNC_RATIO;
        }
      }
    }

    if (targetTop === null) {
      targetTop = syncScroll.y * maxTop;
    }

    const nextTop = Math.max(0, Math.min(targetTop, maxTop));
    if (Math.abs(el.scrollTop - nextTop) < 1) {
      return;
    }

    applyingSyncRef.current = true;
    el.scrollLeft = 0;
    el.scrollTop = nextTop;

    requestAnimationFrame(() => {
      applyingSyncRef.current = false;
    });
  }, [panelId, syncEnabled, syncScroll]);

  const handleScroll = () => {
    if (!syncEnabled || applyingSyncRef.current || !containerRef.current) {
      return;
    }

    const el = containerRef.current;
    const anchor = findPageAnchor(el);

    const maxTop = Math.max(el.scrollHeight - el.clientHeight, 1);
    onPanelScroll(panelId, 0, el.scrollTop / maxTop, el.scrollTop, anchor?.pageNo, anchor?.progress);
  };

  const updateZoom = (delta: number) => {
    setZoom((prev) => clampZoom(Number((prev + delta).toFixed(2))));
  };

  const handleZoomWheel = (event: WheelEvent<HTMLDivElement>) => {
    if (!event.ctrlKey && !event.metaKey) {
      return;
    }
    event.preventDefault();
    updateZoom(event.deltaY < 0 ? ZOOM_STEP : -ZOOM_STEP);
  };

  return (
    <section className="pdf-panel">
      <header className="pdf-panel-header">
        <div className="pdf-panel-title-group">
          <h3>{title}</h3>
          {path ? <code title={path}>{path.split(/[\\/]/).pop()}</code> : <span>未加载</span>}
        </div>
        <div className="pdf-zoom-controls">
          <button type="button" onClick={() => updateZoom(-ZOOM_STEP)} title="缩小">
            -
          </button>
          <button type="button" onClick={() => setZoom(1)} title="重置缩放">
            {Math.round(zoom * 100)}%
          </button>
          <button type="button" onClick={() => updateZoom(ZOOM_STEP)} title="放大">
            +
          </button>
        </div>
      </header>

      <div
        className={`pdf-canvas-container${sharedScrollRole === "follower" ? " shared-scroll-follower" : ""}`}
        ref={containerRef}
        onScroll={handleScroll}
        onWheel={handleZoomWheel}
      >
        {!path && <div className="empty-hint">请选择一个 PDF 文件</div>}
        {path && loading && <div className="empty-hint">正在加载 PDF...</div>}
        {path && error && <div className="error-hint">加载失败: {error}</div>}

        {path && !loading && !error && (
          <div className="pdf-pages">
            {Array.from({ length: renderPageCount }, (_, i) => {
              const pageNo = i + 1;
              return (
                <div className="pdf-page-shell" data-page={pageNo} key={pageNo}>
                  <div className="pdf-page-label">第 {pageNo} 页</div>
                  <canvas
                    ref={(el) => {
                      canvasRefs.current[i] = el;
                    }}
                  />
                </div>
              );
            })}
          </div>
        )}
      </div>
    </section>
  );
}
