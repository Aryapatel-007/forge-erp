// One input for each field type, and the conversions between what a person types and
// the integers the API takes.
import { get, queryString } from '../../api/client.js';
import { RefPicker } from '../../components/RefPicker.jsx';
import { Button, Field, Input, Select, TextArea } from '../../components/ui.jsx';
import { parseScaled, unscale } from '../../utils/format.js';

const SCALES = { money: 2, moneySigned: 2, qty: 3, qtySigned: 3, bps: 2, fx: 4 };
const SIGNED = new Set(['qtySigned', 'moneySigned']);

export function toFormValue(field, value) {
  if (field.type === 'lines') return (value ?? []).map((line) => lineToForm(field, line));
  if (value === undefined || value === null) {
    if (field.default !== undefined && field.type !== 'lines') return toFormValue(field, field.default);
    return field.type === 'check' ? false : '';
  }
  if (field.type in SCALES) return unscale(value, SCALES[field.type]);
  if (field.type === 'check') return Boolean(value);
  return String(value);
}

function lineToForm(field, line) {
  const row = { _key: line.id ?? line._key ?? crypto.randomUUID() };
  for (const child of field.fields) {
    let value = line[child.key];
    if (child.key === '_label' && value === undefined) value = `${line.itemCode ?? ''} · ${line.itemName ?? ''}`;
    if (child.key === 'description' && value === undefined) value = line.itemName;
    row[child.key] = child.display || child.hidden ? value : toFormValue(child, value);
  }
  return row;
}

export const newLine = (field) => lineToForm(field, {});

export const initialValues = (fields, doc = {}) => {
  const values = {};
  for (const field of fields) {
    const source = field.customKey ? doc.custom?.[field.customKey] : doc[field.key];
    values[field.key] = field.type === 'lines' ? toFormValue(field, source ?? field.default) : toFormValue(field, field.type === 'datetime' && source ? new Date(source).toISOString().slice(0, 16) : source);
  }
  return values;
};

export function toPayloadValue(field, value) {
  if (field.type === 'check') return Boolean(value);
  if (value === '' || value === undefined || value === null) return undefined;
  if (field.type in SCALES) {
    const parsed = parseScaled(value, SCALES[field.type], { allowNegative: SIGNED.has(field.type) });
    if (parsed === null) throw new Error(`${field.label}: "${value}" is not a valid number.`);
    return parsed;
  }
  if (field.type === 'integer') {
    if (!/^\d+$/.test(String(value))) throw new Error(`${field.label}: use a whole number.`);
    return Number(value);
  }
  return value;
}

// Only declared fields are sent, and a field its condition hides is left out.
export function toPayload(fields, values, { forEdit = false } = {}) {
  const payload = {};
  for (const field of fields) {
    if (field.display) continue;
    if (field.showIf && !field.showIf(values)) continue;
    if (field.type === 'lines') {
      const rows = (values[field.key] ?? []).map((line) => toPayload(field.fields, line));
      payload[field.key] = rows;
      continue;
    }
    if (field.hidden) {
      if (values[field.key]) payload[field.key] = values[field.key];
      continue;
    }
    const raw = field.type === 'datetime' && values[field.key] ? new Date(values[field.key]).toISOString() : values[field.key];
    const converted = toPayloadValue(field, raw);
    if (converted !== undefined) {
      if (field.customKey) payload.custom = { ...(payload.custom ?? {}), [field.customKey]: converted };
      else payload[field.key] = converted;
    } else if (field.required) throw new Error(`${field.label} is required.`);
    else if (field.sendNull && forEdit) payload[field.key] = null; // a cleared box really clears
  }
  return payload;
}

export function FieldInput({ field, value, onChange, onPick, disabled }) {
  const common = { value: value ?? '', disabled, required: field.required, onChange: (event) => onChange(event.target.value) };
  switch (field.type) {
    case 'textarea':
      return <TextArea {...common} />;
    case 'fileText':
      return (
        <>
          <input aria-label={`${field.label} file`} type="file" accept=".csv,text/csv,text/plain" className="mb-1 block text-sm" onChange={async (event) => { if (event.target.files[0]) onChange(await event.target.files[0].text()); }} />
          <TextArea {...common} placeholder="Or paste it here" />
        </>
      );
    case 'date':
      return <Input type="date" {...common} />;
    case 'datetime':
      return <Input type="datetime-local" {...common} />;
    case 'select':
      return (
        <Select {...common}>
          {!field.required && <option value="">Any</option>}
          {field.required && !value && <option value="">Choose</option>}
          {(field.options ?? []).map((option) => <option key={option.value} value={option.value}>{option.label}</option>)}
        </Select>
      );
    case 'check':
      return <input type="checkbox" className="size-5" checked={Boolean(value)} disabled={disabled} onChange={(event) => onChange(event.target.checked)} />;
    case 'ref':
      return <RefPicker {...field.ref} value={value} required={field.required} disabled={disabled} onChange={(next, row) => { onChange(next ?? '', row); if (row && onPick) onPick(row); }} />;
    case 'money':
    case 'qty':
    case 'qtySigned':
    case 'moneySigned':
    case 'bps':
    case 'fx':
    case 'integer':
      return <Input inputMode="decimal" className="num" {...common} />;
    default:
      return <Input {...common} />;
  }
}

export function FormField({ field, values, setValue, disabled, onPick }) {
  if (field.hidden) return null;
  if (field.showIf && !field.showIf(values)) return null;
  if (field.display) {
    return <Field label={field.label} className={field.wide ? 'md:col-span-2' : ''}><p className="py-1.5 text-sm">{values[field.key]}</p></Field>;
  }
  const isCheck = field.type === 'check';
  return (
    <Field label={`${field.label}${field.required ? ' *' : ''}`} hint={field.hint} className={`${field.wide ? 'md:col-span-2' : ''} ${isCheck ? 'flex flex-col' : ''}`}>
      <FieldInput field={field} value={values[field.key]} onChange={(next, picked) => setValue(field.key, next, picked)} disabled={disabled} onPick={onPick} />
    </Field>
  );
}

export function LinesEditor({ field, rows, onChange, disabled, parentValues }) {
  const setCell = async (index, key, value, picked) => {
    const next = rows.map((row, i) => (i === index ? { ...row, [key]: value } : row));
    const child = field.fields.find((f) => f.key === key);
    const apply = (updates) => {
      for (const [updateKey, updateValue] of Object.entries(updates ?? {})) {
        const target = field.fields.find((f) => f.key === updateKey);
        if (target) next[index][updateKey] = toFormValue(target, updateValue);
      }
    };
    if (picked) apply(child.onPick?.(picked));
    onChange(next);
    // Ask the server for the price: party price, price list and pricing rules.
    if (picked && child.quote) {
      try {
        const quote = await get(`/pricing/quote${queryString({ itemId: value, partyId: parentValues?.partyId, forBuying: child.quote === 'buying' ? 'true' : undefined })}`);
        apply(child.quote === 'buying' ? { ratePaise: quote.ratePaise } : { rateMinor: quote.ratePaise });
        onChange([...next]);
      } catch {
        // The price typed by hand still works if the lookup fails.
      }
    }
  };
  return (
    <fieldset className="md:col-span-full">
      <legend className="mb-2 text-sm font-semibold">{field.label}</legend>
      <div className="space-y-3">
        {rows.map((row, index) => (
          <div key={row._key} className="rounded-md border border-line p-3">
            <div className="grid grid-cols-2 gap-3 md:grid-cols-6">
              {field.fields.map((child) => (
                <FormField
                  key={child.key}
                  field={{ ...child, wide: false }}
                  values={row}
                  disabled={disabled}
                  setValue={(key, value, picked) => setCell(index, key, value, picked)}
                />
              ))}
            </div>
            {!disabled && (
              <div className="mt-2 text-right">
                <Button variant="ghost" onClick={() => onChange(rows.filter((_, i) => i !== index))}>Remove line</Button>
              </div>
            )}
          </div>
        ))}
      </div>
      {!disabled && !field.fixed && (
        <Button className="mt-2" onClick={() => onChange([...rows, newLine(field)])}>Add line</Button>
      )}
    </fieldset>
  );
}
