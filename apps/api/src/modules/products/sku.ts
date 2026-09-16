/**
 * Build an auto SKU from a product name: "SKU" + latin transliteration.
 * Collisions are resolved by the caller with numeric suffixes.
 */
const CYR_TO_LAT: Record<string, string> = {
  а: 'a',
  б: 'b',
  в: 'v',
  г: 'g',
  д: 'd',
  е: 'e',
  ё: 'e',
  ж: 'zh',
  з: 'z',
  и: 'i',
  й: 'y',
  к: 'k',
  л: 'l',
  м: 'm',
  н: 'n',
  о: 'o',
  п: 'p',
  р: 'r',
  с: 's',
  т: 't',
  у: 'u',
  ф: 'f',
  х: 'h',
  ц: 'ts',
  ч: 'ch',
  ш: 'sh',
  щ: 'sch',
  ъ: '',
  ы: 'y',
  ь: '',
  э: 'e',
  ю: 'yu',
  я: 'ya',
};

export function transliterateToLatinSkuPart(name: string): string {
  const lower = name.trim().toLowerCase();
  let out = '';
  for (const ch of lower) {
    if (CYR_TO_LAT[ch] !== undefined) {
      out += CYR_TO_LAT[ch];
      continue;
    }
    if (/[a-z0-9]/.test(ch)) {
      out += ch;
      continue;
    }
    // skip spaces/punctuation
  }
  return out.toUpperCase().slice(0, 48);
}

export function buildSkuBaseFromName(name: string): string {
  const part = transliterateToLatinSkuPart(name);
  return `SKU${part.length > 0 ? part : 'ITEM'}`;
}

/** Next unique SKU: base, then base2, base3, ... */
export function nextUniqueSku(base: string, taken: Set<string>): string {
  const normalizedBase = base.slice(0, 60);
  if (!taken.has(normalizedBase.toUpperCase())) {
    return normalizedBase;
  }
  for (let n = 2; n < 10_000; n += 1) {
    const candidate = `${normalizedBase}${n}`.slice(0, 64);
    if (!taken.has(candidate.toUpperCase())) {
      return candidate;
    }
  }
  return `${normalizedBase}${Date.now()}`.slice(0, 64);
}
