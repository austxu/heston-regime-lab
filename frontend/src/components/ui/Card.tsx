import { useId } from 'react'
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
  const titleId = useId()
  const subtitleId = useId()
  return (
    <section
      aria-labelledby={title ? titleId : undefined}
      aria-describedby={subtitle ? subtitleId : undefined}
      className={`card ${className}`}
    >
      {(title || subtitle || right) && (
        <header className="flex flex-col items-start justify-between gap-2 border-b border-edge px-4 py-3 sm:flex-row sm:gap-3 sm:px-5">
          <div className="min-w-0">
            {title && <h2 id={titleId} className="text-sm font-semibold text-ink">{title}</h2>}
            {subtitle && <p id={subtitleId} className="mt-0.5 text-xs leading-relaxed text-muted">{subtitle}</p>}
          </div>
          {right && <div className="max-w-full shrink-0">{right}</div>}
        </header>
      )}
      <div className={`card-pad ${bodyClassName}`}>{children}</div>
    </section>
  )
}
