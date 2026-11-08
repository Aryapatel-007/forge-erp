// All GST arithmetic. A chartered accountant must review this before real use.
import { allocate, applyBps, roundOffToRupee, sumInts } from './money.js';

export const SUPPLY = Object.freeze({
  INTRA: 'INTRA', // same state: CGST + SGST
  INTER: 'INTER', // other state: IGST
  EXPORT_LUT: 'EXPORT_LUT', // export under Letter of Undertaking: zero-rated
  EXPORT_IGST: 'EXPORT_IGST', // export with IGST paid
  SEZ_LUT: 'SEZ_LUT', // supply to an SEZ under LUT: zero-rated
  SEZ_IGST: 'SEZ_IGST', // supply to an SEZ with IGST paid
  IMPORT: 'IMPORT', // goods from abroad: IGST is paid at customs, on the bill of entry
});

const NO_TAX = new Set([SUPPLY.EXPORT_LUT, SUPPLY.SEZ_LUT, SUPPLY.IMPORT]);
export const ZERO_RATED = new Set([SUPPLY.EXPORT_LUT, SUPPLY.EXPORT_IGST, SUPPLY.SEZ_LUT, SUPPLY.SEZ_IGST]);

export function supplyTypeFor({ companyState, partyState, isExport, isSez = false, exportUnderLut = true }) {
  if (isExport) return exportUnderLut ? SUPPLY.EXPORT_LUT : SUPPLY.EXPORT_IGST;
  if (isSez) return exportUnderLut ? SUPPLY.SEZ_LUT : SUPPLY.SEZ_IGST;
  if (!partyState) throw new RangeError('The party has no GST state');
  return String(companyState) === String(partyState) ? SUPPLY.INTRA : SUPPLY.INTER;
}

// lines: [{ taxablePaise, gstRateBps }]. Tax rounds once per rate, never per line,
// and each line takes its share by the largest remainder, so lines add up exactly.
export function computeTax(lines, supplyType, { roundOff = false } = {}) {
  if (!Object.values(SUPPLY).includes(supplyType)) throw new RangeError(`Unknown supply type ${supplyType}`);
  const byRate = new Map();
  lines.forEach((line, index) => {
    if (!byRate.has(line.gstRateBps)) byRate.set(line.gstRateBps, []);
    byRate.get(line.gstRateBps).push({ index, taxablePaise: line.taxablePaise });
  });

  const lineTax = lines.map(() => ({ cgstPaise: 0, sgstPaise: 0, igstPaise: 0 }));
  const slabs = [];
  const rates = [...byRate.keys()].sort((a, b) => a - b);

  for (const gstRateBps of rates) {
    const group = byRate.get(gstRateBps);
    const taxablePaise = sumInts(group.map((g) => g.taxablePaise));
    const tax = NO_TAX.has(supplyType) ? 0 : applyBps(taxablePaise, gstRateBps);
    let cgstPaise = 0;
    let sgstPaise = 0;
    let igstPaise = 0;
    if (supplyType === SUPPLY.INTRA) {
      cgstPaise = Math.ceil(tax / 2);
      sgstPaise = tax - cgstPaise;
    } else {
      igstPaise = tax;
    }
    slabs.push({ gstRateBps, taxablePaise, cgstPaise, sgstPaise, igstPaise });

    const weights = group.map((g) => g.taxablePaise);
    const cgstShares = allocate(cgstPaise, weights);
    const sgstShares = allocate(sgstPaise, weights);
    const igstShares = allocate(igstPaise, weights);
    group.forEach((g, i) => {
      lineTax[g.index] = { cgstPaise: cgstShares[i], sgstPaise: sgstShares[i], igstPaise: igstShares[i] };
    });
  }

  const taxablePaise = sumInts(slabs.map((s) => s.taxablePaise));
  const cgstPaise = sumInts(slabs.map((s) => s.cgstPaise));
  const sgstPaise = sumInts(slabs.map((s) => s.sgstPaise));
  const igstPaise = sumInts(slabs.map((s) => s.igstPaise));
  const beforeRound = taxablePaise + cgstPaise + sgstPaise + igstPaise;
  const roundOffPaise = roundOff ? roundOffToRupee(beforeRound) : 0;

  return {
    supplyType,
    slabs,
    lineTax,
    taxablePaise,
    cgstPaise,
    sgstPaise,
    igstPaise,
    taxPaise: cgstPaise + sgstPaise + igstPaise,
    roundOffPaise,
    totalPaise: beforeRound + roundOffPaise,
  };
}

// Credit against tax owed, in the order the law sets, with the least left to pay in cash.
// IGST credit goes to IGST first, and the rest to CGST and SGST, where it saves cash. CGST
// and SGST credit go to their own head, then IGST, and never to each other.
// From the CGST Act as generally described. A chartered accountant must confirm it.
export function gstSetOff(liability, credit) {
  const owed = { ...liability };
  const left = { ...credit };
  const used = { igst: 0, cgst: 0, sgst: 0 };
  const apply = (from, to, limit = Infinity) => {
    const amount = Math.min(left[from], owed[to], limit);
    left[from] -= amount;
    owed[to] -= amount;
    used[from] += amount;
  };
  apply('igst', 'igst');
  // Spend IGST credit where the head's own credit will not cover it, then anywhere.
  apply('igst', 'cgst', Math.max(0, owed.cgst - left.cgst));
  apply('igst', 'sgst', Math.max(0, owed.sgst - left.sgst));
  apply('igst', 'cgst');
  apply('igst', 'sgst');
  apply('cgst', 'cgst');
  apply('sgst', 'sgst');
  apply('cgst', 'igst');
  apply('sgst', 'igst');
  return {
    used,
    cash: owed,
    creditLeft: left,
    settled: { igst: liability.igst - owed.igst, cgst: liability.cgst - owed.cgst, sgst: liability.sgst - owed.sgst },
  };
}

const GSTIN = /^[0-9]{2}[A-Z]{5}[0-9]{4}[A-Z][1-9A-Z]Z[0-9A-Z]$/;
const GSTIN_CHARS = '0123456789ABCDEFGHIJKLMNOPQRSTUVWXYZ';

// Checks the format and the check digit. It cannot tell whether the number is live.
export function isValidGstin(gstin) {
  if (typeof gstin !== 'string' || !GSTIN.test(gstin)) return false;
  let sum = 0;
  for (let i = 0; i < 14; i += 1) {
    const value = GSTIN_CHARS.indexOf(gstin[i]);
    const product = value * (i % 2 === 0 ? 1 : 2);
    sum += Math.floor(product / 36) + (product % 36);
  }
  const check = (36 - (sum % 36)) % 36;
  return GSTIN_CHARS[check] === gstin[14];
}
