'use client';

import { useCallback, useEffect, useState, type ReactElement, type MouseEvent } from 'react';
import { createPortal } from 'react-dom';
import type { ProductImageDto } from '@erp/shared';
import { fetchProductImageObjectUrl } from '@/lib/api/product-images';
import { cn } from '@/lib/utils';

function useAuthImageUrl(apiPath: string | null | undefined): string | null {
  const [url, setUrl] = useState<string | null>(null);

  useEffect(() => {
    if (!apiPath) {
      setUrl(null);
      return;
    }
    let cancelled = false;
    let objectUrl: string | null = null;
    void (async () => {
      try {
        objectUrl = await fetchProductImageObjectUrl(apiPath);
        if (!cancelled) setUrl(objectUrl);
      } catch {
        if (!cancelled) setUrl(null);
      }
    })();
    return () => {
      cancelled = true;
      if (objectUrl) URL.revokeObjectURL(objectUrl);
    };
  }, [apiPath]);

  return url;
}

export function ProductThumb({
  image,
  fallback,
  className,
  size = 'md',
  enableHoverPreview = true,
  onOpen,
}: {
  image?: Pick<ProductImageDto, 'thumbUrl' | 'url'> | null;
  fallback?: string;
  className?: string;
  size?: 'sm' | 'md' | 'lg';
  enableHoverPreview?: boolean;
  onOpen?: () => void;
}): ReactElement {
  const thumbUrl = useAuthImageUrl(image?.thumbUrl ?? image?.url);
  const fullUrl = useAuthImageUrl(enableHoverPreview ? image?.url : null);
  const [hover, setHover] = useState(false);
  const [hoverPos, setHoverPos] = useState<{ x: number; y: number } | null>(null);

  const sizeClass = size === 'sm' ? 'h-9 w-9' : size === 'lg' ? 'h-16 w-16' : 'h-12 w-12';

  const onMove = (event: MouseEvent) => {
    if (!enableHoverPreview || !fullUrl) return;
    setHoverPos({ x: event.clientX, y: event.clientY });
  };

  return (
    <>
      <button
        type="button"
        className={cn(
          'relative flex shrink-0 items-center justify-center overflow-hidden rounded-2xl bg-gradient-to-br from-primary-soft to-muted text-foreground/70',
          sizeClass,
          image && 'cursor-zoom-in',
          className,
        )}
        onClick={() => {
          if (image && onOpen) onOpen();
        }}
        onMouseEnter={() => setHover(true)}
        onMouseLeave={() => {
          setHover(false);
          setHoverPos(null);
        }}
        onMouseMove={onMove}
        aria-label={image ? 'Открыть фото' : undefined}
      >
        {thumbUrl ? (
          // eslint-disable-next-line @next/next/no-img-element
          <img src={thumbUrl} alt="" className="h-full w-full object-cover" />
        ) : (
          <span aria-hidden className="text-lg">
            {fallback ?? '✿'}
          </span>
        )}
      </button>
      {enableHoverPreview && hover && fullUrl && hoverPos && typeof document !== 'undefined'
        ? createPortal(
            <div
              className="pointer-events-none fixed z-[120] hidden overflow-hidden rounded-2xl border border-border bg-card shadow-xl md:block"
              style={{
                left: Math.min(hoverPos.x + 16, window.innerWidth - 220),
                top: Math.min(hoverPos.y + 16, window.innerHeight - 220),
                width: 200,
                height: 200,
              }}
            >
              {/* eslint-disable-next-line @next/next/no-img-element */}
              <img src={fullUrl} alt="" className="h-full w-full object-cover" />
            </div>,
            document.body,
          )
        : null}
    </>
  );
}

export function ProductImageLightbox({
  open,
  images,
  initialId,
  onClose,
}: {
  open: boolean;
  images: ProductImageDto[];
  initialId?: string | null;
  onClose: () => void;
}): ReactElement | null {
  const startIndex = Math.max(
    0,
    images.findIndex((img) => img.id === initialId),
  );
  const [index, setIndex] = useState(startIndex < 0 ? 0 : startIndex);
  const current = images[index] ?? null;
  const url = useAuthImageUrl(current?.url);

  useEffect(() => {
    if (!open) return;
    setIndex(startIndex < 0 ? 0 : startIndex);
  }, [open, startIndex]);

  useEffect(() => {
    if (!open) return;
    const onKey = (event: KeyboardEvent) => {
      if (event.key === 'Escape') onClose();
      if (event.key === 'ArrowRight') setIndex((i) => Math.min(i + 1, images.length - 1));
      if (event.key === 'ArrowLeft') setIndex((i) => Math.max(i - 1, 0));
    };
    document.addEventListener('keydown', onKey);
    return () => document.removeEventListener('keydown', onKey);
  }, [open, onClose, images.length]);

  if (!open || typeof document === 'undefined') return null;

  return createPortal(
    <div
      className="fixed inset-0 z-[130] flex items-center justify-center bg-black/70 p-4"
      role="dialog"
      aria-modal
      onClick={onClose}
    >
      <div
        className="relative max-h-[90vh] max-w-[min(920px,96vw)] overflow-hidden rounded-2xl bg-card shadow-2xl"
        onClick={(e) => e.stopPropagation()}
      >
        {url ? (
          // eslint-disable-next-line @next/next/no-img-element
          <img src={url} alt="" className="max-h-[80vh] w-full object-contain" />
        ) : (
          <div className="flex h-64 w-80 items-center justify-center text-sm text-muted-foreground">
            Загрузка…
          </div>
        )}
        <div className="flex items-center justify-between gap-2 border-t border-border px-4 py-3">
          <button
            type="button"
            className="rounded-full px-3 py-1.5 text-sm hover:bg-muted disabled:opacity-40"
            disabled={index <= 0}
            onClick={() => setIndex((i) => Math.max(0, i - 1))}
          >
            ←
          </button>
          <span className="text-xs text-muted-foreground">
            {images.length ? `${index + 1} / ${images.length}` : ''}
          </span>
          <button
            type="button"
            className="rounded-full px-3 py-1.5 text-sm hover:bg-muted disabled:opacity-40"
            disabled={index >= images.length - 1}
            onClick={() => setIndex((i) => Math.min(images.length - 1, i + 1))}
          >
            →
          </button>
          <button
            type="button"
            className="ml-auto rounded-full bg-muted px-3 py-1.5 text-sm"
            onClick={onClose}
          >
            Закрыть
          </button>
        </div>
      </div>
    </div>,
    document.body,
  );
}

export function ProductImageUploader({
  images,
  primaryImageId,
  onChange,
  disabled,
}: {
  images: ProductImageDto[];
  primaryImageId: string | null;
  onChange: (next: { images: ProductImageDto[]; primaryImageId: string | null }) => void;
  disabled?: boolean;
}): ReactElement {
  const [uploading, setUploading] = useState(false);
  const [error, setError] = useState<string | null>(null);
  const [lightboxId, setLightboxId] = useState<string | null>(null);

  const onFiles = useCallback(
    async (fileList: FileList | null) => {
      if (!fileList || fileList.length === 0 || disabled) return;
      setError(null);
      setUploading(true);
      try {
        const { uploadProductImage } = await import('@/lib/api/product-images');
        const uploaded: ProductImageDto[] = [];
        for (const file of Array.from(fileList).slice(0, 8 - images.length)) {
          uploaded.push(await uploadProductImage(file));
        }
        const nextImages = [...images, ...uploaded];
        onChange({
          images: nextImages,
          primaryImageId: primaryImageId ?? nextImages[0]?.id ?? null,
        });
      } catch (err) {
        setError(err instanceof Error ? err.message : 'Ошибка загрузки');
      } finally {
        setUploading(false);
      }
    },
    [disabled, images, onChange, primaryImageId],
  );

  return (
    <div className="space-y-3">
      <div className="flex flex-wrap gap-3">
        {images.map((img) => (
          <div key={img.id} className="relative">
            <ProductThumb
              image={img}
              size="lg"
              enableHoverPreview
              onOpen={() => setLightboxId(img.id)}
            />
            {primaryImageId === img.id ? (
              <span className="absolute -bottom-1 left-1/2 -translate-x-1/2 rounded-full bg-primary-soft px-1.5 text-[10px] font-medium">
                осн.
              </span>
            ) : null}
            <div className="mt-2 flex gap-1">
              <button
                type="button"
                className="rounded-full bg-muted px-2 py-0.5 text-[10px]"
                disabled={disabled || primaryImageId === img.id}
                onClick={() => onChange({ images, primaryImageId: img.id })}
              >
                Основное
              </button>
              <button
                type="button"
                className="rounded-full bg-danger-soft px-2 py-0.5 text-[10px] text-danger-fg"
                disabled={disabled}
                onClick={async () => {
                  try {
                    const { deleteProductImage } = await import('@/lib/api/product-images');
                    await deleteProductImage(img.id);
                  } catch {
                    // still remove from form if staged delete fails after product save race
                  }
                  const next = images.filter((i) => i.id !== img.id);
                  onChange({
                    images: next,
                    primaryImageId:
                      primaryImageId === img.id ? (next[0]?.id ?? null) : primaryImageId,
                  });
                }}
              >
                Удалить
              </button>
            </div>
          </div>
        ))}
        {images.length < 8 ? (
          <label
            className={cn(
              'flex h-16 w-16 cursor-pointer flex-col items-center justify-center rounded-2xl border border-dashed border-border text-xs text-muted-foreground hover:bg-muted/50',
              (disabled || uploading) && 'pointer-events-none opacity-50',
            )}
          >
            <span>{uploading ? '…' : '+'}</span>
            <span className="text-[10px]">Фото</span>
            <input
              type="file"
              accept="image/jpeg,image/png,image/webp,image/gif"
              capture="environment"
              multiple
              className="hidden"
              disabled={disabled || uploading}
              onChange={(e) => {
                void onFiles(e.target.files);
                e.target.value = '';
              }}
            />
          </label>
        ) : null}
      </div>
      {error ? <p className="text-sm text-danger-fg">{error}</p> : null}
      <ProductImageLightbox
        open={Boolean(lightboxId)}
        images={images}
        initialId={lightboxId}
        onClose={() => setLightboxId(null)}
      />
    </div>
  );
}
