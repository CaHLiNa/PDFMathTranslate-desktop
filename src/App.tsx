import { invoke } from "@tauri-apps/api/core";
import { listen } from "@tauri-apps/api/event";
import { open } from "@tauri-apps/plugin-dialog";
import { useCallback, useEffect, useMemo, useRef, useState, type CSSProperties } from "react";
import FileTree from "./components/FileTree";
import PdfCanvasView, { type ScrollSyncState } from "./components/PdfCanvasView";
import TaskPanel from "./components/TaskPanel";
import type {
  FileNode,
  TranslationProgressPayload,
  TranslationRequest,
  TranslationTask,
} from "./types";

type PanelId = "left" | "right";
type SidebarView = "explorer" | "translate" | "tasks";
type PreviewLayout = "source" | "translated" | "compare";
type LangOption = { value: string; label: string };
type EngineConnectionConfig = { apiKey: string; model: string; baseUrl: string };
type ThemeId = "vscode-dark-plus" | "vscode-light-plus" | "vscode-high-contrast";

type EnvStatus = 
  | { status: "NotInitialized" }
  | { status: "PythonMissing" }
  | { status: "VenvCreating" }
  | { status: "InstallingDependencies" }
  | { status: "Ready" }
  | { status: "Error", data: string };

interface EnvSetupProgress {
  message: string;
  progress: number;
}

const MIN_SIDEBAR_WIDTH = 220;
const MAX_SIDEBAR_WIDTH = 520;
const DEFAULT_SIDEBAR_WIDTH = 320;
const DEFAULT_ENGINE = "OpenAI";
const ENGINE_OPTIONS = ["OpenAI", "Google", "Bing", "DeepSeek", "Ollama"] as const;
const THEME_OPTIONS: Array<{ id: ThemeId; label: string }> = [
  { id: "vscode-dark-plus", label: "Dark+（默认深色）" },
  { id: "vscode-light-plus", label: "Light+（默认浅色）" },
  { id: "vscode-high-contrast", label: "High Contrast Dark（高对比）" },
];

interface PersistedSettings {
  lastRootDir: string;
  langIn: string;
  langOut: string;
  engine: string;
  mode: "mono" | "dual" | "both";
  engineConfigs: Record<string, EngineConnectionConfig>;
  pythonCmd: string;
  queueLimit: number;
  syncScrollEnabled: boolean;
  sidebarView: SidebarView;
  sidebarVisible: boolean;
  sidebarWidth: number;
  previewLayout: PreviewLayout;
  themeId: ThemeId;
  translatedByInput: Record<string, string>;
  apiKey?: string;
  model?: string;
  baseUrl?: string;
}

const STORAGE_KEY = "pdf2zh.desktop.settings.v7";

const SOURCE_LANGUAGE_OPTIONS: LangOption[] = [
  { value: "auto", label: "自动检测 (auto)" },
  { value: "zh", label: "中文（简体） (zh)" },
  { value: "zh-TW", label: "中文（繁体） (zh-TW)" },
  { value: "en", label: "英语 (en)" },
  { value: "ja", label: "日语 (ja)" },
  { value: "ko", label: "韩语 (ko)" },
  { value: "fr", label: "法语 (fr)" },
  { value: "de", label: "德语 (de)" },
  { value: "es", label: "西班牙语 (es)" },
  { value: "it", label: "意大利语 (it)" },
  { value: "ru", label: "俄语 (ru)" },
  { value: "pt", label: "葡萄牙语 (pt)" },
  { value: "ar", label: "阿拉伯语 (ar)" },
  { value: "hi", label: "印地语 (hi)" },
];

const TARGET_LANGUAGE_OPTIONS: LangOption[] = SOURCE_LANGUAGE_OPTIONS.filter(
  (item) => item.value !== "auto",
);

function defaultEngineConfig(engine: string): EngineConnectionConfig {
  return {
    apiKey: "",
    model: engine === DEFAULT_ENGINE ? "gpt-4o-mini" : "",
    baseUrl: "",
  };
}

function normalizeEngineConfig(value: unknown, engine: string): EngineConnectionConfig {
  const defaults = defaultEngineConfig(engine);
  if (!value || typeof value !== "object") {
    return defaults;
  }
  const record = value as Record<string, unknown>;
  return {
    apiKey: typeof record.apiKey === "string" ? record.apiKey : defaults.apiKey,
    model: typeof record.model === "string" ? record.model : defaults.model,
    baseUrl: typeof record.baseUrl === "string" ? record.baseUrl : defaults.baseUrl,
  };
}

function normalizeEngineConfigs(value: unknown): Record<string, EngineConnectionConfig> {
  const out: Record<string, EngineConnectionConfig> = {};
  if (value && typeof value === "object") {
    for (const [engine, config] of Object.entries(value as Record<string, unknown>)) {
      if (engine.length > 0) {
        out[engine] = normalizeEngineConfig(config, engine);
      }
    }
  }
  for (const engine of ENGINE_OPTIONS) {
    if (!out[engine]) {
      out[engine] = defaultEngineConfig(engine);
    }
  }
  return out;
}

function normalizeEngine(value: unknown): string {
  if (typeof value === "string" && value.trim().length > 0) {
    return value;
  }
  return DEFAULT_ENGINE;
}

function getEngineConfig(
  configs: Record<string, EngineConnectionConfig>,
  engine: string,
): EngineConnectionConfig {
  return configs[engine] ?? defaultEngineConfig(engine);
}

function buildInitialEngineConfigs(
  persisted: Partial<PersistedSettings>,
  currentEngine: string,
): Record<string, EngineConnectionConfig> {
  const configs = normalizeEngineConfigs(persisted.engineConfigs);
  const hasLegacyValue =
    typeof persisted.apiKey === "string" ||
    typeof persisted.model === "string" ||
    typeof persisted.baseUrl === "string";
  if (!hasLegacyValue) {
    return configs;
  }
  const current = getEngineConfig(configs, currentEngine);
  configs[currentEngine] = {
    apiKey: typeof persisted.apiKey === "string" ? persisted.apiKey : current.apiKey,
    model: typeof persisted.model === "string" ? persisted.model : current.model,
    baseUrl: typeof persisted.baseUrl === "string" ? persisted.baseUrl : current.baseUrl,
  };
  return configs;
}

function loadPersistedSettings(): Partial<PersistedSettings> {
  try {
    if (typeof localStorage === "undefined") {
      return {};
    }
    const raw = localStorage.getItem(STORAGE_KEY);
    if (!raw) {
      return {};
    }
    return JSON.parse(raw) as Partial<PersistedSettings>;
  } catch {
    return {};
  }
}

function getOutputPath(task: TranslationTask): string | null {
  return task.monoOutput ?? task.dualOutput ?? null;
}

function normalizeTranslatedMap(value: unknown): Record<string, string> {
  if (!value || typeof value !== "object") {
    return {};
  }
  const out: Record<string, string> = {};
  for (const [key, item] of Object.entries(value as Record<string, unknown>)) {
    if (typeof key === "string" && typeof item === "string" && key.length > 0 && item.length > 0) {
      out[key] = item;
    }
  }
  return out;
}

function dirnameOf(filePath: string): string {
  const slashIndex = Math.max(filePath.lastIndexOf("/"), filePath.lastIndexOf("\\"));
  if (slashIndex <= 0) {
    return filePath;
  }
  return filePath.slice(0, slashIndex);
}

function collectPdfPaths(nodes: FileNode[]): string[] {
  const all: string[] = [];
  const walk = (items: FileNode[]) => {
    for (const node of items) {
      if (node.isDir) {
        walk(node.children);
      } else {
        all.push(node.path);
      }
    }
  };
  walk(nodes);
  return all;
}

function fileLabel(path: string): string {
  return path.split(/[\\/]/).pop() ?? path;
}

function joinPath(dir: string, fileName: string): string {
  if (!dir) {
    return fileName;
  }
  if (dir.endsWith("/") || dir.endsWith("\\")) {
    return `${dir}${fileName}`;
  }
  const sep = dir.includes("\\") && !dir.includes("/") ? "\\" : "/";
  return `${dir}${sep}${fileName}`;
}

function outputCandidates(inputPath: string, langOut: string): string[] {
  const name = fileLabel(inputPath);
  const stem = name.replace(/\.pdf$/i, "");
  const dir = dirnameOf(inputPath);

  const langVariants = Array.from(
    new Set(
      [
        langOut,
        langOut.toLowerCase(),
        langOut.toUpperCase(),
        langOut.split("-")[0],
        langOut.split("_")[0],
      ].filter((v): v is string => Boolean(v)),
    ),
  );

  const names = [
    `${stem}-mono.pdf`,
    ...langVariants.map((lang) => `${stem}.${lang}.mono.pdf`),
    `${stem}-dual.pdf`,
    ...langVariants.map((lang) => `${stem}.${lang}.dual.pdf`),
  ];

  return Array.from(new Set(names)).map((item) => joinPath(dir, item));
}

function discoverTranslatedMap(pdfPaths: string[], langOut: string): Record<string, string> {
  const pathSet = new Set(pdfPaths);
  const found: Record<string, string> = {};

  for (const inputPath of pdfPaths) {
    const candidates = outputCandidates(inputPath, langOut);
    const matched = candidates.find((candidate) => candidate !== inputPath && pathSet.has(candidate));
    if (matched) {
      found[inputPath] = matched;
    }
  }

  return found;
}

function normalizeSidebarView(value: unknown): SidebarView {
  if (value === "explorer" || value === "translate" || value === "tasks") {
    return value;
  }
  return "explorer";
}

function clampSidebarWidth(width: number): number {
  if (Number.isNaN(width)) {
    return DEFAULT_SIDEBAR_WIDTH;
  }
  return Math.max(MIN_SIDEBAR_WIDTH, Math.min(width, MAX_SIDEBAR_WIDTH));
}

function sidebarTitle(view: SidebarView): string {
  if (view === "explorer") {
    return "文档目录";
  }
  if (view === "translate") {
    return "翻译与设置";
  }
  return "任务";
}

function normalizePreviewLayout(value: unknown): PreviewLayout {
  if (value === "source" || value === "translated" || value === "compare") {
    return value;
  }
  return "source";
}

function normalizeThemeId(value: unknown): ThemeId {
  if (value === "vscode-light-plus" || value === "vscode-high-contrast" || value === "vscode-dark-plus") {
    return value;
  }
  return "vscode-dark-plus";
}

function ActivityIcon({ view }: { view: SidebarView }) {
  if (view === "explorer") {
    return (
      <svg className="activity-icon" viewBox="0 0 24 24" aria-hidden="true">
        <path d="M3 6h6l2 2h10v10a2 2 0 0 1-2 2H5a2 2 0 0 1-2-2z" />
        <path d="M3 10h18" />
      </svg>
    );
  }

  if (view === "translate") {
    return (
      <svg className="activity-icon" viewBox="0 0 24 24" aria-hidden="true">
        <path d="M4 7h10" />
        <path d="M9 7c0 5-2 8-5 10" />
        <path d="M7 13c2 1 3 2 5 4" />
        <path d="M14 9h6" />
        <path d="M17 9v8" />
        <path d="M14.5 15h5" />
      </svg>
    );
  }

  return (
    <svg className="activity-icon" viewBox="0 0 24 24" aria-hidden="true">
      <path d="M5 6h14" />
      <path d="M5 12h14" />
      <path d="M5 18h14" />
      <circle cx="4" cy="6" r="1" />
      <circle cx="4" cy="12" r="1" />
      <circle cx="4" cy="18" r="1" />
    </svg>
  );
}

function EnvSetupOverlay({
  status,
  progress,
  logs,
  onStart,
}: {
  status: EnvStatus | null;
  progress: EnvSetupProgress | null;
  logs: string[];
  onStart: () => void;
}) {
  if (!status || status.status === "Ready") return null;

  return (
    <div className="env-setup-overlay">
      <div className="env-setup-card">
        <h2>环境配置</h2>
        <p className="env-description">
          首次运行需要配置 Python 环境并安装 <code>pdf2zh-next</code> 依赖库。
        </p>
        
        {status.status === "Error" && (
          <div className="env-error-box">
            <h4>配置失败</h4>
            <pre>{status.data}</pre>
            <button className="retry-btn" onClick={onStart}>重试</button>
          </div>
        )}

        {(status.status === "VenvCreating" || status.status === "InstallingDependencies") ? (
          <div className="env-progress-section">
            <div className="progress-bar-container">
              <div 
                className="progress-bar-fill" 
                style={{ width: `${progress?.progress ?? 0}%` }}
              />
            </div>
            <p className="progress-message">{progress?.message ?? "正在初始化..."}</p>
            <div className="env-logs-viewer">
              {logs.map((log, i) => (
                <div key={i} className="log-line">{log}</div>
              ))}
            </div>
          </div>
        ) : status.status !== "Error" && (
          <div className="env-action-section">
            <button className="primary-setup-btn" onClick={onStart}>
              开始自动配置
            </button>
            <p className="env-note">这可能需要几分钟，取决于您的网络速度。</p>
          </div>
        )}
      </div>
    </div>
  );
}

export default function App() {
  const persisted = loadPersistedSettings();
  const initialEngine = normalizeEngine(persisted.engine);

  const [sidebarView, setSidebarView] = useState<SidebarView>(normalizeSidebarView(persisted.sidebarView));
  const [sidebarVisible, setSidebarVisible] = useState(persisted.sidebarVisible ?? true);
  const [sidebarWidth, setSidebarWidth] = useState(
    clampSidebarWidth(Number(persisted.sidebarWidth ?? DEFAULT_SIDEBAR_WIDTH)),
  );
  const [previewLayout, setPreviewLayout] = useState<PreviewLayout>(
    normalizePreviewLayout(persisted.previewLayout),
  );
  const [themeId, setThemeId] = useState<ThemeId>(normalizeThemeId(persisted.themeId));

  const [rootDir, setRootDir] = useState<string>(persisted.lastRootDir ?? "");
  const [nodes, setNodes] = useState<FileNode[]>([]);
  const [openTabs, setOpenTabs] = useState<string[]>([]);
  const [activeTab, setActiveTab] = useState<string | null>(null);
  const [translatedByInput, setTranslatedByInput] = useState<Record<string, string>>(
    () => normalizeTranslatedMap(persisted.translatedByInput),
  );
  const [tasksById, setTasksById] = useState<Record<string, TranslationTask>>({});

  const [langIn, setLangIn] = useState(persisted.langIn ?? "en");
  const [langOut, setLangOut] = useState(persisted.langOut ?? "zh");
  const [engine, setEngine] = useState(initialEngine);
  const [mode, setMode] = useState<"mono" | "dual" | "both">(persisted.mode ?? "both");
  const [engineConfigs, setEngineConfigs] = useState<Record<string, EngineConnectionConfig>>(() =>
    buildInitialEngineConfigs(persisted, initialEngine),
  );
  const [pythonCmd, setPythonCmd] = useState(persisted.pythonCmd ?? "python3");
  const [queueLimit, setQueueLimit] = useState(
    Math.max(1, Math.min(Number(persisted.queueLimit ?? 2), 8)),
  );

  const [originPages, setOriginPages] = useState(0);
  const [translatedPages, setTranslatedPages] = useState(0);

  const [batchQueue, setBatchQueue] = useState<string[]>([]);
  const [syncScrollEnabled, setSyncScrollEnabled] = useState(persisted.syncScrollEnabled ?? true);
  const [scrollSyncState, setScrollSyncState] = useState<ScrollSyncState | null>(null);
  const [statusNote, setStatusNote] = useState("准备就绪");
  const [settingsOpen, setSettingsOpen] = useState(false);

  const dispatchingRef = useRef(false);
  const resizingSidebarRef = useRef(false);
  const settingsWrapRef = useRef<HTMLDivElement | null>(null);

  const [envStatus, setEnvStatus] = useState<EnvStatus | null>(null);
  const [setupProgress, setSetupProgress] = useState<EnvSetupProgress | null>(null);
  const [setupLogs, setSetupLogs] = useState<string[]>([]);

  const tasks = useMemo(
    () => Object.values(tasksById).sort((a, b) => b.updatedAt.localeCompare(a.updatedAt)),
    [tasksById],
  );

  const allPdfPaths = useMemo(() => collectPdfPaths(nodes), [nodes]);
  const allPdfPathSet = useMemo(() => new Set(allPdfPaths), [allPdfPaths]);
  const discoveredTranslatedMap = useMemo(
    () => discoverTranslatedMap(allPdfPaths, langOut),
    [allPdfPaths, langOut],
  );
  const runningCount = useMemo(
    () => Object.values(tasksById).filter((task) => task.status === "running").length,
    [tasksById],
  );

  const selectedPdf = activeTab;
  const activeEngineConfig = useMemo(() => getEngineConfig(engineConfigs, engine), [engine, engineConfigs]);
  const translatedCandidate = selectedPdf ? translatedByInput[selectedPdf] ?? null : null;
  const translatedPath =
    translatedCandidate && allPdfPathSet.has(translatedCandidate) ? translatedCandidate : null;
  const hasTranslatedPreview = Boolean(translatedPath);
  const effectivePreviewLayout: PreviewLayout = hasTranslatedPreview
    ? previewLayout
    : "source";
  const currentOutputDir = selectedPdf ? dirnameOf(selectedPdf) : rootDir || "-";
  const selectedPdfLabel = selectedPdf ? fileLabel(selectedPdf) : "未选择文件";

  const updateCurrentEngineConfig = useCallback(
    (key: keyof EngineConnectionConfig, value: string) => {
      setEngineConfigs((prev) => {
        const current = getEngineConfig(prev, engine);
        if (current[key] === value) {
          return prev;
        }
        return {
          ...prev,
          [engine]: {
            ...current,
            [key]: value,
          },
        };
      });
    },
    [engine],
  );

  const refreshTree = useCallback(async (dir: string) => {
    try {
      const tree = await invoke<FileNode[]>("list_pdf_tree", { root: dir });
      setNodes(tree);
    } catch (err) {
      setStatusNote(`目录读取失败: ${err instanceof Error ? err.message : String(err)}`);
      setNodes([]);
    }
  }, []);

  const ensureTabOpen = useCallback((path: string) => {
    setOpenTabs((prev) => (prev.includes(path) ? prev : [...prev, path]));
    setActiveTab(path);
  }, []);

  const closeTab = (path: string) => {
    setOpenTabs((prev) => {
      const next = prev.filter((item) => item !== path);
      if (activeTab === path) {
        setActiveTab(next.length > 0 ? next[next.length - 1] : null);
      }
      return next;
    });
  };

  const startTranslationForPath = useCallback(
    async (inputPath: string) => {
      const request: TranslationRequest = {
        inputPath,
        outputDir: dirnameOf(inputPath),
        langIn,
        langOut,
        engine,
        mode,
        pythonCmd,
        apiKey: activeEngineConfig.apiKey.trim() || undefined,
        model: activeEngineConfig.model.trim() || undefined,
        baseUrl: activeEngineConfig.baseUrl.trim() || undefined,
      };

      const task = await invoke<TranslationTask>("start_translation", { request });
      setTasksById((prev) => ({
        ...prev,
        [task.id]: task,
      }));
      return task;
    },
    [activeEngineConfig, engine, langIn, langOut, mode, pythonCmd],
  );

  const handleTranslateCurrent = async () => {
    if (!selectedPdf) {
      setStatusNote("请先在左侧选择 PDF");
      return;
    }
    await startTranslationForPath(selectedPdf);
    setStatusNote("当前文件已加入翻译队列");
  };

  const handleOpenFolder = async () => {
    const selected = await open({ directory: true, multiple: false });
    if (!selected || typeof selected !== "string") {
      return;
    }

    setRootDir(selected);
    setOpenTabs([]);
    setActiveTab(null);
    setBatchQueue([]);
    setStatusNote("目录已加载");
    setSidebarView("explorer");
    setSidebarVisible(true);
  };

  const handleUseOutput = (task: TranslationTask) => {
    const outputPath = getOutputPath(task);
    if (!outputPath) {
      return;
    }
    setTranslatedByInput((prev) => ({
      ...prev,
      [task.inputPath]: outputPath,
    }));
    ensureTabOpen(task.inputPath);
    setSidebarView("explorer");
    setPreviewLayout("compare");
  };

  const handleCancel = async (taskId: string) => {
    await invoke<boolean>("cancel_translation", { taskId });
  };

  const handlePanelScroll = useCallback(
    (
      source: PanelId,
      _x: number,
      y: number,
      topPx?: number,
      pageNo?: number,
      pageProgress?: number,
    ) => {
      if (!syncScrollEnabled) {
        return;
      }
      setScrollSyncState({ source, x: 0, y, topPx, pageNo, pageProgress, nonce: Date.now() });
    },
    [syncScrollEnabled],
  );

  const handleSidebarSwitch = (view: SidebarView) => {
    setSettingsOpen(false);
    if (sidebarVisible && sidebarView === view) {
      setSidebarVisible(false);
      return;
    }
    setSidebarView(view);
    if (!sidebarVisible) {
      setSidebarVisible(true);
    }
  };

  const toggleSidebarVisible = useCallback(() => {
    setSidebarVisible((prev) => !prev);
  }, []);

  const startResizeSidebar = (startX: number) => {
    if (!sidebarVisible || resizingSidebarRef.current) {
      return;
    }

    resizingSidebarRef.current = true;
    const startWidth = sidebarWidth;

    const handleMove = (clientX: number) => {
      const delta = clientX - startX;
      setSidebarWidth(clampSidebarWidth(startWidth + delta));
    };

    const onMouseMove = (event: MouseEvent) => {
      handleMove(event.clientX);
    };
    const onTouchMove = (event: TouchEvent) => {
      const point = event.touches[0];
      if (!point) {
        return;
      }
      handleMove(point.clientX);
    };

    const stop = () => {
      resizingSidebarRef.current = false;
      window.removeEventListener("mousemove", onMouseMove);
      window.removeEventListener("mouseup", stop);
      window.removeEventListener("touchmove", onTouchMove);
      window.removeEventListener("touchend", stop);
      window.removeEventListener("touchcancel", stop);
    };

    window.addEventListener("mousemove", onMouseMove);
    window.addEventListener("mouseup", stop);
    window.addEventListener("touchmove", onTouchMove, { passive: true });
    window.addEventListener("touchend", stop);
    window.addEventListener("touchcancel", stop);
  };

  const renderSidebarBody = () => {
    if (sidebarView === "explorer") {
      return (
        <section className="sidebar-block sidebar-block-fill">
          <div className="sidebar-block-title">PDF 文件</div>
          <button
            type="button"
            className="sidebar-open-folder-btn"
            onClick={() => {
              void handleOpenFolder();
            }}
          >
            打开文件夹
          </button>
          <div className="sidebar-info" title={rootDir || "未选择目录"}>
            {rootDir || "未选择目录"}
          </div>
          <div className="sidebar-kv">此目录下 PDF: {allPdfPaths.length}</div>
          <div className="sidebar-tree-wrap">
            <FileTree nodes={nodes} selectedPath={selectedPdf} onSelect={ensureTabOpen} />
          </div>
        </section>
      );
    }

    if (sidebarView === "translate") {
      return (
        <section className="sidebar-block sidebar-form-view">
          <div className="sidebar-info" title={selectedPdf ?? ""}>
            当前文件: {selectedPdfLabel}
          </div>
          <div className="sidebar-subtitle">翻译参数</div>
          <div className="compact-grid translate-params-grid">
            <label>
              源语言
              <select value={langIn} onChange={(e) => setLangIn(e.target.value)}>
                {!SOURCE_LANGUAGE_OPTIONS.some((item) => item.value === langIn) && (
                  <option value={langIn}>{langIn}</option>
                )}
                {SOURCE_LANGUAGE_OPTIONS.map((item) => (
                  <option key={item.value} value={item.value}>
                    {item.label}
                  </option>
                ))}
              </select>
            </label>
            <label>
              目标语言
              <select value={langOut} onChange={(e) => setLangOut(e.target.value)}>
                {!TARGET_LANGUAGE_OPTIONS.some((item) => item.value === langOut) && (
                  <option value={langOut}>{langOut}</option>
                )}
                {TARGET_LANGUAGE_OPTIONS.map((item) => (
                  <option key={item.value} value={item.value}>
                    {item.label}
                  </option>
                ))}
              </select>
            </label>
            <label>
              输出模式
              <select value={mode} onChange={(e) => setMode(e.target.value as "mono" | "dual" | "both") }>
                <option value="both">单语 + 双语</option>
                <option value="mono">仅单语</option>
                <option value="dual">仅双语</option>
              </select>
            </label>
            <label className="span-2">
              并发上限
              <input
                type="number"
                min={1}
                max={8}
                value={queueLimit}
                onChange={(e) => {
                  const next = Number(e.target.value);
                  if (!Number.isNaN(next)) {
                    setQueueLimit(Math.max(1, Math.min(next, 8)));
                  }
                }}
              />
            </label>
          </div>

          <div className="sidebar-subtitle">引擎与模型连接</div>
          <div className="stack-form">
            <label>
              引擎
              <select value={engine} onChange={(e) => setEngine(e.target.value)}>
                {!ENGINE_OPTIONS.some((item) => item === engine) && <option value={engine}>{engine}</option>}
                {ENGINE_OPTIONS.map((item) => (
                  <option key={item} value={item}>
                    {item}
                  </option>
                ))}
              </select>
            </label>
            <label>
              API Key
              <input
                type="password"
                value={activeEngineConfig.apiKey}
                onChange={(e) => updateCurrentEngineConfig("apiKey", e.target.value)}
                placeholder="仅保存在本地"
              />
            </label>
            <label>
              模型
              <input
                value={activeEngineConfig.model}
                onChange={(e) => updateCurrentEngineConfig("model", e.target.value)}
                placeholder="例如 gpt-4o-mini"
              />
            </label>
            <label>
              Base URL
              <input
                value={activeEngineConfig.baseUrl}
                onChange={(e) => updateCurrentEngineConfig("baseUrl", e.target.value)}
                placeholder="https://api.openai.com/v1"
              />
            </label>
            <label>
              Python 命令
              <input value={pythonCmd} onChange={(e) => setPythonCmd(e.target.value)} placeholder="python3" />
            </label>
            <label className="toggle-line">
              <input
                type="checkbox"
                checked={syncScrollEnabled}
                onChange={(e) => setSyncScrollEnabled(e.target.checked)}
              />
              <span>双栏同步滚动</span>
            </label>
          </div>

          <div className="sidebar-kv">运行: {runningCount}</div>
          <div className="sidebar-kv" title={currentOutputDir}>输出目录: {currentOutputDir}</div>
        </section>
      );
    }

    return (
      <section className="sidebar-block sidebar-block-fill">
        <TaskPanel tasks={tasks} onUseOutput={handleUseOutput} onCancel={handleCancel} />
      </section>
    );
  };

  useEffect(() => {
    const checkEnv = async () => {
      const status = await invoke<EnvStatus>("check_env_status");
      setEnvStatus(status);
    };
    void checkEnv();

    const unlistenProgress = listen<EnvSetupProgress>("env-setup-progress", (event) => {
      setSetupProgress(event.payload);
    });
    const unlistenLog = listen<string>("env-setup-log", (event) => {
      setSetupLogs((prev) => [...prev.slice(-100), event.payload]);
    });

    return () => {
      void unlistenProgress.then((off) => off());
      void unlistenLog.then((off) => off());
    };
  }, []);

  const handleStartSetup = async () => {
    try {
      setEnvStatus({ status: "VenvCreating" });
      await invoke("setup_env");
      setEnvStatus({ status: "Ready" });
    } catch (err) {
      setEnvStatus({ status: "Error", data: String(err) });
    }
  };

  useEffect(() => {
    if (!rootDir) {
      setNodes([]);
      return;
    }
    void refreshTree(rootDir);
  }, [rootDir, refreshTree]);

  useEffect(() => {
    const unlisten = listen<TranslationProgressPayload>("translation-progress", (event) => {
      const payload = event.payload;
      setTasksById((prev) => ({
        ...prev,
        [payload.taskId]: payload.task,
      }));

      if (payload.task.status === "completed") {
        const outputPath = getOutputPath(payload.task);
        if (outputPath) {
          setTranslatedByInput((prev) => ({
            ...prev,
            [payload.task.inputPath]: outputPath,
          }));
        }
        if (rootDir) {
          void refreshTree(rootDir);
        }
      }
    });

    void invoke<TranslationTask[]>("list_tasks").then((existing) => {
      const mapped: Record<string, TranslationTask> = {};
      const recoveredByTasks: Record<string, string> = {};
      for (const task of existing) {
        mapped[task.id] = task;
        const outputPath = getOutputPath(task);
        if (task.status === "completed" && outputPath) {
          recoveredByTasks[task.inputPath] = outputPath;
        }
      }
      setTasksById(mapped);
      if (Object.keys(recoveredByTasks).length > 0) {
        setTranslatedByInput((prev) => ({
          ...prev,
          ...recoveredByTasks,
        }));
      }
    });

    return () => {
      void unlisten.then((off) => off());
    };
  }, [refreshTree, rootDir]);

  useEffect(() => {
    if (Object.keys(discoveredTranslatedMap).length === 0) {
      return;
    }
    setTranslatedByInput((prev) => {
      let changed = false;
      const next = { ...prev };
      for (const [inputPath, outputPath] of Object.entries(discoveredTranslatedMap)) {
        if (next[inputPath] !== outputPath) {
          next[inputPath] = outputPath;
          changed = true;
        }
      }
      return changed ? next : prev;
    });
  }, [discoveredTranslatedMap]);

  useEffect(() => {
    setEngineConfigs((prev) => {
      if (prev[engine]) {
        return prev;
      }
      return {
        ...prev,
        [engine]: defaultEngineConfig(engine),
      };
    });
  }, [engine]);

  useEffect(() => {
    const payload: PersistedSettings = {
      lastRootDir: rootDir,
      langIn,
      langOut,
      engine,
      mode,
      engineConfigs,
      pythonCmd,
      queueLimit,
      syncScrollEnabled,
      sidebarView,
      sidebarVisible,
      sidebarWidth,
      previewLayout,
      themeId,
      translatedByInput,
    };
    localStorage.setItem(STORAGE_KEY, JSON.stringify(payload));
  }, [
    engine,
    engineConfigs,
    langIn,
    langOut,
    mode,
    pythonCmd,
    queueLimit,
    rootDir,
    syncScrollEnabled,
    sidebarView,
    sidebarVisible,
    sidebarWidth,
    previewLayout,
    themeId,
    translatedByInput,
  ]);

  useEffect(() => {
    if (!hasTranslatedPreview && previewLayout !== "source") {
      setPreviewLayout("source");
    }
  }, [hasTranslatedPreview, previewLayout]);

  useEffect(() => {
    if (effectivePreviewLayout === "source") {
      setTranslatedPages(0);
    } else if (effectivePreviewLayout === "translated") {
      setOriginPages(0);
    }
  }, [effectivePreviewLayout, selectedPdf, translatedPath]);

  useEffect(() => {
    if (dispatchingRef.current || batchQueue.length === 0) {
      return;
    }

    const availableSlots = Math.max(1, queueLimit) - runningCount;
    if (availableSlots <= 0) {
      return;
    }

    dispatchingRef.current = true;

    void (async () => {
      const rest = [...batchQueue];
      let started = 0;

      while (started < availableSlots && rest.length > 0) {
        const next = rest.shift();
        if (!next) {
          break;
        }
        try {
          await startTranslationForPath(next);
          started += 1;
        } catch (err) {
          setStatusNote(`批量派发失败: ${err instanceof Error ? err.message : String(err)}`);
        }
      }

      setBatchQueue(rest);
      if (rest.length === 0) {
        setStatusNote("批量队列已派发完成");
      }
    })().finally(() => {
      dispatchingRef.current = false;
    });
  }, [batchQueue, queueLimit, runningCount, startTranslationForPath]);

  useEffect(() => {
    const onWindowPointerDown = (event: MouseEvent) => {
      const target = event.target as Node | null;
      if (settingsWrapRef.current && target && !settingsWrapRef.current.contains(target)) {
        setSettingsOpen(false);
      }
    };
    const onWindowKeyDown = (event: KeyboardEvent) => {
      if (event.key === "Escape") {
        setSettingsOpen(false);
      }
    };
    if (settingsOpen) {
      window.addEventListener("mousedown", onWindowPointerDown);
      window.addEventListener("keydown", onWindowKeyDown);
    }
    return () => {
      window.removeEventListener("mousedown", onWindowPointerDown);
      window.removeEventListener("keydown", onWindowKeyDown);
    };
  }, [settingsOpen]);

  useEffect(() => {
    const onKeyDown = (event: KeyboardEvent) => {
      const isToggleSidebar =
        (event.metaKey || event.ctrlKey) &&
        !event.altKey &&
        !event.shiftKey &&
        event.key.toLowerCase() === "b";
      if (isToggleSidebar) {
        event.preventDefault();
        toggleSidebarVisible();
      }
    };

    window.addEventListener("keydown", onKeyDown);
    return () => {
      window.removeEventListener("keydown", onKeyDown);
    };
  }, [toggleSidebarVisible]);

  return (
    <div className={`vsc-root theme-${themeId}`}>
      <EnvSetupOverlay 
        status={envStatus} 
        progress={setupProgress} 
        logs={setupLogs} 
        onStart={handleStartSetup} 
      />

      <div
        className={`vsc-workbench${sidebarVisible ? "" : " sidebar-hidden"}`}
        style={{ "--sidebar-width": `${sidebarWidth}px` } as CSSProperties}
      >
        <aside className="activitybar" aria-label="活动栏">
          <div className="activitybar-top">
            <button
              type="button"
              className={`activity-btn${sidebarView === "explorer" ? " active" : ""}`}
              onClick={() => handleSidebarSwitch("explorer")}
              title="文档目录"
            >
              <ActivityIcon view="explorer" />
            </button>
            <button
              type="button"
              className={`activity-btn${sidebarView === "translate" ? " active" : ""}`}
              onClick={() => handleSidebarSwitch("translate")}
              title="翻译与设置"
            >
              <ActivityIcon view="translate" />
            </button>
            <button
              type="button"
              className={`activity-btn${sidebarView === "tasks" ? " active" : ""}`}
              onClick={() => handleSidebarSwitch("tasks")}
              title="任务"
            >
              <ActivityIcon view="tasks" />
            </button>
          </div>
          <div className="activitybar-bottom" ref={settingsWrapRef}>
            {settingsOpen && (
              <div className="settings-popover" role="dialog" aria-label="设置">
                <div className="settings-popover-title">设置</div>
                <label className="settings-field">
                  <span>颜色主题</span>
                  <select
                    value={themeId}
                    onChange={(event) => setThemeId(normalizeThemeId(event.target.value))}
                  >
                    {THEME_OPTIONS.map((item) => (
                      <option key={item.id} value={item.id}>
                        {item.label}
                      </option>
                    ))}
                  </select>
                </label>
              </div>
            )}
            <button
              type="button"
              className={`activity-btn settings-btn${settingsOpen ? " active" : ""}`}
              title="设置"
              onClick={() => setSettingsOpen((prev) => !prev)}
            >
              <svg className="activity-icon" viewBox="0 0 24 24" aria-hidden="true">
                <circle cx="12" cy="12" r="3.2" />
                <path d="M12 4.2v2.1" />
                <path d="M12 17.7v2.1" />
                <path d="M19.8 12h-2.1" />
                <path d="M6.3 12H4.2" />
                <path d="M17.5 6.5l-1.5 1.5" />
                <path d="M8 16l-1.5 1.5" />
                <path d="M17.5 17.5L16 16" />
                <path d="M8 8L6.5 6.5" />
              </svg>
            </button>
          </div>
        </aside>

        {sidebarVisible && (
          <aside className="vsc-sidebar">
            <div className="sidebar-header">
              <span>{sidebarTitle(sidebarView)}</span>
            </div>
            <div className="sidebar-content">{renderSidebarBody()}</div>
          </aside>
        )}

        {sidebarVisible && (
          <div
            className="sidebar-sash"
            role="separator"
            aria-orientation="vertical"
            aria-label="调整侧边栏宽度"
            onMouseDown={(event) => {
              event.preventDefault();
              startResizeSidebar(event.clientX);
            }}
            onTouchStart={(event) => {
              const point = event.touches[0];
              if (!point) {
                return;
              }
              startResizeSidebar(point.clientX);
            }}
          />
        )}

        <main className="vsc-editor-area">
          <div className="editor-tabs">
            {openTabs.length === 0 && <div className="editor-empty">在侧边栏文件树中打开 PDF 文件</div>}
            {openTabs.map((path) => {
              const active = path === activeTab;
              const output = translatedByInput[path];
              const hasOutput = Boolean(output && allPdfPathSet.has(output));
              return (
                <button
                  key={path}
                  type="button"
                  className={`tab-item${active ? " active" : ""}`}
                  onClick={() => setActiveTab(path)}
                  title={path}
                >
                  <span className="tab-title">{fileLabel(path)}</span>
                  {hasOutput && <span className="tab-dot" title="已有译文">●</span>}
                  <span
                    className="tab-close"
                    onClick={(event) => {
                      event.stopPropagation();
                      closeTab(path);
                    }}
                    title="关闭"
                  >
                    ×
                  </span>
                </button>
              );
            })}
          </div>

          <div className="editor-breadcrumbs">
            <span className="crumb">工作区</span>
            <span className="crumb-sep">›</span>
            <span className="crumb">{selectedPdfLabel}</span>
          </div>

          <div className="editor-actions">
            <div className="editor-current" title={selectedPdf ?? ""}>
              当前: {selectedPdfLabel}
            </div>
            <div className="preview-mode-switch">
              <button
                type="button"
                className={effectivePreviewLayout === "source" ? "active" : ""}
                onClick={() => setPreviewLayout("source")}
              >
                原文
              </button>
              <button
                type="button"
                className={effectivePreviewLayout === "translated" ? "active" : ""}
                disabled={!hasTranslatedPreview}
                onClick={() => setPreviewLayout("translated")}
              >
                译文
              </button>
              <button
                type="button"
                className={effectivePreviewLayout === "compare" ? "active" : ""}
                disabled={!hasTranslatedPreview}
                onClick={() => setPreviewLayout("compare")}
              >
                对照
              </button>
            </div>
            <div className="editor-action-buttons">
              <button type="button" disabled={!selectedPdf} onClick={handleTranslateCurrent}>
                翻译当前文件
              </button>
            </div>
          </div>

          <div className={`editor-group${effectivePreviewLayout === "compare" ? " split" : " single"}`}>
            {effectivePreviewLayout !== "translated" && (
              <PdfCanvasView
                key={`left-${effectivePreviewLayout}-${selectedPdf ?? "empty"}`}
                panelId="left"
                title="原文预览"
                path={selectedPdf}
                onPageCount={setOriginPages}
                syncEnabled={effectivePreviewLayout === "compare" && syncScrollEnabled}
                syncScroll={scrollSyncState}
                onPanelScroll={handlePanelScroll}
              />
            )}
            {effectivePreviewLayout !== "source" && (
              <PdfCanvasView
                key={`right-${effectivePreviewLayout}-${translatedPath ?? "empty"}`}
                panelId="right"
                title="译文预览"
                path={translatedPath}
                onPageCount={setTranslatedPages}
                syncEnabled={effectivePreviewLayout === "compare" && syncScrollEnabled}
                syncScroll={scrollSyncState}
                onPanelScroll={handlePanelScroll}
              />
            )}
          </div>
        </main>
      </div>

      <footer className="vsc-statusbar">
        <div className="status-left">
          <span>{statusNote}</span>
          <span>运行 {runningCount}</span>
        </div>
        <div className="status-right">
          <span>原文 {originPages} 页</span>
          <span>译文 {translatedPages} 页</span>
        </div>
      </footer>
    </div>
  );
}
