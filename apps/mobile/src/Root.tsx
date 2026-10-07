// Switches between the Android test build's screen and the week-0 gates.
import { useState } from 'react';
import { Pressable, SafeAreaView, StyleSheet, Text, View } from 'react-native';
import { router } from 'expo-router';
import App from '../App';
import { GatesScreen } from './gates/GatesScreen';

export default function Root() {
  const [tab, setTab] = useState<'test' | 'gates'>('gates');
  return (
    <SafeAreaView style={s.root}>
      <View style={s.tabs}>
        {(['gates', 'test'] as const).map((t) => (
          <Pressable key={t} onPress={() => setTab(t)} style={[s.tab, tab === t && s.on]}>
            <Text style={[s.label, tab === t && s.onLabel]}>{t === 'gates' ? 'Week 0 gates' : 'Test build'}</Text>
          </Pressable>
        ))}
        <Pressable onPress={() => router.push('/back-test')} style={s.tab}>
          <Text style={s.label}>Back test</Text>
        </Pressable>
      </View>
      <View style={s.body}>{tab === 'gates' ? <GatesScreen /> : <App />}</View>
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
