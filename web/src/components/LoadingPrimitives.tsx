import type { LoadState } from '../core/loadState';
import { isLoadPending } from '../core/loadState';

const joinClasses = (...values: Array<string | false | null | undefined>): string => {
  return values.filter(Boolean).join(' ');
};

const loadStateLabel: Record<LoadState, string> = {
  idle: 'Queued',
  loading: 'Loading',
  processing: 'Processing',
  ready: 'Ready',
  error: 'Unavailable',
};

const loadStateTone: Record<LoadState, string> = {
  idle: 'border-slate-200 bg-white/90 text-slate-600',
  loading: 'border-cyan-200 bg-cyan-50/90 text-cyan-800',
  processing: 'border-sky-200 bg-sky-50/90 text-sky-800',
  ready: 'border-emerald-200 bg-emerald-50/90 text-emerald-800',
  error: 'border-amber-200 bg-amber-50/90 text-amber-800',
};

const mapStatusCopy = {
  idle: 'Queued to load',
  loading: 'Syncing live data',
  processing: 'Preparing runtime routing',
  ready: 'Connected',
  error: 'Using degraded mode',
};

const SkeletonBlock = ({
  className,
}: {
  className?: string;
}): JSX.Element => {
  return <div className={joinClasses('loading-shimmer rounded-2xl bg-slate-200/85', className)} aria-hidden="true" />;
};

export const AppShellLoader: React.FC<{
  title?: string;
  subtitle?: string;
  compact?: boolean;
  className?: string;
}> = ({
  title = 'Loading workspace',
  subtitle = 'Preparing the live map shell and interactive controls.',
  compact = false,
  className,
}) => {
  if (compact) {
    return (
      <div className={joinClasses('rounded-[30px] border border-white/75 bg-white/92 p-5 shadow-[0_24px_60px_rgba(15,23,42,0.16)] backdrop-blur', className)}>
        <div className="flex items-start gap-4">
          <div className="relative mt-1 h-12 w-12 shrink-0 overflow-hidden rounded-2xl border border-cyan-200 bg-[linear-gradient(160deg,rgba(34,211,238,0.18),rgba(255,255,255,0.92))]">
            <div className="absolute inset-0 opacity-70 [background-image:linear-gradient(rgba(8,145,178,0.18)_1px,transparent_1px),linear-gradient(90deg,rgba(8,145,178,0.18)_1px,transparent_1px)] [background-size:14px_14px]" />
            <div className="absolute left-1/2 top-1/2 h-4 w-4 -translate-x-1/2 -translate-y-1/2 rounded-full border border-cyan-500 bg-white shadow-[0_0_0_6px_rgba(34,211,238,0.18)]" />
          </div>
          <div className="min-w-0 flex-1">
            <p className="text-[11px] font-semibold uppercase tracking-[0.2em] text-cyan-700">Loading shell</p>
            <h2 className="mt-2 font-['Outfit'] text-2xl font-semibold text-slate-950">{title}</h2>
            <p className="mt-2 text-sm leading-6 text-slate-600">{subtitle}</p>
            <div className="mt-4 space-y-2">
              <SkeletonBlock className="h-3.5 w-4/5 rounded-full" />
              <SkeletonBlock className="h-3.5 w-3/5 rounded-full" />
            </div>
          </div>
        </div>
      </div>
    );
  }

  return (
    <section className={joinClasses('flex min-h-[100dvh] items-center justify-center px-4 py-8 sm:px-6', className)} aria-label={title}>
      <div className="relative w-full max-w-5xl overflow-hidden rounded-[36px] border border-white/70 bg-[linear-gradient(180deg,rgba(255,255,255,0.96),rgba(241,245,249,0.92))] p-6 shadow-[0_28px_90px_rgba(15,23,42,0.2)] sm:p-8">
        <div className="pointer-events-none absolute inset-0 bg-[radial-gradient(circle_at_18%_18%,rgba(34,211,238,0.16),transparent_34%),radial-gradient(circle_at_82%_14%,rgba(59,130,246,0.14),transparent_28%),radial-gradient(circle_at_50%_100%,rgba(14,165,233,0.12),transparent_34%)]" />
        <div className="relative grid gap-6 lg:grid-cols-[minmax(0,1.1fr)_minmax(320px,0.9fr)]">
          <div className="rounded-[30px] border border-slate-200 bg-slate-950 p-5 text-white shadow-[inset_0_1px_0_rgba(255,255,255,0.04)]">
            <div className="flex items-center justify-between">
              <div>
                <p className="text-[11px] font-semibold uppercase tracking-[0.22em] text-cyan-200">WIA shell</p>
                <h1 className="mt-3 font-['Outfit'] text-4xl font-semibold sm:text-5xl">{title}</h1>
              </div>
              <span className="rounded-full border border-white/15 bg-white/10 px-3 py-1 text-[11px] font-semibold uppercase tracking-[0.16em] text-cyan-100">
                Instant shell
              </span>
            </div>
            <p className="mt-4 max-w-xl text-sm leading-7 text-slate-300 sm:text-base">{subtitle}</p>
            <div className="mt-6 grid gap-3 sm:grid-cols-3">
              {['Map frame', 'Live data', 'Controls'].map((label) => (
                <div key={label} className="rounded-2xl border border-white/10 bg-white/5 px-4 py-4">
                  <p className="text-[11px] font-semibold uppercase tracking-[0.18em] text-cyan-100/80">{label}</p>
                  <SkeletonBlock className="mt-3 h-3.5 w-20 rounded-full bg-white/20" />
                  <SkeletonBlock className="mt-2 h-10 w-full bg-white/15" />
                </div>
              ))}
            </div>
          </div>
          <div className="rounded-[30px] border border-cyan-100 bg-white/84 p-5 backdrop-blur">
            <div className="relative overflow-hidden rounded-[28px] border border-slate-200 bg-[linear-gradient(180deg,#f8fafc,#eef6fb)] p-4">
              <div className="absolute inset-0 opacity-70 [background-image:linear-gradient(rgba(8,145,178,0.12)_1px,transparent_1px),linear-gradient(90deg,rgba(8,145,178,0.12)_1px,transparent_1px)] [background-size:26px_26px]" />
              <div className="relative">
                <div className="flex items-center justify-between">
                  <SkeletonBlock className="h-11 w-[68%] rounded-full" />
                  <SkeletonBlock className="h-11 w-14 rounded-full" />
                </div>
                <div className="mt-4 grid gap-3 sm:grid-cols-2">
                  <SkeletonBlock className="h-24" />
                  <SkeletonBlock className="h-24" />
                </div>
                <div className="mt-4 grid gap-3 sm:grid-cols-3">
                  <SkeletonBlock className="h-16 rounded-3xl" />
                  <SkeletonBlock className="h-16 rounded-3xl" />
                  <SkeletonBlock className="h-16 rounded-3xl" />
                </div>
                <div className="mt-4 rounded-[28px] border border-white/80 bg-white/70 p-4">
                  <div className="flex items-center gap-3">
                    <div className="relative h-11 w-11 rounded-2xl border border-cyan-200 bg-cyan-50/80">
                      <div className="absolute left-1/2 top-1/2 h-3.5 w-3.5 -translate-x-1/2 -translate-y-1/2 rounded-full bg-cyan-600 shadow-[0_0_0_6px_rgba(34,211,238,0.18)]" />
                    </div>
                    <div className="min-w-0 flex-1">
                      <SkeletonBlock className="h-3.5 w-28 rounded-full" />
                      <SkeletonBlock className="mt-2 h-3.5 w-40 rounded-full" />
                    </div>
                  </div>
                  <div className="mt-4 grid gap-2 sm:grid-cols-2">
                    <SkeletonBlock className="h-12 rounded-2xl" />
                    <SkeletonBlock className="h-12 rounded-2xl" />
                  </div>
                </div>
              </div>
            </div>
          </div>
        </div>
      </div>
    </section>
  );
};

export const MapLoadingOverlay: React.FC<{
  mapReady: boolean;
  locationsState: LoadState;
  routingState: LoadState;
}> = ({ mapReady, locationsState, routingState }) => {
  const showLocationsShell = !mapReady || isLoadPending(locationsState);
  const showRoutingShell = !mapReady || isLoadPending(routingState);
  const showOverlay = showLocationsShell || showRoutingShell;

  if (!showOverlay) {
    return null;
  }

  return (
    <div className="pointer-events-none absolute inset-0 z-10">
      <div className="absolute inset-0 bg-[radial-gradient(circle_at_15%_18%,rgba(34,211,238,0.12),transparent_30%),radial-gradient(circle_at_84%_14%,rgba(96,165,250,0.1),transparent_26%),linear-gradient(180deg,rgba(15,23,42,0.08),transparent_30%,rgba(15,23,42,0.12))]" />
      <div className="absolute left-3 right-3 top-[74px] mx-auto max-w-md rounded-[28px] border border-white/75 bg-white/88 p-4 shadow-[0_24px_56px_rgba(15,23,42,0.18)] backdrop-blur md:left-4 md:right-auto">
        <div className="flex items-start gap-3">
          <div className="relative mt-1 h-11 w-11 shrink-0 overflow-hidden rounded-2xl border border-cyan-200 bg-[linear-gradient(160deg,rgba(34,211,238,0.16),rgba(255,255,255,0.96))]">
            <div className="absolute inset-0 opacity-70 [background-image:linear-gradient(rgba(8,145,178,0.14)_1px,transparent_1px),linear-gradient(90deg,rgba(8,145,178,0.14)_1px,transparent_1px)] [background-size:12px_12px]" />
            <div className="absolute left-1/2 top-1/2 h-3.5 w-3.5 -translate-x-1/2 -translate-y-1/2 rounded-full bg-cyan-600 shadow-[0_0_0_6px_rgba(34,211,238,0.18)]" />
          </div>
          <div className="min-w-0 flex-1">
            <p className="text-[11px] font-semibold uppercase tracking-[0.18em] text-cyan-700">Campus shell</p>
            <h2 className="mt-1 font-['Outfit'] text-xl font-semibold text-slate-950">
              {showLocationsShell ? 'Drawing the live map' : 'Connecting walkway routing'}
            </h2>
            <p className="mt-1 text-sm leading-6 text-slate-600">
              {showLocationsShell
                ? 'The map frame is ready first, then locations, markers, and outlines fade in.'
                : 'The map stays interactive while the walking network catches up.'}
            </p>
          </div>
        </div>
        <div className="mt-4 grid gap-2 sm:grid-cols-2">
          {[
            { label: 'Locations', state: locationsState },
            { label: 'Walkway routing', state: routingState },
          ].map((entry) => (
            <div key={entry.label} className="rounded-2xl border border-slate-200 bg-slate-50/70 px-3 py-3">
              <div className="flex items-center justify-between gap-2">
                <p className="text-[11px] font-semibold uppercase tracking-[0.16em] text-slate-500">{entry.label}</p>
                <span className={joinClasses('rounded-full border px-2 py-1 text-[10px] font-semibold uppercase tracking-[0.16em]', loadStateTone[entry.state])}>
                  {loadStateLabel[entry.state]}
                </span>
              </div>
              <p className="mt-2 text-sm font-medium text-slate-700">{mapStatusCopy[entry.state]}</p>
              {isLoadPending(entry.state) ? (
                <SkeletonBlock className="mt-3 h-2.5 w-full rounded-full" />
              ) : null}
            </div>
          ))}
        </div>
      </div>
      {showLocationsShell ? (
        <div className="absolute inset-x-3 bottom-28 hidden max-w-[420px] rounded-[30px] border border-white/75 bg-white/86 p-4 shadow-[0_24px_56px_rgba(15,23,42,0.16)] backdrop-blur md:left-4 md:block">
          <div className="flex items-center justify-between">
            <SkeletonBlock className="h-10 w-[58%] rounded-full" />
            <SkeletonBlock className="h-10 w-12 rounded-full" />
          </div>
          <div className="mt-4 grid gap-2">
            <SkeletonBlock className="h-12 rounded-2xl" />
            <SkeletonBlock className="h-12 rounded-2xl" />
            <SkeletonBlock className="h-12 rounded-2xl" />
          </div>
        </div>
      ) : (
        <div className="absolute bottom-28 left-3 rounded-full border border-cyan-200 bg-white/92 px-4 py-2 text-xs font-semibold uppercase tracking-[0.18em] text-cyan-700 shadow-[0_18px_42px_rgba(15,23,42,0.16)] backdrop-blur md:left-4">
          Walking network syncing
        </div>
      )}
    </div>
  );
};

export const ChipSkeletonRow: React.FC<{
  count?: number;
  className?: string;
}> = ({ count = 6, className }) => {
  return (
    <div className={joinClasses('flex flex-wrap gap-2', className)} aria-hidden="true">
      {Array.from({ length: count }).map((_, index) => (
        <SkeletonBlock
          key={`chip_skeleton_${index}`}
          className={`h-9 rounded-full ${index % 3 === 0 ? 'w-24' : index % 3 === 1 ? 'w-28' : 'w-20'}`}
        />
      ))}
    </div>
  );
};

export const PanelSkeleton: React.FC<{
  title?: string;
  subtitle?: string;
  lines?: number;
  className?: string;
}> = ({
  title = 'Loading panel',
  subtitle = 'Preparing contextual details.',
  lines = 4,
  className,
}) => {
  return (
    <div className={joinClasses('rounded-[28px] border border-slate-200 bg-white p-5 shadow-sm', className)}>
      <p className="text-[11px] font-semibold uppercase tracking-[0.18em] text-cyan-700">Loading panel</p>
      <h3 className="mt-2 font-['Outfit'] text-2xl font-semibold text-slate-950">{title}</h3>
      <p className="mt-2 text-sm leading-6 text-slate-600">{subtitle}</p>
      <div className="mt-5 space-y-3" aria-hidden="true">
        <div className="grid gap-3 sm:grid-cols-2">
          <SkeletonBlock className="h-20" />
          <SkeletonBlock className="h-20" />
        </div>
        {Array.from({ length: lines }).map((_, index) => (
          <SkeletonBlock
            key={`panel_skeleton_${index}`}
            className={`h-12 rounded-2xl ${index === lines - 1 ? 'w-4/5' : 'w-full'}`}
          />
        ))}
      </div>
    </div>
  );
};

export const TableSkeleton: React.FC<{
  columns?: number;
  rows?: number;
  className?: string;
}> = ({ columns = 5, rows = 6, className }) => {
  return (
    <div className={joinClasses('space-y-3', className)} aria-label="Loading table data">
      <div className="overflow-hidden rounded-2xl border border-slate-200 bg-white">
        <div className="border-b border-slate-200 bg-slate-50 px-4 py-4">
          <div className="grid gap-3" style={{ gridTemplateColumns: `repeat(${columns}, minmax(0, 1fr))` }}>
            {Array.from({ length: columns }).map((_, index) => (
              <SkeletonBlock
                key={`table_header_${index}`}
                className={`h-3.5 rounded-full ${index === columns - 1 ? 'w-2/3' : 'w-4/5'}`}
              />
            ))}
          </div>
        </div>
        <div className="px-4 py-2">
          {Array.from({ length: rows }).map((_, rowIndex) => (
            <div
              key={`table_row_${rowIndex}`}
              className="grid gap-3 border-b border-slate-100 py-4 last:border-b-0"
              style={{ gridTemplateColumns: `repeat(${columns}, minmax(0, 1fr))` }}
            >
              {Array.from({ length: columns }).map((__, columnIndex) => (
                <SkeletonBlock
                  key={`table_cell_${rowIndex}_${columnIndex}`}
                  className={`h-4 rounded-full ${columnIndex === 0 ? 'w-3/4' : columnIndex % 2 === 0 ? 'w-full' : 'w-5/6'}`}
                />
              ))}
            </div>
          ))}
        </div>
      </div>
      <div className="flex flex-col gap-3 rounded-2xl border border-slate-200 bg-white px-4 py-3 md:flex-row md:items-center md:justify-between">
        <SkeletonBlock className="h-4 w-44 rounded-full" />
        <div className="flex flex-wrap items-center gap-2">
          <SkeletonBlock className="h-10 w-28 rounded-full" />
          <SkeletonBlock className="h-10 w-24 rounded-full" />
          <SkeletonBlock className="h-10 w-24 rounded-full" />
        </div>
      </div>
    </div>
  );
};

export const ToastSkeleton: React.FC = () => {
  return (
    <div className="pointer-events-none fixed right-4 top-4 z-[2147483000] w-[min(92vw,320px)] rounded-[24px] border border-white/70 bg-white/92 p-4 shadow-[0_24px_60px_rgba(15,23,42,0.18)] backdrop-blur">
      <div className="flex items-start gap-3">
        <SkeletonBlock className="h-10 w-10 shrink-0 rounded-2xl" />
        <div className="min-w-0 flex-1 space-y-2">
          <SkeletonBlock className="h-3.5 w-24 rounded-full" />
          <SkeletonBlock className="h-3.5 w-4/5 rounded-full" />
          <SkeletonBlock className="h-3.5 w-3/5 rounded-full" />
        </div>
      </div>
    </div>
  );
};
