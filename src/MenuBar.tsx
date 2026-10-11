import { useEffect, useRef, useState } from 'react'

// Desktop-style menu bar: click a title to open, hover across titles while
// one is open, Escape or a click elsewhere closes. Items are plain
// callbacks; disabled ones stay visible but greyed, like a native menu.
export type MenuItem =
  | { label: string; shortcut?: string; disabled?: boolean; checked?: boolean; onClick?: () => void }
  | 'sep'
export interface Menu { label: string; items: MenuItem[] }

export function MenuBar({ brand, menus }: { brand?: string; menus: Menu[] }) {
  const [open, setOpen] = useState<number | null>(null)
  const ref = useRef<HTMLDivElement>(null)
  useEffect(() => {
    if (open == null) return
    const down = (e: MouseEvent) => { if (!ref.current?.contains(e.target as Node)) setOpen(null) }
    const key = (e: KeyboardEvent) => { if (e.key === 'Escape') setOpen(null) }
    window.addEventListener('mousedown', down)
    window.addEventListener('keydown', key)
    return () => {
      window.removeEventListener('mousedown', down)
      window.removeEventListener('keydown', key)
    }
  }, [open])
  return (
    <div className="menubar" ref={ref}>
      {brand && <span className="brand">{brand}</span>}
      {menus.map((m, i) => (
        <div key={m.label} className={`menu${open === i ? ' open' : ''}`}>
          <button
            type="button"
            className="menu-title"
            onMouseDown={(e) => { e.preventDefault(); setOpen(open === i ? null : i) }}
            onMouseEnter={() => { if (open != null && open !== i) setOpen(i) }}
          >
            {m.label}
          </button>
          {open === i && (
            <div className="menu-list" role="menu">
              {m.items.map((it, k) =>
                it === 'sep' ? (
                  <div key={k} className="menu-sep" />
                ) : (
                  <button
                    key={k}
                    type="button"
                    role="menuitem"
                    className="menu-item"
                    disabled={it.disabled}
                    onClick={() => { setOpen(null); it.onClick?.() }}
                  >
                    <span className="menu-check">{it.checked ? '✓' : ''}</span>
                    <span className="menu-label">{it.label}</span>
                    {it.shortcut && <span className="menu-key">{it.shortcut}</span>}
                  </button>
                ),
              )}
            </div>
          )}
        </div>
      ))}
    </div>
  )
}
