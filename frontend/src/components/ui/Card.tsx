import type { ReactNode } from 'react'

interface CardProps {
  title?: ReactNode
  subtitle?: ReactNode
  right?: ReactNode
  className?: string
  bodyClassName?: string
  children: ReactNode
}

/** The standard panel: titled, bordered, dark. */
export function Card({ title, subtitle, right, className = '', bodyClassName = '', children }: CardProps) {
  return (
    <section className={`card ${className}`}>
      {(title || right) && (
        <header className="flex items-start justify-between gap-3 border-b border-edge px-4 py-3 sm:px-5">
          <div>
            {title && <h2 className="text-sm font-semibold text-ink">{title}</h2>}
            {subtitle && <p className="mt-0.5 text-xs text-muted">{subtitle}</p>}
          </div>
          {right && <div className="shrink-0">{right}</div>}
        </header>
      )}
      <div className={`card-pad ${bodyClassName}`}>{children}</div>
    </section>
  )
}
