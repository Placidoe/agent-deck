import { Children, useEffect, useId, useRef, useState } from "react";
import { createPortal } from "react-dom";
import { CaretDown, Check } from "@phosphor-icons/react";

// Shared desktop listbox. Portalled menus cannot be clipped by panes/scroll containers.
export function SelectControl({ children, value, onChange, className = "", disabled, title, ...props }) {
  const options = Children.toArray(children).filter(Boolean).map(option => ({ value: String(option.props.value ?? option.props.children), label: option.props.children, disabled: option.props.disabled }));
  const selected = options.findIndex(option => option.value === String(value ?? ""));
  const [open, setOpen] = useState(false); const [active, setActive] = useState(0); const [rect, setRect] = useState(null);
  const button = useRef(null); const menu = useRef(null); const id = useId();
  const toggle = () => { if (disabled) return; setRect(button.current.getBoundingClientRect()); setActive(Math.max(0, selected)); setOpen(current => !current); };
  const choose = index => { const option = options[index]; if (!option || option.disabled) return; onChange?.({ target: { value: option.value }, currentTarget: { value: option.value } }); setOpen(false); button.current?.focus(); };
  useEffect(() => {
    if (!open) return;
    const outside = e => { if (!button.current?.contains(e.target) && !menu.current?.contains(e.target)) setOpen(false); };
    const close = event => { if (!menu.current?.contains(event.target)) setOpen(false); };
    document.addEventListener("pointerdown", outside); window.addEventListener("resize", close); window.addEventListener("scroll", close, true);
    return () => { document.removeEventListener("pointerdown", outside); window.removeEventListener("resize", close); window.removeEventListener("scroll", close, true); };
  }, [open]);
  useEffect(() => { if (open) menu.current?.querySelector(`[data-index="${active}"]`)?.scrollIntoView({ block: "nearest" }); }, [open, active]);
  const keydown = event => {
    if (event.key === "Escape" && open) { event.preventDefault(); event.stopPropagation(); setOpen(false); return; }
    if (["ArrowDown", "ArrowUp", "Home", "End"].includes(event.key)) {
      event.preventDefault(); if (!open) { toggle(); return; }
      const direction = event.key === "ArrowUp" ? -1 : 1;
      let next = event.key === "Home" ? 0 : event.key === "End" ? options.length - 1 : Math.min(options.length - 1, Math.max(0, active + direction));
      while (options[next]?.disabled && next + direction >= 0 && next + direction < options.length) next += direction;
      setActive(next);
    } else if (event.key === "Enter" || event.key === " ") { event.preventDefault(); open ? choose(active) : toggle(); }
  };
  const width = Math.min(Math.max(rect?.width || 0, 220), window.innerWidth - 24);
  const height = Math.min(280, options.length * 38 + 12);
  const below = rect && window.innerHeight - rect.bottom > height + 12;
  return <><button {...props} ref={button} type="button" disabled={disabled} title={title || (typeof options[selected]?.label === "string" ? options[selected].label : undefined)} className={`select-control ${className}`} role="combobox" aria-expanded={open} aria-controls={id} aria-haspopup="listbox" aria-activedescendant={open ? `${id}-${active}` : undefined} onClick={toggle} onKeyDown={keydown}><span>{options[selected]?.label || options[0]?.label || "请选择"}</span><CaretDown size={13} /></button>{open && rect && createPortal(<div id={id} ref={menu} role="listbox" className="select-menu" style={{ width, left: Math.max(12, Math.min(rect.left, window.innerWidth - width - 12)), top: below ? rect.bottom + 6 : undefined, bottom: below ? undefined : Math.max(12, window.innerHeight - rect.top + 6), maxHeight: Math.min(height, below ? window.innerHeight - rect.bottom - 18 : Math.max(80, rect.top - 18)) }}>{options.map((option, index) => <button key={`${option.value}-${index}`} type="button" role="option" id={`${id}-${index}`} data-index={index} aria-selected={index === selected} disabled={option.disabled} className={index === active ? "highlighted" : ""} onPointerMove={() => setActive(index)} onClick={() => choose(index)}><span>{option.label}</span>{index === selected && <Check size={14} />}</button>)}</div>, document.body)}</>;
}
