// CSV in and out for any document type. Import goes through createDoc, so an imported row
// obeys exactly the rules a typed one does. A dry run checks every row and saves nothing.
import { z } from 'zod';
import { linkTarget } from './registry.js';
import { createDoc } from './documents.js';
import { withTxn } from '../utils/txn.js';
import { badRequest } from '../utils/errors.js';

const MAX_ROWS = 5000;

export function parseCsv(text) {
  const rows = [];
  let row = [];
  let cell = '';
  let quoted = false;
  const source = text.replace(/^﻿/, '');
  for (let i = 0; i < source.length; i += 1) {
    const ch = source[i];
    if (quoted) {
      if (ch === '"' && source[i + 1] === '"') { cell += '"'; i += 1; } else if (ch === '"') quoted = false;
      else cell += ch;
    } else if (ch === '"') quoted = true;
    else if (ch === ',') { row.push(cell); cell = ''; } else if (ch === '\n' || ch === '\r') {
      if (ch === '\r' && source[i + 1] === '\n') i += 1;
      row.push(cell);
      cell = '';
      if (row.some((c) => c !== '')) rows.push(row);
      row = [];
    } else cell += ch;
  }
  row.push(cell);
  if (row.some((c) => c !== '')) rows.push(row);
  return rows;
}

// A leading = + - or @ makes a spreadsheet run the cell as a formula, so it is defused.
function csvCell(value) {
  let text = value === null || value === undefined ? '' : String(value);
  if (/^[=+\-@\t\r]/.test(text) && !/^-?\d/.test(text)) text = `'${text}`;
  return `"${text.replace(/"/g, '""')}"`;
}

export async function exportCsv(type, filter) {
  const fields = type.fields;
  const extra = type.series ? ['docNo'] : [];
  if (type.submittable) extra.push('status', 'postingDate');
  const header = [...extra, ...fields.map((f) => f.key)];
  const rows = await type.Model.find(filter).sort({ createdAt: -1 }).limit(50000).lean();
  const lines = [header.map(csvCell).join(',')];
  for (const row of rows) lines.push(header.map((key) => csvCell(row[key])).join(','));
  return `﻿${lines.join('\r\n')}`;
}

// Whole units in a CSV are what a person has: 12.50 rupees, 1.5 kg, 18 percent.
export function scaledInt(text, scale) {
  const match = String(text).trim().replace(/,/g, '').match(/^(-)?(\d*)(?:\.(\d*))?$/);
  if (!match || (!match[2] && !match[3]) || (match[3] ?? '').length > scale) throw new Error(`"${text}" is not a valid number`);
  const value = Number(`${match[2] || '0'}${(match[3] ?? '').padEnd(scale, '0')}`);
  return match[1] ? -value : value;
}

async function convert(field, raw) {
  const text = raw.trim();
  if (text === '') return undefined;
  switch (field.type) {
    case 'check': return ['1', 'true', 'yes', 'y'].includes(text.toLowerCase());
    case 'int': return scaledInt(text, 0);
    case 'money': case 'smoney': case 'pct': return scaledInt(text, 2);
    case 'qty': case 'sqty': return scaledInt(text, 3);
    case 'fx': return scaledInt(text, 4);
    case 'link': {
      // A person writes a code or a name in a spreadsheet, not a database id.
      const target = linkTarget(field.link);
      const key = target.valueKey ?? '_id';
      const options = await Promise.all(target.labelFields.map((labelField) => target.Model.find({ [labelField]: text }).limit(2).lean()));
      const matches = options.flat();
      const unique = [...new Map(matches.map((m) => [String(m[key]), m])).values()];
      if (unique.length === 0) throw new Error(`${field.label}: "${text}" was not found`);
      if (unique.length > 1) throw new Error(`${field.label}: "${text}" matches more than one record`);
      return String(unique[0][key]);
    }
    default: return text;
  }
}

export async function importCsv(type, csv, { dryRun, actor }) {
  const rows = parseCsv(csv);
  if (rows.length < 2) throw badRequest('The file needs a heading row and at least one row of data.');
  if (rows.length - 1 > MAX_ROWS) throw badRequest(`A file can hold at most ${MAX_ROWS} rows.`);
  const header = rows[0].map((h) => h.trim());
  const fields = new Map(type.fields.map((f) => [f.key, f]));
  const byLabel = new Map(type.fields.map((f) => [f.label.toLowerCase(), f]));
  const tables = new Map(type.tables.filter((t) => !t.computed).map((t) => [t.key, t]));
  // A column named lines.qtyMilli fills a line. Rows sharing a _key become one document.
  const keyColumn = header.indexOf('_key');
  const columns = header.map((name) => {
    if (name === '_key') return { isKey: true };
    if (name.includes('.')) {
      const [tableKey, fieldKey] = name.split('.');
      const field = tables.get(tableKey)?.fields.find((f) => f.key === fieldKey && !f.computed);
      return field ? { tableKey, field } : null;
    }
    const field = fields.get(name) ?? byLabel.get(name.toLowerCase());
    return field ? { field } : null;
  });
  const unknown = header.filter((_, i) => !columns[i]);
  if (unknown.length) throw badRequest(`These columns are not fields of ${type.name}: ${unknown.join(', ')}`);
  const hasLines = columns.some((c) => c.tableKey);
  if (hasLines && keyColumn < 0) throw badRequest('A file with line columns needs a _key column. Rows with the same _key become one document.');

  const groups = [];
  const byKey = new Map();
  for (let index = 1; index < rows.length; index += 1) {
    const key = keyColumn >= 0 ? rows[index][keyColumn]?.trim() : '';
    if (key && byKey.has(key)) byKey.get(key).rows.push(rows[index]);
    else {
      const group = { rowNo: index + 1, rows: [rows[index]] };
      if (key) byKey.set(key, group);
      groups.push(group);
    }
  }

  const errors = [];
  let saved = 0;
  for (const group of groups) {
    const input = {};
    try {
      for (let c = 0; c < columns.length; c += 1) {
        if (columns[c].isKey || columns[c].tableKey) continue;
        const value = await convert(columns[c].field, group.rows[0][c] ?? '');
        if (value !== undefined) input[columns[c].field.key] = value;
      }
      if (hasLines) {
        for (const row of group.rows) {
          const lines = {};
          for (let c = 0; c < columns.length; c += 1) {
            if (!columns[c].tableKey) continue;
            const value = await convert(columns[c].field, row[c] ?? '');
            if (value !== undefined) (lines[columns[c].tableKey] ??= {})[columns[c].field.key] = value;
          }
          for (const [tableKey, line] of Object.entries(lines)) (input[tableKey] ??= []).push(line);
        }
      }
      if (dryRun) {
        type.schemaFor.parse(input);
      } else {
        await withTxn((session) => createDoc(session, type.name, input, actor));
      }
      saved += 1;
    } catch (error) {
      let message = error.message;
      if (error instanceof z.ZodError) message = error.issues.map((issue) => `${issue.path.join('.')}: ${issue.message}`).join('; ');
      errors.push({ row: group.rowNo, message });
    }
  }
  return { dryRun, total: groups.length, ok: saved, errors: errors.slice(0, 200), errorCount: errors.length };
}
