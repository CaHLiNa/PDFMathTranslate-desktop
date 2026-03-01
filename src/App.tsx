import { invoke } from "@tauri-apps/api/core";
import { listen } from "@tauri-apps/api/event";
import { open } from "@tauri-apps/plugin-dialog";
import { setTheme as setAppTheme } from "@tauri-apps/api/app";
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
type SidebarView = "explorer" | "translate" | "llm" | "tasks";
type PreviewLayout = "source" | "translated" | "compare";
type LangOption = { value: string; label: string };
type FontFamilyOption = "auto" | "serif" | "sans-serif" | "script";
type DualDisplayModeOption = "left-right" | "alternating-pages";
type EngineConnectionConfig = { apiKey: string; model: string; baseUrl: string };
type EngineExtraParam = { key: string; value: string };
type EngineId = "OpenAI" | "Gemini" | "DeepSeek" | "Kimi" | "Zhipu";
type ThemeId = "vscode-dark-plus" | "vscode-light-plus" | "vscode-high-contrast";
type ConfigDialogMode = "create" | "edit";

type EnvStatus = 
  | { status: "NotInitialized" }
  | { status: "PythonMissing" }
  | { status: "DownloadingPython", data: number }
  | { status: "ExtractingPython" }
| { status: "VenvCreating" }
| { status: "InstallingDependencies" }
| { status: "Ready" }
| { status: "Error", data: string };

interface EnvSetupProgress {
  message: string;
  progress: number;
}

interface LlmConfigFormState {
  serviceName: string;
  engine: EngineId;
  model: string;
  apiKey: string;
  baseUrl: string;
  active: boolean;
  extraParams: EngineExtraParam[];
}

interface TranslationAdvancedOptions {
  primaryFontFamily: FontFamilyOption;
  dualDisplayMode: DualDisplayModeOption;
  ocrWorkaround: boolean;
  autoEnableOcrWorkaround: boolean;
  noWatermarkMode: boolean;
  saveAutoExtractedGlossary: boolean;
  noAutoExtractGlossary: boolean;
  enhanceCompatibility: boolean;
  translateTableText: boolean;
  onlyIncludeTranslatedPage: boolean;
}

const MIN_SIDEBAR_WIDTH = 220;
const MAX_SIDEBAR_WIDTH = 520;
const DEFAULT_SIDEBAR_WIDTH = 320;
const MIN_TRANSLATION_QPS = 1;
const MAX_TRANSLATION_QPS = 32;
const DEFAULT_TRANSLATION_QPS = 8;
const DEFAULT_ENGINE: EngineId = "OpenAI";
const ENGINE_OPTIONS: readonly EngineId[] = ["OpenAI", "Gemini", "DeepSeek", "Kimi", "Zhipu"];
const ENGINE_ALIASES: Record<string, EngineId> = {
  openai: "OpenAI",
  gpt: "OpenAI",
  gemini: "Gemini",
  google: "Gemini",
  deepseek: "DeepSeek",
  kimi: "Kimi",
  moonshot: "Kimi",
  zhipu: "Zhipu",
  glm: "Zhipu",
  "智普": "Zhipu",
};
const ENGINE_DEFAULTS: Record<EngineId, { model: string; baseUrl: string }> = {
  OpenAI: {
    model: "gpt-4o-mini",
    baseUrl: "https://api.openai.com/v1",
  },
  Gemini: {
    model: "gemini-1.5-flash",
    baseUrl: "https://generativelanguage.googleapis.com/v1beta/openai",
  },
  DeepSeek: {
    model: "deepseek-chat",
    baseUrl: "https://api.deepseek.com/v1",
  },
  Kimi: {
    model: "moonshot-v1-8k",
    baseUrl: "https://api.moonshot.cn/v1",
  },
  Zhipu: {
    model: "glm-4-flash",
    baseUrl: "https://open.bigmodel.cn/api/paas/v4",
  },
};
const ENGINE_MODEL_OPTIONS: Record<EngineId, string[]> = {
  OpenAI: ["gpt-4o-mini", "gpt-4.1-mini", "gpt-4.1"],
  Gemini: ["gemini-2.5-flash", "gemini-2.5-pro", "gemini-1.5-flash"],
  DeepSeek: ["deepseek-chat", "deepseek-reasoner"],
  Kimi: ["moonshot-v1-8k", "moonshot-v1-32k", "moonshot-v1-128k"],
  Zhipu: ["glm-4-flash", "glm-4-plus", "glm-4-air"],
};
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
  translationQps: number;
  translationAdvancedOptions: TranslationAdvancedOptions;
  advancedOptionsExpanded?: boolean;
  engineConfigs: Record<string, EngineConnectionConfig>;
  engineDisplayNames: Record<string, string>;
  engineExtraParams: Record<string, EngineExtraParam[]>;
  llmEngineOrder: string[];
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

const FONT_FAMILY_OPTIONS: Array<{ value: FontFamilyOption; label: string }> = [
  { value: "auto", label: "auto" },
  { value: "serif", label: "serif" },
  { value: "sans-serif", label: "sans-serif" },
  { value: "script", label: "script" },
];

const DUAL_DISPLAY_MODE_OPTIONS: Array<{ value: DualDisplayModeOption; label: string }> = [
  { value: "left-right", label: "Left & Right" },
  { value: "alternating-pages", label: "Alternating Pages" },
];

const DEFAULT_TRANSLATION_ADVANCED_OPTIONS: TranslationAdvancedOptions = {
  primaryFontFamily: "auto",
  dualDisplayMode: "left-right",
  ocrWorkaround: false,
  autoEnableOcrWorkaround: false,
  noWatermarkMode: false,
  saveAutoExtractedGlossary: false,
  noAutoExtractGlossary: false,
  enhanceCompatibility: false,
  translateTableText: true,
  onlyIncludeTranslatedPage: false,
};

function normalizeEngineName(value: string): EngineId | null {
  const raw = value.trim();
  if (!raw) {
    return null;
  }
  if (ENGINE_OPTIONS.includes(raw as EngineId)) {
    return raw as EngineId;
  }
  return ENGINE_ALIASES[raw] ?? ENGINE_ALIASES[raw.toLowerCase()] ?? null;
}

function defaultEngineConfig(engine: string): EngineConnectionConfig {
  const normalized = normalizeEngineName(engine) ?? DEFAULT_ENGINE;
  const defaults = ENGINE_DEFAULTS[normalized];
  return {
    apiKey: "",
    model: defaults.model,
    baseUrl: defaults.baseUrl,
  };
}

function defaultEngineDisplayName(engine: string): string {
  const normalized = normalizeEngineName(engine) ?? DEFAULT_ENGINE;
  return normalized.toLowerCase();
}

function normalizeEngineDisplayNames(value: unknown): Record<string, string> {
  const out: Record<string, string> = {};
  if (value && typeof value === "object") {
    for (const [engine, name] of Object.entries(value as Record<string, unknown>)) {
      const normalized = normalizeEngineName(engine) ?? engine;
      if (typeof name === "string" && name.trim().length > 0) {
        out[normalized] = name.trim();
      }
    }
  }
  for (const engine of ENGINE_OPTIONS) {
    if (!out[engine]) {
      out[engine] = defaultEngineDisplayName(engine);
    }
  }
  return out;
}

function normalizeExtraParam(value: unknown): EngineExtraParam | null {
  if (!value || typeof value !== "object") {
    return null;
  }
  const record = value as Record<string, unknown>;
  const key = typeof record.key === "string" ? record.key.trim() : "";
  const val = typeof record.value === "string" ? record.value.trim() : "";
  if (!key && !val) {
    return null;
  }
  return { key, value: val };
}

function normalizeEngineExtraParams(value: unknown): Record<string, EngineExtraParam[]> {
  const out: Record<string, EngineExtraParam[]> = {};
  if (value && typeof value === "object") {
    for (const [engine, params] of Object.entries(value as Record<string, unknown>)) {
      const normalized = normalizeEngineName(engine) ?? engine;
      if (Array.isArray(params)) {
        out[normalized] = params
          .map(normalizeExtraParam)
          .filter((item): item is EngineExtraParam => item !== null);
      }
    }
  }
  for (const engine of ENGINE_OPTIONS) {
    if (!out[engine]) {
      out[engine] = [];
    }
  }
  return out;
}

function normalizeLlmEngineOrder(value: unknown): EngineId[] {
  const list: EngineId[] = [];
  if (Array.isArray(value)) {
    for (const item of value) {
      if (typeof item !== "string") {
        continue;
      }
      const normalized = normalizeEngineName(item);
      if (normalized && !list.includes(normalized)) {
        list.push(normalized);
      }
    }
  }
  for (const engine of ENGINE_OPTIONS) {
    if (!list.includes(engine)) {
      list.push(engine);
    }
  }
  return list;
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
      const normalizedEngine = normalizeEngineName(engine) ?? engine;
      if (normalizedEngine.length > 0) {
        out[normalizedEngine] = normalizeEngineConfig(config, normalizedEngine);
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
  if (typeof value === "string") {
    const normalized = normalizeEngineName(value);
    if (normalized) {
      return normalized;
    }
  }
  return DEFAULT_ENGINE;
}

function maskApiKey(apiKey: string): string {
  if (!apiKey) {
    return "-";
  }
  if (apiKey.length <= 10) {
    return `${apiKey.slice(0, 2)}***`;
  }
  return `${apiKey.slice(0, 4)}...${apiKey.slice(-3)}`;
}

function truncateMiddle(value: string, maxLength: number): string {
  if (!value || value.length <= maxLength) {
    return value || "-";
  }
  const head = Math.max(4, Math.floor(maxLength * 0.5));
  const tail = Math.max(3, maxLength - head - 3);
  return `${value.slice(0, head)}...${value.slice(-tail)}`;
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

function createLlmConfigForm(
  targetEngine: EngineId,
  engineConfigs: Record<string, EngineConnectionConfig>,
  engineDisplayNames: Record<string, string>,
  engineExtraParams: Record<string, EngineExtraParam[]>,
  activeEngine: string,
): LlmConfigFormState {
  const config = getEngineConfig(engineConfigs, targetEngine);
  return {
    serviceName: engineDisplayNames[targetEngine] ?? defaultEngineDisplayName(targetEngine),
    engine: targetEngine,
    model: config.model,
    apiKey: config.apiKey,
    baseUrl: config.baseUrl,
    active: activeEngine === targetEngine,
    extraParams: [...(engineExtraParams[targetEngine] ?? [])],
  };
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
  if (value === "explorer" || value === "translate" || value === "llm" || value === "tasks") {
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

function clampTranslationQps(qps: number): number {
  if (Number.isNaN(qps)) {
    return DEFAULT_TRANSLATION_QPS;
  }
  return Math.max(MIN_TRANSLATION_QPS, Math.min(qps, MAX_TRANSLATION_QPS));
}

function sidebarTitle(view: SidebarView): string {
  if (view === "explorer") {
    return "文档目录";
  }
  if (view === "translate") {
    return "翻译设置";
  }
  if (view === "llm") {
    return "LLM 配置";
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

function mapThemeIdToAppTheme(themeId: ThemeId): "light" | "dark" {
  if (themeId === "vscode-light-plus") {
    return "light";
  }
  return "dark";
}

function normalizeBoolean(value: unknown, fallback: boolean): boolean {
  if (typeof value === "boolean") {
    return value;
  }
  return fallback;
}

function normalizeFontFamilyOption(value: unknown): FontFamilyOption {
  if (value === "serif" || value === "sans-serif" || value === "script" || value === "auto") {
    return value;
  }
  return "auto";
}

function normalizeDualDisplayModeOption(value: unknown): DualDisplayModeOption {
  if (value === "left-right" || value === "alternating-pages") {
    return value;
  }
  return "left-right";
}

function normalizeTranslationAdvancedOptions(value: unknown): TranslationAdvancedOptions {
  if (!value || typeof value !== "object") {
    return { ...DEFAULT_TRANSLATION_ADVANCED_OPTIONS };
  }
  const record = value as Record<string, unknown>;
  return {
    primaryFontFamily: normalizeFontFamilyOption(record.primaryFontFamily),
    dualDisplayMode: normalizeDualDisplayModeOption(record.dualDisplayMode),
    ocrWorkaround: normalizeBoolean(record.ocrWorkaround, DEFAULT_TRANSLATION_ADVANCED_OPTIONS.ocrWorkaround),
    autoEnableOcrWorkaround: normalizeBoolean(
      record.autoEnableOcrWorkaround,
      DEFAULT_TRANSLATION_ADVANCED_OPTIONS.autoEnableOcrWorkaround,
    ),
    noWatermarkMode: normalizeBoolean(record.noWatermarkMode, DEFAULT_TRANSLATION_ADVANCED_OPTIONS.noWatermarkMode),
    saveAutoExtractedGlossary: normalizeBoolean(
      record.saveAutoExtractedGlossary,
      DEFAULT_TRANSLATION_ADVANCED_OPTIONS.saveAutoExtractedGlossary,
    ),
    noAutoExtractGlossary: normalizeBoolean(
      record.noAutoExtractGlossary,
      DEFAULT_TRANSLATION_ADVANCED_OPTIONS.noAutoExtractGlossary,
    ),
    enhanceCompatibility: normalizeBoolean(
      record.enhanceCompatibility,
      DEFAULT_TRANSLATION_ADVANCED_OPTIONS.enhanceCompatibility,
    ),
    translateTableText: normalizeBoolean(
      record.translateTableText,
      DEFAULT_TRANSLATION_ADVANCED_OPTIONS.translateTableText,
    ),
    onlyIncludeTranslatedPage: normalizeBoolean(
      record.onlyIncludeTranslatedPage,
      DEFAULT_TRANSLATION_ADVANCED_OPTIONS.onlyIncludeTranslatedPage,
    ),
  };
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

  if (view === "llm") {
    return (
      <svg className="activity-icon" viewBox="0 0 24 24" aria-hidden="true">
        <rect x="4" y="4" width="16" height="16" rx="2.5" />
        <path d="M8 9h8" />
        <path d="M8 13h4" />
        <path d="M8 17h6" />
        <circle cx="17.5" cy="13.5" r="1.5" />
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

{(status.status === "VenvCreating" || status.status === "InstallingDependencies" || status.status === "DownloadingPython" || status.status === "ExtractingPython") ? (
<div className="env-progress-section">
<div className="progress-bar-container">
<div
className="progress-bar-fill"
style={{ width: `${progress?.progress ?? 0}%` }}
/>
</div>
<p className="progress-message">{progress?.message ?? "正在初始化..."}</p>
{logs.length > 0 && (
<div className="env-logs-viewer">
{logs.map((log, i) => (
<div key={i} className="log-line">{log}</div>
))}
</div>
)}
          </div>
        ) : (status.status !== "Error" && (
<div className="env-action-section">
<button className="primary-setup-btn" onClick={onStart}>
开始自动配置
</button>
<p className="env-note">这可能需要几分钟，取决于您的网络速度。</p>
          </div>
        )
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
  const [translationQps, setTranslationQps] = useState(
    clampTranslationQps(Number(persisted.translationQps ?? DEFAULT_TRANSLATION_QPS)),
  );
  const [translationAdvancedOptions, setTranslationAdvancedOptions] = useState<TranslationAdvancedOptions>(() =>
    normalizeTranslationAdvancedOptions(persisted.translationAdvancedOptions),
  );
  const [advancedOptionsExpanded, setAdvancedOptionsExpanded] = useState(
    persisted.advancedOptionsExpanded ?? false,
  );
  const [engineConfigs, setEngineConfigs] = useState<Record<string, EngineConnectionConfig>>(() =>
    buildInitialEngineConfigs(persisted, initialEngine),
  );
  const [engineDisplayNames, setEngineDisplayNames] = useState<Record<string, string>>(() =>
    normalizeEngineDisplayNames(persisted.engineDisplayNames),
  );
  const [engineExtraParams, setEngineExtraParams] = useState<Record<string, EngineExtraParam[]>>(() =>
    normalizeEngineExtraParams(persisted.engineExtraParams),
  );
  const [llmEngineOrder, setLlmEngineOrder] = useState<EngineId[]>(() =>
    normalizeLlmEngineOrder(persisted.llmEngineOrder),
  );
  const [selectedConfigEngine, setSelectedConfigEngine] = useState<EngineId>(
    normalizeEngineName(initialEngine) ?? DEFAULT_ENGINE,
  );
  const [configDialogOpen, setConfigDialogOpen] = useState(false);
  const [configDialogMode, setConfigDialogMode] = useState<ConfigDialogMode>("create");
  const [configForm, setConfigForm] = useState<LlmConfigFormState>(() =>
    createLlmConfigForm(
      normalizeEngineName(initialEngine) ?? DEFAULT_ENGINE,
      buildInitialEngineConfigs(persisted, initialEngine),
      normalizeEngineDisplayNames(persisted.engineDisplayNames),
      normalizeEngineExtraParams(persisted.engineExtraParams),
      initialEngine,
    ),
  );

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
  const activeEngineDefaults = useMemo(
    () => ENGINE_DEFAULTS[normalizeEngineName(engine) ?? DEFAULT_ENGINE],
    [engine],
  );
  const orderedLlmEngines = useMemo(() => normalizeLlmEngineOrder(llmEngineOrder), [llmEngineOrder]);
  const llmConfigRows = useMemo(
    () =>
      orderedLlmEngines.map((item) => {
        const config = getEngineConfig(engineConfigs, item);
        return {
          engine: item,
          serviceName: engineDisplayNames[item] ?? defaultEngineDisplayName(item),
          model: config.model || ENGINE_DEFAULTS[item].model,
          baseUrl: config.baseUrl || ENGINE_DEFAULTS[item].baseUrl,
          apiKey: config.apiKey,
          active: engine === item,
          extraParams: engineExtraParams[item] ?? [],
        };
      }),
    [engine, engineConfigs, engineDisplayNames, engineExtraParams, orderedLlmEngines],
  );
  const selectedLlmRow = useMemo(
    () => llmConfigRows.find((item) => item.engine === selectedConfigEngine) ?? llmConfigRows[0] ?? null,
    [llmConfigRows, selectedConfigEngine],
  );
  const translatedCandidate = selectedPdf ? translatedByInput[selectedPdf] ?? null : null;
  const translatedPath =
    translatedCandidate && allPdfPathSet.has(translatedCandidate) ? translatedCandidate : null;
  const hasTranslatedPreview = Boolean(translatedPath);
  const effectivePreviewLayout: PreviewLayout = hasTranslatedPreview
    ? previewLayout
    : "source";
  const isLlmConfigView = sidebarView === "llm";
  const selectedPdfLabel = selectedPdf ? fileLabel(selectedPdf) : "未选择文件";

  const openCreateConfigDialog = useCallback(() => {
    const baseEngine =
      ENGINE_OPTIONS.find((item) => getEngineConfig(engineConfigs, item).apiKey.trim().length === 0) ??
      selectedLlmRow?.engine ??
      DEFAULT_ENGINE;
    const defaults = ENGINE_DEFAULTS[baseEngine];
    setConfigDialogMode("create");
    setConfigForm({
      serviceName: defaultEngineDisplayName(baseEngine),
      engine: baseEngine,
      model: defaults.model,
      apiKey: "",
      baseUrl: defaults.baseUrl,
      active: false,
      extraParams: [],
    });
    setConfigDialogOpen(true);
  }, [engineConfigs, selectedLlmRow?.engine]);

  const openEditConfigDialog = useCallback(() => {
    const target = selectedLlmRow?.engine;
    if (!target) {
      return;
    }
    setConfigDialogMode("edit");
    setConfigForm(createLlmConfigForm(target, engineConfigs, engineDisplayNames, engineExtraParams, engine));
    setConfigDialogOpen(true);
  }, [engine, engineConfigs, engineDisplayNames, engineExtraParams, selectedLlmRow?.engine]);

  const handleConfigFormEngineChange = useCallback(
    (nextEngine: EngineId) => {
      setConfigForm((prev) => {
        const existingConfig = getEngineConfig(engineConfigs, nextEngine);
        const existingName = engineDisplayNames[nextEngine] ?? defaultEngineDisplayName(nextEngine);
        const existingParams = engineExtraParams[nextEngine] ?? [];
        return {
          ...prev,
          engine: nextEngine,
          serviceName: existingName,
          model: existingConfig.model || ENGINE_DEFAULTS[nextEngine].model,
          apiKey: existingConfig.apiKey,
          baseUrl: existingConfig.baseUrl || ENGINE_DEFAULTS[nextEngine].baseUrl,
          active: engine === nextEngine,
          extraParams: [...existingParams],
        };
      });
    },
    [engine, engineConfigs, engineDisplayNames, engineExtraParams],
  );

  const handleSaveConfigDialog = useCallback(() => {
    const targetEngine = configForm.engine;
    const cleanedServiceName = configForm.serviceName.trim() || defaultEngineDisplayName(targetEngine);
    const cleanedModel = configForm.model.trim() || ENGINE_DEFAULTS[targetEngine].model;
    const cleanedApiKey = configForm.apiKey.trim();
    const cleanedBaseUrl = configForm.baseUrl.trim() || ENGINE_DEFAULTS[targetEngine].baseUrl;
    const cleanedParams = configForm.extraParams
      .map((item) => ({ key: item.key.trim(), value: item.value.trim() }))
      .filter((item) => item.key.length > 0);
    const defaultServiceName = defaultEngineDisplayName(targetEngine);
    const existing = getEngineConfig(engineConfigs, targetEngine);
    const existingDisplayName = engineDisplayNames[targetEngine] ?? defaultServiceName;
    const existingParams = engineExtraParams[targetEngine] ?? [];
    const hasExistingConfig =
      existing.apiKey.trim().length > 0 ||
      existing.model.trim() !== ENGINE_DEFAULTS[targetEngine].model ||
      existing.baseUrl.trim() !== ENGINE_DEFAULTS[targetEngine].baseUrl ||
      existingDisplayName !== defaultServiceName ||
      existingParams.length > 0;

    if (configForm.active && cleanedApiKey.length === 0) {
      setStatusNote("激活服务前请先填写 API Key。");
      return;
    }
    if (
      configDialogMode === "create" &&
      hasExistingConfig &&
      !window.confirm(`${targetEngine} 已存在配置，确认覆盖吗？`)
    ) {
      return;
    }

    setEngineConfigs((prev) => ({
      ...prev,
      [targetEngine]: {
        apiKey: cleanedApiKey,
        model: cleanedModel,
        baseUrl: cleanedBaseUrl,
      },
    }));
    setEngineDisplayNames((prev) => ({ ...prev, [targetEngine]: cleanedServiceName }));
    setEngineExtraParams((prev) => ({ ...prev, [targetEngine]: cleanedParams }));
    setSelectedConfigEngine(targetEngine);
    if (configForm.active) {
      setEngine(targetEngine);
    }
    setStatusNote(`已保存 ${cleanedServiceName} 配置`);
    setConfigDialogOpen(false);
  }, [configDialogMode, configForm, engineConfigs, engineDisplayNames, engineExtraParams]);

  const handleDeleteSelectedConfig = useCallback(() => {
    const target = selectedLlmRow?.engine;
    if (!target) {
      return;
    }
    const serviceName = engineDisplayNames[target] ?? defaultEngineDisplayName(target);
    if (!window.confirm(`确认重置 ${serviceName} 的配置吗？`)) {
      return;
    }
    setEngineConfigs((prev) => ({ ...prev, [target]: defaultEngineConfig(target) }));
    setEngineDisplayNames((prev) => ({ ...prev, [target]: defaultEngineDisplayName(target) }));
    setEngineExtraParams((prev) => ({ ...prev, [target]: [] }));
    if (engine === target) {
      const fallbackEngine =
        orderedLlmEngines.find(
          (item) => item !== target && getEngineConfig(engineConfigs, item).apiKey.trim().length > 0,
        ) ?? DEFAULT_ENGINE;
      setEngine(fallbackEngine);
      setSelectedConfigEngine(fallbackEngine);
    }
    setStatusNote(`已重置 ${serviceName} 配置`);
  }, [engine, engineConfigs, engineDisplayNames, orderedLlmEngines, selectedLlmRow?.engine]);

  const handleActivateSelectedConfig = useCallback(() => {
    const target = selectedLlmRow?.engine;
    if (!target) {
      return;
    }
    const targetConfig = getEngineConfig(engineConfigs, target);
    if (targetConfig.apiKey.trim().length === 0) {
      setStatusNote("请先填写 API Key，再激活该服务。");
      return;
    }
    setEngine(target);
    setSelectedConfigEngine(target);
    setStatusNote(`已激活 ${engineDisplayNames[target] ?? target}`);
  }, [engineConfigs, engineDisplayNames, selectedLlmRow?.engine]);

  const handlePinSelectedConfig = useCallback(() => {
    const target = selectedLlmRow?.engine;
    if (!target) {
      return;
    }
    setLlmEngineOrder((prev) => {
      const normalized = normalizeLlmEngineOrder(prev);
      const rest = normalized.filter((item) => item !== target);
      return [target, ...rest];
    });
    setStatusNote(`已将 ${engineDisplayNames[target] ?? target} 置顶`);
  }, [engineDisplayNames, selectedLlmRow?.engine]);

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

  const updateTranslationAdvancedOption = useCallback(
    <K extends keyof TranslationAdvancedOptions>(key: K, value: TranslationAdvancedOptions[K]) => {
      setTranslationAdvancedOptions((prev) => {
        const next = { ...prev, [key]: value };
        if (key === "ocrWorkaround" && value === true) {
          next.autoEnableOcrWorkaround = false;
        }
        if (key === "autoEnableOcrWorkaround" && value === true) {
          next.ocrWorkaround = false;
        }
        if (key === "noAutoExtractGlossary" && value === true) {
          next.saveAutoExtractedGlossary = false;
        }
        if (key === "saveAutoExtractedGlossary" && value === true) {
          next.noAutoExtractGlossary = false;
        }
        return next;
      });
    },
    [],
  );

  const advancedOptionChangesCount = useMemo(() => {
    let changes = 0;
    if (translationAdvancedOptions.primaryFontFamily !== DEFAULT_TRANSLATION_ADVANCED_OPTIONS.primaryFontFamily) {
      changes += 1;
    }
    if (translationAdvancedOptions.dualDisplayMode !== DEFAULT_TRANSLATION_ADVANCED_OPTIONS.dualDisplayMode) {
      changes += 1;
    }
    if (translationAdvancedOptions.ocrWorkaround) {
      changes += 1;
    }
    if (translationAdvancedOptions.autoEnableOcrWorkaround) {
      changes += 1;
    }
    if (translationAdvancedOptions.noWatermarkMode) {
      changes += 1;
    }
    if (translationAdvancedOptions.saveAutoExtractedGlossary) {
      changes += 1;
    }
    if (translationAdvancedOptions.noAutoExtractGlossary) {
      changes += 1;
    }
    if (translationAdvancedOptions.enhanceCompatibility) {
      changes += 1;
    }
    if (translationAdvancedOptions.translateTableText !== DEFAULT_TRANSLATION_ADVANCED_OPTIONS.translateTableText) {
      changes += 1;
    }
    if (translationAdvancedOptions.onlyIncludeTranslatedPage) {
      changes += 1;
    }
    return changes;
  }, [translationAdvancedOptions]);

  const resetTranslationAdvancedOptions = useCallback(() => {
    setTranslationAdvancedOptions({ ...DEFAULT_TRANSLATION_ADVANCED_OPTIONS });
    setStatusNote("高级选项已恢复默认值");
  }, []);

  const startTranslationForPath = useCallback(
    async (inputPath: string) => {
      const request: TranslationRequest = {
        inputPath,
        outputDir: dirnameOf(inputPath),
        langIn,
        langOut,
        engine,
        mode,
        qps: clampTranslationQps(translationQps),
        apiKey: activeEngineConfig.apiKey.trim() || undefined,
        model: activeEngineConfig.model.trim() || undefined,
        baseUrl: activeEngineConfig.baseUrl.trim() || undefined,
        primaryFontFamily: translationAdvancedOptions.primaryFontFamily,
        useAlternatingPagesDual: translationAdvancedOptions.dualDisplayMode === "alternating-pages",
        ocrWorkaround: translationAdvancedOptions.ocrWorkaround,
        autoEnableOcrWorkaround: translationAdvancedOptions.autoEnableOcrWorkaround,
        noWatermarkMode: translationAdvancedOptions.noWatermarkMode,
        saveAutoExtractedGlossary: translationAdvancedOptions.saveAutoExtractedGlossary,
        noAutoExtractGlossary: translationAdvancedOptions.noAutoExtractGlossary,
        enhanceCompatibility: translationAdvancedOptions.enhanceCompatibility,
        translateTableText: translationAdvancedOptions.translateTableText,
        onlyIncludeTranslatedPage: translationAdvancedOptions.onlyIncludeTranslatedPage,
      };


      const task = await invoke<TranslationTask>("start_translation", { request });
      setTasksById((prev) => ({
        ...prev,
        [task.id]: task,
      }));
      return task;
    },
    [activeEngineConfig, engine, langIn, langOut, mode, translationAdvancedOptions, translationQps],
  );

  const handleTranslateCurrent = async () => {
    if (!selectedPdf) {
      setStatusNote("请先在左侧选择 PDF");
      return;
    }
    try {
      await startTranslationForPath(selectedPdf);
      setStatusNote("当前文件已加入翻译队列");
    } catch (err) {
      setStatusNote(err instanceof Error ? err.message : String(err));
    }
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
    if (view === "llm") {
      setSelectedConfigEngine(normalizeEngineName(engine) ?? DEFAULT_ENGINE);
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
          <div className="sidebar-subtitle">翻译设置</div>
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
              翻译速度 (QPS)
              <input
                type="number"
                min={MIN_TRANSLATION_QPS}
                max={MAX_TRANSLATION_QPS}
                value={translationQps}
                onChange={(e) => {
                  const next = Number(e.target.value);
                  if (!Number.isNaN(next)) {
                    setTranslationQps(clampTranslationQps(next));
                  }
                }}
              />
            </label>
            <label className="span-2">
              并发任务数
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
          <div className="sidebar-section-header">
            <button
              type="button"
              className="sidebar-section-toggle"
              onClick={() => setAdvancedOptionsExpanded((prev) => !prev)}
              aria-expanded={advancedOptionsExpanded}
            >
              <span>{advancedOptionsExpanded ? "▾" : "▸"}</span>
              <span>高级选项</span>
            </button>
            <button
              type="button"
              className="sidebar-section-reset"
              onClick={resetTranslationAdvancedOptions}
              disabled={advancedOptionChangesCount === 0}
            >
              重置默认
            </button>
          </div>
          {!advancedOptionsExpanded && (
            <div className="sidebar-kv">已启用高级项: {advancedOptionChangesCount}</div>
          )}
          {advancedOptionsExpanded && (
            <>
              <div className="compact-grid translate-advanced-grid">
                <label>
                  选择字体
                  <select
                    value={translationAdvancedOptions.primaryFontFamily}
                    onChange={(e) =>
                      updateTranslationAdvancedOption("primaryFontFamily", e.target.value as FontFamilyOption)
                    }
                  >
                    {FONT_FAMILY_OPTIONS.map((item) => (
                      <option key={item.value} value={item.value}>
                        {item.label}
                      </option>
                    ))}
                  </select>
                </label>
                <label>
                  双语(Dual)文件显示模式
                  <select
                    value={translationAdvancedOptions.dualDisplayMode}
                    onChange={(e) =>
                      updateTranslationAdvancedOption("dualDisplayMode", e.target.value as DualDisplayModeOption)
                    }
                  >
                    {DUAL_DISPLAY_MODE_OPTIONS.map((item) => (
                      <option key={item.value} value={item.value}>
                        {item.label}
                      </option>
                    ))}
                  </select>
                </label>
              </div>
              <div className="translate-option-check-grid">
                <label className="translate-option-check">
                  <input
                    type="checkbox"
                    checked={translationAdvancedOptions.ocrWorkaround}
                    onChange={(e) => updateTranslationAdvancedOption("ocrWorkaround", e.target.checked)}
                  />
                  <span>强制开启OCR版临时解决方案（不推荐）</span>
                </label>
                <label className="translate-option-check">
                  <input
                    type="checkbox"
                    checked={translationAdvancedOptions.autoEnableOcrWorkaround}
                    onChange={(e) => updateTranslationAdvancedOption("autoEnableOcrWorkaround", e.target.checked)}
                  />
                  <span>自动开启OCR版临时解决方案</span>
                </label>
                <label className="translate-option-check">
                  <input
                    type="checkbox"
                    checked={translationAdvancedOptions.noWatermarkMode}
                    onChange={(e) => updateTranslationAdvancedOption("noWatermarkMode", e.target.checked)}
                  />
                  <span>无水印模式</span>
                </label>
                <label className="translate-option-check">
                  <input
                    type="checkbox"
                    checked={translationAdvancedOptions.saveAutoExtractedGlossary}
                    onChange={(e) => updateTranslationAdvancedOption("saveAutoExtractedGlossary", e.target.checked)}
                  />
                  <span>保存自动提取术语表</span>
                </label>
                <label className="translate-option-check">
                  <input
                    type="checkbox"
                    checked={translationAdvancedOptions.noAutoExtractGlossary}
                    onChange={(e) => updateTranslationAdvancedOption("noAutoExtractGlossary", e.target.checked)}
                  />
                  <span>禁用自动术语提取</span>
                </label>
                <label className="translate-option-check">
                  <input
                    type="checkbox"
                    checked={translationAdvancedOptions.enhanceCompatibility}
                    onChange={(e) => updateTranslationAdvancedOption("enhanceCompatibility", e.target.checked)}
                  />
                  <span>兼容性模式（自动启用必要兼容策略）</span>
                </label>
                <label className="translate-option-check">
                  <input
                    type="checkbox"
                    checked={translationAdvancedOptions.translateTableText}
                    onChange={(e) => updateTranslationAdvancedOption("translateTableText", e.target.checked)}
                  />
                  <span>翻译表格文本（Experimental）</span>
                </label>
                <label className="translate-option-check">
                  <input
                    type="checkbox"
                    checked={translationAdvancedOptions.onlyIncludeTranslatedPage}
                    onChange={(e) => updateTranslationAdvancedOption("onlyIncludeTranslatedPage", e.target.checked)}
                  />
                  <span>PDF仅包含选择翻译的页面</span>
                </label>
              </div>
            </>
          )}
        </section>
      );
    }

    if (sidebarView === "llm") {
      return (
        <section className="sidebar-block sidebar-form-view">
          <div className="sidebar-subtitle">LLM API 配置</div>
          <div className="llm-quick-card">
            <div className="sidebar-kv">当前激活服务: {engineDisplayNames[engine] ?? engine}</div>
            <div className="sidebar-kv">当前模型: {activeEngineConfig.model || activeEngineDefaults.model}</div>
            <div className="sidebar-kv">配置已在右侧主区域打开</div>
            <button
              type="button"
              className="sidebar-open-folder-btn"
              onClick={() => {
                setSelectedConfigEngine(normalizeEngineName(engine) ?? DEFAULT_ENGINE);
              }}
            >
              刷新到当前激活服务
            </button>
          </div>
        </section>
      );
    }

    return (
      <section className="sidebar-block sidebar-block-fill">
        <TaskPanel tasks={tasks} onUseOutput={handleUseOutput} onCancel={handleCancel} />
      </section>
    );
  };

  const renderLlmConfigPage = () => {
    const currentEngine = selectedLlmRow?.engine ?? DEFAULT_ENGINE;
    const extraParamSummary =
      selectedLlmRow && selectedLlmRow.extraParams.length > 0
        ? selectedLlmRow.extraParams.map((item) => `${item.key}=${item.value}`).join("; ")
        : "-";

    return (
      <section className="llm-config-page">
        <div className="llm-config-header">
          <div>
            <h2>LLM API 配置管理</h2>
            <p>请在此处维护模型服务配置，翻译时将使用已激活的服务。</p>
          </div>
        </div>

        <div className="llm-config-table-wrap">
          <table className="llm-config-table">
            <thead>
              <tr>
                <th>服务</th>
                <th>模型</th>
                <th>API URL</th>
                <th>API Key</th>
                <th>激活</th>
                <th>额外参数</th>
              </tr>
            </thead>
            <tbody>
              {llmConfigRows.map((row) => (
                <tr
                  key={row.engine}
                  className={selectedConfigEngine === row.engine ? "selected" : ""}
                  onClick={() => setSelectedConfigEngine(row.engine)}
                >
                  <td>{row.serviceName}</td>
                  <td>{row.model || ENGINE_DEFAULTS[row.engine].model}</td>
                  <td title={row.baseUrl || ENGINE_DEFAULTS[row.engine].baseUrl}>
                    {truncateMiddle(row.baseUrl || ENGINE_DEFAULTS[row.engine].baseUrl, 36)}
                  </td>
                  <td title={row.apiKey || "-"}>
                    {maskApiKey(row.apiKey)}
                  </td>
                  <td>{row.active ? "✅" : ""}</td>
                  <td title={row.extraParams.map((item) => `${item.key}=${item.value}`).join("; ") || "-"}>
                    {row.extraParams.length > 0 ? `${row.extraParams.length} 项` : "-"}
                  </td>
                </tr>
              ))}
            </tbody>
          </table>
        </div>

        <div className="llm-config-actions">
          <button type="button" onClick={openCreateConfigDialog}>新增</button>
          <button type="button" onClick={handleDeleteSelectedConfig} disabled={!selectedLlmRow}>删除</button>
          <button type="button" onClick={openEditConfigDialog} disabled={!selectedLlmRow}>编辑</button>
          <button
            type="button"
            onClick={handleActivateSelectedConfig}
            disabled={!selectedLlmRow || selectedLlmRow.active}
          >
            激活
          </button>
          <button type="button" onClick={handlePinSelectedConfig} disabled={!selectedLlmRow}>置顶</button>
        </div>

        <div className="llm-config-current">
          <span>当前选中: {engineDisplayNames[currentEngine] ?? currentEngine}</span>
          <span title={extraParamSummary}>额外参数: {truncateMiddle(extraParamSummary, 50)}</span>
        </div>

        {configDialogOpen && (
          <div className="llm-config-dialog-backdrop">
            <div className="llm-config-dialog" role="dialog" aria-modal="true" aria-label="LLM API 配置编辑">
              <h3>{configDialogMode === "create" ? "添加新的 LLM API 配置" : "编辑 LLM API 配置"}</h3>
              <div className="llm-config-dialog-form">
                <label>
                  LLM服务名称 *
                  <input
                    value={configForm.serviceName}
                    onChange={(e) => setConfigForm((prev) => ({ ...prev, serviceName: e.target.value }))}
                    placeholder="例如 deepseek"
                  />
                </label>
                <label>
                  服务类型
                  <select
                    value={configForm.engine}
                    onChange={(e) => handleConfigFormEngineChange(e.target.value as EngineId)}
                    disabled={configDialogMode === "edit"}
                  >
                    {ENGINE_OPTIONS.map((item) => (
                      <option key={item} value={item}>
                        {item}
                      </option>
                    ))}
                  </select>
                </label>
                <label>
                  模型名称
                  <input
                    value={configForm.model}
                    onChange={(e) => setConfigForm((prev) => ({ ...prev, model: e.target.value }))}
                    placeholder={ENGINE_DEFAULTS[configForm.engine].model}
                  />
                </label>
                <label>
                  常用模型
                  <select
                    value=""
                    onChange={(e) => {
                      if (!e.target.value) {
                        return;
                      }
                      setConfigForm((prev) => ({ ...prev, model: e.target.value }));
                      e.target.value = "";
                    }}
                  >
                    <option value="">请选择常用模型</option>
                    {ENGINE_MODEL_OPTIONS[configForm.engine].map((item) => (
                      <option key={item} value={item}>
                        {item}
                      </option>
                    ))}
                  </select>
                </label>
                <label className="span-2">
                  LLM API KEY
                  <input
                    type="password"
                    value={configForm.apiKey}
                    onChange={(e) => setConfigForm((prev) => ({ ...prev, apiKey: e.target.value }))}
                    placeholder="请输入 API 密钥"
                  />
                </label>
                <label className="span-2">
                  LLM BASE URL
                  <input
                    value={configForm.baseUrl}
                    onChange={(e) => setConfigForm((prev) => ({ ...prev, baseUrl: e.target.value }))}
                    placeholder={ENGINE_DEFAULTS[configForm.engine].baseUrl}
                  />
                </label>
                <label className="span-2 llm-active-toggle">
                  <input
                    type="checkbox"
                    checked={configForm.active}
                    onChange={(e) => setConfigForm((prev) => ({ ...prev, active: e.target.checked }))}
                  />
                  <span>激活此配置（同类型服务中的其他配置将被停用）</span>
                </label>
                <div className="span-2 llm-extra-param-block">
                  <div className="llm-extra-param-header">
                    <span>额外参数</span>
                    <button
                      type="button"
                      onClick={() =>
                        setConfigForm((prev) => ({
                          ...prev,
                          extraParams: [...prev.extraParams, { key: "", value: "" }],
                        }))
                      }
                    >
                      + 添加参数
                    </button>
                  </div>
                  {configForm.extraParams.length === 0 && (
                    <div className="llm-extra-param-empty">未添加额外参数</div>
                  )}
                  {configForm.extraParams.map((item, index) => (
                    <div key={`${index}-${item.key}`} className="llm-extra-param-row">
                      <input
                        value={item.key}
                        onChange={(e) =>
                          setConfigForm((prev) => {
                            const next = [...prev.extraParams];
                            next[index] = { ...next[index], key: e.target.value };
                            return { ...prev, extraParams: next };
                          })
                        }
                        placeholder="参数名"
                      />
                      <input
                        value={item.value}
                        onChange={(e) =>
                          setConfigForm((prev) => {
                            const next = [...prev.extraParams];
                            next[index] = { ...next[index], value: e.target.value };
                            return { ...prev, extraParams: next };
                          })
                        }
                        placeholder="参数值"
                      />
                      <button
                        type="button"
                        onClick={() =>
                          setConfigForm((prev) => ({
                            ...prev,
                            extraParams: prev.extraParams.filter((_, rowIndex) => rowIndex !== index),
                          }))
                        }
                      >
                        删除
                      </button>
                    </div>
                  ))}
                </div>
              </div>
              <div className="llm-config-dialog-actions">
                <button type="button" className="save" onClick={handleSaveConfigDialog}>保存</button>
                <button type="button" onClick={() => setConfigDialogOpen(false)}>取消</button>
              </div>
            </div>
          </div>
        )}
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
    if (llmConfigRows.length === 0) {
      return;
    }
    if (!selectedConfigEngine || !llmConfigRows.some((item) => item.engine === selectedConfigEngine)) {
      setSelectedConfigEngine(llmConfigRows[0].engine);
    }
  }, [llmConfigRows, selectedConfigEngine]);

  useEffect(() => {
    if (!isLlmConfigView && configDialogOpen) {
      setConfigDialogOpen(false);
    }
  }, [configDialogOpen, isLlmConfigView]);

  useEffect(() => {
    const payload: PersistedSettings = {
      lastRootDir: rootDir,
      langIn,
      langOut,
      engine,
      mode,
      translationQps,
      translationAdvancedOptions,
      advancedOptionsExpanded,
      engineConfigs,
      engineDisplayNames,
      engineExtraParams,
      llmEngineOrder,
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
    engineDisplayNames,
    engineExtraParams,
    llmEngineOrder,
    langIn,
    langOut,
    mode,
    translationQps,
    translationAdvancedOptions,
    advancedOptionsExpanded,
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
    void setAppTheme(mapThemeIdToAppTheme(themeId)).catch(() => {
      // Ignore permission/platform failures in non-desktop preview environments.
    });
  }, [themeId]);

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
              title="翻译设置"
            >
              <ActivityIcon view="translate" />
            </button>
            <button
              type="button"
              className={`activity-btn${sidebarView === "llm" ? " active" : ""}`}
              onClick={() => handleSidebarSwitch("llm")}
              title="LLM 配置"
            >
              <ActivityIcon view="llm" />
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

        <main className={`vsc-editor-area${isLlmConfigView ? " model-config-mode" : ""}`}>
          {isLlmConfigView ? renderLlmConfigPage() : (
            <>
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
              <label className="editor-scroll-sync-toggle">
                <input
                  type="checkbox"
                  checked={syncScrollEnabled}
                  onChange={(e) => setSyncScrollEnabled(e.target.checked)}
                />
                <span>双栏联动滚动</span>
              </label>
              <button
                type="button"
                className="translate-current-btn"
                disabled={!selectedPdf}
                onClick={handleTranslateCurrent}
              >
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
            </>
          )}
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
