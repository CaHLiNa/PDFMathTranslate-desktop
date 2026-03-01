export interface FileNode {
  name: string;
  path: string;
  isDir: boolean;
  children: FileNode[];
}

export type TaskStatus =
  | "queued"
  | "running"
  | "completed"
  | "failed"
  | "canceled";

export interface TranslationTask {
  id: string;
  inputPath: string;
  status: TaskStatus;
  progress: number;
  message: string;
  monoOutput?: string | null;
  dualOutput?: string | null;
  startedAt: string;
  updatedAt: string;
}

export interface TranslationRequest {
  inputPath: string;
  outputDir: string;
  langIn: string;
  langOut: string;
  engine: string;
  apiKey?: string;
  model?: string;
  baseUrl?: string;
  qps?: number;
  primaryFontFamily?: string;
  useAlternatingPagesDual?: boolean;
  ocrWorkaround?: boolean;
  autoEnableOcrWorkaround?: boolean;
  noWatermarkMode?: boolean;
  saveAutoExtractedGlossary?: boolean;
  noAutoExtractGlossary?: boolean;
  enhanceCompatibility?: boolean;
  translateTableText?: boolean;
  onlyIncludeTranslatedPage?: boolean;
  mode: "mono" | "dual" | "both";
}

export interface TranslationProgressPayload {
  taskId: string;
  task: TranslationTask;
  rawEvent?: Record<string, unknown>;
  rawLine?: string;
}
