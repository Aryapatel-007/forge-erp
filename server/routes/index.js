import { Router } from 'express';
import mongoose from 'mongoose';
import { authenticate, loginLimiter, requireCsrfHeader, requireObjectId, requirePerm, validate } from '../middleware/index.js';
import { documentRouter, listQuery, masterRouter, ok, scopedList, scopeParam } from './helpers.js';
import { isLimited } from '../engine/access.js';
import * as S from '../validators/schemas.js';
import { AuditLog, RefreshToken, Settings, User } from '../models/core.js';
import { Account, Item, Party, Warehouse } from '../models/masters.js';
import { Bom, FatProtocol, Gauge, MachineBuild, Ncr, ServiceTicket } from '../models/documents.js';
import { withTxn } from '../utils/txn.js';
import { AppError, badRequest, notFound, rule } from '../utils/errors.js';
import { todayIst, fyRange } from '../utils/dates.js';
import { env, isProd } from '../config/env.js';
import { permissionsFor } from '../config/permissions.js';
import { audit } from '../services/auditService.js';
import { getSettings } from '../services/settingsService.js';
import * as auth from '../services/authService.js';
import * as sales from '../services/salesService.js';
import * as builds from '../services/buildService.js';
import * as purchase from '../services/purchaseService.js';
import * as stores from '../services/storesService.js';
import * as quality from '../services/qualityService.js';
import * as accounts from '../services/accountsService.js';
import * as service from '../services/serviceService.js';
import * as reports from '../services/reportService.js';
import { einvoiceJson, ewayBillJson } from '../services/einvoiceService.js';
import { quotePrice } from '../services/pricingService.js';
import { engineRouter } from '../engine/router.js';
import { portalRoutes, publicRoutes, viewRoutes } from './views.js';

const requireObjectId2 = (req, _res, next) => {
  if (!mongoose.isValidObjectId(req.params.id)) throw badRequest('That id is not valid.');
  next();
};

const COOKIE = 'forgeRefresh';
const cookieOptions = () => ({ httpOnly: true, secure: isProd, sameSite: 'lax', path: '/api/v1/auth', maxAge: env.REFRESH_TOKEN_DAYS * 86400000 });
const publicUser = (u) => ({ id: String(u._id), name: u.name, email: u.email, role: u.role, permissions: permissionsFor(u.role) });

function authRoutes() {
  const r = Router();
  r.post('/login', loginLimiter, validate(S.loginSchema), async (req, res) => {
    const { user, accessToken, refreshToken } = await auth.login(req.body);
    res.cookie(COOKIE, refreshToken, cookieOptions());
    ok(res, { accessToken, user: publicUser(user) });
  });
  r.post('/refresh', requireCsrfHeader, async (req, res) => {
    const { user, accessToken, refreshToken } = await auth.refresh(req.cookies?.[COOKIE]);
    res.cookie(COOKIE, refreshToken, cookieOptions());
    ok(res, { accessToken, user: publicUser(user) });
  });
  r.post('/logout', requireCsrfHeader, async (req, res) => {
    await auth.logout(req.cookies?.[COOKIE]);
    res.clearCookie(COOKIE, { path: '/api/v1/auth' });
    ok(res, { signedOut: true });
  });
  r.get('/me', authenticate, async (req, res) => ok(res, publicUser({ ...req.user, _id: req.user.id })));
  r.post('/change-password', authenticate, validate(S.changePasswordSchema), async (req, res) => {
    await auth.changePassword(req.user.id, req.body);
    res.clearCookie(COOKIE, { path: '/api/v1/auth' });
    ok(res, { changed: true });
  });
  return r;
}

function adminRoutes() {
  const r = Router();
  r.use(authenticate);
  r.param('id', requireObjectId);

  r.get('/users', requirePerm('users.manage'), async (_req, res) => ok(res, await User.find().sort({ name: 1 })));
  r.post('/users', requirePerm('users.manage'), validate(S.userCreateSchema), async (req, res) => {
    const { password, ...rest } = req.body;
    const passwordHash = await auth.hashPassword(password);
    const user = await withTxn(async (session) => {
      const [created] = await User.create([{ ...rest, passwordHash }], { session });
      await audit(session, { actor: req.user, action: 'USER_CREATED', entityType: 'User', entityId: created._id, data: { role: created.role } });
      return created;
    });
    const { passwordHash: _hidden, ...safe } = user.toJSON();
    ok(res, safe, 201);
  });
  r.patch('/users/:id', requirePerm('users.manage'), validate(S.userUpdateSchema), async (req, res) => {
    const { password, ...rest } = req.body;
    const passwordHash = password ? await auth.hashPassword(password) : null;
    const user = await withTxn(async (session) => {
      const found = await User.findById(req.params.id).session(session);
      if (!found) throw notFound('User');
      if (String(found._id) === String(req.user.id) && (rest.isActive === false || (rest.role && rest.role !== found.role))) {
        throw rule('You cannot change your own role or switch yourself off.', 'SELF_CHANGE');
      }
      if ((found.role === 'ADMIN' && rest.role && rest.role !== 'ADMIN') || (found.role === 'ADMIN' && rest.isActive === false)) {
        const others = await User.countDocuments({ role: 'ADMIN', isActive: true, _id: { $ne: found._id } }).session(session);
        if (others === 0) throw rule('This is the last admin.', 'LAST_ADMIN');
      }
      found.set(rest);
      if (passwordHash) {
        found.passwordHash = passwordHash;
        found.passwordChangedAt = new Date();
      }
      await found.save({ session });
      if (passwordHash || rest.isActive === false) {
        await RefreshToken.updateMany({ userId: found._id, revokedAt: null }, { revokedAt: new Date() }, { session });
      }
      await audit(session, { actor: req.user, action: 'USER_UPDATED', entityType: 'User', entityId: found._id, data: { ...rest, passwordReset: Boolean(passwordHash) } });
      return found;
    });
    const { passwordHash: _hidden, ...safe } = user.toJSON();
    ok(res, safe);
  });

  r.get('/settings', requirePerm('settings.read'), async (_req, res) => ok(res, await getSettings()));
  r.patch('/settings', requirePerm('settings.write'), validate(S.settingsSchema), async (req, res) => {
    const settings = await withTxn(async (session) => {
      const found = await Settings.findById('company').session(session);
      const before = {};
      for (const key of Object.keys(req.body)) before[key] = found.get(key);
      found.set(req.body);
      await found.save({ session });
      const locking = 'booksLockedUpTo' in req.body;
      await audit(session, { actor: req.user, action: locking ? 'BOOKS_LOCK_CHANGED' : 'SETTINGS_CHANGED', entityType: 'Settings', entityId: 'company', data: { before, after: req.body } });
      return found;
    });
    ok(res, settings);
  });

  r.get('/audit', requirePerm('audit.read'), async (req, res) => {
    const { filter, page, limit } = listQuery(req, { searchFields: ['action', 'entityNo', 'actorName'], filterFields: ['entityType', 'entityId', 'action'] });
    const [rows, total] = await Promise.all([
      AuditLog.find(filter).sort({ seq: -1 }).skip((page - 1) * limit).limit(limit),
      AuditLog.countDocuments(filter),
    ]);
    ok(res, rows, 200, { page, limit, total });
  });
  return r;
}

// Fixed reports add up everything, and cannot be narrowed to one person's records. FAT and
// tickets are not limited either yet. So someone limited is refused, rather than shown it all.
const limitedRefused = async (req, _res, next) => {
  if (await isLimited(req.user)) throw new AppError(403, 'NOT_FOR_LIMITED_USERS', 'Your access is limited to some records, and this covers everything.');
  next();
};

function bomRoutes() {
  const r = Router();
  r.use(authenticate);
  r.param('id', requireObjectId);
  r.param('id', scopeParam(Bom, 'BOM'));
  r.get('/', requirePerm('boms.read'), async (req, res) => {
    const { filter, page, limit } = await scopedList(req, Bom, listQuery(req, { searchFields: ['itemCode', 'itemName'], filterFields: ['status', 'itemId'] }));
    const [rows, total] = await Promise.all([
      Bom.find(filter).sort({ itemCode: 1, revision: -1 }).skip((page - 1) * limit).limit(limit),
      Bom.countDocuments(filter),
    ]);
    ok(res, rows, 200, { page, limit, total });
  });
  r.get('/:id', requirePerm('boms.read'), async (req, res) => {
    const row = await Bom.findById(req.params.id);
    if (!row) throw notFound('BOM');
    ok(res, row);
  });
  r.post('/', requirePerm('boms.write'), validate(S.bomSchema), async (req, res) => {
    ok(res, await withTxn((s) => builds.createBomRevision(s, req.body, req.user)), 201);
  });
  r.patch('/:id', requirePerm('boms.write'), validate(S.bomUpdateSchema), async (req, res) => {
    ok(res, await withTxn((s) => builds.updateBomDraft(s, req.params.id, req.body)));
  });
  r.post('/:id/release', requirePerm('boms.release'), async (req, res) => {
    ok(res, await withTxn((s) => builds.releaseBom(s, req.params.id, req.user)));
  });
  return r;
}

function buildRoutes() {
  const r = Router();
  r.use(authenticate);
  r.param('id', requireObjectId);
  r.param('id', scopeParam(MachineBuild, 'Build'));
  r.get('/', requirePerm('builds.read'), async (req, res) => {
    const { filter, page, limit } = await scopedList(req, MachineBuild, listQuery(req, { searchFields: ['serialNo', 'itemName', 'partyName', 'salesOrderNo'], filterFields: ['stage', 'partyId', 'salesOrderId', 'itemId'] }));
    const [rows, total] = await Promise.all([
      MachineBuild.find(filter).sort({ createdAt: -1 }).skip((page - 1) * limit).limit(limit),
      MachineBuild.countDocuments(filter),
    ]);
    ok(res, rows, 200, { page, limit, total });
  });
  r.get('/:id', requirePerm('builds.read'), async (req, res) => {
    const row = await MachineBuild.findById(req.params.id);
    if (!row) throw notFound('Build');
    ok(res, row);
  });
  r.get('/:id/shortages', requirePerm('builds.read'), async (req, res) => ok(res, await builds.shortages(req.params.id)));
  r.get('/:id/cost-sheet', requirePerm('reports.finance'), async (req, res) => ok(res, await builds.costSheet(req.params.id)));
  r.post('/:id/stage', requirePerm('builds.write'), validate(S.stageSchema), async (req, res) => {
    ok(res, await withTxn((s) => builds.setStage(s, req.params.id, req.body, req.user)));
  });
  r.post('/:id/complete', requirePerm('builds.complete'), validate(S.completeSchema), async (req, res) => {
    ok(res, await withTxn((s) => builds.completeBuild(s, req.params.id, { postingDate: todayIst(), ...req.body }, req.user)));
  });
  r.post('/:id/install', requirePerm('builds.install'), validate(S.installSchema), async (req, res) => {
    ok(res, await withTxn((s) => builds.installBuild(s, req.params.id, req.body, req.user)));
  });
  r.post('/:id/fat', requirePerm('fat.write'), validate(S.fatStartSchema), async (req, res) => {
    ok(res, await withTxn((s) => quality.startFat(s, req.params.id, { postingDate: todayIst(), ...req.body }, req.user)), 201);
  });
  return r;
}

function fatRoutes() {
  const r = Router();
  r.use(authenticate);
  r.param('id', requireObjectId);
  r.use(limitedRefused);
  r.get('/', requirePerm('fat.read'), async (req, res) => {
    const { filter, page, limit } = listQuery(req, { searchFields: ['docNo', 'serialNo'], filterFields: ['status', 'buildId'] });
    const [rows, total] = await Promise.all([
      FatProtocol.find(filter).sort({ createdAt: -1 }).skip((page - 1) * limit).limit(limit),
      FatProtocol.countDocuments(filter),
    ]);
    ok(res, rows, 200, { page, limit, total });
  });
  r.get('/:id', requirePerm('fat.read'), async (req, res) => {
    const row = await FatProtocol.findById(req.params.id);
    if (!row) throw notFound('FAT protocol');
    ok(res, row);
  });
  r.patch('/:id', requirePerm('fat.write'), validate(S.fatSaveSchema), async (req, res) => {
    ok(res, await withTxn((s) => quality.saveFatResults(s, req.params.id, req.body)));
  });
  r.post('/:id/close', requirePerm('fat.write'), async (req, res) => {
    ok(res, await withTxn((s) => quality.closeFat(s, req.params.id, req.user)));
  });
  return r;
}

function ncrRoutes() {
  const r = Router();
  r.use(authenticate);
  r.param('id', requireObjectId);
  r.param('id', scopeParam(Ncr, 'NCR'));
  r.get('/', requirePerm('ncrs.read'), async (req, res) => {
    const { filter, page, limit } = await scopedList(req, Ncr, listQuery(req, { searchFields: ['docNo', 'serialNo', 'itemName', 'description'], filterFields: ['status', 'buildId', 'source'] }));
    const [rows, total] = await Promise.all([
      Ncr.find(filter).sort({ createdAt: -1 }).skip((page - 1) * limit).limit(limit),
      Ncr.countDocuments(filter),
    ]);
    ok(res, rows, 200, { page, limit, total });
  });
  r.get('/:id', requirePerm('ncrs.read'), async (req, res) => {
    const row = await Ncr.findById(req.params.id);
    if (!row) throw notFound('NCR');
    ok(res, row);
  });
  r.post('/', requirePerm('ncrs.write'), validate(S.ncrSchema), async (req, res) => {
    ok(res, await withTxn((s) => quality.raiseNcr(s, { postingDate: todayIst(), ...req.body }, req.user)), 201);
  });
  r.post('/:id/close', requirePerm('ncrs.close'), validate(S.ncrCloseSchema), async (req, res) => {
    ok(res, await withTxn((s) => quality.closeNcr(s, req.params.id, req.body, req.user)));
  });
  return r;
}

function ticketRoutes() {
  const r = Router();
  r.use(authenticate);
  r.param('id', requireObjectId);
  r.use(limitedRefused);
  r.get('/', requirePerm('service.read'), async (req, res) => {
    const { filter, page, limit } = listQuery(req, { searchFields: ['docNo', 'serialNo', 'partyName', 'complaint'], filterFields: ['status', 'buildId', 'priority'] });
    const [rows, total] = await Promise.all([
      ServiceTicket.find(filter).sort({ createdAt: -1 }).skip((page - 1) * limit).limit(limit),
      ServiceTicket.countDocuments(filter),
    ]);
    ok(res, rows, 200, { page, limit, total });
  });
  r.get('/:id', requirePerm('service.read'), async (req, res) => {
    const row = await ServiceTicket.findById(req.params.id);
    if (!row) throw notFound('Ticket');
    ok(res, row);
  });
  r.post('/', requirePerm('service.write'), validate(S.ticketSchema), async (req, res) => {
    ok(res, await withTxn((s) => service.raiseTicket(s, { postingDate: todayIst(), ...req.body }, req.user)), 201);
  });
  r.patch('/:id', requirePerm('service.write'), validate(S.ticketUpdateSchema), async (req, res) => {
    ok(res, await withTxn((s) => service.updateTicket(s, req.params.id, { resolvedOn: todayIst(), ...req.body }, req.user)));
  });
  return r;
}

function reportRoutes() {
  const r = Router();
  r.use(authenticate);
  r.use(limitedRefused);
  const str = (value) => (typeof value === 'string' && value ? value : undefined);
  const range = (req) => {
    const fy = fyRange(todayIst());
    return { from: str(req.query.from) ?? fy.from, to: str(req.query.to) ?? todayIst() };
  };
  const finance = requirePerm('reports.finance');
  const ops = requirePerm('reports.operations');
  r.get('/dashboard', ops, async (_req, res) => ok(res, await reports.dashboard()));
  r.get('/trial-balance', finance, async (req, res) => ok(res, await reports.trialBalance(range(req))));
  r.get('/profit-and-loss', finance, async (req, res) => ok(res, await reports.profitAndLoss(range(req))));
  r.get('/balance-sheet', finance, async (req, res) => ok(res, await reports.balanceSheet({ asOf: str(req.query.asOf) ?? todayIst() })));
  r.get('/ledger', finance, async (req, res) => ok(res, await reports.accountLedger({ code: str(req.query.code), partyId: str(req.query.partyId), from: str(req.query.from), to: str(req.query.to) })));
  r.get('/ageing', finance, async (req, res) => ok(res, await reports.ageing({ kind: req.query.kind === 'PAYABLE' ? 'PAYABLE' : 'RECEIVABLE', asOf: str(req.query.asOf) })));
  r.get('/gstr1', finance, async (req, res) => ok(res, await reports.gstr1(range(req))));
  r.get('/gstr3b', finance, async (req, res) => ok(res, await reports.gstr3b(range(req))));
  r.get('/integrity', finance, async (_req, res) => ok(res, await reports.integrity()));
  r.get('/stock-balance', ops, async (req, res) => ok(res, await reports.stockBalance({ warehouseId: str(req.query.warehouseId), itemId: str(req.query.itemId), buildId: str(req.query.buildId) })));
  r.get('/stock-ledger', ops, async (req, res) => ok(res, await reports.stockLedger({ itemId: str(req.query.itemId), from: str(req.query.from), to: str(req.query.to) })));
  r.get('/trace-lot', ops, async (req, res) => ok(res, await reports.traceLot({ lot: str(req.query.lot) ?? '' })));
  r.get('/job-work', ops, async (_req, res) => ok(res, await reports.jobWorkReport()));
  return r;
}

export function apiRouter() {
  const api = Router();
  api.get('/health', (_req, res) => ok(res, { status: 'ok' }));
  api.use('/auth', authRoutes());
  api.use('/admin', adminRoutes());

  api.use('/items', masterRouter({ Model: Item, label: 'Item', read: 'items.read', write: 'items.write', createSchema: S.itemSchema, updateSchema: S.itemUpdateSchema, searchFields: ['code', 'name', 'drawingNo'], filterFields: ['type', 'isActive'] }));
  api.use('/parties', masterRouter({ Model: Party, label: 'Party', read: 'parties.read', write: 'parties.write', createSchema: S.partySchema, updateSchema: S.partyUpdateSchema, searchFields: ['code', 'name', 'gstin'], filterFields: ['isCustomer', 'isSupplier', 'isJobWorker', 'isActive'] }));
  api.use('/warehouses', masterRouter({ Model: Warehouse, label: 'Warehouse', read: 'warehouses.read', write: 'warehouses.write', createSchema: S.warehouseSchema, updateSchema: S.warehouseUpdateSchema, searchFields: ['code', 'name'], filterFields: ['kind', 'isActive'] }));
  api.use('/accounts', masterRouter({ Model: Account, label: 'Account', read: 'accounts.read', write: 'accounts.write', createSchema: S.accountSchema, updateSchema: S.accountUpdateSchema, searchFields: ['code', 'name'], filterFields: ['type', 'isCashOrBank', 'isActive'] }));
  api.use('/gauges', masterRouter({ Model: Gauge, label: 'Gauge', read: 'gauges.read', write: 'gauges.write', createSchema: S.gaugeSchema, updateSchema: S.gaugeUpdateSchema, searchFields: ['code', 'name'], filterFields: ['isActive'] }));

  api.use('/boms', bomRoutes());
  api.use('/builds', buildRoutes());
  api.use('/fat', fatRoutes());
  api.use('/ncrs', ncrRoutes());
  api.use('/tickets', ticketRoutes());
  api.use('/reports', reportRoutes());

  api.use('/quotations', documentRouter({
    service: sales.quotation, label: 'Quotation', read: 'quotations.read', write: 'quotations.write', createSchema: S.quotationSchema,
    filterFields: ['status', 'partyId'],
    extend(r) {
      r.post('/:id/revise', requirePerm('quotations.write'), async (req, res) => ok(res, await withTxn((s) => sales.reviseQuotation(s, req.params.id, req.user)), 201));
      r.post('/:id/lost', requirePerm('quotations.write'), validate(S.reasonSchema), async (req, res) => ok(res, await withTxn((s) => sales.markQuotationLost(s, req.params.id, req.body.reason, req.user))));
      r.post('/:id/to-order', requirePerm('salesOrders.write'), async (req, res) => ok(res, await withTxn((s) => sales.quotationToOrder(s, req.params.id, req.user)), 201));
    },
  }));
  api.use('/sales-orders', documentRouter({ service: sales.salesOrder, label: 'Sales order', read: 'salesOrders.read', write: 'salesOrders.write', createSchema: S.salesOrderSchema, filterFields: ['status', 'partyId'] }));
  api.use('/material-issues', documentRouter({ service: builds.materialIssue, label: 'Material issue', read: 'builds.read', write: 'issues.write', createSchema: S.materialIssueSchema, searchFields: ['docNo', 'serialNo'], filterFields: ['status', 'buildId', 'direction'] }));
  api.use('/time-bookings', documentRouter({ service: builds.timeBooking, label: 'Time booking', read: 'time.read', write: 'time.write', createSchema: S.timeBookingSchema, searchFields: ['docNo', 'serialNo', 'employeeName', 'operation'], filterFields: ['status', 'buildId'] }));
  api.use('/purchase-orders', documentRouter({
    service: purchase.purchaseOrder, label: 'Purchase order', read: 'purchaseOrders.read', write: 'purchaseOrders.write', createSchema: S.purchaseOrderSchema,
    filterFields: ['status', 'partyId'],
    extend(r) {
      r.post('/:id/approve', requirePerm('purchaseOrders.approve'), async (req, res) => ok(res, await withTxn((s) => purchase.approvePurchaseOrder(s, req.params.id, req.user))));
    },
  }));
  api.use('/grns', documentRouter({ service: purchase.grn, label: 'Goods receipt', read: 'grns.read', write: 'grns.write', createSchema: S.grnSchema, searchFields: ['docNo', 'partyName', 'purchaseOrderNo', 'supplierChallanNo'], filterFields: ['status', 'partyId', 'purchaseOrderId'] }));
  api.use('/inspections', documentRouter({ service: purchase.inspection, label: 'Inspection', read: 'inspections.read', write: 'inspections.write', createSchema: S.inspectionSchema, searchFields: ['docNo', 'grnNo', 'partyName'], filterFields: ['status', 'grnId'] }));
  api.use('/purchase-invoices', documentRouter({ service: purchase.purchaseInvoice, label: 'Purchase invoice', read: 'purchaseInvoices.read', write: 'purchaseInvoices.write', createSchema: S.purchaseInvoiceSchema, searchFields: ['docNo', 'partyName', 'supplierInvoiceNo'], filterFields: ['status', 'partyId'] }));
  api.use('/stock-moves', documentRouter({ service: stores.stockMoveDoc, label: 'Stock move', read: 'stock.read', write: 'stock.write', createSchema: S.stockMoveSchema, searchFields: ['docNo', 'reason'], filterFields: ['status', 'kind'] }));
  api.use('/job-work', documentRouter({
    service: stores.jobWorkChallan, label: 'Job work challan', read: 'jobWork.read', write: 'jobWork.write', createSchema: S.jobWorkSchema,
    searchFields: ['docNo', 'partyName', 'process', 'serialNo'], filterFields: ['status', 'partyId', 'buildId'],
    extend(r) {
      r.post('/:id/receive', requirePerm('jobWork.write'), validate(S.jobWorkReceiveSchema), async (req, res) => ok(res, await withTxn((s) => stores.receiveJobWork(s, req.params.id, { postingDate: todayIst(), ...req.body }, req.user))));
    },
  }));
  api.use('/sales-invoices', documentRouter({
    service: accounts.salesInvoice, label: 'Sales invoice', read: 'salesInvoices.read', write: 'salesInvoices.write', createSchema: S.salesInvoiceSchema, submitSchema: S.invoiceSubmitSchema, filterFields: ['status', 'partyId', 'salesOrderId'],
    extend(r) {
      r.post('/:id/irn', requirePerm('salesInvoices.write'), validate(S.irnSchema), async (req, res) => ok(res, await withTxn((s) => accounts.recordIrn(s, req.params.id, req.body, req.user))));
      r.post('/:id/irn-cancelled', requirePerm('salesInvoices.write'), validate(S.reasonSchema), async (req, res) => ok(res, await withTxn((s) => accounts.recordIrnCancelled(s, req.params.id, req.body.reason, req.user))));
    },
  }));
  api.use('/notes', documentRouter({ service: accounts.adjustmentNote, label: 'Note', read: 'payments.read', write: 'payments.write', createSchema: S.noteSchema, searchFields: ['docNo', 'partyName', 'invoiceNo'], filterFields: ['status', 'kind', 'partyId'] }));
  api.use('/payments', documentRouter({
    service: accounts.payment, label: 'Payment', read: 'payments.read', write: 'payments.write', createSchema: S.paymentSchema,
    searchFields: ['docNo', 'partyName', 'reference'], filterFields: ['status', 'kind', 'partyId'],
    extend(r) {
      r.post('/:id/allocate', requirePerm('payments.write'), validate(S.allocateSchema), async (req, res) => ok(res, await withTxn((s) => accounts.allocatePayment(s, req.params.id, { postingDate: todayIst(), ...req.body }, req.user))));
      r.post('/:id/unallocate', requirePerm('payments.write'), validate(S.unallocateSchema), async (req, res) => ok(res, await withTxn((s) => accounts.unallocatePayment(s, req.params.id, { postingDate: todayIst(), ...req.body }, req.user))));
    },
  }));
  api.use('/journals', documentRouter({ service: accounts.journal, label: 'Journal', read: 'journals.read', write: 'journals.write', createSchema: S.journalSchema, searchFields: ['docNo', 'narration'], filterFields: ['status'] }));
  api.use('/amc', documentRouter({ service: service.amcContract, label: 'AMC contract', read: 'service.read', write: 'service.write', createSchema: S.amcSchema, searchFields: ['docNo', 'partyName', 'serialNo'], filterFields: ['status', 'buildId'] }));

  api.get('/sales-invoices/:id/einvoice.json', authenticate, requireObjectId2, requirePerm('salesInvoices.read'), async (req, res) => ok(res, await einvoiceJson(req.params.id)));
  api.get('/sales-invoices/:id/eway-bill.json', authenticate, requireObjectId2, requirePerm('salesInvoices.read'), async (req, res) => ok(res, await ewayBillJson(req.params.id)));
  api.get('/pricing/quote', authenticate, async (req, res) => {
    if (typeof req.query.itemId !== 'string' || !mongoose.isValidObjectId(req.query.itemId)) throw badRequest('Choose an item.');
    const partyId = typeof req.query.partyId === 'string' && mongoose.isValidObjectId(req.query.partyId) ? req.query.partyId : null;
    const qtyMilli = Number.parseInt(req.query.qtyMilli, 10);
    ok(res, await quotePrice({ itemId: req.query.itemId, partyId, qtyMilli: Number.isSafeInteger(qtyMilli) && qtyMilli > 0 ? qtyMilli : 1000, forBuying: req.query.forBuying === 'true' }));
  });

  api.use('/public', publicRoutes());
  api.use('/portal', portalRoutes());
  api.use('/views', viewRoutes());
  api.use(engineRouter());
  api.use((_req, res) => res.status(404).json({ success: false, error: { code: 'NOT_FOUND', message: 'That address does not exist.' } }));
  return api;
}
