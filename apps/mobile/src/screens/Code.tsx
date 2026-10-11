// Enter your recovery code (mobile spec 5.3, FD 23, FD 40, FD 106; prototype code-empty, code-wrong, code-ready,
// code-checking, code-notfound). Twelve fields, numbered down the columns: a space moves on, Paste (or pasting into
// any field) fills all twelve, a word fills itself in once its letters fit only one (typeIntoCode), and up to three
// words from the list are offered for the field being typed. A word not on the list is
// flagged at its field; once all twelve are words, Bring back my library derives the key and asks the relays whether
// anything was saved with it, storing the key only if so. Nothing found offers Try again (clearing the fields) or
// Start fresh instead. The window is secured while the words are on screen (7.1), and the keyboard is the kind
// that neither suggests nor learns.
import { useEffect, useRef, useState } from 'react';
import { TextInput, View } from 'react-native';
import * as Clipboard from 'expo-clipboard';
import * as Haptics from 'expo-haptics';
import { radius } from '@kefli/tokens';
import { cleanMnemonic, couldBeRecoveryWord, emptyCodeEntry, isRecoveryWord, suggestWords, typeIntoCode, type CodeEntry } from '@kefli/protocol';
import { KefliSystem } from '../../modules/kefli-system/src';
import { answerNewHere, answerRecovered } from '../services/app';
import { loadDefaults } from '../services/config';
import { pubkeyOfCode } from '../services/identity';
import { findLibrary } from '../services/recovery';
import { pool } from '../services/runner';
import { Button } from '../ui/Button';
import { Icon } from '../ui/Icon';
import { Banner, ErrLine } from '../ui/Notice';
import { useOnline } from '../ui/online';
import { Press, pressLayer } from '../ui/Press';
import { S } from '../ui/strings';
import { T, ui } from '../ui/text';
import { useTheme } from '../ui/theme';
import { Lead, OnbShell } from './Onb';

const N = 12;

export default function Code() {
  const { c } = useTheme();
  const online = useOnline();
  const [entry, setEntry] = useState<CodeEntry>(emptyCodeEntry);
  const words = entry.words;
  const [focus, setFocus] = useState<number | null>(0);
  const [checking, setChecking] = useState(false);
  const [notFound, setNotFound] = useState(false);
  const [lostConnection, setLostConnection] = useState(false);
  const [notCode, setNotCode] = useState(false);
  const fields = useRef<(TextInput | null)[]>([]);

  useEffect(() => {
    KefliSystem.setSecure(true);
    return () => {
      KefliSystem.setSecure(false);
      setEntry(emptyCodeEntry());
    };
  }, []);

  /** Field i's text changed: typeIntoCode decides what fills where, and which field the keyboard moves to. */
  const fill = (i: number, text: string) => {
    const next = typeIntoCode(entry, i, text);
    setEntry(next);
    if (next.focus === null) fields.current[i]?.blur();
    else if (next.focus !== i) fields.current[next.focus]?.focus();
    setNotCode(false);
    setLostConnection(false);
  };
  const paste = async () => {
    const t = await Clipboard.getStringAsync().catch(() => '');
    if (t) fill(0, `${t} `);
  };
  const pick = (w: string) => {
    if (focus === null) return;
    setEntry({ words: words.map((x, k) => (k === focus ? w : x)), focus: Math.min(N - 1, focus + 1), spill: null });
    if (focus < N - 1) fields.current[focus + 1]?.focus();
  };

  const bad = (i: number) => !!words[i] && !isRecoveryWord(words[i]) && !(focus === i && couldBeRecoveryWord(words[i]));
  const firstBad = words.findIndex((_, i) => bad(i));
  const ready = words.every((w) => isRecoveryWord(w));
  const suggestions = focus === null ? [] : suggestWords(words[focus] ?? '');

  const go = async () => {
    const mnemonic = cleanMnemonic(words.join(' '));
    if (!mnemonic) {
      setNotCode(true);
      Haptics.notificationAsync(Haptics.NotificationFeedbackType.Error).catch(() => undefined);
      return;
    }
    setChecking(true);
    try {
      const pubkey = await pubkeyOfCode(mnemonic);
      const found = await findLibrary({ query: (url, f) => pool.query(url, f as never), defaults: await loadDefaults() }, pubkey);
      if (found === 'found') return void (await answerRecovered(mnemonic));
      if (found === 'none') setNotFound(true);
      else setLostConnection(true);
    } finally {
      setChecking(false);
    }
  };
  const retry = () => {
    setEntry(emptyCodeEntry());
    setNotFound(false);
    setFocus(0);
  };

  if (notFound) {
    return (
      <OnbShell title={S.code.title} actions={(
        <>
          <Button label={S.code.retry} full onPress={retry} />
          <Button label={S.code.fresh} kind="quiet" full onPress={() => answerNewHere()} />
        </>
      )}>
        <View accessibilityLiveRegion="assertive" style={{ flexDirection: 'row', alignItems: 'flex-start', gap: 8, paddingVertical: 12, paddingHorizontal: 16, borderRadius: radius.container, backgroundColor: c.surface, borderWidth: 1, borderColor: c.error, marginTop: 8 }}>
          <View style={{ marginTop: 1 }}><Icon name="alert" size={16} color={c.error} /></View>
          <T style={[ui(13, 'meta', 1.4), { flex: 1 }]}>
            <T style={ui(13, 'heading', 1.4)}>{S.code.notFoundTitle}</T>
            {'\n'}{S.code.notFoundBody}
          </T>
        </View>
      </OnbShell>
    );
  }

  const field = (w: string, i: number) => {
    const wrong = bad(i) || (notCode && i === N - 1);
    return (
      <View key={i} style={{ height: 48, flexDirection: 'row', alignItems: 'center', gap: 8, paddingHorizontal: 12, borderRadius: radius.button, backgroundColor: c.surface, borderWidth: 1, borderColor: wrong ? c.error : c.lineStrong }}>
        <T muted style={[ui(13, 'body', 1), { width: 18, textAlign: 'right', fontVariant: ['tabular-nums'] }]}>{i + 1}</T>
        <TextInput
          ref={(r) => void (fields.current[i] = r)} value={w} editable={!checking} autoFocus={i === 0}
          onChangeText={(t) => fill(i, t)} onFocus={() => setFocus(i)} onBlur={() => setFocus((f) => (f === i ? null : f))}
          onSubmitEditing={() => (i < N - 1 ? fields.current[i + 1]?.focus() : undefined)} blurOnSubmit={i === N - 1} returnKeyType={i < N - 1 ? 'next' : 'done'}
          autoCapitalize="none" autoCorrect={false} autoComplete="off" importantForAutofill="no" spellCheck={false} keyboardType="visible-password"
          accessibilityLabel={S.code.word(i + 1)} accessibilityHint={wrong ? error : undefined}
          style={[ui(15, 'body', 1.2), { flex: 1, minWidth: 0, color: c.text, padding: 0 }]}
        />
      </View>
    );
  };

  const error = notCode ? S.code.notCode : firstBad >= 0 ? S.code.notWord(firstBad + 1, words[firstBad]) : '';
  return (
    <OnbShell title={S.code.title} actions={<Button label={checking ? S.code.checking : S.code.go} busy={checking} full disabled={!ready || !online} onPress={go} />}>
      {(!online || lostConnection) && <Banner text={S.code.offline} style={{ marginHorizontal: 0 }} />}
      <Lead>{S.code.lead}</Lead>
      <View style={{ flexDirection: 'row', alignItems: 'center', justifyContent: 'space-between', gap: 8, marginBottom: 12 }}>
        <T accessibilityRole="header" style={ui(17, 'heading', 1.3)}>{S.code.words}</T>
        <Press accessibilityRole="button" accessibilityLabel={S.code.paste} onPress={paste} layer={pressLayer(c.text)}
          style={{ height: 36, paddingLeft: 10, paddingRight: 12, borderRadius: radius.control, borderWidth: 1, borderColor: c.line, flexDirection: 'row', alignItems: 'center', gap: 6 }}>
          <Icon name="clipboard" size={14} color={c.text} />
          <T style={ui(13, 'title', 1)}>{S.code.paste}</T>
        </Press>
      </View>
      {/* numbered down the columns, 1 to 6 then 7 to 12, as the words are written down; Next follows them (FD 106) */}
      <View style={{ flexDirection: 'row', justifyContent: 'space-between' }}>
        {[0, 6].map((from) => (
          <View key={from} style={{ width: '48.5%', gap: 8 }}>
            {words.slice(from, from + 6).map((w, k) => field(w, from + k))}
          </View>
        ))}
      </View>
      <View style={{ flexDirection: 'row', flexWrap: 'wrap', gap: 8, minHeight: 40, marginTop: 12, marginBottom: 4 }}>
        {suggestions.map((s) => (
          <Press key={s} accessibilityRole="button" accessibilityLabel={s} onPress={() => pick(s)} layer={pressLayer(c.text)}
            style={{ height: 36, paddingHorizontal: 16, borderRadius: radius.control, borderWidth: 1, borderColor: c.line, justifyContent: 'center' }}>
            <T style={ui(13, 'meta', 1)}>{s}</T>
          </Press>
        ))}
      </View>
      <T accessibilityLiveRegion="polite" style={[ui(13, 'body', 1.45), { color: c.error, minHeight: 20 }]}>{error}</T>
    </OnbShell>
  );
}
