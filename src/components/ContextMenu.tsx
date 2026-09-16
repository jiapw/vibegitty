import { useLayoutEffect, useRef, useState } from "react";
import { X } from "lucide-react";
import { useUiStore } from "../store/ui";

export function ContextMenu() {
  const menu = useUiStore((s) => s.contextMenu);
  const close = useUiStore((s) => s.closeContextMenu);
  const ref = useRef<HTMLDivElement>(null);
  const [pos, setPos] = useState<{ x: number; y: number } | null>(null);

  useLayoutEffect(() => {
    if (!menu) return;
    const onKey = (e: KeyboardEvent) => {
      if (e.key === "Escape") close();
    };
    document.addEventListener("keydown", onKey);
    return () => document.removeEventListener("keydown", onKey);
  }, [menu, close]);

  useLayoutEffect(() => {
    if (!menu || !ref.current) {
      setPos(null);
      return;
    }
    const r = ref.current.getBoundingClientRect();
    let x = menu.x;
    let y = menu.y;
    if (x + r.width > window.innerWidth - 8) x = Math.max(8, window.innerWidth - r.width - 8);
    if (y + r.height > window.innerHeight - 8) y = Math.max(8, window.innerHeight - r.height - 8);
    setPos({ x, y });
  }, [menu]);

  if (!menu) return null;
  return (
    <>
      <div
        className="ctx-backdrop"
        onMouseDown={close}
        onContextMenu={(e) => {
          e.preventDefault();
          close();
        }}
        onKeyDown={(e) => e.key === "Escape" && close()}
      />
      <div
        ref={ref}
        className="ctx-menu"
        style={{ left: pos?.x ?? menu.x, top: pos?.y ?? menu.y, visibility: pos ? "visible" : "hidden" }}
      >
        {menu.items.map((it, i) =>
          it.separator ? (
            <div key={i} className="ctx-sep" />
          ) : (
            <div
              key={i}
              className={`ctx-item${it.danger ? " danger" : ""}${it.disabled ? " disabled" : ""}${it.section ? " section" : ""}`}
              onClick={() => {
                if (it.disabled) return;
                close();
                it.onClick?.();
              }}
            >
              {it.icon ?? <span style={{ width: 14 }} />}
              <span>{it.label}</span>
              {it.hint ? <span className="hint">{it.hint}</span> : null}
              {it.onRemove ? (
                <button
                  className="ctx-remove"
                  title={it.removeTitle ?? "Remove"}
                  onClick={(e) => {
                    e.stopPropagation();
                    close();
                    it.onRemove?.();
                  }}
                >
                  <X />
                </button>
              ) : null}
            </div>
          )
        )}
      </div>
    </>
  );
}
