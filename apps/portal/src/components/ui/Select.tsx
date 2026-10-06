'use client';

import { Check, ChevronDown, Search } from 'lucide-react';
import {
  Children,
  Fragment,
  ReactElement,
  ReactNode,
  SelectHTMLAttributes,
  forwardRef,
  isValidElement,
  useCallback,
  useEffect,
  useId,
  useImperativeHandle,
  useMemo,
  useRef,
  useState,
} from 'react';
import { createPortal } from 'react-dom';
import { useI18n } from '../../i18n/I18nProvider';

/**
 * The design-system dropdown (docs/conventions/design-system.md § Dropdown / Select).
 *
 * API-compatible with a native `<select>`: callers keep passing `<option>` /
 * `<optgroup>` children plus `value`/`onChange`/`required`/`id`/`data-testid`.
 * Under the hood it renders a styled combobox trigger + a portalled listbox,
 * and keeps a REAL (visually-hidden, aria-hidden, tab-skipped) `<select>`
 * mirrored beside it — the source of truth for form validation, label `for`
 * association, `onChange` (we dispatch a genuine `change` event on it, so
 * React fires the caller's handler untouched) and Playwright's `selectOption`.
 *
 * Logical-only layout (start/end), so the chevron and list mirror under RTL.
 * The popover is portalled + `position: fixed`, so a Modal's overflow can't clip it.
 */
interface Opt {
  value: string;
  label: string;
  disabled: boolean;
  group?: string;
}

const SEARCH_THRESHOLD = 8;

function nodeText(node: ReactNode): string {
  return Children.toArray(node)
    .map((c) => (typeof c === 'string' || typeof c === 'number' ? String(c) : isValidElement(c) ? nodeText((c.props as { children?: ReactNode }).children) : ''))
    .join('');
}

function collectOptions(children: ReactNode, group?: string, out: Opt[] = []): Opt[] {
  Children.forEach(children, (child) => {
    if (!isValidElement(child)) return;
    const el = child as ReactElement<{ value?: string | number; disabled?: boolean; label?: string; children?: ReactNode }>;
    if (el.type === Fragment) {
      collectOptions(el.props.children, group, out);
    } else if (el.type === 'optgroup') {
      collectOptions(el.props.children, el.props.label, out);
    } else if (el.type === 'option') {
      const label = nodeText(el.props.children);
      out.push({ value: el.props.value !== undefined ? String(el.props.value) : label, label, disabled: !!el.props.disabled, group });
    }
  });
  return out;
}

export interface SelectProps extends SelectHTMLAttributes<HTMLSelectElement> {
  /** Shown when the selected option's value is '' (or nothing is selected). */
  placeholder?: string;
  /** Force the in-popover search box on/off (default: on above 8 options). */
  searchable?: boolean;
}

export const Select = forwardRef<HTMLSelectElement, SelectProps>(function Select(
  { className = '', children, placeholder, searchable, value, defaultValue, disabled, id, onFocus, ...rest },
  ref,
) {
  const { t } = useI18n();
  const nativeRef = useRef<HTMLSelectElement>(null);
  useImperativeHandle(ref, () => nativeRef.current as HTMLSelectElement);
  const triggerRef = useRef<HTMLButtonElement>(null);
  const listRef = useRef<HTMLDivElement>(null);
  const searchRef = useRef<HTMLInputElement>(null);
  const uid = useId();
  const listId = `${uid}-list`;

  const options = useMemo(() => collectOptions(children), [children]);
  const [domValue, setDomValue] = useState(String(value ?? defaultValue ?? ''));
  const current = value !== undefined ? String(value) : domValue;
  const selected = options.find((o) => o.value === current);
  const showPlaceholder = !selected || selected.value === '';
  const display = showPlaceholder ? (selected?.label || placeholder || t('ui.select.placeholder')) : selected.label;

  // Uncontrolled / form-reset changes: mirror whatever the native element currently holds.
  useEffect(() => {
    const el = nativeRef.current;
    if (!el) return;
    const sync = () => setDomValue(el.value);
    el.addEventListener('change', sync);
    sync();
    const form = el.form;
    const onReset = () => setTimeout(sync, 0);
    form?.addEventListener('reset', onReset);
    return () => {
      el.removeEventListener('change', sync);
      form?.removeEventListener('reset', onReset);
    };
  }, [options]);

  // The accessible name comes from the caller's <label for=id> (it points at the hidden native select).
  const [ariaLabel, setAriaLabel] = useState<string | undefined>();
  useEffect(() => {
    if (!id) return;
    const label = document.querySelector<HTMLLabelElement>(`label[for="${CSS.escape(id)}"]`);
    setAriaLabel(label?.textContent?.trim() || undefined);
  });

  const [open, setOpen] = useState(false);
  const [query, setQuery] = useState('');
  const [active, setActive] = useState(0);
  const [pos, setPos] = useState<{ top: number; left: number; width: number; maxHeight: number; up: boolean } | null>(null);

  const isSearchable = searchable ?? options.length > SEARCH_THRESHOLD;
  const visible = useMemo(() => {
    const q = query.trim().toLowerCase();
    return q ? options.filter((o) => o.label.toLowerCase().includes(q)) : options;
  }, [options, query]);

  const close = useCallback((refocus = true) => {
    setOpen(false);
    setQuery('');
    if (refocus) triggerRef.current?.focus();
  }, []);

  const commit = useCallback(
    (opt: Opt) => {
      if (opt.disabled) return;
      const el = nativeRef.current;
      if (el && el.value !== opt.value) {
        el.value = opt.value;
        // A genuine DOM event: React's own onChange machinery (and any native listener) fires exactly as for a user-driven <select>.
        el.dispatchEvent(new Event('change', { bubbles: true }));
      }
      close();
    },
    [close],
  );

  function openList() {
    if (disabled) return;
    const rect = triggerRef.current!.getBoundingClientRect();
    const below = window.innerHeight - rect.bottom - 12;
    const above = rect.top - 12;
    const up = below < 220 && above > below;
    const maxHeight = Math.max(160, Math.min(320, up ? above : below));
    setPos({ top: up ? rect.top - 6 : rect.bottom + 6, left: rect.left, width: rect.width, maxHeight, up });
    setQuery('');
    const idx = options.findIndex((o) => o.value === current);
    setActive(Math.max(0, idx));
    setOpen(true);
  }

  // While open: focus the search box (if any), close on outside click / scroll / resize, and swallow Escape before an enclosing Modal sees it.
  useEffect(() => {
    if (!open) return;
    if (isSearchable) searchRef.current?.focus();
    function onDown(e: MouseEvent) {
      const target = e.target as Node;
      if (listRef.current?.contains(target) || triggerRef.current?.contains(target)) return;
      close(false);
    }
    function onScroll(e: Event) {
      if (listRef.current?.contains(e.target as Node)) return;
      close(false);
    }
    function onEsc(e: KeyboardEvent) {
      if (e.key === 'Escape') {
        e.stopImmediatePropagation();
        close();
      }
    }
    window.addEventListener('mousedown', onDown);
    window.addEventListener('scroll', onScroll, true);
    window.addEventListener('resize', onScroll);
    window.addEventListener('keydown', onEsc, true);
    return () => {
      window.removeEventListener('mousedown', onDown);
      window.removeEventListener('scroll', onScroll, true);
      window.removeEventListener('resize', onScroll);
      window.removeEventListener('keydown', onEsc, true);
    };
  }, [open, isSearchable, close]);

  useEffect(() => {
    if (!open) return;
    listRef.current?.querySelector<HTMLElement>(`[data-index="${active}"]`)?.scrollIntoView({ block: 'nearest' });
  }, [open, active]);

  function move(delta: number) {
    if (visible.length === 0) return;
    let i = active;
    for (let n = 0; n < visible.length; n += 1) {
      i = (i + delta + visible.length) % visible.length;
      if (!visible[i].disabled) break;
    }
    setActive(i);
  }

  function onKeyDown(e: React.KeyboardEvent) {
    switch (e.key) {
      case 'ArrowDown':
        e.preventDefault();
        if (!open) openList();
        else move(1);
        break;
      case 'ArrowUp':
        e.preventDefault();
        if (!open) openList();
        else move(-1);
        break;
      case 'Home':
        if (open && !isSearchable) {
          e.preventDefault();
          setActive(0);
        }
        break;
      case 'End':
        if (open && !isSearchable) {
          e.preventDefault();
          setActive(Math.max(0, visible.length - 1));
        }
        break;
      case 'Enter':
        if (open) {
          e.preventDefault();
          if (visible[active]) commit(visible[active]);
        }
        break;
      case ' ':
        if (!open) {
          e.preventDefault();
          openList();
        } else if (!isSearchable) {
          e.preventDefault();
          if (visible[active]) commit(visible[active]);
        }
        break;
      case 'Tab':
        if (open) close(false);
        break;
      default:
        // Type-ahead on a closed/non-searchable list: jump to the next option starting with the typed letter.
        if (!isSearchable && e.key.length === 1 && !e.ctrlKey && !e.metaKey) {
          const ch = e.key.toLowerCase();
          const start = open ? active + 1 : Math.max(0, options.findIndex((o) => o.value === current)) + 1;
          for (let n = 0; n < options.length; n += 1) {
            const i = (start + n) % options.length;
            if (!options[i].disabled && options[i].label.toLowerCase().startsWith(ch)) {
              if (open) setActive(i);
              else commit(options[i]);
              break;
            }
          }
        }
    }
  }

  const activeId = open && visible[active] ? `${uid}-opt-${active}` : undefined;
  let lastGroup: string | undefined;

  return (
    <div className={`relative ${className.includes('w-') ? '' : 'w-full'} ${className}`}>
      <select
        ref={nativeRef}
        id={id}
        value={value}
        defaultValue={defaultValue}
        disabled={disabled}
        tabIndex={-1}
        aria-hidden="true"
        onFocus={(e) => {
          onFocus?.(e);
          triggerRef.current?.focus();
        }}
        className="pointer-events-none absolute inset-0 h-full w-full opacity-0"
        {...rest}
      >
        {children}
      </select>

      <button
        ref={triggerRef}
        type="button"
        role="combobox"
        aria-haspopup="listbox"
        aria-expanded={open}
        aria-controls={open ? listId : undefined}
        aria-activedescendant={!isSearchable ? activeId : undefined}
        aria-label={ariaLabel ? `${ariaLabel}: ${display}` : undefined}
        disabled={disabled}
        data-select-trigger
        onClick={() => (open ? close() : openList())}
        onKeyDown={onKeyDown}
        className={`flex w-full items-center justify-between gap-2 rounded-lg border bg-surface px-3 py-2.5 text-start text-sm shadow-sm transition-colors hover:border-ink-300 focus:border-accent-500 disabled:cursor-not-allowed disabled:bg-sand-100 disabled:text-ink-400 ${
          open ? 'border-accent-500' : 'border-ink-200'
        } ${showPlaceholder ? 'text-ink-400' : 'text-ink-900'}`}
      >
        <span className="truncate">{display}</span>
        <ChevronDown className={`h-4 w-4 shrink-0 text-ink-400 transition-transform duration-150 ${open ? 'rotate-180' : ''}`} aria-hidden />
      </button>

      {open &&
        pos &&
        createPortal(
          <div
            ref={listRef}
            dir={typeof document !== 'undefined' ? document.documentElement.dir || 'ltr' : 'ltr'}
            style={{
              position: 'fixed',
              left: pos.left,
              minWidth: pos.width,
              maxWidth: 'min(28rem, calc(100vw - 1rem))',
              ...(pos.up ? { bottom: window.innerHeight - pos.top } : { top: pos.top }),
            }}
            className="z-[60] animate-pop-in overflow-hidden rounded-xl border border-ink-100 bg-surface-raised shadow-pop"
            data-testid="select-popover"
          >
            {isSearchable && (
              <div className="flex items-center gap-2 border-b border-ink-100 px-3 py-2">
                <Search className="h-4 w-4 shrink-0 text-ink-400" aria-hidden />
                <input
                  ref={searchRef}
                  value={query}
                  onChange={(e) => {
                    setQuery(e.target.value);
                    setActive(0);
                  }}
                  onKeyDown={onKeyDown}
                  role="combobox"
                  aria-controls={listId}
                  aria-expanded
                  aria-activedescendant={activeId}
                  aria-label={t('ui.select.searchPlaceholder')}
                  placeholder={t('ui.select.searchPlaceholder')}
                  className="w-full bg-transparent text-sm text-ink-900 outline-none placeholder:text-ink-400 focus:shadow-none"
                />
              </div>
            )}
            <div id={listId} role="listbox" aria-label={ariaLabel} style={{ maxHeight: pos.maxHeight }} className="overflow-y-auto p-1">
              {visible.length === 0 && <p className="px-3 py-2 text-sm text-ink-400">{t('ui.select.noOptions')}</p>}
              {visible.map((o, i) => {
                const header = o.group && o.group !== lastGroup ? o.group : null;
                lastGroup = o.group;
                const isSel = o.value === current;
                return (
                  <Fragment key={`${o.value}-${i}`}>
                    {header && <p className="eyebrow px-3 pb-1 pt-2 text-ink-400">{header}</p>}
                    <div
                      id={`${uid}-opt-${i}`}
                      role="option"
                      aria-selected={isSel}
                      aria-disabled={o.disabled || undefined}
                      data-index={i}
                      data-value={o.value}
                      onMouseEnter={() => setActive(i)}
                      onMouseDown={(e) => e.preventDefault()}
                      onClick={() => commit(o)}
                      className={`flex cursor-pointer items-center justify-between gap-3 rounded-lg px-3 py-2 text-sm ${
                        o.disabled ? 'cursor-not-allowed text-ink-300' : i === active ? 'bg-brand-50 text-brand-800' : 'text-ink-800'
                      } ${isSel ? 'font-medium' : ''} ${o.value === '' ? 'text-ink-400' : ''}`}
                    >
                      <span className="truncate">{o.label}</span>
                      {isSel && <Check className="h-4 w-4 shrink-0 text-brand-600" aria-hidden />}
                    </div>
                  </Fragment>
                );
              })}
            </div>
          </div>,
          document.body,
        )}
    </div>
  );
});
