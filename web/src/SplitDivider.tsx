import { useRef, type CSSProperties } from "react";

export default function SplitDivider({ ratio, onChange }: { ratio: number; onChange: (ratio: number) => void }) {
  const dragging = useRef(false);
  return <div className="split-divider" role="separator" aria-label="Resize editor and preview" aria-orientation="vertical"
    aria-valuemin={30} aria-valuemax={70} aria-valuenow={ratio} tabIndex={0}
    onPointerDown={event => { dragging.current = true; event.currentTarget.setPointerCapture(event.pointerId); }}
    onPointerMove={event => {
      if (!dragging.current) return;
      const box = event.currentTarget.parentElement!.getBoundingClientRect();
      onChange(Math.round(Math.max(30, Math.min(70, (event.clientX - box.left) / box.width * 100))));
    }}
    onPointerUp={event => { dragging.current = false; event.currentTarget.releasePointerCapture(event.pointerId); }}
    onPointerCancel={() => { dragging.current = false; }} onLostPointerCapture={() => { dragging.current = false; }}
    onDoubleClick={() => onChange(50)}
    onKeyDown={event => {
      const value = event.key === "ArrowLeft" ? ratio - 2 : event.key === "ArrowRight" ? ratio + 2 : event.key === "Home" ? 30 : event.key === "End" ? 70 : null;
      if (value !== null) { event.preventDefault(); onChange(Math.max(30, Math.min(70, value))); }
    }}><span /></div>;
}

export function splitStyle(ratio: number): CSSProperties { return { "--editor-ratio": `${ratio}%` } as CSSProperties; }
