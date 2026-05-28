import { AnimatePresence, motion } from 'framer-motion';
import { createPortal } from 'react-dom';
import type { ToastRecord, ToastTone, ToastVisualStyle } from './ToastContext';

const TOAST_META: Record<
  ToastTone,
  {
    label: string;
    cardClassName: string;
    iconClassName: string;
    lineClassName: string;
  }
> = {
  success: {
    label: 'Success',
    cardClassName: 'border-emerald-200/80 bg-white/94',
    iconClassName: 'border-emerald-200 bg-emerald-50 text-emerald-700',
    lineClassName: 'from-emerald-400 via-emerald-300 to-transparent',
  },
  warning: {
    label: 'Warning',
    cardClassName: 'border-amber-200/80 bg-white/94',
    iconClassName: 'border-amber-200 bg-amber-50 text-amber-700',
    lineClassName: 'from-amber-400 via-amber-300 to-transparent',
  },
  error: {
    label: 'Error',
    cardClassName: 'border-rose-200/80 bg-white/94',
    iconClassName: 'border-rose-200 bg-rose-50 text-rose-700',
    lineClassName: 'from-rose-400 via-rose-300 to-transparent',
  },
  info: {
    label: 'Info',
    cardClassName: 'border-sky-200/80 bg-white/94',
    iconClassName: 'border-sky-200 bg-sky-50 text-sky-700',
    lineClassName: 'from-sky-400 via-sky-300 to-transparent',
  },
};

const SuccessIcon: React.FC = () => (
  <svg viewBox="0 0 24 24" className="h-4 w-4" aria-hidden="true">
    <path
      d="M6.5 12.4 10 16l7.5-8"
      fill="none"
      stroke="currentColor"
      strokeWidth="1.9"
      strokeLinecap="round"
      strokeLinejoin="round"
    />
  </svg>
);

const WarningIcon: React.FC = () => (
  <svg viewBox="0 0 24 24" className="h-4 w-4" aria-hidden="true">
    <path
      d="M12 4.7 20 18H4l8-13.3Z"
      fill="none"
      stroke="currentColor"
      strokeWidth="1.8"
      strokeLinejoin="round"
    />
    <path
      d="M12 9.2v4.8"
      fill="none"
      stroke="currentColor"
      strokeWidth="1.8"
      strokeLinecap="round"
    />
    <circle cx="12" cy="16.9" r="1" fill="currentColor" />
  </svg>
);

const ErrorIcon: React.FC = () => (
  <svg viewBox="0 0 24 24" className="h-4 w-4" aria-hidden="true">
    <path
      d="M8 8l8 8M16 8l-8 8"
      fill="none"
      stroke="currentColor"
      strokeWidth="1.9"
      strokeLinecap="round"
    />
    <circle
      cx="12"
      cy="12"
      r="9"
      fill="none"
      stroke="currentColor"
      strokeWidth="1.8"
    />
  </svg>
);

const NavigationProgressIcon: React.FC = () => (
  <svg viewBox="0 0 24 24" className="h-4 w-4" aria-hidden="true">
    <path
      d="M5 12h10"
      fill="none"
      stroke="currentColor"
      strokeWidth="1.9"
      strokeLinecap="round"
    />
    <path
      d="m12 7 5 5-5 5"
      fill="none"
      stroke="currentColor"
      strokeWidth="1.9"
      strokeLinecap="round"
      strokeLinejoin="round"
    />
    <circle cx="6" cy="12" r="2.1" fill="none" stroke="currentColor" strokeWidth="1.6" />
  </svg>
);

const CelebrationIcon: React.FC = () => (
  <svg viewBox="0 0 24 24" className="h-4 w-4" aria-hidden="true">
    <path
      d="M6.5 12.4 10 16l7.5-8"
      fill="none"
      stroke="currentColor"
      strokeWidth="1.9"
      strokeLinecap="round"
      strokeLinejoin="round"
    />
    <path
      d="M12 3.8v2.4M18.4 5.6l-1.4 1.7M20.2 11.5h-2.2"
      fill="none"
      stroke="currentColor"
      strokeWidth="1.5"
      strokeLinecap="round"
    />
  </svg>
);

const InfoIcon: React.FC = () => (
  <svg viewBox="0 0 24 24" className="h-4 w-4" aria-hidden="true">
    <circle cx="12" cy="12" r="9" fill="none" stroke="currentColor" strokeWidth="1.6" />
    <path d="M12 10v4" fill="none" stroke="currentColor" strokeWidth="1.8" strokeLinecap="round" />
    <circle cx="12" cy="8" r="0.6" fill="currentColor" />
  </svg>
);

const iconByTone: Record<ToastTone, React.FC> = {
  success: SuccessIcon,
  warning: WarningIcon,
  error: ErrorIcon,
  info: InfoIcon,
};

type ArrivalConfettiShape = 'streamer' | 'dot' | 'spark';

interface ArrivalConfettiParticle {
  left: string;
  top: string;
  x: number;
  y: number;
  rotate: number;
  color: string;
  width: number;
  height: number;
  delay: number;
  shape: ArrivalConfettiShape;
}

const ARRIVAL_CONFETTI_PARTICLES: ReadonlyArray<ArrivalConfettiParticle> = [
  { left: '4%', top: '8%', x: -22, y: 56, rotate: -132, color: 'bg-amber-300', width: 10, height: 22, delay: 0.02, shape: 'streamer' },
  { left: '12%', top: '-1%', x: -14, y: 48, rotate: 82, color: 'bg-cyan-300', width: 8, height: 18, delay: 0.08, shape: 'streamer' },
  { left: '21%', top: '5%', x: -10, y: 42, rotate: -76, color: 'bg-emerald-300', width: 10, height: 10, delay: 0.04, shape: 'dot' },
  { left: '31%', top: '-6%', x: -2, y: 44, rotate: 25, color: 'bg-amber-200', width: 18, height: 18, delay: 0.11, shape: 'spark' },
  { left: '41%', top: '-4%', x: 4, y: 52, rotate: 108, color: 'bg-sky-300', width: 9, height: 20, delay: 0.14, shape: 'streamer' },
  { left: '52%', top: '-8%', x: 10, y: 54, rotate: -100, color: 'bg-yellow-300', width: 8, height: 18, delay: 0.01, shape: 'streamer' },
  { left: '63%', top: '-1%', x: 16, y: 48, rotate: 92, color: 'bg-emerald-400', width: 10, height: 10, delay: 0.09, shape: 'dot' },
  { left: '74%', top: '-3%', x: 20, y: 46, rotate: -72, color: 'bg-rose-300', width: 8, height: 18, delay: 0.05, shape: 'streamer' },
  { left: '85%', top: '5%', x: 26, y: 54, rotate: 122, color: 'bg-violet-300', width: 9, height: 20, delay: 0.16, shape: 'streamer' },
  { left: '92%', top: '18%', x: 28, y: 28, rotate: -18, color: 'bg-fuchsia-300', width: 16, height: 16, delay: 0.12, shape: 'spark' },
  { left: '6%', top: '82%', x: -22, y: -26, rotate: -98, color: 'bg-lime-300', width: 9, height: 18, delay: 0.06, shape: 'streamer' },
  { left: '18%', top: '92%', x: -12, y: -24, rotate: 68, color: 'bg-amber-200', width: 9, height: 9, delay: 0.1, shape: 'dot' },
  { left: '34%', top: '98%', x: -4, y: -22, rotate: -116, color: 'bg-cyan-200', width: 8, height: 18, delay: 0.15, shape: 'streamer' },
  { left: '48%', top: '102%', x: 0, y: -26, rotate: 6, color: 'bg-emerald-200', width: 18, height: 18, delay: 0.07, shape: 'spark' },
  { left: '62%', top: '96%', x: 10, y: -24, rotate: 74, color: 'bg-fuchsia-300', width: 10, height: 20, delay: 0.13, shape: 'streamer' },
  { left: '77%', top: '90%', x: 18, y: -28, rotate: -92, color: 'bg-emerald-200', width: 8, height: 16, delay: 0.03, shape: 'streamer' },
  { left: '88%', top: '84%', x: 24, y: -16, rotate: 94, color: 'bg-sky-200', width: 9, height: 9, delay: 0.05, shape: 'dot' },
  { left: '95%', top: '72%', x: 30, y: -8, rotate: 38, color: 'bg-amber-300', width: 16, height: 16, delay: 0.09, shape: 'spark' },
] as const;

const ArrivalConfettiBurst: React.FC<{ toastId: number }> = ({ toastId }) => {
  return (
    <div className="pointer-events-none absolute inset-[-30px] z-30 overflow-visible">
      <motion.div
        initial={{ opacity: 0, scale: 0.72 }}
        animate={{ opacity: [0.16, 0.34, 0.12], scale: [0.72, 1.08, 1.18] }}
        transition={{ duration: 1.15, ease: 'easeOut' }}
        className="absolute left-1/2 top-1/2 h-32 w-32 -translate-x-1/2 -translate-y-1/2 rounded-full bg-[radial-gradient(circle,rgba(16,185,129,0.26),rgba(16,185,129,0.08)_48%,transparent_72%)] blur-2xl"
      />
      <motion.div
        initial={{ opacity: 0, scale: 0.68 }}
        animate={{ opacity: [0.12, 0.28, 0.08], scale: [0.68, 1.02, 1.14] }}
        transition={{ duration: 1.2, ease: 'easeOut', delay: 0.08 }}
        className="absolute left-1/2 top-1/2 h-40 w-40 -translate-x-1/2 -translate-y-1/2 rounded-full bg-[radial-gradient(circle,rgba(250,204,21,0.2),rgba(250,204,21,0.06)_42%,transparent_72%)] blur-3xl"
      />
      {ARRIVAL_CONFETTI_PARTICLES.map((particle, index) => {
        const commonStyle = {
          left: particle.left,
          top: particle.top,
          width: particle.width,
          height: particle.height,
        };

        if (particle.shape === 'spark') {
          return (
            <motion.span
              key={`${toastId}_confetti_${index}`}
              initial={{ opacity: 0, scale: 0.45, x: 0, y: 0, rotate: 0 }}
              animate={{
                opacity: [0, 1, 1, 0],
                scale: [0.45, 1.24, 0.92],
                x: particle.x,
                y: particle.y,
                rotate: particle.rotate,
              }}
              transition={{
                duration: 1.25,
                delay: particle.delay,
                ease: 'easeOut',
              }}
              className="absolute block"
              style={commonStyle}
            >
              <span className={`absolute left-1/2 top-1/2 h-full w-[2px] -translate-x-1/2 -translate-y-1/2 rounded-full shadow-[0_0_16px_rgba(255,255,255,0.55)] ${particle.color}`} />
              <span className={`absolute left-1/2 top-1/2 h-[2px] w-full -translate-x-1/2 -translate-y-1/2 rounded-full shadow-[0_0_16px_rgba(255,255,255,0.55)] ${particle.color}`} />
            </motion.span>
          );
        }

        return (
          <motion.span
            key={`${toastId}_confetti_${index}`}
            initial={{ opacity: 0, scale: particle.shape === 'dot' ? 0.4 : 0.55, x: 0, y: 0, rotate: 0 }}
            animate={{
              opacity: [0, 1, 1, 0],
              scale: particle.shape === 'dot' ? [0.4, 1.15, 0.86] : [0.55, 1.08, 0.9],
              x: particle.x,
              y: particle.y,
              rotate: particle.rotate,
            }}
            transition={{
              duration: 1.4,
              delay: particle.delay,
              ease: 'easeOut',
            }}
            className={`absolute shadow-[0_10px_24px_rgba(15,23,42,0.16)] ${
              particle.shape === 'dot' ? 'rounded-full' : 'rounded-[999px]'
            } ${particle.color}`}
            style={commonStyle}
          />
        );
      })}
    </div>
  );
};

const CloseIcon: React.FC = () => (
  <svg viewBox="0 0 24 24" className="h-4 w-4" aria-hidden="true">
    <path
      d="M7 7l10 10M17 7 7 17"
      fill="none"
      stroke="currentColor"
      strokeWidth="1.8"
      strokeLinecap="round"
    />
  </svg>
);

export interface ToastViewportProps {
  toasts: ToastRecord[];
  dismissToast: (id: number) => void;
}

export default function ToastViewport({ toasts, dismissToast }: ToastViewportProps): JSX.Element {
  const content = (
    <div className="pointer-events-none fixed inset-x-0 top-3 z-[2147483000] flex justify-center px-3 sm:top-4 sm:px-4">
      <div className="flex w-full max-w-md flex-col gap-3">
        <AnimatePresence initial={false}>
          {toasts.map((toast) => {
            const meta = TOAST_META[toast.type];
            const visualStyle: ToastVisualStyle = toast.visualStyle ?? 'default';
            const isNavigationProgress = visualStyle === 'navigation-progress';
            const isArrivalCelebration = visualStyle === 'arrival-celebration';
            const Icon = isNavigationProgress
              ? NavigationProgressIcon
              : isArrivalCelebration
                ? CelebrationIcon
                : iconByTone[toast.type];
            const cardClassName = isNavigationProgress
              ? 'border-cyan-200/90 bg-[linear-gradient(135deg,rgba(236,254,255,0.96),rgba(255,255,255,0.97))]'
              : isArrivalCelebration
                ? 'border-emerald-200/90 bg-[linear-gradient(135deg,rgba(236,253,245,0.98),rgba(255,251,235,0.96)_48%,rgba(240,249,255,0.96))]'
                : meta.cardClassName;
            const iconClassName = isNavigationProgress
              ? 'border-cyan-200 bg-cyan-50 text-cyan-700'
              : isArrivalCelebration
                ? 'border-emerald-200 bg-white/92 text-emerald-700 shadow-[0_14px_32px_rgba(16,185,129,0.18)]'
                : meta.iconClassName;
            const lineClassName = isNavigationProgress
              ? 'from-cyan-400 via-sky-300 to-transparent'
              : isArrivalCelebration
                ? 'from-emerald-400 via-amber-300 to-transparent'
                : meta.lineClassName;

            return (
              <motion.div
                key={toast.id}
                initial={{
                  opacity: 0,
                  y: -18,
                  scale: isArrivalCelebration ? 0.92 : 0.97,
                }}
                animate={{ opacity: 1, y: 0, scale: 1 }}
                exit={{ opacity: 0, y: -14, scale: 0.98 }}
                transition={
                  isArrivalCelebration
                    ? { type: 'spring', stiffness: 340, damping: 26, mass: 0.9 }
                    : { duration: 0.2, ease: 'easeOut' }
                }
                className="pointer-events-auto relative px-1 py-1"
              >
                <article
                  className={`relative rounded-[24px] border px-4 py-4 shadow-[0_22px_48px_rgba(15,23,42,0.18)] backdrop-blur-xl supports-[backdrop-filter]:bg-white/78 ${cardClassName} ${isArrivalCelebration ? 'shadow-[0_30px_72px_rgba(16,185,129,0.22)] ring-1 ring-amber-100/80' : ''}`}
                  role="status"
                  aria-live="polite"
                >
                  <div className="pointer-events-none absolute inset-0 overflow-hidden rounded-[inherit]">
                    {isArrivalCelebration ? (
                      <>
                        <motion.div
                          initial={{ opacity: 0.42, scale: 0.92 }}
                          animate={{ opacity: [0.42, 0.82, 0.56], scale: [0.92, 1.04, 1] }}
                          transition={{ duration: 1.15, ease: 'easeOut' }}
                          className="absolute inset-0 bg-[radial-gradient(circle_at_top,rgba(255,255,255,0.86),transparent_48%)]"
                        />
                        <div className="absolute inset-0 bg-[radial-gradient(circle_at_20%_16%,rgba(16,185,129,0.14),transparent_34%),radial-gradient(circle_at_82%_24%,rgba(250,204,21,0.16),transparent_30%),radial-gradient(circle_at_50%_100%,rgba(14,165,233,0.12),transparent_34%)]" />
                        <motion.div
                          initial={{ opacity: 0.18, scaleX: 0.8 }}
                          animate={{ opacity: [0.18, 0.42, 0.24], scaleX: [0.8, 1.08, 1] }}
                          transition={{ duration: 1.05, ease: 'easeOut', delay: 0.05 }}
                          className="absolute inset-x-6 top-0 h-14 rounded-full bg-[radial-gradient(circle,rgba(255,255,255,0.7),transparent_68%)] blur-xl"
                        />
                      </>
                    ) : null}
                  </div>

                  {isArrivalCelebration && (
                    <ArrivalConfettiBurst toastId={toast.id} />
                  )}

                  <div
                    className={`pointer-events-none absolute inset-x-0 top-0 z-[1] h-px bg-gradient-to-r ${lineClassName}`}
                  />

                  <div className="relative z-20 flex items-start gap-3">
                    <div
                      className={`mt-0.5 flex h-10 w-10 shrink-0 items-center justify-center rounded-2xl border ${iconClassName} ${isArrivalCelebration ? 'ring-4 ring-white/70' : ''}`}
                    >
                      <Icon />
                    </div>

                    <div className="min-w-0 flex-1">
                      <p className={`text-[10px] font-semibold uppercase tracking-[0.24em] ${isArrivalCelebration ? 'text-emerald-700/80' : 'text-slate-500'}`}>
                        {toast.title ?? meta.label}
                      </p>
                      {isArrivalCelebration && (
                        <motion.div
                          initial={{ opacity: 0, y: 6, scale: 0.96 }}
                          animate={{ opacity: 1, y: 0, scale: 1 }}
                          transition={{ duration: 0.28, ease: 'easeOut', delay: 0.08 }}
                          className="mt-2 inline-flex items-center rounded-full border border-emerald-200/90 bg-white/88 px-2.5 py-1 text-[10px] font-semibold uppercase tracking-[0.18em] text-emerald-700 shadow-[0_8px_18px_rgba(16,185,129,0.12)]"
                        >
                          Destination reached
                        </motion.div>
                      )}
                      <p className={`mt-1 text-sm font-medium leading-6 ${isArrivalCelebration ? 'text-slate-900' : 'text-slate-800'}`}>
                        {toast.message}
                      </p>
                      {toast.stats && toast.stats.length > 0 && (
                        <div className="mt-3 flex flex-wrap gap-2">
                          {toast.stats.map((stat) => (
                            <div
                              key={`${toast.id}_${stat.label}`}
                              className={`rounded-full border px-3 py-1.5 ${isNavigationProgress ? 'border-cyan-200 bg-white/90 text-cyan-900' : 'border-slate-200 bg-white/90 text-slate-800'}`}
                            >
                              <span className={`text-[10px] font-semibold uppercase tracking-[0.18em] ${isNavigationProgress ? 'text-cyan-600' : 'text-slate-500'}`}>
                                {stat.label}
                              </span>
                              <span className="ml-2 text-sm font-semibold">{stat.value}</span>
                            </div>
                          ))}
                        </div>
                      )}
                    </div>

                    <button
                      type="button"
                      onClick={() => dismissToast(toast.id)}
                      className={`inline-flex h-8 w-8 shrink-0 items-center justify-center rounded-full border bg-white/80 text-slate-500 transition hover:text-slate-800 ${isArrivalCelebration ? 'border-emerald-200 hover:border-emerald-300' : 'border-slate-200 hover:border-slate-300'}`}
                      aria-label="Dismiss notification"
                    >
                      <CloseIcon />
                    </button>
                  </div>
                </article>
              </motion.div>
            );
          })}
        </AnimatePresence>
      </div>
    </div>
  );

  if (typeof document === 'undefined') {
    return content;
  }

  return createPortal(content, document.body);
}
