import { useState } from "react";
import { UserRound } from "lucide-react";

export function ProfileDialog({ initialValue, required = false, onSave, onClose }: {
  initialValue: string;
  required?: boolean;
  onSave: (value: string) => void;
  onClose?: () => void;
}) {
  const [value, setValue] = useState(initialValue);
  return (
    <div className="modal-backdrop">
      <form
        className="profile-dialog"
        onSubmit={(event) => {
          event.preventDefault();
          if (value.trim()) onSave(value.trim());
        }}
      >
        <div className="dialog-icon"><UserRound size={24} /></div>
        <span className="eyebrow">本地标注身份</span>
        <h2>{required ? "开始前，请设置标注人员" : "修改标注人员"}</h2>
        <p>该信息只保存在本机，并会写入导出的审计文件。</p>
        <label>
          <span>工号或姓名</span>
          <input autoFocus value={value} onChange={(event) => setValue(event.target.value)} placeholder="例如 A023 或 张三" />
        </label>
        <div className="dialog-actions">
          {!required && onClose && <button type="button" className="text-button" onClick={onClose}>取消</button>}
          <button className="primary-button" disabled={!value.trim()} type="submit">保存并继续</button>
        </div>
      </form>
    </div>
  );
}
