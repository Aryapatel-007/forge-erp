// Fixed assets: buying, depreciating, moving, repairing and selling them.
import { define, modelOf } from '../engine/registry.js';
import { A } from '../config/accounts.js';
import { postGl } from '../services/ledgerService.js';
import { allocate, applyBps } from '../utils/money.js';
import { addMonths, todayIst } from '../utils/dates.js';
import { rule } from '../utils/errors.js';
import { nextDocNo } from '../services/numberService.js';

const m = (name, fields, extra = {}) => define({ name, module: 'assets', fields, ...extra });

m('AssetCategory', 'name!* method:select(STRAIGHT_LINE,WRITTEN_DOWN)=STRAIGHT_LINE lifeMonths:int=60 wdvRateBps:pct', { list: 'name method lifeMonths wdvRateBps', readers: 'all' });
m('AssetMaintenanceTeam', 'name!* managerId:link(User)', { tables: { members: 'employeeId:link(Employee) role' } });

// A depreciation plan, in whole paise, that always ends exactly at the salvage value.
export function depreciationPlan({ grossPaise, salvagePaise, method, lifeMonths, wdvRateBps, startOn }) {
  const depreciable = grossPaise - salvagePaise;
  if (depreciable <= 0) return [];
  if (method === 'STRAIGHT_LINE') {
    return allocate(depreciable, Array(lifeMonths).fill(1)).map((amountPaise, i) => ({ onDate: addMonths(startOn, i + 1), amountPaise }));
  }
  if (!wdvRateBps) throw rule('A written-down-value asset needs a rate.', 'WDV_RATE_REQUIRED');
  const rows = [];
  let book = grossPaise;
  // Yearly rate, charged monthly on the book value at the start of each year.
  for (let year = 0; year * 12 < lifeMonths; year += 1) {
    const yearly = Math.min(applyBps(book, wdvRateBps), book - salvagePaise);
    const months = Math.min(12, lifeMonths - year * 12);
    const shares = allocate(yearly, Array(months).fill(1));
    shares.forEach((amountPaise, i) => rows.push({ onDate: addMonths(startOn, year * 12 + i + 1), amountPaise }));
    book -= yearly;
  }
  rows[rows.length - 1].amountPaise += book - salvagePaise;
  return rows.filter((row) => row.amountPaise > 0);
}

function accumulated(asset) {
  return asset.schedule.filter((r) => r.isPosted).reduce((sum, r) => sum + r.amountPaise, 0);
}

async function disposeLines(asset, proceedsPaise, bankAccountCode) {
  const accum = accumulated(asset);
  const book = asset.grossPaise + asset.adjustedPaise - accum;
  const gain = proceedsPaise - book;
  const lines = [
    { accountCode: A.ACCUM_DEPRECIATION, debitPaise: accum },
    { accountCode: A.FIXED_ASSETS, creditPaise: asset.grossPaise + asset.adjustedPaise },
  ];
  if (proceedsPaise > 0) lines.push({ accountCode: bankAccountCode, debitPaise: proceedsPaise });
  if (gain > 0) lines.push({ accountCode: A.ASSET_GAIN, creditPaise: gain });
  if (gain < 0) lines.push({ accountCode: A.ASSET_LOSS, debitPaise: -gain });
  return { lines, gain };
}

async function dispose(session, asset, state, proceedsPaise, bankAccountCode, onDate) {
  if (asset.state !== 'IN_USE') throw rule('This asset has already left the books.', 'ASSET_GONE');
  // Anything not yet depreciated stops here. Its rows stay unposted and are dropped.
  const { lines, gain } = await disposeLines(asset, proceedsPaise, bankAccountCode);
  const voucherNo = await nextDocNo(session, 'AD', onDate);
  await postGl(session, { postingDate: onDate, voucherType: 'AssetDisposal', voucherId: asset._id, voucherNo, narration: `${state} ${asset.docNo}`, lines });
  asset.schedule = asset.schedule.filter((r) => r.isPosted);
  asset.state = state;
  asset.disposedOn = onDate;
  asset.disposalGainPaise = gain;
  await asset.save({ session });
  return asset;
}

define({
  name: 'Asset',
  module: 'assets',
  series: 'AS',
  submittable: true,
  labelFields: ['docNo', 'assetName'],
  searchFields: ['docNo', 'assetName', 'tagNo'],
  fields: 'assetName! categoryId!:link(AssetCategory) tagNo itemId:link(Item) locationId:link(Location) custodianId:link(Employee) costCenterId:link(CostCenter) purchasedOn!:date grossPaise!:money salvagePaise:money depreciationStartOn!:date creditAccountCode:link(Account) state~:select(DRAFT,IN_USE,SOLD,SCRAPPED)=DRAFT adjustedPaise~:smoney disposedOn~:date disposalGainPaise~:smoney',
  tables: { 'schedule~': 'onDate:date amountPaise:money isPosted:check voucherNo' },
  list: 'docNo assetName categoryId grossPaise purchasedOn state',
  dateField: 'purchasedOn',
  submitLabel: 'Capitalise',
  hint: 'Puts the asset on the books and draws up its depreciation.',
  async onSubmit(session, doc) {
    const category = await modelOf('AssetCategory').findById(doc.categoryId).session(session).lean();
    if (doc.salvagePaise > doc.grossPaise) throw rule('Salvage value cannot exceed the cost.', 'BAD_SALVAGE');
    doc.schedule = depreciationPlan({ grossPaise: doc.grossPaise, salvagePaise: doc.salvagePaise, method: category.method, lifeMonths: category.lifeMonths, wdvRateBps: category.wdvRateBps, startOn: doc.depreciationStartOn });
    doc.state = 'IN_USE';
    await postGl(session, {
      postingDate: doc.postingDate, voucherType: 'Asset', voucherId: doc._id, voucherNo: doc.docNo, narration: `Capitalised ${doc.assetName}`,
      lines: [{ accountCode: A.FIXED_ASSETS, debitPaise: doc.grossPaise }, { accountCode: doc.creditAccountCode || A.ASSET_CLEARING, creditPaise: doc.grossPaise }],
    });
    return { action: 'ASSET_CAPITALISED', data: { grossPaise: doc.grossPaise, rows: doc.schedule.length } };
  },
  async onCancel(_session, doc) {
    if (doc.schedule.some((r) => r.isPosted)) throw rule('This asset has been depreciated, so it cannot be cancelled. Sell or scrap it instead.', 'ASSET_DEPRECIATED');
    if (doc.state !== 'IN_USE') throw rule('This asset has left the books.', 'ASSET_GONE');
    doc.state = 'DRAFT';
  },
  actions: [
    {
      key: 'sell',
      label: 'Sell',
      when: { state: ['IN_USE'] },
      fields: 'proceedsPaise!:money bankAccountCode!:link(Account;isCashOrBank=true)',
      async run(session, doc, body) {
        if (!Number.isSafeInteger(body.proceedsPaise) || body.proceedsPaise <= 0) throw rule('Enter the sale price.', 'PRICE_REQUIRED');
        return dispose(session, doc, 'SOLD', body.proceedsPaise, body.bankAccountCode, todayIst());
      },
    },
    {
      key: 'scrap',
      label: 'Scrap',
      when: { state: ['IN_USE'] },
      fields: '',
      run: (session, doc) => dispose(session, doc, 'SCRAPPED', 0, null, todayIst()),
    },
  ],
});

// One month's depreciation for every asset that is due. Each row posts once.
export async function postDueDepreciation(session, asOf) {
  const Asset = modelOf('Asset');
  const assets = await Asset.find({ status: 'SUBMITTED', state: 'IN_USE', schedule: { $elemMatch: { isPosted: false, onDate: { $lte: asOf } } } }).session(session);
  let posted = 0;
  for (const asset of assets) {
    for (const row of asset.schedule) {
      if (row.isPosted || row.onDate > asOf) continue;
      const voucherNo = await nextDocNo(session, 'DP', row.onDate);
      await postGl(session, {
        postingDate: row.onDate, voucherType: 'AssetDepreciation', voucherId: asset._id, voucherNo, narration: `Depreciation on ${asset.docNo}`,
        lines: [{ accountCode: A.DEPRECIATION, debitPaise: row.amountPaise, costCenterId: asset.costCenterId ?? null }, { accountCode: A.ACCUM_DEPRECIATION, creditPaise: row.amountPaise }],
      });
      row.isPosted = true;
      row.voucherNo = voucherNo;
      posted += 1;
    }
    await asset.save({ session });
  }
  return posted;
}

m('AssetMovement', 'assetId!:link(Asset) onDate!:date fromLocationId:link(Location) toLocationId:link(Location) toCustodianId:link(Employee) purpose', {
  series: 'AM',
  submittable: true,
  labelFields: ['docNo'],
  dateField: 'onDate',
  list: 'docNo assetId onDate fromLocationId toLocationId',
  async onSubmit(session, doc) {
    const asset = await modelOf('Asset').findById(doc.assetId).session(session);
    asset.locationId = doc.toLocationId ?? asset.locationId;
    asset.custodianId = doc.toCustodianId ?? asset.custodianId;
    await asset.save({ session });
  },
});
m('AssetRepair', 'assetId!:link(Asset) onDate!:date description!:long costPaise!:money creditAccountCode!:link(Account) capitalise:check', {
  series: 'AR',
  submittable: true,
  labelFields: ['docNo'],
  dateField: 'onDate',
  list: 'docNo assetId onDate costPaise capitalise',
  async onSubmit(session, doc) {
    const asset = await modelOf('Asset').findById(doc.assetId).session(session);
    if (doc.capitalise) {
      asset.adjustedPaise += doc.costPaise;
      await asset.save({ session });
    }
    await postGl(session, {
      postingDate: doc.postingDate, voucherType: 'AssetRepair', voucherId: doc._id, voucherNo: doc.docNo, narration: `Repair of ${asset.docNo}`,
      lines: [{ accountCode: doc.capitalise ? A.FIXED_ASSETS : A.ASSET_REPAIRS, debitPaise: doc.costPaise }, { accountCode: doc.creditAccountCode, creditPaise: doc.costPaise }],
    });
    return { action: 'ASSET_REPAIRED' };
  },
  async onCancel(session, doc) {
    if (!doc.capitalise) return;
    const asset = await modelOf('Asset').findById(doc.assetId).session(session);
    asset.adjustedPaise -= doc.costPaise;
    await asset.save({ session });
  },
});
m('AssetValueAdjustment', 'assetId!:link(Asset) onDate!:date differencePaise!:smoney reason!', {
  series: 'AV',
  submittable: true,
  labelFields: ['docNo'],
  dateField: 'onDate',
  list: 'docNo assetId onDate differencePaise reason',
  async onSubmit(session, doc) {
    const asset = await modelOf('Asset').findById(doc.assetId).session(session);
    if (asset.state !== 'IN_USE') throw rule('This asset has left the books.', 'ASSET_GONE');
    asset.adjustedPaise += doc.differencePaise;
    await asset.save({ session });
    const value = Math.abs(doc.differencePaise);
    await postGl(session, {
      postingDate: doc.postingDate, voucherType: 'AssetValueAdjustment', voucherId: doc._id, voucherNo: doc.docNo, narration: doc.reason,
      lines: doc.differencePaise > 0
        ? [{ accountCode: A.FIXED_ASSETS, debitPaise: value }, { accountCode: A.ASSET_GAIN, creditPaise: value }]
        : [{ accountCode: A.ASSET_LOSS, debitPaise: value }, { accountCode: A.FIXED_ASSETS, creditPaise: value }],
    });
    return { action: 'ASSET_REVALUED' };
  },
  async onCancel(session, doc) {
    const asset = await modelOf('Asset').findById(doc.assetId).session(session);
    asset.adjustedPaise -= doc.differencePaise;
    await asset.save({ session });
  },
});
m('AssetMaintenance', 'assetId!:link(Asset) teamId:link(AssetMaintenanceTeam) frequency:select(MONTHLY,QUARTERLY,HALF_YEARLY,YEARLY)=QUARTERLY nextDueOn:date', { tables: { tasks: 'task! assignedTo:link(Employee)' }, labelFields: ['assetId'], dateField: 'nextDueOn', list: 'assetId frequency nextDueOn' });
m('AssetMaintenanceLog', 'assetId!:link(Asset) onDate!:date task! doneBy:link(Employee) result:select(DONE,OVERDUE,CANCELLED)=DONE notes:long', { labelFields: ['task'], dateField: 'onDate', list: 'assetId task onDate doneBy result' });

