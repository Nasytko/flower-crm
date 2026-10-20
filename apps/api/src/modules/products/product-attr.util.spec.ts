import { normalizeProductAttrName, suggestFlowerProductName } from '@erp/shared';
import { displayNameFromRaw, parentKeyFor } from './product-attr.util';

describe('product attribute utils', () => {
  it('normalizes and displays names', () => {
    expect(normalizeProductAttrName('  Роза   Мондиаль ')).toBe('роза мондиаль');
    expect(displayNameFromRaw('  Роза   Мондиаль ')).toBe('Роза Мондиаль');
    expect(parentKeyFor(null)).toBe('');
    expect(parentKeyFor('kind1')).toBe('kind1');
  });

  it('suggests flower product names', () => {
    expect(
      suggestFlowerProductName({
        kindName: 'Роза',
        varietyName: 'Мондиаль',
        colorName: 'белая',
        stemLengthCm: 50,
      }),
    ).toBe('Роза Мондиаль белая 50 см');
  });
});
