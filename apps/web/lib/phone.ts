/** Phone country profiles for order forms. Default is Belarus. */

export type PhoneCountryId = 'BY' | 'RU' | 'UA' | 'PL' | 'LT' | 'LV' | 'OTHER';

export interface PhoneCountry {
  id: PhoneCountryId;
  label: string;
  /** Dial code digits without +. Empty for OTHER. */
  dial: string;
  /** Expected national digit count (OTHER = flexible). */
  nationalLength: number | null;
  placeholder: string;
}

export const PHONE_COUNTRIES: PhoneCountry[] = [
  { id: 'BY', label: 'РБ +375', dial: '375', nationalLength: 9, placeholder: '29 123-45-67' },
  { id: 'RU', label: 'РФ +7', dial: '7', nationalLength: 10, placeholder: '900 123-45-67' },
  { id: 'UA', label: 'UA +380', dial: '380', nationalLength: 9, placeholder: '50 123-45-67' },
  { id: 'PL', label: 'PL +48', dial: '48', nationalLength: 9, placeholder: '512 345 678' },
  { id: 'LT', label: 'LT +370', dial: '370', nationalLength: 8, placeholder: '612 34567' },
  { id: 'LV', label: 'LV +371', dial: '371', nationalLength: 8, placeholder: '2123 4567' },
  { id: 'OTHER', label: 'Другой', dial: '', nationalLength: null, placeholder: '+…' },
];

export function getPhoneCountry(id: PhoneCountryId): PhoneCountry {
  return PHONE_COUNTRIES.find((c) => c.id === id) ?? PHONE_COUNTRIES[0]!;
}

export function digitsOnly(value: string): string {
  return value.replace(/\D/g, '');
}

/** Format national digits for display (spaces/dashes). */
export function formatNational(countryId: PhoneCountryId, nationalDigits: string): string {
  const d = digitsOnly(nationalDigits);
  if (countryId === 'BY' || countryId === 'UA') {
    // XX XXX-XX-XX
    const a = d.slice(0, 2);
    const b = d.slice(2, 5);
    const c = d.slice(5, 7);
    const e = d.slice(7, 9);
    let out = a;
    if (b) out += ` ${b}`;
    if (c) out += `-${c}`;
    if (e) out += `-${e}`;
    return out;
  }
  if (countryId === 'RU') {
    // XXX XXX-XX-XX
    const a = d.slice(0, 3);
    const b = d.slice(3, 6);
    const c = d.slice(6, 8);
    const e = d.slice(8, 10);
    let out = a;
    if (b) out += ` ${b}`;
    if (c) out += `-${c}`;
    if (e) out += `-${e}`;
    return out;
  }
  if (countryId === 'PL') {
    const a = d.slice(0, 3);
    const b = d.slice(3, 6);
    const c = d.slice(6, 9);
    let out = a;
    if (b) out += ` ${b}`;
    if (c) out += ` ${c}`;
    return out;
  }
  if (countryId === 'LT') {
    const a = d.slice(0, 3);
    const b = d.slice(3, 8);
    return b ? `${a} ${b}` : a;
  }
  if (countryId === 'LV') {
    const a = d.slice(0, 4);
    const b = d.slice(4, 8);
    return b ? `${a} ${b}` : a;
  }
  // OTHER: keep + and group loosely
  return d;
}

/**
 * Build stored E.164-ish value (+digits). Empty national → ''.
 * OTHER: store as typed digits with leading +.
 */
export function toStoredPhone(countryId: PhoneCountryId, nationalDigits: string): string {
  const national = digitsOnly(nationalDigits);
  if (countryId === 'OTHER') {
    if (!national) return '';
    return `+${national}`;
  }
  if (!national) return '';
  const country = getPhoneCountry(countryId);
  return `+${country.dial}${national}`;
}

export function isPhoneComplete(countryId: PhoneCountryId, nationalDigits: string): boolean {
  const national = digitsOnly(nationalDigits);
  const country = getPhoneCountry(countryId);
  if (countryId === 'OTHER') return national.length >= 8;
  if (country.nationalLength == null) return national.length >= 8;
  return national.length === country.nationalLength;
}

export function isPhoneValidEnough(countryId: PhoneCountryId, nationalDigits: string): boolean {
  const national = digitsOnly(nationalDigits);
  if (countryId === 'OTHER') return national.length >= 8;
  const country = getPhoneCountry(countryId);
  if (country.nationalLength == null) return national.length >= 8;
  // Allow saving only when full length for known countries
  return national.length === country.nationalLength;
}

/** Detect country + national part from a stored +375… / raw value. */
export function parseStoredPhone(stored: string): {
  countryId: PhoneCountryId;
  nationalDigits: string;
} {
  const raw = stored.trim();
  if (!raw) return { countryId: 'BY', nationalDigits: '' };

  const digits = digitsOnly(raw.startsWith('00') ? raw.slice(2) : raw);

  // Prefer longer dial codes first
  const sorted = [...PHONE_COUNTRIES]
    .filter((c) => c.dial)
    .sort((a, b) => b.dial.length - a.dial.length);

  for (const country of sorted) {
    if (digits.startsWith(country.dial)) {
      let national = digits.slice(country.dial.length);
      // BY local leftover 80XXXXXXXXX → drop trunk 0
      if (country.id === 'BY' && national.startsWith('0')) {
        national = national.slice(1);
      }
      // RU 8XXXXXXXXXX pasted with country already stripped incorrectly
      if (country.id === 'RU' && national.length === 11 && national.startsWith('8')) {
        national = national.slice(1);
      }
      if (country.nationalLength != null && national.length > country.nationalLength) {
        national = national.slice(0, country.nationalLength);
      }
      return { countryId: country.id, nationalDigits: national };
    }
  }

  // Local BY without country: 29… / 8029…
  if (/^80?\d{9}$/.test(digits) || /^\d{9}$/.test(digits)) {
    let national = digits;
    if (national.startsWith('80') && national.length === 11) national = national.slice(2);
    else if (national.startsWith('0') && national.length === 10) national = national.slice(1);
    if (national.length === 9) return { countryId: 'BY', nationalDigits: national };
  }

  // RU local 8XXXXXXXXXX / 9XXXXXXXXX
  if (/^8\d{10}$/.test(digits)) {
    return { countryId: 'RU', nationalDigits: digits.slice(1) };
  }
  if (/^9\d{9}$/.test(digits)) {
    return { countryId: 'RU', nationalDigits: digits };
  }

  return { countryId: 'OTHER', nationalDigits: digits };
}

/** Cap national digits while typing; strip leading dial if user pasted full intl. */
export function normalizeNationalInput(
  countryId: PhoneCountryId,
  input: string,
): string {
  let d = digitsOnly(input);
  const country = getPhoneCountry(countryId);

  if (countryId !== 'OTHER' && country.dial && d.startsWith(country.dial)) {
    d = d.slice(country.dial.length);
  }
  // Paste +375… into national field already handled via dial strip

  if (countryId === 'BY') {
    if (d.startsWith('80') && d.length > 9) d = d.slice(2);
    else if (d.startsWith('0') && d.length > 9) d = d.slice(1);
  }
  if (countryId === 'RU' && d.startsWith('8') && d.length === 11) {
    d = d.slice(1);
  }

  if (country.nationalLength != null) {
    d = d.slice(0, country.nationalLength);
  } else {
    d = d.slice(0, 15);
  }
  return d;
}
