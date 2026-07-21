import { useMemo, useState } from "react";
import {
  AlertTriangle,
  CheckCircle2,
  CircleDashed,
  Download,
  FileVideo,
  FolderOpen,
  LoaderCircle,
  Settings,
} from "lucide-react";
import { buildAnnotationUnits } from "../domain/annotation";
import type { MediaScanProgress, ProjectSnapshot, ProjectTask, TaskStatus } from "../domain/types";

const STATUS_LABELS: Record<TaskStatus, string> = {
  not_started: "未开始",
  in_progress: "进行中",
  complete: "已完成",
  invalid: "异常",
};

export function ProjectDashboard({
  project,
  annotatorId,
  loading,
  scanProgress,
  onOpenProject,
  onOpenTask,
  onExport,
  onSettings,
}: {
  project?: ProjectSnapshot;
  annotatorId: string;
  loading: boolean;
  scanProgress?: MediaScanProgress;
  onOpenProject: () => void;
  onOpenTask: (taskId: string) => void;
  onExport: () => void;
  onSettings: () => void;
}) {
  const [filter, setFilter] = useState<"all" | TaskStatus>("all");
  const stats = useMemo(() => {
    const tasks = project?.tasks ?? [];
    return {
      all: tasks.length,
      not_started: tasks.filter((task) => task.status === "not_started").length,
      in_progress: tasks.filter((task) => task.status === "in_progress").length,
      complete: tasks.filter((task) => task.status === "complete").length,
      invalid: tasks.filter((task) => task.status === "invalid").length,
    };
  }, [project]);
  const tasks = (project?.tasks ?? []).filter((task) => filter === "all" || task.status === filter);

  return (
    <main className="dashboard-shell">
      <header className="app-header">
        <div className="brand">
          <div className="brand-mark">VA</div>
          <div><strong>视频剧情标注</strong><span>Offline Annotation Studio</span></div>
        </div>
        <div className="app-actions">
          <span className="annotator-chip">标注人 · {annotatorId}</span>
          <button className="icon-button" onClick={onSettings} aria-label="设置"><Settings size={19} /></button>
        </div>
      </header>

      <section className="dashboard-content">
        <div className="hero-row">
          <div>
            <span className="eyebrow">离线项目</span>
            <h1>{project?.name ?? "打开本地标注项目"}</h1>
            <p>{project ? "所有进度保存在项目本地，原始视频和 JSONL 不会被修改。" : "选择同时包含 Caption JSONL 与 video_path 视频目录的共同父目录。"}</p>
          </div>
          <div className="hero-actions">
            <button className="secondary-button" onClick={onOpenProject} disabled={loading}>
              {loading ? <LoaderCircle className="spin" size={18} /> : <FolderOpen size={18} />}
              {scanProgress ? `正在检测音轨 ${scanProgress.current}/${scanProgress.total}` : project ? "切换项目" : "打开项目"}
            </button>
            {project && <button className="primary-button" onClick={onExport}><Download size={18} /> 导出当前结果</button>}
          </div>
        </div>

        {!project ? (
          <div className="empty-project">
            <div className="empty-illustration"><FileVideo size={42} /></div>
            <h2>选择数据集的共同父目录</h2>
            <p>根目录下的 <code>scenes_*_final_caption_zh.jsonl</code> 会按每行 <code>video_path</code> 精确查找视频。Visible Text 仅原样透传，不参与标注。</p>
            <button className="primary-button" onClick={onOpenProject}><FolderOpen size={18} /> 选择项目文件夹</button>
          </div>
        ) : (
          <>
            <div className="stats-grid">
              <StatCard icon={<FileVideo />} label="全部任务" value={stats.all} />
              <StatCard icon={<CircleDashed />} label="未开始" value={stats.not_started} />
              <StatCard icon={<LoaderCircle />} label="进行中" value={stats.in_progress} />
              <StatCard icon={<CheckCircle2 />} label="已完成" value={stats.complete} />
              <StatCard icon={<AlertTriangle />} label="异常" value={stats.invalid} danger={stats.invalid > 0} />
            </div>

            <div className="task-panel">
              <div className="task-panel-header">
                <div><h2>标注任务</h2><span>{project.rootPath}</span></div>
                <div className="filter-tabs">
                  {(["all", "not_started", "in_progress", "complete", "invalid"] as const).map((item) => (
                    <button key={item} className={filter === item ? "active" : ""} onClick={() => setFilter(item)}>
                      {item === "all" ? "全部" : STATUS_LABELS[item]} {stats[item]}
                    </button>
                  ))}
                </div>
              </div>
              <div className="task-table">
                {tasks.map((task) => <TaskRow key={task.id} task={task} onOpen={() => onOpenTask(task.id)} />)}
                {tasks.length === 0 && <div className="no-results">当前筛选条件下没有任务</div>}
              </div>
            </div>
          </>
        )}
      </section>
    </main>
  );
}

function StatCard({ icon, label, value, danger = false }: { icon: React.ReactNode; label: string; value: number; danger?: boolean }) {
  return <div className={`stat-card ${danger ? "danger" : ""}`}><span>{icon}</span><div><strong>{value}</strong><small>{label}</small></div></div>;
}

function TaskRow({ task, onOpen }: { task: ProjectTask; onOpen: () => void }) {
  const total = task.document ? buildAnnotationUnits(task.document).length : 0;
  const completed = Object.keys(task.records).length;
  const percent = total ? Math.round((completed / total) * 100) : 0;
  return (
    <div className={`task-row ${task.status === "invalid" ? "invalid" : ""}`}>
      <div className="task-file-icon"><FileVideo size={21} /></div>
      <div className="task-name"><strong>{task.id}</strong><span>{task.videoPath.split("/").pop() || "缺少视频"}</span></div>
      {task.status === "invalid" ? (
        <div className="task-error"><AlertTriangle size={16} /> {task.mediaAnomaly?.message ?? task.error}</div>
      ) : (
        <div className="task-progress"><div><span style={{ width: `${percent}%` }} /></div><small>{completed}/{total} 单元</small></div>
      )}
      <span className={`task-status ${task.status}`}>{STATUS_LABELS[task.status]}</span>
      <button className="secondary-button compact" disabled={task.status === "invalid"} onClick={onOpen}>
        {task.status === "not_started" ? "开始标注" : task.status === "complete" ? "查看结果" : "继续标注"}
      </button>
    </div>
  );
}
