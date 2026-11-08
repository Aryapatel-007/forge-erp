// What should this line cost? A customer's price, then the price list, then the item's own
// price, with the best-priority pricing rule applied over that.
import { getType, modelOf } from '../engine/registry.js';
import { Item, Party } from '../models/masters.js';
import { applyBps } from '../utils/money.js';
import { notFound } from '../utils/errors.js';
import { todayIst } from '../utils/dates.js';

const inDate = (row, date) => (!row.validFrom || row.validFrom <= date) && (!row.validUpto || row.validUpto >= date);
const matches = (ruleValue, value) => !ruleValue || String(ruleValue) === String(value ?? '');

export async function quotePrice({ itemId, partyId = null, qtyMilli = 1000, date = todayIst(), forBuying = false }) {
  const item = await Item.findById(itemId).lean();
  if (!item) throw notFound('Item');
  const party = partyId ? await Party.findById(partyId).lean() : null;

  let basePaise = forBuying ? item.standardCostPaise : item.salePricePaise;
  let source = 'ITEM';
  const prices = await modelOf('ItemPrice').find({ itemId: String(itemId) }).lean();
  const usable = prices.filter((row) => inDate(row, date) && (row.minQtyMilli ?? 0) <= qtyMilli);
  const forParty = party ? usable.find((row) => String(row.partyId) === String(party._id)) : null;
  const forList = party?.priceListId ? usable.find((row) => !row.partyId && String(row.priceListId) === String(party.priceListId)) : null;
  const anyList = usable.find((row) => !row.partyId);
  const chosen = forParty ?? forList ?? (party?.priceListId ? null : anyList);
  if (chosen) {
    basePaise = chosen.ratePaise;
    source = forParty ? 'PARTY_PRICE' : 'PRICE_LIST';
  }

  const rules = await getType('PricingRule').Model.find({ isActive: true, [forBuying ? 'forBuying' : 'forSelling']: true }).sort({ priority: -1, createdAt: 1 }).lean();
  const applied = rules.find((row) => inDate(row, date)
    && matches(row.itemId, item._id)
    && matches(row.itemGroupId, item.itemGroupId)
    && matches(row.brandId, item.brandId)
    && matches(row.partyId, party?._id)
    && matches(row.customerGroupId, party?.customerGroupId)
    && matches(row.territoryId, party?.territoryId)
    && (row.minQtyMilli ?? 0) <= qtyMilli
    && (!row.maxQtyMilli || row.maxQtyMilli >= qtyMilli));

  let ratePaise = basePaise;
  let discountBps = 0;
  if (applied?.kind === 'FIXED_RATE') ratePaise = applied.ratePaise;
  if (applied?.kind === 'DISCOUNT_AMOUNT') ratePaise = Math.max(0, basePaise - applied.discountPaise);
  if (applied?.kind === 'DISCOUNT_PERCENT') {
    discountBps = applied.discountBps;
    ratePaise = basePaise - applyBps(basePaise, discountBps);
  }
  return { itemId: String(item._id), basePaise, source, ratePaise, discountBps, gstRateBps: item.gstRateBps, ruleTitle: applied?.title ?? null };
}
