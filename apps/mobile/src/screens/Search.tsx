// Search (mobile spec 5.6, FD 50, FD 51; prototype search, search-none, search-reader): a pushed screen with no tab
// bar, its field focused on arrival. Before typing, the caption; results on every keystroke across Unread and
// Archive, archived ones tagged; "Nothing matches" only once typing has paused for 250 ms, the last results staying
// until then. A swipe archives or restores a result in place. Back from a Reader opened here keeps the query,
// results and scroll; the query resets only when Search is entered from Saves.
import { useCallback, useEffect, useRef, useState } from 'react';
import { FlatList, TextInput, View } from 'react-native';
import { router, useFocusEffect, useLocalSearchParams } from 'expo-router';
import Animated, { FadeIn } from 'react-native-reanimated';
import { useSafeAreaInsets } from 'react-native-safe-area-context';
import { motion, radius } from '@kefli/tokens';
import type { LibRow } from '../data/library';
import { search } from '../data/search';
import { useApp } from '../services/app';
import { store } from '../services/store';
import { Button } from '../ui/Button';
import { Icon } from '../ui/Icon';
import { useLive } from '../ui/live';
import { MenuItem, MenuTitle } from '../ui/MenuItem';
import { useOnline } from '../ui/online';
import { closeSheet, openSheet } from '../ui/sheet';
import { S } from '../ui/strings';
import { T, ui } from '../ui/text';
import { setToastFloor } from '../ui/toast';
import { useTheme } from '../ui/theme';
import { archive, remove } from './actions';
import { IconButton } from './Onb';
import { SaveRow } from './SaveRow';

/** No results show only after typing pauses this long (5.6). */
export const NONE_AFTER_MS = 250;

// The query outlives the screen, so Back from a Reader opened here finds it as it was.
let kept = '';

export default function Search() {
  const { c } = useTheme();
  const insets = useSafeAreaInsets();
  const owner = useApp()?.owner ?? '';
  const online = useOnline();
  const { fresh } = useLocalSearchParams<{ fresh?: string }>();
  const [q, setQ] = useState(() => (fresh ? '' : kept));
  const [idle, setIdle] = useState(true);
  const last = useRef<LibRow[]>([]);
  const input = useRef<TextInput>(null);

  useEffect(() => {
    kept = q;
    setIdle(false);
    const t = setTimeout(() => setIdle(true), NONE_AFTER_MS);
    return () => clearTimeout(t);
  }, [q]);
  useFocusEffect(useCallback(() => setToastFloor(16), []));

  const rows = useLive(() => (owner ? search(store(), owner, q) : []), ['items', 'items_fts'], [owner, q]);
  if (rows.length) last.current = rows;
  const typed = q.trim() !== '';
  // while typing pauses on no match, the last results stay until the empty state is due
  const shown = rows.length ? rows : typed && !idle ? last.current : [];
  const none = typed && !rows.length && idle;

  const open = useCallback((r: LibRow) => router.push(`/reader/${r.hash}`), []);
  const swipe = useCallback((r: LibRow) => archive(r.hash, r.state !== 'archived'), []);
  const drop = useCallback((r: LibRow) => remove(r.hash), []);
  const more = useCallback((r: LibRow) => {
    openSheet(r.title ?? r.url, () => (
      <View>
        <MenuTitle>{r.title ?? r.url}</MenuTitle>
        <MenuItem icon="restore" label={S.row.backToUnread} onPress={() => closeSheet(() => archive(r.hash, false))} />
        <MenuItem icon="trash" label={S.row.delete} danger onPress={() => closeSheet(() => remove(r.hash))} />
      </View>
    ));
  }, []);

  const caption = (text: string) => <T muted style={[ui(13, 'body', 1.45), { paddingVertical: 4, paddingHorizontal: 16 }]}>{text}</T>;
  return (
    <View style={{ flex: 1, backgroundColor: c.background, paddingTop: insets.top }}>
      <View style={{ height: 56, flexDirection: 'row', alignItems: 'center', gap: 4, paddingLeft: 8, paddingRight: 16 }}>
        <IconButton icon="back" label={S.back} onPress={() => router.back()} />
        <View style={{ flex: 1, height: 48, borderRadius: radius.button, backgroundColor: c.surface, borderWidth: 1, borderColor: c.lineStrong, flexDirection: 'row', alignItems: 'center', gap: 8, paddingHorizontal: 16 }}>
          <Icon name="search" size={18} color={c.muted} />
          <TextInput
            ref={input} value={q} onChangeText={setQ} autoFocus placeholder={S.search.field} placeholderTextColor={c.muted}
            accessibilityLabel={S.search.field} autoCorrect={false} autoCapitalize="none" returnKeyType="search"
            style={[ui(15, 'body', 1.2), { flex: 1, color: c.text, paddingVertical: 0 }]}
          />
        </View>
      </View>
      {!typed ? caption(S.search.caption) : none ? (
        <Animated.View entering={FadeIn.duration(motion.quickIn.duration)} style={{ paddingVertical: 32, paddingHorizontal: 24, alignItems: 'center' }}>
          <View style={{ width: 56, height: 56, borderRadius: radius.button, backgroundColor: c.surface, borderWidth: 1, borderColor: c.line, alignItems: 'center', justifyContent: 'center' }}>
            <Icon name="search" size={26} color={c.text} />
          </View>
          <T accessibilityLiveRegion="polite" style={[ui(20, 'emptyHeading', 1.3, -0.01), { marginTop: 22, marginBottom: 8, textAlign: 'center' }]}>{S.search.noneTitle(q.trim())}</T>
          <T muted style={[ui(15, 'body', 1.45), { textAlign: 'center', maxWidth: 260, marginBottom: 24 }]}>{S.search.noneBody}</T>
          <Button label={S.search.clear} kind="secondary" onPress={() => { setQ(''); input.current?.focus(); }} />
        </Animated.View>
      ) : (
        <FlatList
          data={shown}
          keyExtractor={(r) => r.hash}
          keyboardShouldPersistTaps="handled"
          ListHeaderComponent={shown.length ? caption(S.search.results(shown.length)) : null}
          renderItem={({ item }) => (
            <View style={{ paddingHorizontal: 16 }}>
              <SaveRow r={item} online={online} onOpen={open} onSwipe={swipe} onMore={item.state === 'archived' ? more : undefined} onDelete={drop} inPlace />
            </View>
          )}
          contentContainerStyle={{ paddingBottom: 160 }}
        />
      )}
    </View>
  );
}
