// Machine builds: BOM explosion, shortages, material, labour, finishing, installation.
import { Bin } from '../models/ledgers.js';
import { Bom, MachineBuild, MaterialIssue, Ncr, PurchaseOrder, TimeBooking } from '../models/documents.js';
import { Item, Warehouse } from '../models/masters.js';
import { A } from '../config/accounts.js';
import { applyBps, lineValue, mulDivRound, sumInts } from '../utils/money.js';
import { conflict, notFound, rule } from '../utils/errors.js';
import { addMonths } from '../utils/dates.js';
import { assertPostingDate, getSettings } from './settingsService.js';
import { nextDocNo } from './numberService.js';
import { audit } from './auditService.js';
import { postGl, reverseGl } from './ledgerService.js';
import { assertWarehouseKind, pickBuckets, reverseStock, stockIn, stockOut, warehouseOfKind } from './stockService.js';

/* ---------- BOM ---------- */

const BOM_MAX_DEPTH = 8;

// Flattens a BOM to leaf parts: an ASSEMBLY with its own released BOM is replaced by
// its children. Scrap allowance is added to the quantity. Duplicates merge.
export async function explodeBom(session, bom, parentQtyMilli, path = [], totals = new Map()) {
  if (path.length >= BOM_MAX_DEPTH) throw rule('This BOM is nested too deeply.', 'BOM_TOO_DEEP');
  const itemId = String(bom.itemId);
  if (path.includes(itemId)) throw rule(`BOM loop found at ${bom.itemCode}.`, 'BOM_LOOP');
  const nextPath = [...path, itemId];

  const childIds = bom.lines.map((l) => l.itemId);
  const childBoms = await Bom.find({ itemId: { $in: childIds }, status: 'RELEASED' }).session(session).lean();
  const items = await Item.find({ _id: { $in: childIds } }, { type: 1 }).session(session).lean();

  for (const line of bom.lines) {
    const withScrap = line.qtyMilli + applyBps(line.qtyMilli, line.scrapBps ?? 0);
    const required = mulDivRound(withScrap, parentQtyMilli, 1000);
    const item = items.find((i) => String(i._id) === String(line.itemId));
    const child = item?.type === 'ASSEMBLY' ? childBoms.find((b) => String(b.itemId) === String(line.itemId)) : null;
    if (child) {
      await explodeBom(session, child, required, nextPath, totals);
    } else {
      const key = String(line.itemId);
      const existing = totals.get(key);
      if (existing) existing.requiredMilli += required;
      else {
        totals.set(key, {
          itemId: line.itemId,
          itemCode: line.itemCode,
          itemName: line.itemName,
          uom: line.uom,
          hsn: line.hsn,
          requiredMilli: required,
        });
      }
    }
  }
  return [...totals.values()];
}

// Walks released BOMs from the lines being released. If any path leads back to the item
// itself it is a loop, whatever the item types, and whether or not that item is released.
async function assertNoBomLoop(session, rootItemId, lines, depth = 0) {
  if (depth >= BOM_MAX_DEPTH) throw rule('This BOM is nested too deeply.', 'BOM_TOO_DEEP');
  const childIds = lines.map((l) => l.itemId);
  if (childIds.some((id) => String(id) === String(rootItemId))) {
    throw rule('This BOM would contain itself.', 'BOM_LOOP');
  }
  const children = await Bom.find({ itemId: { $in: childIds }, status: 'RELEASED' }).session(session).lean();
  for (const child of children) await assertNoBomLoop(session, rootItemId, child.lines, depth + 1);
}

export async function freezeBomLines(session, lines) {
  const items = await Item.find({ _id: { $in: lines.map((l) => l.itemId) } }).session(session).lean();
  return lines.map((line) => {
    const item = items.find((i) => String(i._id) === String(line.itemId));
    if (!item) throw rule('A BOM line names an item that does not exist.', 'UNKNOWN_ITEM');
    return {
      itemId: item._id,
      itemCode: item.code,
      itemName: item.name,
      uom: item.uom,
      hsn: item.hsn,
      qtyMilli: line.qtyMilli,
      scrapBps: line.scrapBps ?? 0,
      drawingNo: line.drawingNo || item.drawingNo,
    };
  });
}

export async function createBomRevision(session, data, actor) {
  const item = await Item.findById(data.itemId).session(session).lean();
  if (!item) throw notFound('Item');
  if (!['MACHINE', 'ASSEMBLY'].includes(item.type)) throw rule('Only a machine or an assembly has a BOM.', 'NOT_BOM_ITEM');
  const latest = await Bom.findOne({ itemId: item._id }).sort({ revision: -1 }).session(session).lean();
  if (latest && !data.changeNote) throw rule('A new revision must say what changed.', 'CHANGE_NOTE_REQUIRED');
  const [bom] = await Bom.create([{
    ...data,
    itemCode: item.code,
    itemName: item.name,
    revision: latest ? latest.revision + 1 : 1,
    status: 'DRAFT',
    lines: await freezeBomLines(session, data.lines),
    createdBy: actor.id,
  }], { session });
  return bom;
}

export async function updateBomDraft(session, id, data) {
  const bom = await Bom.findById(id).session(session);
  if (!bom) throw notFound('BOM');
  if (bom.status !== 'DRAFT') throw rule('A released BOM cannot be edited. Start a new revision.', 'BOM_NOT_DRAFT');
  if (data.lines) bom.lines = await freezeBomLines(session, data.lines);
  for (const key of ['changeNote', 'labourHoursMilli', 'fatChecklist']) {
    if (data[key] !== undefined) bom[key] = data[key];
  }
  await bom.save({ session });
  return bom;
}

// One released revision per item, enforced by a unique index. Existing builds keep
// the revision they were snapshotted from.
export async function releaseBom(session, id, actor) {
  const bom = await Bom.findById(id).session(session);
  if (!bom) throw notFound('BOM');
  if (bom.status !== 'DRAFT') throw rule('Only a draft can be released.', 'BOM_NOT_DRAFT');
  if (bom.lines.length === 0) throw rule('A BOM with no lines cannot be released.', 'BOM_EMPTY');
  await assertNoBomLoop(session, bom.itemId, bom.lines);
  await Bom.updateMany({ itemId: bom.itemId, status: 'RELEASED' }, { status: 'OBSOLETE' }, { session });
  bom.status = 'RELEASED';
  bom.releasedBy = actor.id;
  bom.releasedAt = new Date();
  await bom.save({ session });
  await audit(session, { actor, action: 'BOM_RELEASED', entityType: 'Bom', entityId: bom._id, entityNo: `${bom.itemCode} rev ${bom.revision}`, reason: bom.changeNote });
  return bom;
}

/* ---------- Stage ---------- */

const MANUAL_STAGES = ['PLANNED', 'PROCUREMENT', 'FABRICATION', 'ASSEMBLY', 'FAT'];

export async function setStage(session, id, { stage, note }, actor) {
  const build = await MachineBuild.findById(id).session(session);
  if (!build) throw notFound('Build');
  if (!MANUAL_STAGES.includes(stage)) throw rule(`${stage} is set by its own step, not by hand.`, 'STAGE_NOT_MANUAL');
  if (!MANUAL_STAGES.includes(build.stage)) throw rule(`A build at ${build.stage} cannot change stage by hand.`, 'STAGE_LOCKED');
  build.stage = stage;
  build.stageHistory.push({ stage, at: new Date(), byName: actor.name, note: note ?? '' });
  await build.save({ session });
  await audit(session, { actor, action: 'BUILD_STAGE_CHANGED', entityType: 'MachineBuild', entityId: build._id, entityNo: build.serialNo, data: { stage }, reason: note });
  return build;
}

/* ---------- Shortages ---------- */

// For each part still owed to a build: what is set aside for it, what is free, what is
// already on order for it, and what is still short.
export async function shortages(buildId) {
  const build = await MachineBuild.findById(buildId).lean();
  if (!build) throw notFound('Build');
  const itemIds = build.materials.map((m) => m.itemId);
  const stores = await Warehouse.find({ kind: { $in: ['STORES', 'QUARANTINE', 'JOBWORK'] } }, { kind: 1 }).lean();
  const kindOf = new Map(stores.map((w) => [String(w._id), w.kind]));
  const bins = await Bin.find({ itemId: { $in: itemIds }, warehouseId: { $in: stores.map((w) => w._id) }, qtyMilli: { $gt: 0 } }).lean();
  const orders = await PurchaseOrder.find({ status: 'APPROVED', 'lines.buildId': build._id }, { lines: 1 }).lean();

  const rows = build.materials.map((material) => {
    const key = String(material.itemId);
    const relevant = bins.filter((b) => String(b.itemId) === key);
    const sum = (filter) => sumInts(relevant.filter(filter).map((b) => b.qtyMilli));
    const isStores = (b) => kindOf.get(String(b.warehouseId)) === 'STORES';
    const peggedMilli = sum((b) => isStores(b) && String(b.buildId) === String(build._id));
    const freeMilli = sum((b) => isStores(b) && b.buildId === null);
    const quarantineMilli = sum((b) => kindOf.get(String(b.warehouseId)) === 'QUARANTINE' && String(b.buildId) === String(build._id));
    const atJobWorkMilli = sum((b) => kindOf.get(String(b.warehouseId)) === 'JOBWORK' && String(b.buildId) === String(build._id));
    let onOrderMilli = 0;
    for (const order of orders) {
      for (const line of order.lines) {
        if (String(line.buildId) === String(build._id) && String(line.itemId) === key) {
          onOrderMilli += Math.max(0, line.qtyMilli - line.receivedMilli);
        }
      }
    }
    const stillNeededMilli = Math.max(0, material.requiredMilli - material.issuedMilli);
    const covered = peggedMilli + quarantineMilli + atJobWorkMilli + onOrderMilli;
    return {
      itemId: key,
      itemCode: material.itemCode,
      itemName: material.itemName,
      uom: material.uom,
      requiredMilli: material.requiredMilli,
      issuedMilli: material.issuedMilli,
      stillNeededMilli,
      peggedMilli,
      freeMilli,
      quarantineMilli,
      atJobWorkMilli,
      onOrderMilli,
      shortMilli: Math.max(0, stillNeededMilli - covered),
      toBuyMilli: Math.max(0, stillNeededMilli - covered - freeMilli),
    };
  });
  return {
    build: { id: String(build._id), serialNo: build.serialNo, itemName: build.itemName, stage: build.stage },
    rows,
    shortLines: rows.filter((r) => r.shortMilli > 0).length,
    readyToIssue: rows.every((r) => r.stillNeededMilli <= r.peggedMilli + r.freeMilli),
  };
}

/* ---------- Material issue ---------- */

const OPEN_FOR_COST = ['PLANNED', 'PROCUREMENT', 'FABRICATION', 'ASSEMBLY', 'FAT'];

function assertBuildOpen(build) {
  if (!OPEN_FOR_COST.includes(build.stage)) {
    throw rule(`Build ${build.serialNo} is at ${build.stage} and takes no more cost.`, 'BUILD_CLOSED_TO_COST');
  }
}

export const materialIssue = {
  Model: MaterialIssue,
  async prepare(session, data) {
    const build = await MachineBuild.findById(data.buildId).session(session).lean();
    if (!build) throw notFound('Build');
    const items = await Item.find({ _id: { $in: data.lines.map((l) => l.itemId) } }).session(session).lean();
    return {
      ...data,
      serialNo: build.serialNo,
      lines: data.lines.map((line) => {
        const item = items.find((i) => String(i._id) === String(line.itemId));
        if (!item) throw rule('A line names an item that does not exist.', 'UNKNOWN_ITEM');
        if (item.type === 'SERVICE') throw rule('A service cannot be issued from stores.', 'NOT_STOCK_ITEM');
        return { itemId: item._id, itemCode: item.code, itemName: item.name, uom: item.uom, hsn: item.hsn, qtyMilli: line.qtyMilli, warehouseId: line.warehouseId ?? null };
      }),
    };
  },
  async submit(session, doc, { actor }) {
    if (doc.status !== 'DRAFT') throw conflict('Only a draft can be submitted.');
    const build = await MachineBuild.findById(doc.buildId).session(session);
    if (!build) throw notFound('Build');
    assertBuildOpen(build);
    doc.docNo = await nextDocNo(session, doc.direction === 'ISSUE' ? 'MI' : 'MR', doc.postingDate);
    doc.status = 'SUBMITTED';
    const voucher = { voucherType: 'MaterialIssue', voucherId: doc._id, voucherNo: doc.docNo, postingDate: doc.postingDate };

    let total = 0;
    for (const line of doc.lines) {
      const material = build.materials.find((m) => String(m.itemId) === String(line.itemId));
      if (doc.direction === 'ISSUE') {
        // Extra parts beyond the BOM still cost the build, so they get a row of their own.
        let row = material;
        if (!row) {
          build.materials.push({ itemId: line.itemId, itemCode: line.itemCode, itemName: line.itemName, uom: line.uom, hsn: line.hsn, requiredMilli: 0 });
          row = build.materials[build.materials.length - 1];
        }
        const picks = await pickBuckets(session, { itemId: line.itemId, qtyMilli: line.qtyMilli, buildId: build._id });
        let lineValuePaise = 0;
        line.picks = [];
        for (const pick of picks) {
          const { valuePaise } = await stockOut(session, { voucher, ...pick });
          lineValuePaise += valuePaise;
          line.picks.push({ warehouseId: pick.warehouseId, lot: pick.lot, buildId: pick.buildId, qtyMilli: pick.qtyMilli, valuePaise });
        }
        line.valuePaise = lineValuePaise;
        row.issuedMilli += line.qtyMilli;
        row.issuedValuePaise += lineValuePaise;
        total += lineValuePaise;
      } else {
        if (!material || material.issuedMilli < line.qtyMilli) {
          throw rule(`${line.itemCode}: more is being returned than was issued to this build.`, 'RETURN_TOO_MUCH');
        }
        const warehouse = line.warehouseId
          ? await assertWarehouseKind(session, line.warehouseId, ['STORES'])
          : await warehouseOfKind(session, 'STORES');
        // Comes back at the build's own average issue cost, and stays set aside for it.
        const valuePaise = line.qtyMilli === material.issuedMilli
          ? material.issuedValuePaise
          : mulDivRound(material.issuedValuePaise, line.qtyMilli, material.issuedMilli);
        await stockIn(session, { voucher, itemId: line.itemId, warehouseId: warehouse._id, buildId: build._id, qtyMilli: line.qtyMilli, valuePaise });
        line.valuePaise = valuePaise;
        line.picks = [{ warehouseId: warehouse._id, lot: '', buildId: build._id, qtyMilli: line.qtyMilli, valuePaise }];
        material.issuedMilli -= line.qtyMilli;
        material.issuedValuePaise -= valuePaise;
        total += valuePaise;
      }
    }
    doc.totalValuePaise = total;
    const sign = doc.direction === 'ISSUE' ? 1 : -1;
    build.materialCostPaise += sign * total;
    build.wipPaise += sign * total;
    await build.save({ session });
    await postGl(session, {
      postingDate: doc.postingDate,
      voucherType: 'MaterialIssue',
      voucherId: doc._id,
      voucherNo: doc.docNo,
      narration: `${doc.direction === 'ISSUE' ? 'Issue to' : 'Return from'} ${build.serialNo}`,
      lines: doc.direction === 'ISSUE'
        ? [{ accountCode: A.WIP, debitPaise: total, buildId: build._id }, { accountCode: A.INVENTORY, creditPaise: total }]
        : [{ accountCode: A.INVENTORY, debitPaise: total }, { accountCode: A.WIP, creditPaise: total, buildId: build._id }],
    });
    return { action: doc.direction === 'ISSUE' ? 'MATERIAL_ISSUED' : 'MATERIAL_RETURNED', actor, data: { serialNo: build.serialNo, valuePaise: total } };
  },
  async cancel(session, doc, { postingDate }) {
    const build = await MachineBuild.findById(doc.buildId).session(session);
    assertBuildOpen(build);
    await reverseStock(session, { voucherType: 'MaterialIssue', voucherId: doc._id, voucherNo: doc.docNo, postingDate });
    await reverseGl(session, { postingDate, voucherType: 'MaterialIssue', voucherId: doc._id, voucherNo: doc.docNo });
    const sign = doc.direction === 'ISSUE' ? -1 : 1;
    for (const line of doc.lines) {
      const material = build.materials.find((m) => String(m.itemId) === String(line.itemId));
      material.issuedMilli += sign * line.qtyMilli;
      material.issuedValuePaise += sign * line.valuePaise;
    }
    build.materialCostPaise += sign * doc.totalValuePaise;
    build.wipPaise += sign * doc.totalValuePaise;
    await build.save({ session });
    doc.status = 'CANCELLED';
  },
};

/* ---------- Labour ---------- */

export const timeBooking = {
  Model: TimeBooking,
  async prepare(session, data) {
    const build = await MachineBuild.findById(data.buildId).session(session).lean();
    if (!build) throw notFound('Build');
    return { ...data, serialNo: build.serialNo };
  },
  async submit(session, doc, { actor }) {
    if (doc.status !== 'DRAFT') throw conflict('Only a draft can be submitted.');
    const build = await MachineBuild.findById(doc.buildId).session(session);
    assertBuildOpen(build);
    const settings = await getSettings(session);
    doc.ratePaise = doc.ratePaise || settings.labourRatePaise;
    doc.valuePaise = lineValue(doc.hoursMilli, doc.ratePaise);
    doc.docNo = await nextDocNo(session, 'TB', doc.postingDate);
    doc.status = 'SUBMITTED';
    build.labourCostPaise += doc.valuePaise;
    build.wipPaise += doc.valuePaise;
    await build.save({ session });
    await postGl(session, {
      postingDate: doc.postingDate,
      voucherType: 'TimeBooking',
      voucherId: doc._id,
      voucherNo: doc.docNo,
      narration: `${doc.operation} on ${build.serialNo}, ${doc.employeeName}`,
      lines: [
        { accountCode: A.WIP, debitPaise: doc.valuePaise, buildId: build._id },
        { accountCode: A.LABOUR_ABSORBED, creditPaise: doc.valuePaise },
      ],
    });
    return { action: 'LABOUR_BOOKED', actor, data: { serialNo: build.serialNo, valuePaise: doc.valuePaise } };
  },
  async cancel(session, doc, { postingDate }) {
    const build = await MachineBuild.findById(doc.buildId).session(session);
    assertBuildOpen(build);
    await reverseGl(session, { postingDate, voucherType: 'TimeBooking', voucherId: doc._id, voucherNo: doc.docNo });
    build.labourCostPaise -= doc.valuePaise;
    build.wipPaise -= doc.valuePaise;
    await build.save({ session });
    doc.status = 'CANCELLED';
  },
};

/* ---------- Finish ---------- */

// Turns WIP into a finished machine. The machine's cost is exactly what the build took.
export async function completeBuild(session, id, { postingDate, allowUnissued = false, reason }, actor) {
  const build = await MachineBuild.findById(id).session(session);
  if (!build) throw notFound('Build');
  if (!OPEN_FOR_COST.includes(build.stage)) throw rule(`Build ${build.serialNo} is at ${build.stage}.`, 'BUILD_NOT_OPEN');
  const settings = await getSettings(session);
  assertPostingDate(postingDate, settings);
  if (build.fatStatus !== 'PASSED') throw rule('This machine has not passed its FAT.', 'FAT_NOT_PASSED');
  const open = await Ncr.countDocuments({ buildId: build._id, status: 'OPEN' }).session(session);
  if (open > 0) throw rule(`${open} non-conformance report(s) are still open on this build.`, 'OPEN_NCR', { open });

  const unissued = build.materials.filter((m) => m.issuedMilli < m.requiredMilli);
  if (unissued.length > 0 && !allowUnissued) {
    throw rule(`${unissued.length} BOM part(s) were not fully issued.`, 'MATERIALS_NOT_ISSUED', { items: unissued.map((m) => m.itemCode) });
  }
  if (unissued.length > 0 && !reason) throw rule('Say why a machine is finishing without all its BOM parts.', 'REASON_REQUIRED');

  const fg = await warehouseOfKind(session, 'FG');
  const docNo = await nextDocNo(session, 'FG', postingDate);
  const value = build.wipPaise;
  await stockIn(session, {
    voucher: { voucherType: 'BuildCompletion', voucherId: build._id, voucherNo: docNo, postingDate },
    itemId: build.itemId,
    warehouseId: fg._id,
    buildId: build._id,
    qtyMilli: 1000,
    valuePaise: value,
  });
  await postGl(session, {
    postingDate,
    voucherType: 'BuildCompletion',
    voucherId: build._id,
    voucherNo: docNo,
    narration: `Finished ${build.serialNo}`,
    lines: [
      { accountCode: A.FINISHED_GOODS, debitPaise: value, buildId: build._id },
      { accountCode: A.WIP, creditPaise: value, buildId: build._id },
    ],
  });
  build.finishedValuePaise = value;
  build.wipPaise = 0;
  build.stage = 'READY';
  build.completedAt = new Date();
  build.stageHistory.push({ stage: 'READY', at: new Date(), byName: actor.name, note: `Finished, ${docNo}` });
  await build.save({ session });
  await audit(session, { actor, action: 'BUILD_COMPLETED', entityType: 'MachineBuild', entityId: build._id, entityNo: build.serialNo, reason, data: { valuePaise: value, docNo, unissued: unissued.map((m) => m.itemCode) } });
  return build;
}

/* ---------- Installation ---------- */

export async function installBuild(session, id, { installedOn, installedBy, installationRef }, actor) {
  const build = await MachineBuild.findById(id).session(session);
  if (!build) throw notFound('Build');
  if (build.stage !== 'DISPATCHED') throw rule('Only a dispatched machine can be installed.', 'NOT_DISPATCHED');
  if (installedOn < build.dispatchedOn) throw rule('A machine cannot be installed before it was dispatched.', 'BAD_DATE');
  const settings = await getSettings(session);
  build.installedOn = installedOn;
  build.installedBy = installedBy;
  build.installationRef = installationRef ?? '';
  build.warrantyUntil = addMonths(installedOn, settings.warrantyMonths);
  build.stage = 'INSTALLED';
  build.stageHistory.push({ stage: 'INSTALLED', at: new Date(), byName: actor.name, note: `Installed by ${installedBy}` });
  await build.save({ session });
  await audit(session, { actor, action: 'BUILD_INSTALLED', entityType: 'MachineBuild', entityId: build._id, entityNo: build.serialNo, data: { installedOn, warrantyUntil: build.warrantyUntil } });
  return build;
}

// Actual against the order value, with the cost split out.
export async function costSheet(id) {
  const build = await MachineBuild.findById(id).lean();
  if (!build) throw notFound('Build');
  const totalCostPaise = build.materialCostPaise + build.labourCostPaise + build.otherCostPaise;
  return {
    serialNo: build.serialNo,
    budgetPaise: build.budgetPaise,
    materialCostPaise: build.materialCostPaise,
    labourCostPaise: build.labourCostPaise,
    otherCostPaise: build.otherCostPaise,
    totalCostPaise,
    marginPaise: build.budgetPaise - totalCostPaise,
    marginBps: build.budgetPaise > 0 ? mulDivRound(build.budgetPaise - totalCostPaise, 10000, build.budgetPaise) : null,
    materials: build.materials,
  };
}
