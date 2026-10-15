'use client';

import { useEffect, useId, useState } from 'react';
import { X } from 'lucide-react';
import { useI18n } from '../../i18n/I18nProvider';
import { listEmployees } from '../../lib/api/employees';
import type { Employee } from '../../lib/api/types';
import { Input } from '../ui/Field';
import { Avatar } from './Avatar';

export interface PickedPerson {
  id: string;
  name: string;
}

/**
 * A searchable multi-select of employees (chips + a results list). Used for recognition recipients; capped by `max`.
 * Results come from the same `GET /employees?search=` the other pickers use, so branch scoping is the server's.
 */
export function PeoplePicker({
  value,
  onChange,
  excludeIds = [],
  max,
  inputId,
  label,
}: {
  value: PickedPerson[];
  onChange: (next: PickedPerson[]) => void;
  excludeIds?: string[];
  max: number;
  inputId?: string;
  label: string;
}) {
  const { t } = useI18n();
  const autoId = useId();
  const id = inputId ?? `${autoId}-people`;
  const [query, setQuery] = useState('');
  const [results, setResults] = useState<Employee[]>([]);
  const [searching, setSearching] = useState(false);

  useEffect(() => {
    let cancelled = false;
    setSearching(true);
    const handle = setTimeout(() => {
      listEmployees({ search: query.trim() || undefined, pageSize: 12 })
        .then((r) => {
          if (!cancelled) setResults(r.data);
        })
        .catch(() => {
          if (!cancelled) setResults([]);
        })
        .finally(() => {
          if (!cancelled) setSearching(false);
        });
    }, 200);
    return () => {
      cancelled = true;
      clearTimeout(handle);
    };
  }, [query]);

  const taken = new Set([...excludeIds, ...value.map((v) => v.id)]);
  const available = results.filter((e) => !taken.has(e.id));
  const full = value.length >= max;

  return (
    <div className="space-y-2">
      {value.length > 0 && (
        <ul className="flex flex-wrap gap-2" aria-label={t('recognition.give.selected')}>
          {value.map((p) => (
            <li key={p.id} data-testid="selected-recipient" className="inline-flex items-center gap-1.5 rounded-full bg-brand-50 py-1 ps-3 pe-1.5 text-xs font-medium text-brand-700 ring-1 ring-inset ring-brand-200">
              {p.name}
              <button
                type="button"
                aria-label={t('recognition.give.removeRecipient', { name: p.name })}
                onClick={() => onChange(value.filter((v) => v.id !== p.id))}
                className="rounded-full p-0.5 hover:bg-brand-100"
              >
                <X className="h-3 w-3" aria-hidden />
              </button>
            </li>
          ))}
        </ul>
      )}
      <Input
        id={id}
        type="search"
        autoComplete="off"
        value={query}
        onChange={(e) => setQuery(e.target.value)}
        placeholder={t('recognition.give.searchPeople')}
        aria-label={label}
        disabled={full}
        data-testid="recipient-search"
      />
      <p className="text-xs text-ink-400" aria-live="polite">
        {full ? t('recognition.give.maxReached', { max }) : t('recognition.give.recipientsCount', { count: value.length, max })}
      </p>
      {!full && (
        <ul className="max-h-44 divide-y divide-ink-100 overflow-y-auto rounded-lg border border-ink-100" aria-busy={searching}>
          {available.length === 0 ? (
            <li className="px-3 py-2 text-xs text-ink-400">{searching ? t('common.loading') : t('recognition.give.noPeople')}</li>
          ) : (
            available.map((e) => {
              const name = `${e.firstName} ${e.lastName}`;
              return (
                <li key={e.id}>
                  <button
                    type="button"
                    data-testid="recipient-option"
                    onClick={() => onChange([...value, { id: e.id, name }])}
                    className="flex w-full items-center gap-2 px-3 py-2 text-start text-sm text-ink-800 hover:bg-sand-100"
                  >
                    <Avatar name={name} size="sm" />
                    <span>{name}</span>
                    <span className="ms-auto text-xs text-ink-400">{e.employeeCode}</span>
                  </button>
                </li>
              );
            })
          )}
        </ul>
      )}
    </div>
  );
}
