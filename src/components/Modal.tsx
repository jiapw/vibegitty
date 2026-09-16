import { useEffect, type ReactNode } from "react";
import { X } from "lucide-react";
import { useUiStore } from "../store/ui";

export function Modal({
  title,
  children,
  footer,
  wide,
  onClose,
  icon,
}: {
  title: string;
  children: ReactNode;
  footer?: ReactNode;
  wide?: boolean;
  onClose?: () => void;
  icon?: ReactNode;
}) {
  const closeModal = useUiStore((s) => s.closeModal);
  const close = onClose ?? closeModal;
  useEffect(() => {
    const onKey = (e: KeyboardEvent) => {
      if (e.key === "Escape") close();
    };
    document.addEventListener("keydown", onKey);
    return () => document.removeEventListener("keydown", onKey);
  }, [close]);
  return (
    <div className="modal-backdrop" onMouseDown={(e) => e.target === e.currentTarget && close()}>
      <div className={`modal${wide ? " wide" : ""}`}>
        <div className="modal-header">
          {icon}
          <span>{title}</span>
          <span className="spacer" />
          <button className="icon-btn" onClick={close}>
            <X />
          </button>
        </div>
        <div className="modal-body">{children}</div>
        {footer ? <div className="modal-footer">{footer}</div> : null}
      </div>
    </div>
  );
}
