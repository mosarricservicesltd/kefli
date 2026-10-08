// The development gates and the predictive-back test (the local stack's build only, src/app/gates.tsx).
import { Pressable, SafeAreaView, StyleSheet, Text, View } from 'react-native';
import { router } from 'expo-router';
import { GatesScreen } from './gates/GatesScreen';

export default function Root() {
  return (
    <SafeAreaView style={s.root}>
      <View style={s.tabs}>
        <View style={[s.tab, s.on]}><Text style={[s.label, s.onLabel]}>Week 0 gates</Text></View>
        <Pressable onPress={() => router.push('/back-test')} style={s.tab}>
          <Text style={s.label}>Back test</Text>
        </Pressable>
      </View>
      <View style={s.body}><GatesScreen /></View>
    </SafeAreaView>
  );
}

const s = StyleSheet.create({
  root: { flex: 1, backgroundColor: '#F3F2EE', paddingTop: 36 },
  tabs: { flexDirection: 'row', gap: 8, paddingHorizontal: 20, paddingVertical: 8 },
  tab: { paddingHorizontal: 14, height: 36, borderRadius: 999, borderWidth: 1, borderColor: '#8C8A83', justifyContent: 'center' },
  on: { backgroundColor: '#17171A', borderColor: '#17171A' },
  label: { fontSize: 13, color: '#17171A' },
  onLabel: { color: '#F3F2EE' },
  body: { flex: 1 },
});
