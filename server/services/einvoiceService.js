// Builds the files the government portals take: e-invoice (IRN) and e-way bill JSON.
// It does not talk to the portal. That needs GSP credentials, and the company uploads the
// file or a GSP integration is added. Field details must be checked against the current
// published schema before use, because NIC revises them.
import { SalesInvoice } from '../models/documents.js';
import { Party } from '../models/masters.js';
import { getSettings } from './settingsService.js';
import { notFound, rule } from '../utils/errors.js';

const rupees = (paise) => Number((paise / 100).toFixed(2));
const qty = (milli) => Number((milli / 1000).toFixed(3));
const indianDate = (date) => date.split('-').reverse().join('/');
const SUPPLY_TYPE = { INTRA: 'B2B', INTER: 'B2B', EXPORT_LUT: 'EXPWOP', EXPORT_IGST: 'EXPWP', SEZ_LUT: 'SEZWOP', SEZ_IGST: 'SEZWP' };

function assertReady(settings, invoice) {
  if (invoice.status !== 'SUBMITTED') throw rule('Only a submitted invoice can go to the portal.', 'INVOICE_NOT_SUBMITTED');
  if (invoice.isOpening) throw rule('An opening balance is not an invoice for the portal.', 'OPENING_INVOICE');
  if (!settings.gstin) throw rule('Enter the company GSTIN in Settings first.', 'COMPANY_GSTIN_REQUIRED');
  if (!invoice.isExport && !invoice.partyGstin) throw rule('E-invoices are for registered customers. This customer has no GSTIN.', 'CUSTOMER_GSTIN_REQUIRED');
  for (const line of invoice.lines) {
    if (!line.hsn) throw rule(`${line.itemCode} has no HSN code.`, 'HSN_REQUIRED');
  }
}

export async function einvoiceJson(id) {
  const invoice = await SalesInvoice.findById(id).lean();
  if (!invoice) throw notFound('Invoice');
  const settings = await getSettings();
  assertReady(settings, invoice);
  const party = await Party.findById(invoice.partyId).lean();
  return {
    Version: '1.1',
    TranDtls: { TaxSch: 'GST', SupTyp: SUPPLY_TYPE[invoice.supplyType], RegRev: 'N', IgstOnIntra: 'N' },
    DocDtls: { Typ: 'INV', No: invoice.docNo, Dt: indianDate(invoice.postingDate) },
    SellerDtls: { Gstin: settings.gstin, LglNm: settings.legalName, Addr1: settings.address.slice(0, 100), Stcd: settings.stateCode },
    BuyerDtls: { Gstin: invoice.isExport ? 'URP' : invoice.partyGstin, LglNm: invoice.partyName, Pos: invoice.placeOfSupply, Addr1: (party.address || party.country).slice(0, 100), Stcd: invoice.isExport ? '96' : party.stateCode },
    ItemList: invoice.lines.map((line, index) => ({
      SlNo: String(index + 1),
      PrdDesc: line.itemName.slice(0, 300),
      IsServc: line.kind === 'SERVICE' ? 'Y' : 'N',
      HsnCd: line.hsn,
      Qty: qty(line.qtyMilli),
      Unit: line.uom,
      AssAmt: rupees(line.taxablePaise),
      GstRt: line.gstRateBps / 100,
      IgstAmt: rupees(line.igstPaise),
      CgstAmt: rupees(line.cgstPaise),
      SgstAmt: rupees(line.sgstPaise),
      TotItemVal: rupees(line.taxablePaise + line.igstPaise + line.cgstPaise + line.sgstPaise),
    })),
    ValDtls: { AssVal: rupees(invoice.taxablePaise), CgstVal: rupees(invoice.cgstPaise), SgstVal: rupees(invoice.sgstPaise), IgstVal: rupees(invoice.igstPaise), RndOffAmt: rupees(invoice.roundOffPaise), TotInvVal: rupees(invoice.totalPaise) },
    ...(invoice.isExport ? { ExpDtls: { ShipBNo: invoice.shippingBillNo || undefined, ForCur: invoice.currency, CntCode: undefined } } : {}),
  };
}

export async function ewayBillJson(id) {
  const invoice = await SalesInvoice.findById(id).lean();
  if (!invoice) throw notFound('Invoice');
  const settings = await getSettings();
  assertReady(settings, invoice);
  if (!invoice.vehicleNo) throw rule('Enter the vehicle number on the invoice first.', 'VEHICLE_REQUIRED');
  const party = await Party.findById(invoice.partyId).lean();
  return {
    supplyType: 'O',
    subSupplyType: invoice.isExport ? '3' : '1',
    docType: 'INV',
    docNo: invoice.docNo,
    docDate: indianDate(invoice.postingDate),
    fromGstin: settings.gstin,
    fromTrdName: settings.legalName,
    fromStateCode: Number(settings.stateCode),
    toGstin: invoice.isExport ? 'URP' : invoice.partyGstin,
    toTrdName: invoice.partyName,
    toStateCode: invoice.isExport ? 99 : Number(party.stateCode),
    totalValue: rupees(invoice.taxablePaise),
    cgstValue: rupees(invoice.cgstPaise),
    sgstValue: rupees(invoice.sgstPaise),
    igstValue: rupees(invoice.igstPaise),
    totInvValue: rupees(invoice.totalPaise),
    transporterName: invoice.transporter,
    transMode: '1',
    vehicleNo: invoice.vehicleNo,
    vehicleType: 'R',
    itemList: invoice.lines.filter((l) => l.kind !== 'SERVICE').map((line) => ({
      productName: line.itemName.slice(0, 100), hsnCode: line.hsn, quantity: qty(line.qtyMilli), qtyUnit: line.uom, taxableAmount: rupees(line.taxablePaise), cgstRate: invoice.supplyType === 'INTRA' ? line.gstRateBps / 200 : 0, sgstRate: invoice.supplyType === 'INTRA' ? line.gstRateBps / 200 : 0, igstRate: invoice.supplyType === 'INTRA' ? 0 : line.gstRateBps / 100,
    })),
  };
}
