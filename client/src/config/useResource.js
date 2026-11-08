// A screen config for any document: the hand-written ones in resources.js, or one built
// here from what the server says about an engine document type.
import { RESOURCES } from './resources.js';
import { useMeta } from '../context/Meta.jsx';
import { useAuth } from '../context/Auth.jsx';
import { formatBps, formatDate, formatDateTime, formatFx, formatPaise, formatQty, humanise } from '../utils/format.js';

const ACTIONS = { read: 'read', write: 'write' };

export function formatByType(type, value, label) {
  if (label !== undefined && label !== null) return label;
  if (value === null || value === undefined || value === '') return '';
  switch (type) {
    case 'money': case 'smoney': return formatPaise(value);
    case 'qty': case 'sqty': return formatQty(value);
    case 'pct': return formatBps(value);
    case 'fx': return formatFx(value);
    case 'date': return formatDate(value);
    case 'datetime': return formatDateTime(value);
    case 'check': return value ? 'Yes' : 'No';
    case 'select': return humanise(value);
    default: return String(value);
  }
}

const isNumeric = (type) => ['money', 'smoney', 'qty', 'sqty', 'pct', 'fx', 'int'].includes(type);

function formField(field) {
  const out = { key: field.key, label: field.label, required: field.required, default: field.default, sendNull: true };
  switch (field.type) {
    case 'long': return { ...out, type: 'textarea', wide: true };
    case 'bigtext': return { ...out, type: 'fileText', wide: true };
    case 'int': return { ...out, type: 'integer' };
    case 'pct': return { ...out, type: 'bps' };
    case 'smoney': return { ...out, type: 'moneySigned' };
    case 'sqty': return { ...out, type: 'qtySigned' };
    case 'select': return { ...out, type: 'select', options: field.options.map((value) => ({ value, label: humanise(value) })) };
    case 'link': return {
      ...out,
      type: 'ref',
      ref: {
        endpoint: field.link.endpoint,
        params: field.link.params,
        valueKey: field.link.valueKey,
        labelOf: (row) => field.link.labelFields.map((key) => row[key]).filter((v) => v !== null && v !== undefined && v !== '').join(' · '),
      },
    };
    case 'time': return { ...out, type: 'text', hint: 'Like 09:30' };
    case 'email': case 'phone': case 'attach': return { ...out, type: 'text' };
    case 'datetime': return { ...out, type: 'datetime' };
    default: return { ...out, type: field.type };
  }
}

function column(field) {
  return {
    key: field.key,
    label: field.label,
    align: isNumeric(field.type) ? 'right' : undefined,
    wrap: field.type === 'text' || field.type === 'long' || field.type === 'link',
    render: (row) => formatByType(field.type, row[field.key], row._labels?.[field.key]),
  };
}

const whenFn = (when) => (doc) => Object.entries(when ?? {}).every(([key, allowed]) => allowed.includes(doc[key] ?? null));

const titleOf = (type) => (doc) => doc.docNo ?? (type.labelFields.map((key) => doc._labels?.[key] ?? doc[key]).filter(Boolean).join(' · ') || `New ${type.label.toLowerCase()}`);

export function configFromMeta(type, custom = []) {
  const byKey = new Map(type.fields.map((f) => [f.key, f]));
  const editable = type.fields.filter((f) => !f.computed);
  const customFields = custom.filter((c) => c.doctype === type.name).map((c) => ({
    key: `custom__${c.key}`,
    customKey: c.key,
    label: c.label,
    required: c.required,
    type: { long: 'textarea', int: 'integer' }[c.type] ?? c.type,
    options: c.options?.map((value) => ({ value, label: value })),
    sendNull: false,
  }));
  const fields = [
    ...editable.map(formField),
    ...customFields,
    ...(type.submittable ? [{ key: 'postingDate', label: 'Date', type: 'date' }] : []),
    ...type.tables.filter((t) => !t.computed).map((t) => ({
      key: t.key,
      type: 'lines',
      label: t.label,
      fields: t.fields.filter((f) => !f.computed).map((f) => ({ ...formField(f), sendNull: false })),
    })),
  ];

  const listKeys = type.list.filter((key) => key !== 'status');
  const columns = [];
  for (const key of listKeys) {
    if (key === 'docNo') columns.push({ key: 'docNo', label: 'Number', render: (row) => row.docNo ?? 'Draft' });
    else if (byKey.has(key)) columns.push(column(byKey.get(key)));
  }
  if (type.submittable) columns.push({ key: 'status', label: 'Status', status: true });
  const statusField = byKey.get('status') ?? byKey.get('state');
  if (statusField && !type.submittable && !columns.some((c) => c.key === statusField.key)) columns.push({ key: statusField.key, label: statusField.label, status: true });

  const filters = [];
  if (type.submittable) filters.push({ key: 'status', label: 'Status', options: ['DRAFT', 'SUBMITTED', 'CANCELLED'].map((value) => ({ value, label: humanise(value) })) });
  for (const field of type.fields) {
    if (field.type === 'select' && filters.length < 3) filters.push({ key: field.key, label: field.label, options: field.options.map((value) => ({ value, label: humanise(value) })) });
  }

  const summary = [
    ...type.fields.filter((f) => f.type !== 'long').map((f) => ({ key: f.key, label: f.label, labelKey: f.key, format: (value) => formatByType(f.type, value) })),
    ...(type.submittable ? [{ key: 'postingDate', label: 'Date', format: formatDate }] : []),
    ...type.fields.filter((f) => f.type === 'long').map((f) => ({ key: f.key, label: f.label })),
  ];

  return {
    isEngine: true,
    meta: type,
    kind: 'document',
    name: type.name,
    title: type.label,
    single: type.label,
    printTitle: type.submittable ? type.label : null,
    endpoint: `/d/${type.name}`,
    access: type.can,
    submittable: type.submittable,
    noSubmit: !type.submittable,
    noCancel: !type.submittable,
    noDelete: !type.submittable && !type.canDelete,
    alwaysEditable: !type.submittable,
    submitLabel: type.submitLabel,
    submitHint: type.hint,
    titleOf: titleOf(type),
    filters,
    columns,
    fields,
    summary,
    customFields,
    extraTables: type.tables.map((t) => ({ title: t.label, key: t.key, columns: t.fields.map(column) })),
    actions: type.actions.map((action) => ({
      label: action.label,
      primary: action.primary,
      when: whenFn(action.when),
      path: `a/${action.key}`,
      navigate: action.navigate ?? action.navigateTo,
      form: action.fields.length ? { title: action.label, fields: action.fields.map((f) => ({ ...formField(f), sendNull: false })) } : null,
    })),
  };
}

export function useResource(key) {
  const meta = useMeta();
  if (RESOURCES[key]) return RESOURCES[key];
  const type = meta?.doctypes.find((d) => d.name === key);
  return type ? configFromMeta(type, meta.custom) : null;
}

// One question for either kind of screen.
export function useAllowed(config) {
  const { can } = useAuth();
  return (action) => {
    if (!config) return false;
    if (config.access) return Boolean(config.access[ACTIONS[action] ?? action]);
    return can(config[action]);
  };
}

