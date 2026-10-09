// The viewfinder (prototype .vf): the camera reading QR codes only, under four corners and a scan line, with its
// caption; without the camera, a faint drawn code in its place. Connect a browser and Scan from my other phone.
import { useEffect } from 'react';
import { View } from 'react-native';
import { CameraView } from 'expo-camera';
import Animated, { useAnimatedStyle, useReducedMotion, useSharedValue, withDelay, withRepeat, withTiming } from 'react-native-reanimated';
import { motion, radius } from '@kefli/tokens';
import { ambient } from '@kefli/tokens/reanimated';
import { PhoneQR } from './PhoneQR';
import { T, ui } from './text';

const VF_DARK = '#0C0E12';
const CORNER = 34;

function Corners() {
  const at = (k: number) => {
    const left = k % 2 === 0;
    const top = k < 2;
    return {
      position: 'absolute' as const, width: CORNER, height: CORNER, borderColor: '#FFFFFF', opacity: 0.9,
      [left ? 'left' : 'right']: '18%', [top ? 'top' : 'bottom']: '17%',
      [left ? 'borderLeftWidth' : 'borderRightWidth']: 3, [top ? 'borderTopWidth' : 'borderBottomWidth']: 3,
      [`border${top ? 'Top' : 'Bottom'}${left ? 'Left' : 'Right'}Radius`]: 10,
    };
  };
  return <>{[0, 1, 2, 3].map((k) => <View key={k} style={at(k)} />)}</>;
}

/** The scan line on translateY, alternating (motion.ambient.scan); still under reduced motion it isn't drawn. */
function ScanLine() {
  const y = useSharedValue(0);
  const still = useReducedMotion();
  useEffect(() => {
    if (!still) y.value = withDelay(motion.ambient.delay, withRepeat(withTiming(168, ambient.scan), -1, true));
  }, [y, still]);
  const st = useAnimatedStyle(() => ({ transform: [{ translateY: y.value }] }));
  if (still) return null;
  return <Animated.View style={[{ position: 'absolute', left: '20%', right: '20%', top: '22%', height: 2, backgroundColor: '#FFFFFF', opacity: 0.85 }, st]} />;
}

export function Viewfinder({ live, onCode, caption }: { live: boolean; onCode: (data: string) => void; caption: string }) {
  return (
    <View style={{ height: 300, borderRadius: radius.sheet, overflow: 'hidden', backgroundColor: VF_DARK, marginVertical: 16 }}>
      {live && (
        <CameraView style={{ position: 'absolute', top: 0, left: 0, right: 0, bottom: 0 }} facing="back"
          barcodeScannerSettings={{ barcodeTypes: ['qr'] }} onBarcodeScanned={(r) => onCode(r.data)} />
      )}
      {!live && <View style={{ position: 'absolute', top: '50%', left: '50%', marginTop: -75, marginLeft: -75, opacity: 0.35 }}><PhoneQR size={150} color="#FFFFFF" /></View>}
      <Corners />
      <ScanLine />
      <T style={[ui(13, 'body', 1.3), { position: 'absolute', left: 0, right: 0, bottom: 12, textAlign: 'center', color: '#FFFFFF', opacity: 0.85 }]}>{caption}</T>
    </View>
  );
}

