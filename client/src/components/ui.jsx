// The shared parts every screen is made from. Change how Forge looks here, not on a screen.
import { useEffect, useRef, useState } from 'react';
import { Link } from 'react-router-dom';
import { humanise } from '../utils/format.js';
import { Icon } from './icons.jsx';

export function Button({ variant = 'default', className = '', ...props }) {
  const styles = {
    primary: 'bg-accent text-white border-accent hover:bg-accent-strong shadow-sm',
    default: 'bg-card text-ink border-line-strong hover:bg-paper',
    danger: 'bg-card text-danger border-danger/40 hover:bg-danger-soft',
    ghost: 'bg-transparent text-steel border-transparent hover:bg-paper hover:text-ink',
  };
  return <button type="button" className={`inline-flex min-h-10 items-center justify-center gap-1.5 rounded-lg border px-3 text-sm font-medium transition-colors md:min-h-9 disabled:cursor-not-allowed disabled:opacity-50 ${styles[variant]} ${className}`} {...props} />;
}

export const Card = ({ title, actions, className = '', children }) => (
  <section className={`rounded-xl border border-line bg-card ${className}`}>
    {(title || actions) && (
      <header className="flex flex-wrap items-center justify-between gap-2 border-b border-line px-4 py-2.5">
        <h2 className="text-sm font-semibold">{title}</h2>
        {actions}
      </header>
    )}
    {children}
  </section>
);

export const PageHeader = ({ title, subtitle, actions, back, leading }) => (
  <div className="no-print mb-4">
    {back && (
      <Link to={back.to} className="mb-1 inline-flex items-center gap-1 text-xs text-steel hover:text-ink">
        <Icon name="chevronLeft" size={14} />{back.label}
      </Link>
    )}
    <div className="flex flex-wrap items-center justify-between gap-3">
      <div className="flex min-w-0 items-center gap-2">
        {leading}
        <div className="min-w-0">
          <h1 className="truncate text-xl font-semibold tracking-tight">{title}</h1>
          {subtitle && <div className="mt-0.5 text-sm text-steel">{subtitle}</div>}
        </div>
      </div>
      {actions && <div className="flex flex-wrap items-center gap-2">{actions}</div>}
    </div>
  </div>
);

const tones = {
  ok: 'bg-ok-soft text-ok',
  warn: 'bg-warn-soft text-warn',
  danger: 'bg-danger-soft text-danger',
  info: 'bg-accent-soft text-accent',
  neutral: 'bg-paper text-steel',
};

const STATUS_TONES = {
  DRAFT: 'neutral', CANCELLED: 'neutral', SUPERSEDED: 'neutral', OBSOLETE: 'neutral', ENDED: 'neutral', CLOSED: 'neutral', LOST: 'neutral', RETURNED: 'neutral', NOT_DONE: 'neutral', STOPPED: 'neutral',
  SUBMITTED: 'ok', CONFIRMED: 'ok', APPROVED: 'ok', RELEASED: 'ok', PASSED: 'ok', PASS: 'ok', WON: 'ok', RESOLVED: 'ok', ACTIVE: 'ok', READY: 'ok', INSTALLED: 'ok', DISPATCHED: 'ok', COMPLETED: 'ok', DONE: 'ok', PAID: 'ok', DELIVERED: 'ok', SENT: 'info', RECONCILED: 'ok',
  PENDING_APPROVAL: 'warn', PARTLY_RETURNED: 'warn', OPEN: 'warn', NOT_STARTED: 'neutral', IN_PROCESS: 'info', IN_PROGRESS: 'info', PLANNED: 'neutral', PROCUREMENT: 'info', FABRICATION: 'info', ASSEMBLY: 'info', FAT: 'info', FAILED: 'danger', FAIL: 'danger', LINE_DOWN: 'danger', HIGH: 'warn', UNRECONCILED: 'warn', NEW: 'info', REJECTED: 'danger',
};

export const Badge = ({ value, tone }) => (
  <span className={`inline-block whitespace-nowrap rounded-full px-2 py-0.5 text-xs font-medium ${tones[tone ?? STATUS_TONES[value] ?? 'neutral']}`}>{humanise(value)}</span>
);

export const Spinner = ({ label = 'Loading' }) => <p className="px-4 py-8 text-center text-sm text-steel" role="status">{label}…</p>;
export const Empty = ({ children = 'Nothing here yet.' }) => <p className="px-4 py-10 text-center text-sm text-steel">{children}</p>;

export function ErrorBox({ error }) {
  if (!error) return null;
  return (
    <div role="alert" className="rounded-lg border border-danger/30 bg-danger-soft px-3 py-2 text-sm text-danger">
      {error.message ?? String(error)}
      {error.fields && (
        <ul className="mt-1 list-disc pl-4">
          {Object.entries(error.fields).map(([field, message]) => <li key={field}>{field}: {message}</li>)}
        </ul>
      )}
    </div>
  );
}

const inputClass = 'w-full rounded-lg border border-line-strong bg-card px-2.5 py-1.5 min-h-10 md:min-h-9 disabled:bg-paper disabled:text-steel';

export const Input = ({ className = '', ...props }) => <input className={`${inputClass} ${className}`} {...props} />;
export const TextArea = ({ className = '', ...props }) => <textarea className={`${inputClass} ${className}`} rows={3} {...props} />;
export const Select = ({ className = '', ...props }) => <select className={`${inputClass} ${className}`} {...props} />;

export const Field = ({ label, hint, children, className = '' }) => (
  // eslint-disable-next-line jsx-a11y/label-has-associated-control
  <label className={`block ${className}`}>
    <span className="mb-1 block text-xs font-medium text-steel">{label}</span>
    {children}
    {hint && <span className="mt-1 block text-xs text-steel">{hint}</span>}
  </label>
);

const cellClass = (column) => `px-3 py-2 ${column.align === 'right' ? 'num text-right whitespace-nowrap' : ''} ${column.wrap ? '' : 'whitespace-nowrap'}`;
const cellValue = (column, row) => (column.render ? column.render(row) : row[column.key]);

// A wide table does not fit a phone, so the same rows become cards there. A table with up to
// three columns fits, and stays a table.
export function Table({ columns, rows, onRowClick, totals, empty, rowKey = (row) => row.id }) {
  if (!rows?.length) return <Empty>{empty}</Empty>;
  const useCards = columns.length > 3;
  const [first, ...others] = columns;
  return (
    <>
      <div className={`overflow-x-auto ${useCards ? 'wide-only' : ''}`}>
        <table className="w-full border-collapse text-sm">
          <thead>
            <tr className="border-b border-line text-left text-xs text-steel">
              {columns.map((column) => (
                <th key={column.key ?? column.label} scope="col" className={`whitespace-nowrap px-3 py-2 font-medium ${column.align === 'right' ? 'text-right' : ''}`}>{column.label}</th>
              ))}
            </tr>
          </thead>
          <tbody>
            {rows.map((row, index) => (
              <tr
                key={rowKey(row) ?? index}
                className={`border-b border-line last:border-0 ${onRowClick ? 'cursor-pointer hover:bg-paper' : ''}`}
                onClick={onRowClick ? () => onRowClick(row) : undefined}
              >
                {columns.map((column) => <td key={column.key ?? column.label} className={cellClass(column)}>{cellValue(column, row)}</td>)}
              </tr>
            ))}
          </tbody>
          {totals && (
            <tfoot>
              <tr className="border-t-2 border-line font-semibold">
                {columns.map((column) => (
                  <td key={column.key ?? column.label} className={`px-3 py-2 ${column.align === 'right' ? 'num text-right whitespace-nowrap' : ''}`}>{totals[column.key] ?? ''}</td>
                ))}
              </tr>
            </tfoot>
          )}
        </table>
      </div>
      {useCards && (
        <ul className="narrow-only divide-y divide-line">
          {rows.map((row, index) => (
            <li key={rowKey(row) ?? index}>
              <div
                role={onRowClick ? 'button' : undefined}
                tabIndex={onRowClick ? 0 : undefined}
                onClick={onRowClick ? () => onRowClick(row) : undefined}
                onKeyDown={onRowClick ? (e) => { if (e.key === 'Enter') onRowClick(row); } : undefined}
                className={`block w-full px-4 py-3 text-left text-sm ${onRowClick ? 'active:bg-paper' : ''}`}
              >
                <div className="mb-1 font-medium">{cellValue(first, row)}</div>
                <dl className="grid grid-cols-2 gap-x-3 gap-y-1">
                  {others.map((column) => {
                    const value = cellValue(column, row);
                    if (value === null || value === undefined || value === '') return null;
                    return (
                      <div key={column.key ?? column.label} className="min-w-0">
                        <dt className="text-xs text-steel">{column.label}</dt>
                        <dd className={`break-words ${column.align === 'right' ? 'num' : ''}`}>{value}</dd>
                      </div>
                    );
                  })}
                </dl>
              </div>
            </li>
          ))}
          {totals && (
            <li className="bg-paper px-4 py-3 text-sm font-semibold">
              <dl className="grid grid-cols-2 gap-x-3 gap-y-1">
                {columns.filter((column) => totals[column.key]).map((column) => (
                  <div key={column.key}>
                    <dt className="text-xs font-normal text-steel">{column.label}</dt>
                    <dd className="num">{totals[column.key]}</dd>
                  </div>
                ))}
              </dl>
            </li>
          )}
        </ul>
      )}
    </>
  );
}

export const Stat = ({ label, value, tone, to }) => {
  const toneClass = tone === 'warn' ? 'text-warn' : tone === 'danger' ? 'text-danger' : '';
  const body = (
    <>
      <div className="truncate text-xs text-steel">{label}</div>
      <div className={`num mt-1 truncate text-lg font-semibold ${toneClass}`}>{value}</div>
    </>
  );
  const box = 'block rounded-xl border border-line bg-card px-4 py-3';
  return to ? <Link to={to} className={`${box} hover:border-line-strong`}>{body}</Link> : <div className={box}>{body}</div>;
};

/* ---------- Menus ---------- */

// A menu that drops down on a large screen, and rises from the bottom on a phone.
export function Menu({ label, button, align = 'right', width = 'md:w-64', children }) {
  const [isOpen, setIsOpen] = useState(false);
  const root = useRef(null);
  useEffect(() => {
    if (!isOpen) return undefined;
    const onDown = (event) => { if (root.current && !root.current.contains(event.target)) setIsOpen(false); };
    const onKey = (event) => { if (event.key === 'Escape') setIsOpen(false); };
    document.addEventListener('mousedown', onDown);
    document.addEventListener('keydown', onKey);
    return () => {
      document.removeEventListener('mousedown', onDown);
      document.removeEventListener('keydown', onKey);
    };
  }, [isOpen]);
  const close = () => setIsOpen(false);
  return (
    <div className="relative" ref={root}>
      {button({ isOpen, toggle: () => setIsOpen((open) => !open), label })}
      {isOpen && (
        <>
          <button type="button" aria-label="Close menu" className="fixed inset-0 z-40 bg-black/30 md:hidden" onClick={close} />
          <div
            role="menu"
            aria-label={label}
            className={`fixed inset-x-0 bottom-0 z-50 max-h-[75vh] overflow-y-auto rounded-t-2xl border border-line bg-card p-1.5 pb-4 text-ink shadow-xl md:absolute md:inset-x-auto md:bottom-auto md:top-full md:mt-1.5 md:max-h-[70vh] md:rounded-xl md:pb-1.5 ${width} ${align === 'right' ? 'md:right-0' : 'md:left-0'}`}
          >
            {typeof children === 'function' ? children(close) : children}
          </div>
        </>
      )}
    </div>
  );
}

const menuRow = 'flex w-full items-center gap-2.5 rounded-lg px-3 py-2.5 text-left text-sm hover:bg-paper md:py-2 disabled:opacity-50';

export const MenuLink = ({ to, onClick, children, ...props }) => <Link to={to} role="menuitem" className={menuRow} onClick={onClick} {...props}>{children}</Link>;
export const MenuButton = ({ onClick, children, danger, disabled }) => <button type="button" role="menuitem" disabled={disabled} className={`${menuRow} ${danger ? 'text-danger' : ''}`} onClick={onClick}>{children}</button>;
export const MenuTitle = ({ children }) => <div className="px-3 pb-1 pt-2 text-xs font-semibold uppercase tracking-wide text-steel">{children}</div>;

// Everything that is not the next step goes in here, so the page shows one clear action.
export const MoreMenu = ({ children, label = 'More' }) => (
  <Menu label={label} width="md:w-56" button={({ toggle, isOpen }) => <Button aria-haspopup="menu" aria-expanded={isOpen} onClick={toggle}>{label}<Icon name="chevronDown" size={14} /></Button>}>
    {children}
  </Menu>
);

/* ---------- Tabs and steps ---------- */

export function Tabs({ tabs, active, onChange }) {
  return (
    <div role="tablist" className="no-scrollbar -mb-px flex gap-1 overflow-x-auto border-b border-line">
      {tabs.map((tab) => (
        <button
          key={tab.key}
          type="button"
          role="tab"
          aria-selected={active === tab.key}
          className={`shrink-0 whitespace-nowrap border-b-2 px-3 py-2 text-sm ${tab.className ?? ''} ${active === tab.key ? 'border-accent font-semibold text-ink' : 'border-transparent text-steel hover:text-ink'}`}
          onClick={() => onChange(tab.key)}
        >
          {tab.label}
          {tab.count !== undefined && <span className="ml-1.5 rounded-full bg-paper px-1.5 text-xs text-steel">{tab.count}</span>}
        </button>
      ))}
    </div>
  );
}

// Where a document is in its life, and what is still to come.
export function StatusSteps({ steps, current }) {
  const at = steps.indexOf(current);
  if (at < 0) return <Badge value={current} />;
  return (
    <ol className="no-scrollbar flex items-center gap-1 overflow-x-auto" aria-label="Progress">
      {steps.map((step, index) => {
        const isDone = index < at;
        const isNow = index === at;
        return (
          <li key={step} className="flex shrink-0 items-center gap-1" aria-current={isNow ? 'step' : undefined}>
            {index > 0 && <span aria-hidden="true" className={`h-px w-3 md:w-5 ${isDone || isNow ? 'bg-accent' : 'bg-line-strong'}`} />}
            <span className={`inline-flex items-center gap-1 whitespace-nowrap rounded-full px-2 py-0.5 text-xs font-medium ${isNow ? 'bg-accent text-white' : isDone ? 'bg-accent-soft text-accent' : 'bg-paper text-steel'}`}>
              {isDone && <Icon name="check" size={12} />}
              {humanise(step)}
            </span>
          </li>
        );
      })}
    </ol>
  );
}
