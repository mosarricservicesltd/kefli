// Week 1: the phone's test identity, shown on screen (never logged) so the desktop can check a save with
// npm run decrypt. Only for the local stack's test identities.
import { useState } from 'react';
import { Pressable, StyleSheet, Text, View } from 'react-native';
import { ShelfKeystore } from '../../modules/shelf-keystore/src';

export function IdentityGate() {
  const [shown, setShown] = useState<string | null>(null);
  const show = async () => {
    const r = await ShelfKeystore.read();
    const id = r?.identities[0];
    if (!id) return setShown('No identity yet: share a link first.');
    const words = await ShelfKeystore.readMnemonic(id.pubkey);
    setShown(`pubkey ${id.pubkey}\nwords ${words}\nStrongBox ${await ShelfKeystore.strongBox()}`);
  };
  return (
    <View style={s.box}>
      <Text style={s.h2}>Test identity (key file)</Text>
      <Pressable style={s.btn} onPress={show}>
        <Text style={s.btnText}>Show the test identity</Text>
      </Pressable>
      {shown && <Text selectable style={s.meta}>{shown}</Text>}
    </View>
  );
}

const s = StyleSheet.create({
  box: { gap: 8, marginTop: 16 },
  h2: { fontSize: 17, fontWeight: '600' },
  meta: { fontSize: 13, color: '#17171A' },
  btn: { height: 44, paddingHorizontal: 14, borderRadius: 12, backgroundColor: '#17171A', justifyContent: 'center', alignSelf: 'flex-start' },
  btnText: { color: '#F3F2EE', fontSize: 15, fontWeight: '600' },
});
