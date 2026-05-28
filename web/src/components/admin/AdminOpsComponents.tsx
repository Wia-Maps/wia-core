import { Fragment, useCallback, useEffect, useMemo, useRef, useState } from 'react';
import type { MouseEvent as ReactMouseEvent, ReactNode } from 'react';
import { createPortal } from 'react-dom';
import {
  flexRender,
  getCoreRowModel,
  useReactTable,
  type ColumnDef,
  type PaginationState,
  type RowSelectionState,
  type SortingState,
  type Updater,
} from '@tanstack/react-table';
import { TableSkeleton } from '../LoadingPrimitives';
import { AdminEmptyState, AdminStatusBadge, cx } from './AdminUi';

interface SearchInputProps {
  value: string;
  onChange: (nextValue: string) => void;
  placeholder?: string;
  className?: string;
  label?: string;
}

export const SearchInput: React.FC<SearchInputProps> = ({
  value,
  onChange,
  placeholder = 'Search',
  className,
  label,
}) => {
  return (
    <label className={cx('block', className)}>
      {label ? (
        <span className="mb-2 block text-[11px] font-semibold uppercase tracking-[0.16em] text-slate-500">
          {label}
        </span>
      ) : (
        <span className="sr-only">{placeholder}</span>
      )}
      <div className="relative">
        <span className="pointer-events-none absolute left-4 top-1/2 -translate-y-1/2 rounded-full border border-slate-200 bg-slate-50 p-2 text-slate-400">
          <svg viewBox="0 0 24 24" className="h-4 w-4" aria-hidden="true">
            <path
              d="m21 21-4.35-4.35M10.5 18a7.5 7.5 0 1 1 0-15 7.5 7.5 0 0 1 0 15Z"
              fill="none"
              stroke="currentColor"
              strokeWidth="1.8"
              strokeLinecap="round"
              strokeLinejoin="round"
            />
          </svg>
        </span>
        <input
          type="text"
          value={value}
          onChange={(event) => onChange(event.target.value)}
          placeholder={placeholder}
          className="w-full rounded-2xl border border-slate-200 bg-white py-3 pl-16 pr-4 text-sm text-slate-900 placeholder:text-slate-400 outline-none transition focus:border-sky-500 focus:ring-4 focus:ring-sky-100"
        />
      </div>
    </label>
  );
};

interface FilterDropdownProps {
  label: string;
  value: string;
  options: Array<{ label: string; value: string }>;
  onChange: (value: string) => void;
  className?: string;
  disabled?: boolean;
}

export const FilterDropdown: React.FC<FilterDropdownProps> = ({
  label,
  value,
  options,
  onChange,
  className,
  disabled = false,
}) => {
  return (
    <label className={cx('block min-w-[180px]', className)}>
      <span className="mb-2 block text-[11px] font-semibold uppercase tracking-[0.16em] text-slate-500">
        {label}
      </span>
      <select
        value={value}
        disabled={disabled}
        onChange={(event) => onChange(event.target.value)}
        className="w-full min-w-0 rounded-2xl border border-slate-200 bg-white px-3 py-3 text-sm text-slate-900 outline-none transition focus:border-sky-500 focus:ring-4 focus:ring-sky-100 disabled:cursor-default disabled:opacity-100"
      >
        {options.map((option) => (
          <option key={option.value || 'empty'} value={option.value}>
            {option.label}
          </option>
        ))}
      </select>
    </label>
  );
};

interface LiveIndicatorProps {
  active: boolean;
  label: string;
}

export const LiveIndicator: React.FC<LiveIndicatorProps> = ({ active, label }) => {
  return (
    <span className="inline-flex items-center gap-2 rounded-full border border-slate-200 bg-white px-3 py-2 text-xs font-semibold text-slate-700">
      <span className={cx('h-2.5 w-2.5 rounded-full', active ? 'bg-emerald-500' : 'bg-slate-300')} />
      {label}
    </span>
  );
};

interface BulkActionBarProps {
  count: number;
  children: ReactNode;
}

export const BulkActionBar: React.FC<BulkActionBarProps> = ({ count, children }) => {
  return (
    <div className="sticky top-[84px] z-10 rounded-2xl border border-sky-200 bg-sky-50 px-4 py-3 shadow-sm">
      <div className="flex flex-col gap-3 lg:flex-row lg:items-center lg:justify-between">
        <div className="flex items-center gap-2">
          <AdminStatusBadge tone="info">{count} selected</AdminStatusBadge>
          <p className="text-sm font-medium text-slate-700">Bulk actions</p>
        </div>
        <div className="flex flex-wrap items-center gap-2">{children}</div>
      </div>
    </div>
  );
};

interface ActionMenuItem {
  label: string;
  onSelect: () => void;
  tone?: 'default' | 'danger';
}

interface ActionMenuProps {
  items: ActionMenuItem[];
}

export const ActionMenu: React.FC<ActionMenuProps> = ({ items }) => {
  const buttonRef = useRef<HTMLButtonElement | null>(null);
  const menuRef = useRef<HTMLDivElement | null>(null);
  const [buttonMenuOpen, setButtonMenuOpen] = useState(false);
  const [menuStyle, setMenuStyle] = useState<{ top: number; left: number; transformOrigin: string } | null>(null);
  const menuId = useMemo(() => `admin-action-menu-${Math.random().toString(36).slice(2, 10)}`, []);

  const closeMenu = useCallback(() => {
    setButtonMenuOpen(false);
  }, []);

  useEffect(() => {
    if (!buttonMenuOpen) {
      return;
    }

    const handlePointerDown = (event: MouseEvent): void => {
      const target = event.target;
      if (!(target instanceof Node)) {
        closeMenu();
        return;
      }

      if (menuRef.current?.contains(target) || buttonRef.current?.contains(target)) {
        return;
      }

      closeMenu();
    };

    const handleEscape = (event: KeyboardEvent): void => {
      if (event.key === 'Escape') {
        closeMenu();
      }
    };

    const handleViewportChange = (): void => {
      closeMenu();
    };

    document.addEventListener('mousedown', handlePointerDown);
    document.addEventListener('contextmenu', handlePointerDown);
    document.addEventListener('keydown', handleEscape);
    window.addEventListener('resize', handleViewportChange);
    window.addEventListener('scroll', handleViewportChange, true);

    return () => {
      document.removeEventListener('mousedown', handlePointerDown);
      document.removeEventListener('contextmenu', handlePointerDown);
      document.removeEventListener('keydown', handleEscape);
      window.removeEventListener('resize', handleViewportChange);
      window.removeEventListener('scroll', handleViewportChange, true);
    };
  }, [buttonMenuOpen, closeMenu]);

  useEffect(() => {
    if (!buttonMenuOpen) {
      setMenuStyle(null);
      return;
    }

    const updateMenuPosition = (): void => {
      const buttonRect = buttonRef.current?.getBoundingClientRect();
      if (!buttonRect) {
        return;
      }

      const estimatedMenuWidth = Math.max(menuRef.current?.offsetWidth ?? 0, 180);
      const estimatedMenuHeight = Math.max(menuRef.current?.offsetHeight ?? 0, items.length * 44 + 16);
      const viewportWidth = window.innerWidth;
      const viewportHeight = window.innerHeight;
      const gutter = 12;
      const preferredTop = buttonRect.bottom + 8;
      const canOpenDownward = preferredTop + estimatedMenuHeight <= viewportHeight - gutter;
      const top = canOpenDownward
        ? preferredTop
        : Math.max(gutter, buttonRect.top - estimatedMenuHeight - 8);
      const left = Math.min(
        Math.max(gutter, buttonRect.right - estimatedMenuWidth),
        viewportWidth - estimatedMenuWidth - gutter
      );

      setMenuStyle({
        top,
        left,
        transformOrigin: canOpenDownward ? 'top right' : 'bottom right',
      });
    };

    updateMenuPosition();
    window.addEventListener('resize', updateMenuPosition);
    window.addEventListener('scroll', updateMenuPosition, true);

    return () => {
      window.removeEventListener('resize', updateMenuPosition);
      window.removeEventListener('scroll', updateMenuPosition, true);
    };
  }, [buttonMenuOpen, items.length]);

  const handleButtonToggle = (): void => {
    setButtonMenuOpen((current) => !current);
  };

  const menuContent = (
    <div
      ref={menuRef}
      role="menu"
      aria-labelledby={menuId}
      className="min-w-[180px] rounded-2xl border border-slate-200 bg-white p-2 shadow-xl"
    >
      <div className="space-y-1">
        {items.map((item) => (
          <button
            key={item.label}
            type="button"
            role="menuitem"
            onClick={() => {
              item.onSelect();
              closeMenu();
            }}
            className={cx(
              'flex w-full rounded-xl px-3 py-2 text-left text-sm transition',
              item.tone === 'danger'
                ? 'text-rose-700 hover:bg-rose-50'
                : 'text-slate-700 hover:bg-slate-50 hover:text-slate-950'
            )}
          >
            {item.label}
          </button>
        ))}
      </div>
    </div>
  );

  return (
    <div className="relative">
      <button
        ref={buttonRef}
        id={menuId}
        type="button"
        data-admin-action-menu-trigger="true"
        aria-haspopup="menu"
        aria-expanded={buttonMenuOpen}
        onClick={handleButtonToggle}
        className="list-none cursor-pointer rounded-full border border-slate-200 bg-white px-3 py-2 text-xs font-semibold uppercase tracking-[0.14em] text-slate-700 transition hover:border-slate-300 hover:text-slate-950"
      >
        Actions
      </button>

      {buttonMenuOpen && menuStyle && typeof document !== 'undefined'
        ? createPortal(
            <div
              className="fixed z-[120]"
              style={{
                top: menuStyle.top,
                left: menuStyle.left,
                transformOrigin: menuStyle.transformOrigin,
              }}
            >
              {menuContent}
            </div>,
            document.body
          )
        : null}
    </div>
  );
};

interface ConfirmationModalProps {
  open: boolean;
  title: string;
  message: string;
  confirmLabel: string;
  onCancel: () => void;
  onConfirm: () => void;
  tone?: 'default' | 'danger';
  busy?: boolean;
}

export const ConfirmationModal: React.FC<ConfirmationModalProps> = ({
  open,
  title,
  message,
  confirmLabel,
  onCancel,
  onConfirm,
  tone = 'default',
  busy = false,
}) => {
  if (!open || typeof document === 'undefined') {
    return null;
  }

  return createPortal(
    <div className="fixed inset-0 z-[100] flex items-center justify-center bg-slate-950/35 p-4 backdrop-blur-sm">
      <div className="w-full max-w-lg rounded-[28px] border border-slate-200 bg-white p-6 shadow-[0_24px_80px_rgba(15,23,42,0.22)]">
        <div className="flex items-center gap-2">
          <AdminStatusBadge tone={tone === 'danger' ? 'danger' : 'warning'}>
            {tone === 'danger' ? 'Confirm destructive action' : 'Confirm action'}
          </AdminStatusBadge>
        </div>
        <h3 className="mt-4 font-['Outfit'] text-2xl font-semibold text-slate-950">{title}</h3>
        <p className="mt-3 text-sm leading-6 text-slate-600">{message}</p>
        <div className="mt-6 flex flex-wrap justify-end gap-2">
          <button
            type="button"
            onClick={onCancel}
            className="rounded-full border border-slate-300 bg-white px-4 py-2 text-sm font-semibold text-slate-700 transition hover:border-slate-400 hover:text-slate-950"
          >
            Cancel
          </button>
          <button
            type="button"
            onClick={onConfirm}
            disabled={busy}
            className={cx(
              'rounded-full px-4 py-2 text-sm font-semibold text-white transition disabled:cursor-not-allowed disabled:opacity-60',
              tone === 'danger' ? 'bg-rose-600 hover:bg-rose-500' : 'bg-sky-600 hover:bg-sky-500'
            )}
          >
            {busy ? 'Working...' : confirmLabel}
          </button>
        </div>
      </div>
    </div>,
    document.body
  );
};

interface TextEntryModalProps {
  open: boolean;
  title: string;
  description?: string;
  label: string;
  value: string;
  placeholder?: string;
  confirmLabel: string;
  onCancel: () => void;
  onChange: (value: string) => void;
  onConfirm: () => void;
  busy?: boolean;
  confirmDisabled?: boolean;
}

export const TextEntryModal: React.FC<TextEntryModalProps> = ({
  open,
  title,
  description,
  label,
  value,
  placeholder,
  confirmLabel,
  onCancel,
  onChange,
  onConfirm,
  busy = false,
  confirmDisabled = false,
}) => {
  if (!open || typeof document === 'undefined') {
    return null;
  }

  return createPortal(
    <div className="fixed inset-0 z-[100] flex items-center justify-center bg-slate-950/35 p-4 backdrop-blur-sm">
      <div className="w-full max-w-lg rounded-[28px] border border-slate-200 bg-white p-6 shadow-[0_24px_80px_rgba(15,23,42,0.22)]">
        <div className="flex items-center gap-2">
          <AdminStatusBadge tone="info">Save view</AdminStatusBadge>
        </div>
        <h3 className="mt-4 font-['Outfit'] text-2xl font-semibold text-slate-950">{title}</h3>
        {description ? <p className="mt-3 text-sm leading-6 text-slate-600">{description}</p> : null}
        <label className="mt-5 block">
          <span className="mb-2 block text-[11px] font-semibold uppercase tracking-[0.16em] text-slate-500">
            {label}
          </span>
          <input
            type="text"
            value={value}
            onChange={(event) => onChange(event.target.value)}
            placeholder={placeholder}
            className="w-full rounded-2xl border border-slate-200 bg-white px-4 py-3 text-sm text-slate-900 outline-none transition focus:border-sky-500 focus:ring-4 focus:ring-sky-100"
          />
        </label>
        <div className="mt-6 flex flex-wrap justify-end gap-2">
          <button
            type="button"
            onClick={onCancel}
            className="rounded-full border border-slate-300 bg-white px-4 py-2 text-sm font-semibold text-slate-700 transition hover:border-slate-400 hover:text-slate-950"
          >
            Cancel
          </button>
          <button
            type="button"
            onClick={onConfirm}
            disabled={busy || confirmDisabled}
            className="rounded-full bg-sky-600 px-4 py-2 text-sm font-semibold text-white transition hover:bg-sky-500 disabled:cursor-not-allowed disabled:opacity-60"
          >
            {busy ? 'Working...' : confirmLabel}
          </button>
        </div>
      </div>
    </div>,
    document.body
  );
};

interface SidePanelEditorProps {
  open: boolean;
  title: string;
  description?: string;
  onClose: () => void;
  children: ReactNode;
  widthClassName?: string;
}

export const SidePanelEditor: React.FC<SidePanelEditorProps> = ({
  open,
  title,
  description,
  onClose,
  children,
  widthClassName = 'max-w-xl',
}) => {
  if (!open || typeof document === 'undefined') {
    return null;
  }

  return createPortal(
    <div className="fixed inset-0 z-[95] bg-slate-950/25">
      <button type="button" aria-label="Close side panel" className="absolute inset-0 cursor-default" onClick={onClose} />
      <aside
        className={cx(
          'absolute inset-y-0 right-0 w-full border-l border-slate-200 bg-white shadow-[0_24px_80px_rgba(15,23,42,0.2)]',
          widthClassName
        )}
      >
        <div className="flex h-full flex-col">
          <div className="border-b border-slate-200 px-5 py-4">
            <div className="flex items-start justify-between gap-3">
              <div>
                <p className="text-[11px] font-semibold uppercase tracking-[0.16em] text-sky-700">Editor</p>
                <h3 className="mt-2 font-['Outfit'] text-2xl font-semibold text-slate-950">{title}</h3>
                {description ? <p className="mt-2 text-sm leading-6 text-slate-600">{description}</p> : null}
              </div>
              <button
                type="button"
                onClick={onClose}
                className="rounded-full border border-slate-300 bg-white px-3 py-1.5 text-xs font-semibold uppercase tracking-[0.14em] text-slate-700 transition hover:border-slate-400 hover:text-slate-950"
              >
                Close
              </button>
            </div>
          </div>
          <div className="min-h-0 flex-1 overflow-y-auto px-5 py-5">{children}</div>
        </div>
      </aside>
    </div>,
    document.body
  );
};

interface DataTableProps<TData> {
  data: TData[];
  columns: ColumnDef<TData, unknown>[];
  pageIndex: number;
  pageSize: number;
  pageCount: number;
  rowCount: number;
  sorting: SortingState;
  onSortingChange: (updater: Updater<SortingState>) => void;
  onPageIndexChange: (pageIndex: number) => void;
  onPageSizeChange: (pageSize: number) => void;
  rowSelection?: RowSelectionState;
  onRowSelectionChange?: (updater: Updater<RowSelectionState>) => void;
  getRowId?: (row: TData, index: number) => string;
  loading?: boolean;
  dense?: boolean;
  emptyState?: ReactNode;
}

export function DataTable<TData>({
  data,
  columns,
  pageIndex,
  pageSize,
  pageCount,
  rowCount,
  sorting,
  onSortingChange,
  onPageIndexChange,
  onPageSizeChange,
  rowSelection = {},
  onRowSelectionChange,
  getRowId,
  loading = false,
  dense = true,
  emptyState,
}: DataTableProps<TData>): JSX.Element {
  const paginationState: PaginationState = {
    pageIndex,
    pageSize,
  };

  const table = useReactTable({
    data,
    columns,
    state: {
      sorting,
      rowSelection,
      pagination: paginationState,
    },
    manualPagination: true,
    manualSorting: true,
    enableRowSelection: Boolean(onRowSelectionChange),
    pageCount,
    getRowId,
    onSortingChange,
    onRowSelectionChange,
    getCoreRowModel: getCoreRowModel(),
  });

  if (loading) {
    return <TableSkeleton columns={columns.length} rows={Math.min(Math.max(pageSize, 4), 8)} />;
  }

  const handleTableContextMenuCapture = (event: ReactMouseEvent<HTMLTableSectionElement>): void => {
    const target = event.target;
    if (!(target instanceof HTMLElement)) {
      return;
    }

    const rowElement = target.closest<HTMLTableRowElement>('tr[data-admin-table-row="true"]');
    if (!rowElement || !event.currentTarget.contains(rowElement)) {
      return;
    }

    const actionTrigger = rowElement.querySelector<HTMLElement>('[data-admin-action-menu-trigger="true"]');

    if (!actionTrigger) {
      return;
    }

    event.preventDefault();
    if (actionTrigger.getAttribute('aria-expanded') !== 'true') {
      actionTrigger.click();
    }
    actionTrigger.focus();
  };

  return (
    <div className="space-y-3">
      <div className="overflow-hidden rounded-2xl border border-slate-200 bg-white">
        <div className="overflow-x-auto">
          <table className="min-w-full border-collapse">
            <thead className="sticky top-0 bg-slate-50">
              {table.getHeaderGroups().map((headerGroup) => (
                <tr key={headerGroup.id} className="border-b border-slate-200">
                  {headerGroup.headers.map((header) => {
                    const canSort = header.column.getCanSort();
                    const isSorted = header.column.getIsSorted();

                    return (
                      <th
                        key={header.id}
                        className={cx(
                          'whitespace-nowrap px-4 text-left text-[11px] font-semibold uppercase tracking-[0.16em] text-slate-500',
                          dense ? 'py-3.5' : 'py-4.5'
                        )}
                      >
                        {header.isPlaceholder ? null : canSort ? (
                          <button
                            type="button"
                            onClick={header.column.getToggleSortingHandler()}
                            className="inline-flex items-center gap-2 text-left transition hover:text-slate-900"
                          >
                            {flexRender(header.column.columnDef.header, header.getContext())}
                            <span className="text-slate-400">
                              {isSorted === 'asc' ? '↑' : isSorted === 'desc' ? '↓' : '↕'}
                            </span>
                          </button>
                        ) : (
                          flexRender(header.column.columnDef.header, header.getContext())
                        )}
                      </th>
                    );
                  })}
                </tr>
              ))}
            </thead>
              <tbody onContextMenuCapture={handleTableContextMenuCapture}>
                {table.getRowModel().rows.length === 0 ? (
                  <tr>
                    <td colSpan={columns.length} className="px-4 py-8">
                      {emptyState ?? (
                      <AdminEmptyState
                        title="No rows available"
                        message="Adjust the current filters or try a different search."
                      />
                    )}
                  </td>
                </tr>
              ) : (
                table.getRowModel().rows.map((row) => (
                  <tr
                    key={row.id}
                    data-admin-table-row="true"
                    className="border-b border-slate-100 last:border-b-0 hover:bg-slate-50/80"
                  >
                    {row.getVisibleCells().map((cell) => (
                      <td
                        key={cell.id}
                        className={cx('px-4 align-top text-sm text-slate-700', dense ? 'py-3.5' : 'py-4.5')}
                      >
                        {flexRender(cell.column.columnDef.cell, cell.getContext())}
                      </td>
                    ))}
                  </tr>
                ))
              )}
            </tbody>
          </table>
        </div>
      </div>

      <div className="flex flex-col gap-3 rounded-2xl border border-slate-200 bg-white px-4 py-3 md:flex-row md:items-center md:justify-between">
        <p className="text-sm text-slate-600">
          Showing <span className="font-semibold text-slate-900">{data.length}</span> of{' '}
          <span className="font-semibold text-slate-900">{rowCount}</span> row(s)
        </p>

        <div className="flex flex-wrap items-center gap-2">
          <select
            value={pageSize}
            onChange={(event) => onPageSizeChange(Number(event.target.value))}
            className="rounded-full border border-slate-300 bg-white px-3 py-2 text-sm text-slate-700 outline-none transition focus:border-sky-500"
          >
            {[10, 25, 50, 100].map((size) => (
              <option key={size} value={size}>
                {size} / page
              </option>
            ))}
          </select>
          <button
            type="button"
            onClick={() => onPageIndexChange(Math.max(0, pageIndex - 1))}
            disabled={pageIndex <= 0}
            className="rounded-full border border-slate-300 bg-white px-3 py-2 text-sm font-semibold text-slate-700 transition hover:border-slate-400 hover:text-slate-950 disabled:cursor-not-allowed disabled:opacity-60"
          >
            Previous
          </button>
          <span className="text-sm font-medium text-slate-700">
            Page {pageIndex + 1} of {Math.max(1, pageCount)}
          </span>
          <button
            type="button"
            onClick={() => onPageIndexChange(Math.min(pageCount - 1, pageIndex + 1))}
            disabled={pageIndex + 1 >= pageCount}
            className="rounded-full border border-slate-300 bg-white px-3 py-2 text-sm font-semibold text-slate-700 transition hover:border-slate-400 hover:text-slate-950 disabled:cursor-not-allowed disabled:opacity-60"
          >
            Next
          </button>
        </div>
      </div>
    </div>
  );
}

interface CommandPaletteProps {
  open: boolean;
  query: string;
  onQueryChange: (value: string) => void;
  onClose: () => void;
  children: ReactNode;
}

export const CommandPalette: React.FC<CommandPaletteProps> = ({
  open,
  query,
  onQueryChange,
  onClose,
  children,
}) => {
  if (!open || typeof document === 'undefined') {
    return null;
  }

  return createPortal(
    <div className="fixed inset-0 z-[110] bg-slate-950/35 p-4 backdrop-blur-sm">
      <button type="button" className="absolute inset-0 cursor-default" onClick={onClose} aria-label="Close command palette" />
      <div className="relative mx-auto mt-[10vh] w-full max-w-2xl rounded-[28px] border border-slate-200 bg-white shadow-[0_24px_80px_rgba(15,23,42,0.22)]">
        <div className="border-b border-slate-200 px-5 py-4">
          <input
            autoFocus
            value={query}
            onChange={(event) => onQueryChange(event.target.value)}
            placeholder="Search pages and locations..."
            className="w-full bg-transparent text-base text-slate-900 outline-none placeholder:text-slate-400"
          />
        </div>
        <div className="max-h-[60vh] overflow-y-auto px-3 py-3">{children}</div>
      </div>
    </div>,
    document.body
  );
};

interface CommandPaletteGroupProps {
  label: string;
  items: Array<{
    id: string;
    title: string;
    subtitle?: string;
    onSelect: () => void;
  }>;
}

export const CommandPaletteGroup: React.FC<CommandPaletteGroupProps> = ({ label, items }) => {
  if (items.length === 0) {
    return null;
  }

  return (
    <Fragment>
      <div className="px-2 py-2 text-[11px] font-semibold uppercase tracking-[0.16em] text-slate-500">{label}</div>
      <div className="space-y-1">
        {items.map((item) => (
          <button
            key={item.id}
            type="button"
            onClick={item.onSelect}
            className="flex w-full flex-col rounded-2xl px-3 py-3 text-left transition hover:bg-slate-50"
          >
            <span className="text-sm font-semibold text-slate-900">{item.title}</span>
            {item.subtitle ? <span className="mt-1 text-xs text-slate-500">{item.subtitle}</span> : null}
          </button>
        ))}
      </div>
    </Fragment>
  );
};
