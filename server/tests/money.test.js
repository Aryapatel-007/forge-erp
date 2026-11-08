import test from 'node:test';
import assert from 'node:assert/strict';
import { allocate, applyBps, lineValue, mulDivRound, roundOffToRupee, sumInts, toBasePaise } from '../utils/money.js';
import { computeTax, isValidGstin, SUPPLY, supplyTypeFor } from '../utils/tax.js';
import { addMonths, fyOf, isDateString, todayIst } from '../utils/dates.js';

test('mulDivRound rounds half away from zero, both signs', () => {
  assert.equal(mulDivRound(5, 1, 2), 3);
  assert.equal(mulDivRound(-5, 1, 2), -3);
  assert.equal(mulDivRound(4, 1, 3), 1);
  assert.equal(mulDivRound(0, -5, 7), 0);
  assert.ok(Object.is(mulDivRound(0, -5, 7), 0), 'never negative zero');
});

test('mulDivRound survives products beyond 2^53', () => {
  // 90,000 units at Rs 9 crore: the product is 8.1e17, which floats cannot hold exactly.
  assert.equal(mulDivRound(90_000_000, 9_000_000_000, 1000), 810_000_000_000_000);
  assert.throws(() => mulDivRound(Number.MAX_SAFE_INTEGER, Number.MAX_SAFE_INTEGER, 1), RangeError);
});

test('mulDivRound refuses non-integers and zero divisors', () => {
  assert.throws(() => mulDivRound(1.5, 1, 1), TypeError);
  assert.throws(() => mulDivRound(1, 1, 0), RangeError);
});

test('lineValue: 1.5 kg at Rs 333.33 is Rs 500.00 (rounded from 499.995)', () => {
  assert.equal(lineValue(1500, 33333), 50000);
});

test('applyBps: 18% of Rs 100.55', () => {
  assert.equal(applyBps(10055, 1800), 1810);
});

test('toBasePaise: USD 1,000.50 at 83.1234', () => {
  assert.equal(toBasePaise(100050, 831234), 8316496);
});

test('allocate always adds up exactly, and a tie goes to the earlier entry', () => {
  assert.deepEqual(allocate(100, [1, 1, 1]), [34, 33, 33]);
  assert.deepEqual(allocate(-100, [1, 1, 1]), [-34, -33, -33]);
  assert.deepEqual(allocate(5, [0, 0]), [5, 0]);
  for (const [total, weights] of [[1, [3, 7, 11]], [99999, [17, 19, 23, 29]], [7, [1000000, 1]]]) {
    assert.equal(sumInts(allocate(total, weights)), total);
  }
});

test('roundOffToRupee returns the adjustment', () => {
  assert.equal(roundOffToRupee(10049), -49);
  assert.equal(roundOffToRupee(10050), 50);
  assert.equal(roundOffToRupee(10000), 0);
});

test('intra-state: CGST takes the odd paisa, and the halves re-add', () => {
  const r = computeTax([{ taxablePaise: 10005, gstRateBps: 1800 }], SUPPLY.INTRA);
  // 18% of 100.05 = 18.009, rounds to 18.01
  assert.equal(r.taxPaise, 1801);
  assert.equal(r.cgstPaise, 901);
  assert.equal(r.sgstPaise, 900);
  assert.equal(r.igstPaise, 0);
  assert.equal(r.totalPaise, 11806);
});

test('tax rounds once per rate, not per line', () => {
  // Per line would be 0.05 + 0.05 + 0.05 = 15 paise. On the rate it is 0.1 of 142 = 14.2 -> 14.
  const lines = [{ taxablePaise: 47, gstRateBps: 1000 }, { taxablePaise: 47, gstRateBps: 1000 }, { taxablePaise: 48, gstRateBps: 1000 }];
  const r = computeTax(lines, SUPPLY.INTER);
  assert.equal(r.igstPaise, 14);
  assert.equal(sumInts(r.lineTax.map((t) => t.igstPaise)), 14, 'line shares add up to the rate');
});

test('several rates produce a slab each, sorted', () => {
  const r = computeTax([{ taxablePaise: 100000, gstRateBps: 1800 }, { taxablePaise: 50000, gstRateBps: 500 }], SUPPLY.INTER);
  assert.deepEqual(r.slabs.map((s) => [s.gstRateBps, s.igstPaise]), [[500, 2500], [1800, 18000]]);
  assert.equal(r.lineTax[0].igstPaise, 18000);
  assert.equal(r.lineTax[1].igstPaise, 2500);
});

test('export under LUT is zero-rated; export with payment is IGST', () => {
  const lut = computeTax([{ taxablePaise: 100000, gstRateBps: 1800 }], SUPPLY.EXPORT_LUT);
  assert.equal(lut.taxPaise, 0);
  assert.equal(lut.totalPaise, 100000);
  const igst = computeTax([{ taxablePaise: 100000, gstRateBps: 1800 }], SUPPLY.EXPORT_IGST);
  assert.equal(igst.igstPaise, 18000);
  assert.equal(igst.cgstPaise, 0);
});

test('invoice round-off lands on a whole rupee and the parts still add up', () => {
  const r = computeTax([{ taxablePaise: 10005, gstRateBps: 1800 }], SUPPLY.INTRA, { roundOff: true });
  assert.equal(r.roundOffPaise, -6);
  assert.equal(r.totalPaise, 11800);
  assert.equal(r.taxablePaise + r.taxPaise + r.roundOffPaise, r.totalPaise);
});

test('supplyTypeFor', () => {
  assert.equal(supplyTypeFor({ companyState: '24', partyState: '24' }), SUPPLY.INTRA);
  assert.equal(supplyTypeFor({ companyState: '24', partyState: '27' }), SUPPLY.INTER);
  assert.equal(supplyTypeFor({ companyState: '24', isExport: true }), SUPPLY.EXPORT_LUT);
  assert.equal(supplyTypeFor({ companyState: '24', isExport: true, exportUnderLut: false }), SUPPLY.EXPORT_IGST);
  assert.throws(() => supplyTypeFor({ companyState: '24', partyState: '' }), RangeError);
});

test('GSTIN format and check digit', () => {
  assert.equal(isValidGstin('27AAPFU0939F1ZV'), true);
  assert.equal(isValidGstin('27AAPFU0939F1ZW'), false, 'wrong check digit');
  assert.equal(isValidGstin('27AAPFU0939F1Z'), false, 'too short');
  assert.equal(isValidGstin(''), false);
});

test('dates', () => {
  assert.equal(fyOf('2026-03-31'), '2526');
  assert.equal(fyOf('2026-04-01'), '2627');
  assert.equal(todayIst(new Date('2026-11-07T19:00:00Z')), '2026-11-08', 'past 6:30 PM UTC is tomorrow in India');
  assert.equal(isDateString('2026-02-30'), false);
  assert.equal(addMonths('2026-01-31', 1), '2026-02-28');
});
