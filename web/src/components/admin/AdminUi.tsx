import type { ReactNode } from 'react';

type Tone = 'default' | 'info' | 'success' | 'danger' | 'warning';

export const cx = (...values: Array<string | false | null | undefined>): string => {
  return values.filter(Boolean).join(' ');
};

const toneClasses: Record<Tone, string> = {
  default: 'border-slate-200 bg-white text-slate-900',
  info: 'border-sky-200 bg-sky-50 text-sky-900',
  success: 'border-emerald-200 bg-emerald-50 text-emerald-900',
  danger: 'border-rose-200 bg-rose-50 text-rose-900',
  warning: 'border-amber-200 bg-amber-50 text-amber-900',
};

const badgeToneClasses: Record<Tone, string> = {
  default: 'border-slate-200 bg-slate-100 text-slate-700',
  info: 'border-sky-200 bg-sky-50 text-sky-700',
  success: 'border-emerald-200 bg-emerald-50 text-emerald-700',
  danger: 'border-rose-200 bg-rose-50 text-rose-700',
  warning: 'border-amber-200 bg-amber-50 text-amber-700',
};

interface AdminSectionCardProps {
  label?: string;
  title?: string;
  description?: string;
  actions?: ReactNode;
  children: ReactNode;
  className?: string;
  headerClassName?: string;
  bodyClassName?: string;
}

export const AdminSectionCard: React.FC<AdminSectionCardProps> = ({
  label,
  title,
  description,
  actions,
  children,
  className,
  headerClassName,
  bodyClassName,
}) => {
  return (
    <section className={cx('rounded-3xl border border-slate-200 bg-white shadow-sm', className)}>
      {label || title || description || actions ? (
        <div className={cx('flex flex-wrap items-start justify-between gap-3 border-b border-slate-100 px-5 py-4 md:px-6', headerClassName)}>
          <div className="max-w-2xl">
            {label ? (
              <p className="text-[11px] font-semibold uppercase tracking-[0.18em] text-sky-700">{label}</p>
            ) : null}
            {title ? (
              <h3 className={cx("font-['Outfit'] text-xl font-semibold text-slate-950 md:text-2xl", label ? 'mt-2' : '')}>
                {title}
              </h3>
            ) : null}
            {description ? <p className="mt-1.5 text-sm leading-6 text-slate-600">{description}</p> : null}
          </div>
          {actions ? <div className="flex flex-wrap items-center gap-2">{actions}</div> : null}
        </div>
      ) : null}
      <div className={cx('px-5 py-5 md:px-6', bodyClassName)}>{children}</div>
    </section>
  );
};

interface AdminStatCardProps {
  label: string;
  value: ReactNode;
  hint?: ReactNode;
  tone?: Tone;
  className?: string;
}

export const AdminStatCard: React.FC<AdminStatCardProps> = ({ label, value, hint, tone = 'default', className }) => {
  return (
    <article className={cx('rounded-2xl border px-4 py-4', toneClasses[tone], className)}>
      <p className="text-[11px] font-semibold uppercase tracking-[0.16em] text-slate-500">{label}</p>
      <div className="mt-2 font-['Outfit'] text-3xl font-semibold leading-none">{value}</div>
      {hint ? <p className="mt-2 text-sm font-medium text-slate-600">{hint}</p> : null}
    </article>
  );
};

interface AdminStatusBadgeProps {
  children: ReactNode;
  tone?: Tone;
  className?: string;
}

export const AdminStatusBadge: React.FC<AdminStatusBadgeProps> = ({ children, tone = 'default', className }) => {
  return (
    <span
      className={cx(
        'inline-flex items-center rounded-full border px-2.5 py-1 text-[10px] font-semibold uppercase tracking-[0.16em]',
        badgeToneClasses[tone],
        className
      )}
    >
      {children}
    </span>
  );
};

interface AdminEmptyStateProps {
  title: string;
  message: string;
  action?: ReactNode;
}

export const AdminEmptyState: React.FC<AdminEmptyStateProps> = ({ title, message, action }) => {
  return (
    <div className="rounded-2xl border border-dashed border-slate-300 bg-slate-50 px-4 py-6">
      <p className="text-sm font-semibold text-slate-900">{title}</p>
      <p className="mt-2 text-sm leading-6 text-slate-600">{message}</p>
      {action ? <div className="mt-4">{action}</div> : null}
    </div>
  );
};

interface AdminSidebarItemProps {
  active: boolean;
  icon: ReactNode;
  label: string;
  description?: string;
  collapsed?: boolean;
  onClick: () => void;
}

export const AdminSidebarItem: React.FC<AdminSidebarItemProps> = ({
  active,
  icon,
  label,
  description,
  collapsed = false,
  onClick,
}) => {
  return (
    <button
      type="button"
      onClick={onClick}
      title={collapsed ? label : undefined}
      className={cx(
        'flex w-full rounded-2xl border px-3 py-3 text-left transition',
        collapsed ? 'items-center justify-center' : 'items-start',
        active
          ? 'border-sky-200 bg-sky-50 text-sky-900 shadow-sm'
          : 'border-transparent bg-transparent text-slate-700 hover:border-slate-200 hover:bg-slate-50'
      )}
    >
      <span
        className={cx(
          'inline-flex h-10 w-10 shrink-0 items-center justify-center rounded-2xl border',
          active ? 'border-sky-200 bg-white text-sky-700' : 'border-slate-200 bg-white text-slate-500'
        )}
      >
        {icon}
      </span>
      {!collapsed ? (
        <span className="min-w-0 pl-3">
          <span className="block text-sm font-semibold">{label}</span>
          {description ? <span className="mt-1 block text-xs leading-5 text-slate-500">{description}</span> : null}
        </span>
      ) : null}
    </button>
  );
};
