import QRCode from 'qrcode';
import { useMemo } from 'react';

interface QrCodeSvgProps {
  value: string;
  size?: number;
  label?: string;
}

/** Local synchronous SVG QR renderer; keeps session keys strictly off third-party image APIs. */
export function QrCodeSvg({ value, size = 188, label = 'QR code' }: QrCodeSvgProps) {
  const { modulesCount, pathData } = useMemo(() => {
    const qr = QRCode.create(value, { errorCorrectionLevel: 'M' });
    const count = qr.modules.size;
    const data = qr.modules.data;
    const parts: string[] = [];
    for (let y = 0; y < count; y++) {
      for (let x = 0; x < count; x++) {
        if (data[y * count + x]) {
          parts.push(`M${x} ${y}h1v1h-1z`);
        }
      }
    }
    return { modulesCount: count, pathData: parts.join('') };
  }, [value]);

  const quiet = 3;
  const viewBoxSize = modulesCount + quiet * 2;

  return (
    <div
      className="inline-flex items-center justify-center rounded-[16px] bg-white p-3 shadow-xs"
      style={{ width: size, height: size }}
    >
      <svg
        role="img"
        aria-label={label}
        viewBox={`${-quiet} ${-quiet} ${viewBoxSize} ${viewBoxSize}`}
        width={size - 24}
        height={size - 24}
        shapeRendering="crispEdges"
      >
        <rect x={-quiet} y={-quiet} width={viewBoxSize} height={viewBoxSize} fill="#ffffff" />
        <path d={pathData} fill="#000000" />
      </svg>
    </div>
  );
}
