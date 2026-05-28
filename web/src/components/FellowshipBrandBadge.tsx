import { useEffect, useState } from 'react';

interface FellowshipBrandBadgeProps {
  code: string;
  logoUrl?: string | null;
  alt?: string;
  className?: string;
  imageClassName?: string;
  fallbackClassName?: string;
}

export const FellowshipBrandBadge: React.FC<FellowshipBrandBadgeProps> = ({
  code,
  logoUrl = null,
  alt,
  className,
  imageClassName = 'h-full w-full object-contain',
  fallbackClassName,
}) => {
  const [imageFailed, setImageFailed] = useState(false);
  const normalizedCode = code.trim().toUpperCase() || 'Badge';
  const normalizedLogoUrl = typeof logoUrl === 'string' ? logoUrl.trim() : '';

  useEffect(() => {
    setImageFailed(false);
  }, [normalizedLogoUrl]);

  return (
    <span
      className={className}
      title={alt || normalizedCode}
      aria-label={alt || normalizedCode}
    >
      {normalizedLogoUrl && !imageFailed ? (
        <span className="flex h-full w-full items-center justify-center overflow-hidden">
          <img
            src={normalizedLogoUrl}
            alt={alt || normalizedCode}
            loading="lazy"
            decoding="async"
            draggable={false}
            referrerPolicy="no-referrer"
            onError={() => setImageFailed(true)}
            className={`block max-h-full max-w-full object-contain ${imageClassName}`}
          />
        </span>
      ) : (
        <span className={fallbackClassName || 'text-[10px] font-semibold uppercase tracking-[0.14em] text-slate-700'}>
          {normalizedCode}
        </span>
      )}
    </span>
  );
};

export default FellowshipBrandBadge;
