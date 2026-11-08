// Display and entry conversion. All maths is on integers, using strings to read decimals,
// so a typed 19.99 can never become 1998.9999.

const groupIndian = (digits) => {
  if (digits.length <= 3) return digits;
  const last = digits.slice(-3);
  return `${digits.slice(0, -3).replace(/\B(?=(\d{2})+(?!\d))/g, ',')},${last}`;
};

const groupWestern = (digits) => digits.replace(/\B(?=(\d{3})+(?!\d))/g, ',');

function scaled(value, scale, { indian = true, trim = false } = {}) {
  if (value === null || value === undefined || value === '') return '';
  const negative = value < 0;
  const raw = String(Math.abs(value)).padStart(scale + 1, '0');
  const whole = raw.slice(0, raw.length - scale);
  let fraction = raw.slice(raw.length - scale);
  if (trim) fraction = fraction.replace(/0+$/, '');
  const grouped = indian ? groupIndian(whole) : groupWestern(whole);
  return `${negative ? '-' : ''}${grouped}${fraction ? `.${fraction}` : ''}`;
}

export const formatPaise = (paise) => (paise === null || paise === undefined ? '' : `₹${scaled(paise, 2)}`);
export const formatAmount = (paise) => scaled(paise ?? 0, 2);
export const formatMinor = (minor, currency = 'INR') => {
  if (minor === null || minor === undefined) return '';
  return currency === 'INR' ? formatPaise(minor) : `${currency} ${scaled(minor, 2, { indian: false })}`;
};
export const formatQty = (milli) => scaled(milli ?? 0, 3, { trim: true });
export const formatBps = (bps) => `${scaled(bps ?? 0, 2, { trim: true })}%`;
export const formatFx = (fx4) => scaled(fx4 ?? 0, 4, { indian: false, trim: true });

export function formatDate(value) {
  if (!value) return '';
  const [y, m, d] = String(value).slice(0, 10).split('-');
  const months = ['Jan', 'Feb', 'Mar', 'Apr', 'May', 'Jun', 'Jul', 'Aug', 'Sep', 'Oct', 'Nov', 'Dec'];
  return `${d} ${months[Number(m) - 1]} ${y}`;
}

export function formatDateTime(value) {
  if (!value) return '';
  return new Intl.DateTimeFormat('en-IN', { timeZone: 'Asia/Kolkata', dateStyle: 'medium', timeStyle: 'short' }).format(new Date(value));
}

// "12.5" at scale 2 -> 1250. Returns null if it is not a number of at most that scale.
export function parseScaled(text, scale, { allowNegative = false } = {}) {
  const value = String(text ?? '').trim().replace(/,/g, '');
  if (value === '') return null;
  const match = value.match(/^(-)?(\d*)(?:\.(\d*))?$/);
  if (!match || (!match[2] && !match[3])) return null;
  if (match[1] && !allowNegative) return null;
  if ((match[3] ?? '').length > scale) return null;
  const digits = `${match[2] || '0'}${(match[3] ?? '').padEnd(scale, '0')}`;
  const result = Number(digits);
  if (!Number.isSafeInteger(result)) return null;
  return match[1] && result !== 0 ? -result : result;
}

export const unscale = (value, scale) => (value === null || value === undefined ? '' : scaled(value, scale, { indian: false, trim: true }).replace(/,/g, ''));

const ones = ['', 'One', 'Two', 'Three', 'Four', 'Five', 'Six', 'Seven', 'Eight', 'Nine', 'Ten', 'Eleven', 'Twelve', 'Thirteen', 'Fourteen', 'Fifteen', 'Sixteen', 'Seventeen', 'Eighteen', 'Nineteen'];
const tens = ['', '', 'Twenty', 'Thirty', 'Forty', 'Fifty', 'Sixty', 'Seventy', 'Eighty', 'Ninety'];

function belowThousand(n) {
  const hundred = Math.floor(n / 100);
  const rest = n % 100;
  const parts = [];
  if (hundred) parts.push(`${ones[hundred]} Hundred`);
  if (rest >= 20) parts.push(`${tens[Math.floor(rest / 10)]}${rest % 10 ? ` ${ones[rest % 10]}` : ''}`);
  else if (rest) parts.push(ones[rest]);
  return parts.join(' ');
}

// In lakh and crore, as on an Indian tax invoice.
export function paiseInWords(paise) {
  const rupees = Math.floor(Math.abs(paise) / 100);
  const fraction = Math.abs(paise) % 100;
  const crore = Math.floor(rupees / 10000000);
  const lakh = Math.floor((rupees % 10000000) / 100000);
  const thousand = Math.floor((rupees % 100000) / 1000);
  const rest = rupees % 1000;
  const parts = [];
  if (crore) parts.push(`${belowThousand(crore)} Crore`);
  if (lakh) parts.push(`${belowThousand(lakh)} Lakh`);
  if (thousand) parts.push(`${belowThousand(thousand)} Thousand`);
  if (rest) parts.push(belowThousand(rest));
  const words = parts.join(' ') || 'Zero';
  return `Rupees ${words}${fraction ? ` and ${belowThousand(fraction)} Paise` : ''} Only`;
}

export const todayIso = () => new Intl.DateTimeFormat('en-CA', { timeZone: 'Asia/Kolkata' }).format(new Date());

export const humanise = (code) => String(code ?? '').replace(/_/g, ' ').toLowerCase().replace(/^\w/, (c) => c.toUpperCase());
