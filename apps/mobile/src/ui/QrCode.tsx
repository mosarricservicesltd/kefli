// A real QR code (toqr), drawn as one path in the text colour on a light card, for a phone to scan: Add another
// device's offer (mobile spec 5.8). The quiet zone is the card's padding.
import { useMemo } from 'react';
import Svg, { Path } from 'react-native-svg';
import { toQR } from 'toqr';

export function QrCode({ text, size, color, opacity = 1 }: { text: string; size: number; color: string; opacity?: number }) {
  const { n, d } = useMemo(() => {
    const m = toQR(text);
    const side = Math.sqrt(m.length);
    let path = '';
    for (let y = 0; y < side; y++) for (let x = 0; x < side; x++) if (m[y * side + x]) path += `M${x} ${y}h1v1h-1z`;
    return { n: side, d: path };
  }, [text]);
  return (
    <Svg width={size} height={size} viewBox={`0 0 ${n} ${n}`} opacity={opacity}>
      <Path d={d} fill={color} />
    </Svg>
  );
}
