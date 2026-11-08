// All money and quantity arithmetic. Inputs and outputs are safe integers.
// Products go through BigInt, so a large quantity at a large rate cannot lose precision.

export const MILLI = 1000;
export const BPS = 10000;
export const FX_ONE = 10000; // fxRate4: rupees per one foreign unit, times 10,000.

function assertInt(value, name) {
  if (!Number.isSafeInteger(value)) throw new TypeError(`${name} must be a safe integer, got ${value}`);
}

// (a * b) / c, rounded half away from zero.
export function mulDivRound(a, b, c) {
  assertInt(a, 'a');
  assertInt(b, 'b');
  assertInt(c, 'c');
  if (c === 0) throw new RangeError('Division by zero');
  const numerator = BigInt(a) * BigInt(b);
  const divisor = BigInt(c);
  const negative = numerator < 0n !== divisor < 0n;
  const n = numerator < 0n ? -numerator : numerator;
  const d = divisor < 0n ? -divisor : divisor;
  const rounded = (2n * n + d) / (2n * d);
  const result = Number(negative ? -rounded : rounded);
  if (!Number.isSafeInteger(result)) throw new RangeError('Result is too large');
  return result === 0 ? 0 : result; // never -0
}

// Value of a quantity in thousandths at a price per whole unit.
export const lineValue = (qtyMilli, rate) => mulDivRound(qtyMilli, rate, MILLI);

export const applyBps = (amount, bps) => mulDivRound(amount, bps, BPS);

export const afterDiscount = (amount, discountBps = 0) => amount - applyBps(amount, discountBps);

// Foreign minor units (cents) to paise, at rupees per foreign unit times 10,000.
export const toBasePaise = (minor, fxRate4 = FX_ONE) => mulDivRound(minor, fxRate4, FX_ONE);

export function sumInts(values) {
  let total = 0;
  for (const value of values) {
    assertInt(value, 'value');
    total += value;
  }
  if (!Number.isSafeInteger(total)) throw new RangeError('Sum is too large');
  return total;
}

// Split a total across weights so the shares add up exactly (largest remainder).
// A tie goes to the earlier entry.
export function allocate(total, weights) {
  assertInt(total, 'total');
  const weightSum = sumInts(weights);
  if (weights.length === 0) return [];
  if (weightSum === 0) {
    const zero = weights.map(() => 0);
    zero[0] = total;
    return zero;
  }
  const sign = total < 0 ? -1 : 1;
  const absolute = Math.abs(total);
  const shares = weights.map((weight, index) => {
    const product = BigInt(absolute) * BigInt(weight);
    return {
      index,
      share: Number(product / BigInt(weightSum)),
      remainder: product % BigInt(weightSum),
    };
  });
  let left = absolute - sumInts(shares.map((s) => s.share));
  const order = [...shares].sort((a, b) => {
    if (a.remainder === b.remainder) return a.index - b.index;
    return a.remainder > b.remainder ? -1 : 1;
  });
  for (const entry of order) {
    if (left <= 0) break;
    entry.share += 1;
    left -= 1;
  }
  return shares.map((s) => (s.share === 0 ? 0 : s.share * sign));
}

// Nearest whole rupee, half away from zero. Returns the adjustment in paise.
export function roundOffToRupee(paise) {
  assertInt(paise, 'paise');
  const rupees = mulDivRound(paise, 1, 100);
  return rupees * 100 - paise;
}
