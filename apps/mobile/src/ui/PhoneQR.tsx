// The prototype's phoneQR: a stylised code for illustrations and the viewfinder's ghost, never a scannable one.
import Svg, { Rect } from 'react-native-svg';

const on = (x: number, y: number) => (x * 7 + y * 13 + x * y) % 5 < 2;
const finder = (x: number, y: number) => (x < 3 && y < 3) || (x > 7 && y < 3) || (x < 3 && y > 7);
const CELLS = Array.from({ length: 121 }, (_, i) => ({ x: i % 11, y: Math.floor(i / 11) })).filter(({ x, y }) => finder(x, y) || on(x, y));

export function PhoneQR({ size, color }: { size: number; color: string }) {
  return (
    <Svg width={size} height={size} viewBox="0 0 110 110">
      {CELLS.map(({ x, y }) => <Rect key={`${x}-${y}`} x={x * 10} y={y * 10} width={9} height={9} rx={1.5} fill={color} />)}
    </Svg>
  );
}
