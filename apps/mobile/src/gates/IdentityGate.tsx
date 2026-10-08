// Week 1: the phone's test identity, shown on screen (never logged) so the desktop can check a save with
// npm run decrypt. Only for the local stack's test identities. Forget wipes the key file, Block Store's entry and
// the database, so the next launch starts at Welcome: for testing Bring back your shelf (week 4).
import { useState } from 'react';
import { Pressable, StyleSheet, Text, View } from 'react-native';
import { ShelfKeystore } from '../../modules/shelf-keystore/src';
import { launchPlan } from '../services/launchState';
import { wipe } from '../data/settings';
import { store } from '../services/store';

export function IdentityGate() {
  const [shown, setShown] = useState<string | null>(null);
  const show = async () => {
    const r = await ShelfKeystore.read();
    const id = r?.identities[0];
    if (!id) return setShown(`No identity yet: share a link first.\nlaunch ${JSON.stringify(await launchPlan())}`);
    const words = await ShelfKeystore.readMnemonic(id.pubkey);
    const bs = await ShelfKeystore.blockStoreGet().catch(() => 'read failed');
    const plan = await launchPlan();
    setShown(`pubkey ${id.pubkey}\norigin ${id.origin}\nwords ${words}\nStrongBox ${await ShelfKeystore.strongBox()}\nBlock Store ${bs === words ? 'holds these words' : bs ? 'holds other words' : 'empty'}, end-to-end ${await ShelfKeystore.isE2EEAvailable().catch(() => false)}\nlaunch ${JSON.stringify(plan)}`);
  };
  const forget = async () => {
    const r = await ShelfKeystore.read();
    for (const id of r?.identities ?? []) await ShelfKeystore.wipe(id.pubkey).catch(() => undefined);
    await ShelfKeystore.blockStoreRemove().catch(() => undefined);
    wipe(store());
    setShown('Forgotten: the key file, Block Store and the database are empty. Close Shelf and open it again to reach Welcome.');
  };
  return (
    <View style={s.box}>
      <Text style={s.h2}>Test identity (key file)</Text>
      <Pressable style={s.btn} onPress={show}>
        <Text style={s.btnText}>Show the test identity</Text>
      </Pressable>
      <Pressable style={s.btn} onPress={forget}>
        <Text style={s.btnText}>Forget this phone’s shelf</Text>
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
