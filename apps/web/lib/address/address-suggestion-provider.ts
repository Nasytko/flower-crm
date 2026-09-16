/**
 * Address suggestion provider boundary (Phase 7).
 *
 * Order stores a frozen address snapshot:
 * - deliveryAddressText (required for DELIVERY)
 * - deliveryLatitude / deliveryLongitude (optional)
 * - deliveryProvider / deliveryProviderPlaceId (optional)
 *
 * Concrete providers (Yandex Geocoder, etc.) must live behind this interface
 * and must never be imported into OrdersService.
 */

import type { AddressSuggestionDto } from '@erp/shared';
import { suggestAddress } from '@/lib/api/address';

export type AddressSuggestion = {
  label: string;
  addressText: string;
  latitude: number | null;
  longitude: number | null;
  provider: string;
  providerPlaceId: string | null;
};

export type AddressSuggestQuery = {
  query: string;
  limit?: number;
};

export interface AddressSuggestionProvider {
  readonly id: string;
  suggest(query: AddressSuggestQuery): Promise<AddressSuggestion[]>;
}

function fromDto(dto: AddressSuggestionDto): AddressSuggestion {
  return {
    label: dto.label,
    addressText: dto.addressText,
    latitude: dto.latitude,
    longitude: dto.longitude,
    provider: dto.provider,
    providerPlaceId: dto.providerPlaceId,
  };
}

/** Backend address suggestions: Yandex Geosuggest (preferred) or Nominatim fallback. */
export class ApiAddressProvider implements AddressSuggestionProvider {
  readonly id = 'api';

  async suggest(query: AddressSuggestQuery): Promise<AddressSuggestion[]> {
    const q = query.query.trim();
    if (q.length < 2) return [];
    const items = await suggestAddress(q, query.limit ?? 7);
    return items.map(fromDto);
  }
}

/** Manual entry only — always available without API keys. */
export class ManualAddressProvider implements AddressSuggestionProvider {
  readonly id = 'manual';

  async suggest(query: AddressSuggestQuery): Promise<AddressSuggestion[]> {
    const q = query.query.trim();
    if (!q) return [];
    return [
      {
        label: q,
        addressText: q,
        latitude: null,
        longitude: null,
        provider: this.id,
        providerPlaceId: null,
      },
    ];
  }
}
