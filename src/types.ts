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
  mode: "mono" | "dual" | "both";
  pythonCmd?: string;
}

export interface TranslationProgressPayload {
  taskId: string;
  task: TranslationTask;
  rawEvent?: Record<string, unknown>;
  rawLine?: string;
}
