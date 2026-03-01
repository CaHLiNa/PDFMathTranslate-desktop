import type { TranslationTask } from "../types";

interface TaskPanelProps {
  tasks: TranslationTask[];
  onUseOutput: (task: TranslationTask) => void;
  onCancel: (taskId: string) => void;
}

function statusLabel(status: TranslationTask["status"]): string {
  if (status === "queued") return "排队中";
  if (status === "running") return "翻译中";
  if (status === "completed") return "已完成";
  if (status === "failed") return "失败";
  return "已取消";
}

export default function TaskPanel({ tasks, onUseOutput, onCancel }: TaskPanelProps) {
  return (
    <section className="task-panel">
      <div className="task-panel-title">翻译任务</div>
      {tasks.length === 0 ? (
        <div className="empty-hint">暂无任务</div>
      ) : (
        <div className="task-list">
          {tasks.map((task) => (
            <article className="task-item" key={task.id}>
              <div className="task-main">
                <div className="task-path" title={task.inputPath}>
                  {task.inputPath}
                </div>
                <div className="task-meta">
                  <span className={`task-status status-${task.status}`}>{statusLabel(task.status)}</span>
                  <span>{Math.round(task.progress)}%</span>
                  <span>{task.message}</span>
                </div>
                <div className="task-bar">
                  <div className="task-bar-inner" style={{ width: `${task.progress}%` }} />
                </div>
              </div>
              <div className="task-actions">
                {task.status === "running" && (
                  <button type="button" onClick={() => onCancel(task.id)}>
                    取消
                  </button>
                )}
                {task.status === "completed" && (
                  <button type="button" onClick={() => onUseOutput(task)}>
                    打开结果
                  </button>
                )}
              </div>
            </article>
          ))}
        </div>
      )}
    </section>
  );
}
