import { Injectable, Logger } from '@nestjs/common';
import type { AddressSuggestionDto } from '@erp/shared';
import { AppConfigService } from '../../config/app-config.service';

type NominatimResult = {
  display_name?: string;
  lat?: string;
  lon?: string;
  place_id?: number;
  address?: {
    road?: string;
    pedestrian?: string;
    house_number?: string;
    suburb?: string;
    city?: string;
    town?: string;
    village?: string;
  };
};

type YandexSuggestResult = {
  title?: { text?: string };
  subtitle?: { text?: string };
  tags?: string[];
  uri?: string;
  address?: {
    formatted_address?: string;
    component?: Array<{ name?: string; kind?: string[] }>;
  };
};

type YandexSuggestResponse = {
  results?: YandexSuggestResult[];
};

type YandexGeocoderResponse = {
  response?: {
    GeoObjectCollection?: {
      featureMember?: Array<{
        GeoObject?: {
          name?: string;
          description?: string;
          metaDataProperty?: {
            GeocoderMetaData?: {
              text?: string;
              Address?: { formatted?: string };
            };
          };
          Point?: { pos?: string };
        };
      }>;
    };
  };
};

/**
 * Address suggestions:
 * 1) Yandex Geosuggest when YANDEX_MAPS_API_KEY is set (best for BY/RU)
 * 2) Nominatim fallback otherwise
 */
@Injectable()
export class AddressService {
  private readonly logger = new Logger(AddressService.name);
  private lastNominatimAt = 0;

  constructor(private readonly config: AppConfigService) {}

  async suggest(query: string, limit: number): Promise<AddressSuggestionDto[]> {
    const q = query.trim();
    if (q.length < 2) return [];

    const key = this.config.yandexMapsApiKey;
    if (key) {
      try {
        const yandex = await this.suggestYandex(q, limit, key);
        if (yandex.length > 0) return yandex;
      } catch (error) {
        this.logger.warn(
          `Yandex suggest failed: ${error instanceof Error ? error.message : 'unknown'}`,
        );
      }
    }

    return this.suggestNominatim(q, limit);
  }

  private async suggestYandex(
    query: string,
    limit: number,
    apiKey: string,
  ): Promise<AddressSuggestionDto[]> {
    const url = new URL('https://suggest-maps.yandex.ru/v1/suggest');
    url.searchParams.set('apikey', apiKey);
    url.searchParams.set('text', query);
    url.searchParams.set('lang', 'ru_RU');
    url.searchParams.set('results', String(Math.min(Math.max(limit, 1), 10)));
    url.searchParams.set('print_address', '1');
    url.searchParams.set('attrs', 'uri');
    // Belarus first — much better house numbers / letters than global OSM.
    url.searchParams.set('countries', 'BY');
    url.searchParams.set('types', 'street,house,locality,district,area,province');

    const bias = this.config.yandexSuggestLl;
    if (bias) {
      url.searchParams.set('ll', bias);
      url.searchParams.set('spn', '0.35,0.25');
    }

    const response = await fetch(url, {
      headers: { Accept: 'application/json' },
      signal: AbortSignal.timeout(8_000),
    });
    if (!response.ok) {
      this.logger.warn(`Yandex Suggest HTTP ${response.status}`);
      return [];
    }

    const data = (await response.json()) as YandexSuggestResponse;
    const rows = data.results ?? [];
    const mapped = rows
      .map((row) => this.mapYandexSuggest(row))
      .filter((row) => row.addressText.length > 0);

    // Enrich first few with coordinates via Geocoder (uri → point).
    await Promise.all(
      mapped.slice(0, Math.min(mapped.length, 5)).map(async (item) => {
        if (!item.providerPlaceId || item.latitude != null) return;
        const point = await this.geocodeYandexUri(item.providerPlaceId, apiKey);
        if (point) {
          item.latitude = point.lat;
          item.longitude = point.lon;
        }
      }),
    );

    return mapped;
  }

  private mapYandexSuggest(row: YandexSuggestResult): AddressSuggestionDto {
    const formatted = row.address?.formatted_address?.trim();
    const title = row.title?.text?.trim() ?? '';
    const subtitle = row.subtitle?.text?.trim() ?? '';
    const compact = [title, subtitle].filter(Boolean).join(', ');
    const addressText = this.shortenBelarusAddress(formatted || compact);
    const label = addressText || compact;

    return {
      label,
      addressText: addressText || label,
      latitude: null,
      longitude: null,
      provider: 'yandex',
      providerPlaceId: row.uri ?? null,
    };
  }

  /** Prefer "улица …, дом, город" without country prefix. */
  private shortenBelarusAddress(raw: string): string {
    let text = raw.trim();
    text = text.replace(/^Беларусь,\s*/i, '').replace(/^Белоруссия,\s*/i, '');
    return text;
  }

  private async geocodeYandexUri(
    uri: string,
    apiKey: string,
  ): Promise<{ lat: number; lon: number } | null> {
    try {
      const url = new URL('https://geocode-maps.yandex.ru/1.x/');
      url.searchParams.set('apikey', apiKey);
      url.searchParams.set('format', 'json');
      url.searchParams.set('lang', 'ru_RU');
      url.searchParams.set('results', '1');
      url.searchParams.set('uri', uri);

      const response = await fetch(url, {
        headers: { Accept: 'application/json' },
        signal: AbortSignal.timeout(6_000),
      });
      if (!response.ok) return null;

      const data = (await response.json()) as YandexGeocoderResponse;
      const pos =
        data.response?.GeoObjectCollection?.featureMember?.[0]?.GeoObject?.Point?.pos;
      if (!pos) return null;
      const [lonRaw, latRaw] = pos.split(/\s+/);
      const lon = Number(lonRaw);
      const lat = Number(latRaw);
      if (!Number.isFinite(lat) || !Number.isFinite(lon)) return null;
      return { lat, lon };
    } catch {
      return null;
    }
  }

  private async suggestNominatim(query: string, limit: number): Promise<AddressSuggestionDto[]> {
    const wait = 1100 - (Date.now() - this.lastNominatimAt);
    if (wait > 0) {
      await new Promise((resolve) => setTimeout(resolve, wait));
    }
    this.lastNominatimAt = Date.now();

    const url = new URL('https://nominatim.openstreetmap.org/search');
    url.searchParams.set('q', query);
    url.searchParams.set('format', 'json');
    url.searchParams.set('addressdetails', '1');
    url.searchParams.set('limit', String(limit));
    url.searchParams.set('countrycodes', 'by');
    url.searchParams.set('accept-language', 'ru');

    try {
      const response = await fetch(url, {
        headers: {
          'User-Agent': 'FlowerCRM/1.0 (erp.nasytko.ru; address-suggest)',
          Accept: 'application/json',
        },
        signal: AbortSignal.timeout(8_000),
      });
      if (!response.ok) {
        this.logger.warn(`Nominatim HTTP ${response.status}`);
        return [];
      }
      const data = (await response.json()) as NominatimResult[];
      return data.map((row) => this.mapNominatim(row)).filter((row) => row.addressText.length > 0);
    } catch (error) {
      this.logger.warn(`Nominatim failed: ${error instanceof Error ? error.message : 'unknown'}`);
      return [];
    }
  }

  private mapNominatim(row: NominatimResult): AddressSuggestionDto {
    const road = row.address?.road || row.address?.pedestrian;
    const house = row.address?.house_number;
    const locality = row.address?.city || row.address?.town || row.address?.village;
    const parts = [road && house ? `${road}, ${house}` : road, locality].filter(Boolean);
    const addressText = parts.length > 0 ? parts.join(', ') : (row.display_name ?? '').trim();
    const lat = row.lat ? Number(row.lat) : null;
    const lon = row.lon ? Number(row.lon) : null;

    return {
      label: addressText,
      addressText,
      latitude: Number.isFinite(lat) ? lat : null,
      longitude: Number.isFinite(lon) ? lon : null,
      provider: 'nominatim',
      providerPlaceId: row.place_id != null ? String(row.place_id) : null,
    };
  }
}
