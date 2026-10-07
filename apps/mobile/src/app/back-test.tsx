// A pushed screen for the predictive-back gate.
import { Pressable, StyleSheet, Text, View } from 'react-native';
import { router } from 'expo-router';

export default function BackTest() {
  return (
    <View style={s.page}>
      <Text style={s.title}>Back test</Text>
      <Text style={s.body}>Swipe back from the edge slowly, then let go. In-app, this screen should leave only when you let go, fading as it travels 24 px right. On the gates screen, the same swipe should show Android’s preview of going home.</Text>
      <Pressable style={s.btn} onPress={() => router.back()}>
        <Text style={s.btnText}>Back</Text>
      </Pressable>
    </View>
  );
}

const s = StyleSheet.create({
  page: { flex: 1, padding: 24, paddingTop: 72, gap: 16, backgroundColor: '#F3F2EE' },
  title: { fontSize: 28, fontWeight: '700', color: '#17171A' },
  body: { fontSize: 15, lineHeight: 22, color: '#17171A' },
  btn: { alignSelf: 'flex-start', height: 44, paddingHorizontal: 16, borderRadius: 12, backgroundColor: '#17171A', justifyContent: 'center' },
  btnText: { color: '#F3F2EE', fontSize: 15, fontWeight: '600' },
});
