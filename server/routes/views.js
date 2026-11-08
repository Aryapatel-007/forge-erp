// Shared screens that need more than a list: dashboards, print formats, the setup checklist,
// backups, public forms and the customer and supplier portal.
import { createReadStream } from 'node:fs';
import { Router } from 'express';
import rateLimit from 'express-rate-limit';
import { z } from 'zod';
import { authenticate, requirePerm } from '../middleware/index.js';
import { accessFor, scopeFilter } from '../engine/access.js';
import { createDoc } from '../engine/documents.js';
import { getType, modelOf } from '../engine/registry.js';
import { runReport } from '../engine/reports.js';
import mongoose from 'mongoose';
import { WEB_FORM_TYPES } from '../config/webForms.js';
import { GLOSSARY } from '../config/glossary.js';
import { Attachment } from '../models/platform.js';
import { razorpaySignatureOk, recordLinkPaid } from '../services/channelsService.js';
import { User } from '../models/core.js';
import { GlEntry, Bin } from '../models/ledgers.js';
import { Account, Item, Party, Warehouse } from '../models/masters.js';
import { MachineBuild, Payment, PurchaseInvoice, PurchaseOrder, Quotation, SalesInvoice, SalesOrder } from '../models/documents.js';
import { A } from '../config/accounts.js';
import { backupPath, createBackup, listBackups } from '../services/backupService.js';
import { homeFor } from '../services/homeService.js';
import { getSettings } from '../services/settingsService.js';
import { withTxn } from '../utils/txn.js';
import { addDays, todayIst } from '../utils/dates.js';
import { AppError, badRequest, forbidden, notFound } from '../utils/errors.js';

const ok = (res, data, status = 200) => res.status(status).json({ success: true, data });
const isTest = process.env.NODE_ENV === 'test';

/* ---------- Dashboards ---------- */

const NUMERIC = new Set(['int', 'money', 'smoney', 'qty', 'sqty', 'pct', 'fx']);

function matchFor(type, def) {
  const fields = new Map(type.fields.map((f) => [f.key, f]));
  const match = {};
  for (const row of def.filters ?? []) {
    const field = fields.get(row.fieldKey);
    if (row.fieldKey === 'status' && type.submittable) match.status = row.value;
    else if (field?.type === 'check') match[row.fieldKey] = row.value === 'true';
    else if (field && NUMERIC.has(field.type)) match[row.fieldKey] = Number(row.value);
    else if (field) match[row.fieldKey] = row.value;
    else throw badRequest(`${type.name} has no field called ${row.fieldKey}.`);
  }
  const dateField = type.submittable ? 'postingDate' : type.dateField;
  if (def.withinDays > 0 && dateField) match[dateField] = { $gte: addDays(todayIst(), -def.withinDays) };
  return match;
}

async function scopedMatch(user, type, def) {
  const match = matchFor(type, def);
  const scope = await scopeFilter(user, type);
  return scope ? { $and: [match, scope] } : match;
}

function sumExpression(type, def) {
  if (def.measure !== 'SUM') return { $sum: 1 };
  const field = type.fields.find((f) => f.key === def.sumField);
  if (!field || !NUMERIC.has(field.type)) throw badRequest(`${def.sumField} is not a number on ${type.name}.`);
  return { $sum: `$${field.key}` };
}

const reportValue = (result, column) => {
  if (!column) return result.rows.length;
  if (column in (result.totals ?? {})) return result.totals[column];
  return result.rows.reduce((sum, row) => sum + (Number(row[column]) || 0), 0);
};

async function cardValue(card, user) {
  if (card.source === 'REPORT') return reportValue(await runReport(card.reportKey, {}, user), card.reportColumn);
  const type = getType(card.doctypeName);
  if (!type) throw badRequest(`There is no document type called ${card.doctypeName}.`);
  const access = await accessFor(type.name, user.role);
  if (!access.read) throw forbidden();
  const [row] = await type.Model.aggregate([{ $match: await scopedMatch(user, type, card) }, { $group: { _id: null, value: sumExpression(type, card) } }]);
  return row?.value ?? 0;
}

async function chartPoints(chart, user) {
  const limit = Math.min(50, chart.limit || 12);
  if (chart.source === 'REPORT') {
    const result = await runReport(chart.reportKey, {}, user);
    return result.rows.slice(0, limit).map((row) => ({ label: String(row[chart.labelColumn] ?? ''), value: Number(row[chart.valueColumn]) || 0 }));
  }
  const type = getType(chart.doctypeName);
  if (!type) throw badRequest(`There is no document type called ${chart.doctypeName}.`);
  const access = await accessFor(type.name, user.role);
  if (!access.read) throw forbidden();
  const dateField = type.submittable ? 'postingDate' : type.dateField;
  let group;
  if (chart.byMonth) {
    if (!dateField) throw badRequest(`${type.name} has no date to group by.`);
    group = { $substrCP: [`$${dateField}`, 0, 7] };
  } else {
    const field = type.fields.find((f) => f.key === chart.groupByField);
    if (!field && chart.groupByField !== 'status') throw badRequest(`${type.name} has no field called ${chart.groupByField}.`);
    group = field?.type === 'link' ? { $ifNull: [`$_labels.${field.key}`, 'None'] } : { $ifNull: [`$${chart.groupByField}`, 'None'] };
  }
  const rows = await type.Model.aggregate([
    { $match: await scopedMatch(user, type, chart) },
    { $group: { _id: group, value: sumExpression(type, chart) } },
    { $sort: chart.byMonth ? { _id: 1 } : { value: -1 } },
    { $limit: limit },
  ]);
  return rows.map((row) => ({ label: String(row._id ?? 'None'), value: row.value }));
}

// One broken or forbidden tile shows its own message, and the rest still draw.
const tile = async (fn, base) => {
  try {
    return { ...base, ...(await fn()) };
  } catch (error) {
    return { ...base, error: error.status === 403 ? 'You do not have permission to see this.' : error.message };
  }
};

/* ---------- Setup checklist ---------- */

async function setupStatus() {
  const settings = await getSettings();
  const kinds = new Set((await Warehouse.find({ isActive: true }, { kind: 1 }).lean()).map((w) => w.kind));
  const backups = await listBackups();
  const lastBackup = backups[0]?.createdAt ?? null;
  const count = (name, filter = {}) => modelOf(name).countDocuments(filter);
  const steps = [
    { key: 'company', label: 'Company name, address, GSTIN and state', done: Boolean(settings.legalName && settings.address && settings.gstin && settings.stateCode), to: '/settings' },
    { key: 'lut', label: 'Export LUT number, if you export', done: Boolean(settings.lutNumber), optional: true, to: '/settings' },
    { key: 'users', label: 'A sign-in for each person', done: (await User.countDocuments({ isActive: true })) > 1, to: '/users' },
    { key: 'fiscal', label: 'Fiscal year', done: (await count('FiscalYear')) > 0, to: '/FiscalYear' },
    { key: 'warehouses', label: 'Stores, quarantine, reject, job work and finished goods warehouses', done: ['STORES', 'QUARANTINE', 'REJECT', 'JOBWORK', 'FG'].every((k) => kinds.has(k)), to: '/warehouses' },
    { key: 'bank', label: 'Your bank accounts in the chart of accounts', done: (await Account.countDocuments({ isCashOrBank: true, code: { $nin: [A.CASH, A.BANK] } })) > 0, optional: true, to: '/accounts' },
    { key: 'items', label: 'Items, by CSV import or typed', done: (await Item.countDocuments()) > 0, to: '/items' },
    { key: 'parties', label: 'Customers and suppliers', done: (await Party.countDocuments()) > 0, to: '/parties' },
    { key: 'stock', label: 'Opening stock, with a stock reconciliation', done: (await Bin.countDocuments({ qtyMilli: { $gt: 0 } })) > 0, to: '/StockReconciliation/new' },
    { key: 'openingInvoices', label: 'Opening balances, invoice by invoice', done: (await count('OpeningInvoice', { status: 'SUBMITTED' })) > 0, to: '/OpeningInvoice' },
    { key: 'email', label: 'A mail server, so emails can leave', done: Boolean(process.env.SMTP_HOST), optional: true, to: '/system' },
    { key: 'backup', label: 'A backup in the last two days', done: Boolean(lastBackup) && Date.now() - new Date(lastBackup).getTime() < 2 * 86400000, to: '/system' },
    { key: 'ca', label: 'Your CA has reviewed GST, TDS and payroll settings', done: Boolean(settings.caReviewedOn), to: '/settings' },
  ];
  return { steps, doneCount: steps.filter((s) => s.done).length, total: steps.length };
}

export function viewRoutes() {
  const r = Router();
  r.use(authenticate);

  r.get('/home', async (req, res) => ok(res, await homeFor(req.user)));

  r.get('/dashboards', async (_req, res) => ok(res, await modelOf('Dashboard').find().sort({ name: 1 }).lean().then((rows) => rows.map((row) => ({ id: String(row._id), name: row.name, description: row.description, isDefault: row.isDefault })))));
  r.get('/dashboards/:id', async (req, res) => {
    const dashboard = await modelOf('Dashboard').findById(req.params.id).lean();
    if (!dashboard) throw notFound('Dashboard');
    const cardRows = await modelOf('NumberCard').find({ _id: { $in: dashboard.cards.map((c) => c.cardId) } }).lean();
    const chartRows = await modelOf('DashboardChart').find({ _id: { $in: dashboard.charts.map((c) => c.chartId) } }).lean();
    const cards = await Promise.all(cardRows.map((card) => tile(async () => ({ value: await cardValue(card, req.user) }), { id: String(card._id), label: card.label, format: card.format })));
    const charts = await Promise.all(chartRows.map((chart) => tile(async () => ({ points: await chartPoints(chart, req.user) }), { id: String(chart._id), title: chart.title, chartType: chart.chartType, format: chart.format })));
    ok(res, { id: String(dashboard._id), name: dashboard.name, description: dashboard.description, cards, charts });
  });

  r.get('/print-formats/:resource', async (req, res) => {
    const formats = await modelOf('PrintFormat').find({ doctypeName: req.params.resource }).lean();
    const letterHeads = await modelOf('LetterHead').find().lean();
    ok(res, {
      formats: formats.map((f) => ({ ...f, id: String(f._id) })),
      letterHeads: letterHeads.map((l) => ({ id: String(l._id), name: l.name, headerText: l.headerText, footerText: l.footerText, isDefault: l.isDefault })),
    });
  });

  r.get('/fx-rate', async (req, res) => {
    const row = await modelOf('CurrencyExchange').findOne({ fromCurrency: String(req.query.currency ?? ''), toCurrency: 'INR' }).sort({ onDate: -1 }).lean();
    ok(res, row ? { currency: row.fromCurrency, rateFx4: row.rateFx4, onDate: row.onDate } : null);
  });

  r.get('/setup-status', requirePerm('settings.write'), async (_req, res) => ok(res, await setupStatus()));

  r.get('/backups', requirePerm('settings.write'), async (_req, res) => ok(res, await listBackups()));
  r.post('/backups', requirePerm('settings.write'), async (_req, res) => ok(res, await createBackup(), 201));
  r.get('/backups/:name/download', requirePerm('settings.write'), async (req, res) => {
    const file = (() => {
      try {
        return backupPath(req.params.name);
      } catch {
        throw notFound('Backup');
      }
    })();
    res.setHeader('content-type', 'application/gzip');
    res.setHeader('content-disposition', `attachment; filename="${req.params.name}.jsonl.gz"`);
    createReadStream(file).on('error', () => res.destroy()).pipe(res);
  });
  return r;
}

/* ---------- Public forms ---------- */

const formLimiter = rateLimit({ windowMs: 15 * 60000, limit: 20, skip: () => isTest, standardHeaders: true, legacyHeaders: false, handler: (_req, res) => res.status(429).json({ success: false, error: { code: 'TOO_MANY', message: 'Too many tries. Please wait a while.' } }) });
const WEB_FORM_ACTOR = { id: null, name: 'Web form', role: 'ADMIN' };

const publishedForm = async (slug) => {
  const form = await modelOf('WebForm').findOne({ slug: String(slug), isPublished: true }).lean();
  if (!form || !WEB_FORM_TYPES.includes(form.doctypeName)) throw notFound('Form');
  return form;
};

const websiteItem = (item, showPrices) => ({
  code: item.code,
  name: item.name,
  description: item.webDescription || '',
  ...(showPrices && item.salePricePaise ? { pricePaise: item.salePricePaise } : {}),
});

// Only these image types are served, so an uploaded file can never run as a page here.
const WEB_IMAGES = new Set(['image/jpeg', 'image/png', 'image/webp']);

export function publicRoutes() {
  const r = Router();

  r.get('/site', async (_req, res) => {
    const settings = await getSettings();
    const pages = await modelOf('WebPage').find({ isPublished: true, showInMenu: true }, { title: 1, slug: 1, sortOrder: 1 }).sort({ sortOrder: 1, title: 1 }).lean();
    ok(res, {
      name: settings.legalName,
      address: settings.address,
      phone: settings.phone,
      email: settings.email,
      menu: pages.map((p) => ({ title: p.title, slug: p.slug })),
    });
  });
  r.get('/pages/:slug', async (req, res) => {
    const page = await modelOf('WebPage').findOne({ slug: String(req.params.slug), isPublished: true }).lean();
    if (!page) throw notFound('Page');
    ok(res, { title: page.title, metaDescription: page.metaDescription, blocks: page.blocks.map(({ kind, text }) => ({ kind, text })) });
  });
  r.get('/catalogue', async (req, res) => {
    const settings = await getSettings();
    const q = typeof req.query.q === 'string' ? req.query.q.trim().slice(0, 80) : '';
    const pattern = q ? new RegExp(q.replace(/[.*+?^${}()|[\]\\]/g, '\\$&'), 'i') : null;
    const items = await Item.find({ showOnWebsite: true, isActive: true, ...(pattern ? { $or: [{ name: pattern }, { code: pattern }] } : {}) }).sort({ name: 1 }).limit(200).lean();
    ok(res, items.map((item) => websiteItem(item, settings.siteShowPrices)));
  });
  r.get('/catalogue/:code/image', async (req, res) => {
    const item = await Item.findOne({ code: String(req.params.code).toUpperCase(), showOnWebsite: true, isActive: true }, { _id: 1 }).lean();
    if (!item) throw notFound('Image');
    const file = await Attachment.findOne({ entityId: item._id, contentType: { $in: [...WEB_IMAGES] } }).sort({ createdAt: 1 }).lean();
    if (!file) throw notFound('Image');
    res.setHeader('content-type', file.contentType);
    res.setHeader('x-content-type-options', 'nosniff');
    res.setHeader('cache-control', 'public, max-age=3600');
    new mongoose.mongo.GridFSBucket(mongoose.connection.db, { bucketName: 'files' }).openDownloadStream(file.fileId).pipe(res);
  });
  // An enquiry from the site is a lead with the items listed. Nobody is charged, and no
  // price is promised: a person follows it up.
  r.post('/enquiry', formLimiter, async (req, res) => {
    const body = z.strictObject({
      name: z.string().trim().min(1).max(200),
      company: z.string().trim().max(200).optional(),
      email: z.string().trim().email().max(200),
      phone: z.string().trim().max(30).optional(),
      message: z.string().trim().max(5000).optional(),
      website: z.string().max(200).optional(),
      items: z.array(z.strictObject({ code: z.string().trim().min(1).max(60), qty: z.number().int().positive().max(100000) })).max(50).optional(),
    }).parse(req.body ?? {});
    const thanks = { message: 'Thank you. We will be in touch.' };
    if (body.website) return ok(res, thanks, 201);
    const codes = (body.items ?? []).map((row) => row.code.toUpperCase());
    const items = await Item.find({ code: { $in: codes }, showOnWebsite: true, isActive: true }, { code: 1, name: 1 }).lean();
    if (items.length !== new Set(codes).size) throw badRequest('One of those items is not available.');
    const lines = (body.items ?? []).map((row) => `${row.qty} x ${items.find((i) => i.code === row.code.toUpperCase()).name} (${row.code.toUpperCase()})`);
    const requirement = [body.message, lines.length ? `Items asked about:\n${lines.join('\n')}` : ''].filter(Boolean).join('\n\n');
    await withTxn((session) => createDoc(session, 'Lead', { leadName: body.name, companyName: body.company ?? '', email: body.email, mobile: body.phone ?? '', requirement }, WEB_FORM_ACTOR));
    return ok(res, thanks, 201);
  });

  // Words for a language. Public, as the sign-in page needs them too.
  r.get('/translations/:language', async (req, res) => {
    const language = String(req.params.language);
    if (!GLOSSARY[language]) throw notFound('Language');
    const rows = await modelOf('Translation').find({ language }, { sourceText: 1, translatedText: 1 }).lean();
    ok(res, { ...GLOSSARY[language], ...Object.fromEntries(rows.map((row) => [row.sourceText, row.translatedText])) });
  });

  // Razorpay signs the exact bytes it sends. Nothing is believed until that signature checks.
  r.post('/webhooks/razorpay', async (req, res) => {
    if (!razorpaySignatureOk(req.rawBody, req.get('x-razorpay-signature'), process.env.RAZORPAY_WEBHOOK_SECRET)) {
      throw new AppError(401, 'BAD_SIGNATURE', 'That signature does not check.');
    }
    const result = await withTxn((session) => recordLinkPaid(session, req.body));
    ok(res, result);
  });

  r.get('/forms/:slug', async (req, res) => {
    const form = await publishedForm(req.params.slug);
    const type = getType(form.doctypeName);
    const fields = new Map(type.fields.map((f) => [f.key, f]));
    ok(res, {
      title: form.title,
      intro: form.intro,
      fields: form.formFields.filter((row) => fields.has(row.fieldKey)).map((row) => {
        const field = fields.get(row.fieldKey);
        return { key: row.fieldKey, label: row.label || field.label, type: field.type, required: row.isRequired || field.required, options: field.options ?? null };
      }),
    });
  });
  r.post('/forms/:slug', formLimiter, async (req, res) => {
    const form = await publishedForm(req.params.slug);
    const body = z.record(z.string().max(60), z.union([z.string().max(5000), z.number()])).parse(req.body ?? {});
    // A field no person can see. Only a bot fills it, so it is thanked and ignored.
    if (body.website) return ok(res, { message: form.successMessage || 'Thank you. We will be in touch.' }, 201);
    const type = getType(form.doctypeName);
    const fields = new Map(type.fields.map((f) => [f.key, f]));
    const input = {};
    for (const row of form.formFields) {
      const value = body[row.fieldKey];
      if ((value === undefined || value === '') && (row.isRequired || fields.get(row.fieldKey)?.required)) throw badRequest(`${row.label || fields.get(row.fieldKey)?.label} is required.`);
      if (value !== undefined && value !== '') input[row.fieldKey] = value;
    }
    await withTxn((session) => createDoc(session, form.doctypeName, input, WEB_FORM_ACTOR));
    return ok(res, { message: form.successMessage || 'Thank you. We will be in touch.' }, 201);
  });
  return r;
}

/* ---------- Portal ---------- */

const invoiceView = (i) => ({ id: String(i._id), docNo: i.docNo, postingDate: i.postingDate, dueDate: i.dueDate, currency: i.currency ?? 'INR', status: i.status, taxablePaise: i.taxablePaise, cgstPaise: i.cgstPaise, sgstPaise: i.sgstPaise, igstPaise: i.igstPaise, totalPaise: i.totalPaise, paidPaise: i.paidPaise, creditedPaise: i.creditedPaise, outstandingPaise: i.totalPaise - (i.paidPaise ?? 0) - (i.creditedPaise ?? 0) });
const orderView = (o) => ({ id: String(o._id), docNo: o.docNo, postingDate: o.postingDate, status: o.status, deliveryDate: o.deliveryDate ?? null, validUntil: o.validUntil ?? null, currency: o.currency ?? 'INR', amountMinor: o.subtotalMinor ?? o.totalPaise ?? 0, lines: (o.lines ?? []).map((l) => ({ itemName: l.itemName, description: l.description, qtyMilli: l.qtyMilli, rateMinor: l.rateMinor ?? l.ratePaise, amountMinor: l.amountMinor ?? l.amountPaise })) });

export function portalRoutes() {
  const r = Router();
  r.use(authenticate);
  r.use(async (req, _res, next) => {
    if (req.user.role !== 'PORTAL') throw forbidden();
    const user = await User.findById(req.user.id, { partyId: 1 }).lean();
    if (!user?.partyId) throw new AppError(422, 'NO_PARTY', 'This sign-in is not linked to a customer or supplier yet.');
    const party = await Party.findById(user.partyId).lean();
    if (!party) throw new AppError(422, 'NO_PARTY', 'This sign-in is not linked to a customer or supplier yet.');
    req.party = party;
    next();
  });

  const sold = (req) => ({ partyId: req.party._id, status: { $in: ['SUBMITTED'] } });

  r.get('/me', async (req, res) => {
    const invoices = req.party.isCustomer ? await SalesInvoice.find(sold(req)).lean() : [];
    const bills = req.party.isSupplier ? await PurchaseInvoice.find(sold(req)).lean() : [];
    const open = (rows) => rows.reduce((sum, i) => sum + i.totalPaise - (i.paidPaise ?? 0) - (i.creditedPaise ?? 0), 0);
    ok(res, { name: req.party.name, code: req.party.code, isCustomer: req.party.isCustomer, isSupplier: req.party.isSupplier, youOwePaise: open(invoices), weOwePaise: open(bills) });
  });
  r.get('/invoices', async (req, res) => ok(res, (await SalesInvoice.find(sold(req)).sort({ postingDate: -1 }).limit(500).lean()).map(invoiceView)));
  r.get('/bills', async (req, res) => ok(res, (await PurchaseInvoice.find(sold(req)).sort({ postingDate: -1 }).limit(500).lean()).map(invoiceView)));
  r.get('/quotations', async (req, res) => ok(res, (await Quotation.find({ partyId: req.party._id, status: { $in: ['SENT', 'WON', 'LOST'] } }).sort({ postingDate: -1 }).limit(200).lean()).map(orderView)));
  r.get('/orders', async (req, res) => ok(res, (await SalesOrder.find({ partyId: req.party._id, status: { $in: ['CONFIRMED', 'CLOSED'] } }).sort({ postingDate: -1 }).limit(200).lean()).map(orderView)));
  r.get('/purchase-orders', async (req, res) => ok(res, (await PurchaseOrder.find({ partyId: req.party._id, status: { $in: ['APPROVED', 'CLOSED'] } }).sort({ postingDate: -1 }).limit(200).lean()).map(orderView)));
  r.get('/machines', async (req, res) => ok(res, (await MachineBuild.find({ partyId: req.party._id, stage: { $ne: 'CANCELLED' } }, { serialNo: 1, itemName: 1, stage: 1, targetDate: 1 }).sort({ createdAt: -1 }).lean()).map((b) => ({ id: String(b._id), serialNo: b.serialNo, itemName: b.itemName, stage: b.stage, targetDate: b.targetDate }))));
  r.get('/payments', async (req, res) => ok(res, (await Payment.find({ partyId: req.party._id, status: 'SUBMITTED' }).sort({ postingDate: -1 }).limit(200).lean()).map((p) => ({ id: String(p._id), docNo: p.docNo, kind: p.kind, postingDate: p.postingDate, amountPaise: p.amountPaise, reference: p.reference }))));
  r.get('/statement', async (req, res) => {
    const rows = await GlEntry.find({ partyId: req.party._id, accountCode: { $in: [A.DEBTORS, A.CREDITORS] } }).sort({ postingDate: 1, _id: 1 }).limit(2000).lean();
    let balance = 0;
    ok(res, rows.map((row) => {
      balance += row.debitPaise - row.creditPaise;
      return { id: String(row._id), postingDate: row.postingDate, voucherNo: row.voucherNo, debitPaise: row.debitPaise, creditPaise: row.creditPaise, balancePaise: balance };
    }));
  });
  r.get('/tickets', async (req, res) => ok(res, (await modelOf('Issue').find({ partyId: String(req.party._id) }).sort({ createdAt: -1 }).limit(200).lean()).map((t) => ({ id: String(t._id), subject: t.subject, status: t.status, description: t.description, resolution: t.resolution, createdAt: t.createdAt }))));
  r.post('/tickets', async (req, res) => {
    const body = z.strictObject({ subject: z.string().trim().min(1).max(300), description: z.string().trim().max(5000).optional() }).parse(req.body);
    const issue = await withTxn((session) => createDoc(session, 'Issue', { ...body, partyId: String(req.party._id) }, { id: req.user.id, name: req.user.name, role: 'ADMIN' }));
    ok(res, { id: String(issue._id), subject: issue.subject, status: issue.status }, 201);
  });
  return r;
}
