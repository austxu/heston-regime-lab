import type { ReactNode } from 'react'

interface TooltipProps {
  content: ReactNode
  children: ReactNode
}

/** CSS-only hover/focus tooltip (no dependency, keyboard-accessible). */
export function Tooltip({ content, children }: TooltipProps) {
  return (
    <span className="group relative inline-flex items-center" tabIndex={0}>
      {children}
      <span
        role="tooltip"
        className="pointer-events-none absolute bottom-full left-1/2 z-20 mb-2 w-56 -translate-x-1/2
                   rounded-lg border border-edge bg-panel2 px-3 py-2 text-xs leading-relaxed text-ink
                   opacity-0 shadow-xl transition-opacity duration-150
                   group-hover:opacity-100 group-focus:opacity-100"
      >
        {content}
      </span>
    </span>
  )
}

/** A small "?" info chip that reveals a tooltip. */
export function InfoDot({ content }: { content: ReactNode }) {
  return (
    <Tooltip content={content}>
      <span className="ml-1 inline-flex h-4 w-4 cursor-help items-center justify-center rounded-full border border-edge text-[10px] text-muted">
        ?
      </span>
    </Tooltip>
  )
}
