import { CheckCircle2, Info, X, XCircle } from "lucide-react";
import { useUiStore } from "../store/ui";

export function Toasts() {
  const toasts = useUiStore((s) => s.toasts);
  const remove = useUiStore((s) => s.removeToast);
  if (toasts.length === 0) return null;
  return (
    <div className="toasts">
      {toasts.map((t) => (
        <div key={t.id} className={`toast ${t.kind}`}>
          {t.kind === "error" ? (
            <XCircle size={16} style={{ color: "var(--danger)", flexShrink: 0 }} />
          ) : t.kind === "success" ? (
            <CheckCircle2 size={16} style={{ color: "var(--accent)", flexShrink: 0 }} />
          ) : (
            <Info size={16} style={{ color: "var(--blue)", flexShrink: 0 }} />
          )}
          <span className="msg">{t.message}</span>
          <button className="icon-btn" onClick={() => remove(t.id)}>
            <X />
          </button>
        </div>
      ))}
    </div>
  );
}
