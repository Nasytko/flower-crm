import type { ProductImageDto } from '@erp/shared';
import { ApiClientError, apiFetchRaw } from './client';

export async function uploadProductImage(file: File): Promise<ProductImageDto> {
  const body = new FormData();
  body.append('file', file);
  const response = await apiFetchRaw('/api/v1/product-images', {
    method: 'POST',
    body,
  });
  if (!response.ok) {
    let message = `HTTP ${response.status}`;
    try {
      const json = (await response.json()) as { message?: string };
      if (json.message) message = json.message;
    } catch {
      // ignore
    }
    throw new ApiClientError(response.status, {
      code: 'UPLOAD_ERROR',
      message,
      details: {},
    });
  }
  return (await response.json()) as ProductImageDto;
}

export async function deleteProductImage(id: string): Promise<void> {
  const response = await apiFetchRaw(`/api/v1/product-images/${id}`, {
    method: 'DELETE',
  });
  if (!response.ok && response.status !== 204) {
    throw new ApiClientError(response.status, {
      code: 'DELETE_ERROR',
      message: 'Не удалось удалить изображение',
      details: {},
    });
  }
}

/** Fetch image bytes with auth and return an object URL (caller must revoke). */
export async function fetchProductImageObjectUrl(apiPath: string): Promise<string> {
  const path = apiPath.startsWith('/api/')
    ? apiPath
    : apiPath.startsWith('/')
      ? `/api/v1${apiPath}`
      : `/api/v1/${apiPath}`;
  const response = await apiFetchRaw(path);
  if (!response.ok) {
    throw new ApiClientError(response.status, {
      code: 'IMAGE_FETCH_ERROR',
      message: 'Не удалось загрузить изображение',
      details: {},
    });
  }
  const blob = await response.blob();
  return URL.createObjectURL(blob);
}
