interface SkeletonProps {
  className?: string
}

/** A single shimmering placeholder block. */
export function Skeleton({ className = '' }: SkeletonProps) {
  return <div className={`animate-pulse rounded bg-edge/60 ${className}`} />
}

/** A full-panel chart placeholder. */
export function ChartSkeleton({ height = 360 }: { height?: number }) {
  return (
    <div className="space-y-3" aria-busy="true">
      <div className="flex gap-2">
        <Skeleton className="h-4 w-24" />
        <Skeleton className="h-4 w-16" />
      </div>
      <div style={{ height }}>
        <Skeleton className="h-full w-full" />
      </div>
    </div>
  )
}

/** A multi-row placeholder for tables / stat lists. */
export function RowsSkeleton({ rows = 5 }: { rows?: number }) {
  return (
    <div className="space-y-2" aria-busy="true">
      {Array.from({ length: rows }).map((_, i) => (
        <Skeleton key={i} className="h-8 w-full" />
      ))}
    </div>
  )
}
