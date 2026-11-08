// A document type's fields, written as one compact line. A token is:
//
//   key[!][*][~][:type[(args)]][=default]
//
//   !  required      *  unique      ~  computed: the server sets it, and input is refused
//   text long bigtext int check date datetime time email phone attach
//   money smoney qty sqty pct fx  (integers: paise, signed paise, thousandths, signed,
//                                  basis points, rate x 10,000)
//   select(A,B,C)    link(Target)   link(Target;field=value)
//
// Example: 'name!* status:select(OPEN,CLOSED)=OPEN ownerId:link(User) budgetPaise:money'

const TOKEN = /^(\w+)(!)?(\*)?(~)?(?::(\w+)(?:\(([^)]*)\))?)?(?:=(\S+))?$/;
const NUMERIC = new Set(['int', 'money', 'smoney', 'qty', 'sqty', 'pct', 'fx']);
export const FIELD_TYPES = new Set(['text', 'long', 'bigtext', 'int', 'check', 'date', 'datetime', 'time', 'email', 'phone', 'attach', 'money', 'smoney', 'qty', 'sqty', 'pct', 'fx', 'select', 'link']);

export function labelFromKey(key) {
  const trimmed = key.replace(/(Paise|Milli|Bps|Id|Fx4)$/, '') || key;
  const words = trimmed.replace(/([a-z0-9])([A-Z])/g, '$1 $2').toLowerCase();
  return words.charAt(0).toUpperCase() + words.slice(1);
}

function parseDefault(type, raw) {
  if (raw === undefined) return undefined;
  if (type === 'check') return raw === 'true';
  if (NUMERIC.has(type)) return Number(raw);
  return raw;
}

export function parseFields(spec, labels = {}) {
  const fields = [];
  for (const token of String(spec ?? '').trim().split(/\s+/).filter(Boolean)) {
    const match = token.match(TOKEN);
    if (!match) throw new Error(`Bad field token: ${token}`);
    const [, key, required, unique, computed, rawType, args, rawDefault] = match;
    const type = rawType ?? 'text';
    if (!FIELD_TYPES.has(type)) throw new Error(`Unknown field type "${type}" in ${token}`);
    const field = { key, type, label: labels[key] ?? labelFromKey(key), required: Boolean(required), unique: Boolean(unique), computed: Boolean(computed) };
    if (type === 'select') {
      field.options = String(args ?? '').split(',').filter(Boolean);
      if (field.options.length === 0) throw new Error(`Select needs options: ${token}`);
    }
    if (type === 'link') {
      const [target, ...filters] = String(args ?? '').split(';');
      if (!target) throw new Error(`Link needs a target: ${token}`);
      field.link = target;
      if (filters.length) field.linkFilter = Object.fromEntries(filters.map((f) => f.split('=')));
    }
    const value = parseDefault(type, rawDefault);
    if (value !== undefined) field.default = value;
    fields.push(field);
  }
  return fields;
}
