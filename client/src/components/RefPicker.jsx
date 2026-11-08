import { useEffect, useId, useRef, useState } from 'react';
import { useQuery } from '@tanstack/react-query';
import { get, getList, queryString } from '../api/client.js';
import { Input } from './ui.jsx';

// Search-as-you-type picker for a record. Works however many records there are.
// valueKey lets a field store something other than the id, like an account code.
export function RefPicker({ endpoint, value, onChange, labelOf, params = {}, placeholder = 'Search', disabled, required: isRequired, valueKey = 'id' }) {
  const [text, setText] = useState('');
  const [debounced, setDebounced] = useState('');
  const [isOpen, setIsOpen] = useState(false);
  const wrapper = useRef(null);
  const listId = useId();

  useEffect(() => {
    const timer = setTimeout(() => setDebounced(text), 200);
    return () => clearTimeout(timer);
  }, [text]);

  useEffect(() => {
    const close = (event) => {
      if (wrapper.current && !wrapper.current.contains(event.target)) setIsOpen(false);
    };
    document.addEventListener('mousedown', close);
    return () => document.removeEventListener('mousedown', close);
  }, []);

  const selected = useQuery({
    queryKey: ['ref', endpoint, value],
    queryFn: async () => {
      if (valueKey === 'id') return get(`${endpoint}/${value}`);
      const found = await getList(`${endpoint}${queryString({ q: value, limit: 25 })}`);
      return found.data.find((row) => row[valueKey] === value) ?? null;
    },
    enabled: Boolean(value),
    staleTime: 60000,
  });
  const options = useQuery({
    queryKey: ['ref-search', endpoint, debounced, params],
    queryFn: () => getList(`${endpoint}${queryString({ ...params, q: debounced, limit: 25 })}`),
    enabled: isOpen,
  });

  const shown = isOpen ? text : (selected.data ? labelOf(selected.data) : '');
  const rows = options.data?.data ?? [];

  return (
    <div ref={wrapper} className="relative">
      <div className="flex gap-1">
        <Input
          value={shown}
          placeholder={placeholder}
          disabled={disabled}
          required={isRequired && !value}
          role="combobox"
          aria-expanded={isOpen}
          aria-controls={listId}
          onFocus={() => { setIsOpen(true); setText(''); }}
          onChange={(event) => { setText(event.target.value); setIsOpen(true); }}
          onKeyDown={(event) => {
            if (event.key === 'Escape') setIsOpen(false);
            if (event.key === 'Enter') {
              event.preventDefault();
              if (rows[0]) { onChange(rows[0][valueKey], rows[0]); setIsOpen(false); }
            }
          }}
        />
        {value && !disabled && (
          <button type="button" aria-label="Clear" className="px-2 text-steel" onClick={() => onChange('', null)}>×</button>
        )}
      </div>
      {isOpen && (
        <ul id={listId} role="listbox" className="absolute z-30 mt-1 max-h-64 w-full min-w-64 overflow-auto rounded-md border border-line bg-card shadow-lg">
          {options.isLoading && <li className="px-3 py-2 text-sm text-steel">Searching…</li>}
          {options.isError && <li className="px-3 py-2 text-sm text-danger">{options.error.message}</li>}
          {!options.isLoading && rows.length === 0 && !options.isError && <li className="px-3 py-2 text-sm text-steel">No matches</li>}
          {rows.map((row) => (
            <li key={row.id} role="option" aria-selected={row[valueKey] === value}>
              <button
                type="button"
                className="block w-full px-3 py-2 text-left text-sm hover:bg-paper"
                onClick={() => { onChange(row[valueKey], row); setIsOpen(false); }}
              >
                {labelOf(row)}
              </button>
            </li>
          ))}
        </ul>
      )}
    </div>
  );
}
