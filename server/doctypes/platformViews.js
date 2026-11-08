// Records behind the shared screens: print formats, dashboards, per-record permissions and
// public forms. The print designer works in blocks rather than HTML, so a saved format can
// never run a script in someone's browser.
import { define, getType } from '../engine/registry.js';
import { clearScopeCache } from '../engine/access.js';
import { rule } from '../utils/errors.js';

const m = (name, fields, extra = {}) => define({ name, module: 'platform', fields, ...extra });

m('PrintFormat', 'name!* doctypeName! isDefault:check letterHeadId:link(LetterHead) hideLetterhead:check', {
  labels: { doctypeName: 'For screen', hideLetterhead: 'Printing on letterhead paper' },
  hint: 'For screen is the address of its list, like salesInvoices or WorkOrder. Fields are keys separated by commas.',
  tables: { blocks: 'kind!:select(HEADING,FIELDS,LINES,TABLE,TOTALS,WORDS,TEXT,SIGNATURE,SPACER)=TEXT text:long fields tableKey' },
  list: 'name doctypeName isDefault',
  readers: 'all',
  deletable: true,
});

/* ---------- Dashboards ---------- */

// A figure comes from a document type (any field, filtered) or from a report's own totals.
// Either way the viewer's own permissions apply.
m('NumberCard', 'label!* source:select(DOCTYPE,REPORT)=DOCTYPE doctypeName measure:select(COUNT,SUM)=COUNT sumField withinDays:int reportKey reportColumn format:select(NUMBER,MONEY,QTY)=NUMBER', {
  tables: { filters: 'fieldKey! value!' },
  list: 'label source doctypeName reportKey',
  labelFields: ['label'],
  readers: 'all',
  deletable: true,
});

m('DashboardChart', 'title!* chartType:select(BAR,LINE,PIE)=BAR source:select(DOCTYPE,REPORT)=DOCTYPE doctypeName groupByField byMonth:check measure:select(COUNT,SUM)=COUNT sumField withinDays:int reportKey labelColumn valueColumn limit:int=12 format:select(NUMBER,MONEY,QTY)=NUMBER', {
  labels: { byMonth: 'Group by month of the date' },
  tables: { filters: 'fieldKey! value!' },
  list: 'title chartType source doctypeName reportKey',
  labelFields: ['title'],
  readers: 'all',
  deletable: true,
});

m('Dashboard', 'name!* description isDefault:check', {
  tables: { cards: 'cardId!:link(NumberCard)', charts: 'chartId!:link(DashboardChart)' },
  list: 'name description isDefault',
  readers: 'all',
  deletable: true,
});

/* ---------- Per-record permissions ---------- */

// Once a person has any row for a warehouse, say, they only see documents for the listed
// ones. Applies to engine documents. The hand-written core documents are not limited by this.
m('UserPermission', 'userId!:link(User) targetDoctype! valueId!', {
  labels: { targetDoctype: 'Limited to which records', valueId: 'Allowed record id' },
  hint: 'Target is a record type such as Warehouse, Plant, Project or CostCenter.',
  labelFields: ['targetDoctype', 'valueId'],
  list: 'userId targetDoctype valueId',
  deletable: true,
  afterCreate: () => clearScopeCache(),
  afterUpdate: () => clearScopeCache(),
  afterDelete: () => clearScopeCache(),
});

/* ---------- Public forms ---------- */

// A link would let an outsider probe which records exist, so only plain fields are offered.
const SAFE_TYPES = new Set(['text', 'long', 'email', 'phone', 'date', 'select', 'int']);

m('WebForm', 'title!* slug!* doctypeName:select(Lead,Issue)=Lead isPublished:check intro:long successMessage', {
  tables: { formFields: 'fieldKey! label isRequired:check' },
  list: 'title slug doctypeName isPublished',
  labelFields: ['title'],
  hint: 'The form opens at /form/your-slug, with no sign-in. Only published forms are open.',
  deletable: true,
  prepare(_session, data) {
    if (!/^[a-z0-9-]{2,60}$/.test(data.slug)) throw rule('A slug uses lowercase letters, numbers and dashes.', 'BAD_SLUG');
    const type = getType(data.doctypeName ?? 'Lead');
    const fields = new Map(type.fields.map((f) => [f.key, f]));
    for (const row of data.formFields ?? []) {
      const field = fields.get(row.fieldKey);
      if (!field || field.computed || !SAFE_TYPES.has(field.type)) throw rule(`"${row.fieldKey}" cannot go on a public form.`, 'BAD_FORM_FIELD');
    }
    const listed = new Set((data.formFields ?? []).map((row) => row.fieldKey));
    const missing = type.fields.filter((f) => f.required && !f.computed && !listed.has(f.key));
    if (missing.length) throw rule(`The form must include: ${missing.map((f) => f.label).join(', ')}.`, 'FORM_MISSING_REQUIRED');
    return data;
  },
});
