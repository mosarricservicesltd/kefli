// Enter your recovery code (mobile spec 5.3, FD 23, FD 40; prototype code-empty, code-wrong, code-ready,
// code-checking, code-notfound). Twelve fields: a space moves on, Paste (or pasting into any field) fills all
// twelve, and up to three words from the list are offered for the field being typed. A word not on the list is
// flagged at its field; once all twelve are words, Bring back my shelf derives the key and asks the relays whether
// anything was saved with it, storing the key only if so. Nothing found offers Try again (clearing the fields) or
// Start fresh instead. The window is secured while the words are on screen (7.1), and the keyboard is the kind
// that neither suggests nor learns.
import { useEffect, useRef, useState } from 'react';
import { TextInput, View } from 'react-native';
import * as Clipboard from 'expo-clipboard';
import * as Haptics from 'expo-haptics';
import { radius } from '@shelf/tokens';
import { cleanMnemonic, couldBeRecoveryWord, isRecoveryWord, suggestWords } from '@shelf/protocol';
import { ShelfSystem } from '../../modules/shelf-system/src';
import { answerNewHere, answerRecovered } from '../services/app';
import { loadDefaults } from '../services/config';
import { pubkeyOfCode } from '../services/identity';
import { findShelf } from '../services/recovery';
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
const empty = () => Array.from({ length: N }, () => '');

export default function Code() {
  const { c } = useTheme();
  const online = useOnline();
  const [words, setWords] = useState<string[]>(empty);
  const [focus, setFocus] = useState<number | null>(0);
  const [checking, setChecking] = useState(false);
  const [notFound, setNotFound] = useState(false);
  const [lostConnection, setLostConnection] = useState(false);
  const [notCode, setNotCode] = useState(false);
  const fields = useRef<(TextInput | null)[]>([]);

  useEffect(() => {
    ShelfSystem.setSecure(true);
    return () => {
      ShelfSystem.setSecure(false);
      setWords(empty());
    };
  }, []);

  /** A whole code pasted fills all twelve; words with spaces fill from field i on and move along; else one word. */
  const fill = (i: number, text: string) => {
    const parts = text.toLowerCase().split(/[\s,]+/).filter(Boolean);
    const next = [...words];
    if (parts.length >= N) {
      parts.slice(0, N).forEach((w, k) => (next[k] = w));
      fields.current[focus ?? 0]?.blur();
    } else if (parts.length > 1 || /\s$/.test(text)) {
      parts.forEach((w, k) => i + k < N && (next[i + k] = w));
      fields.current[Math.min(N - 1, i + Math.max(1, parts.length))]?.focus();
    } else {
      next[i] = text.trim().toLowerCase();
    }
    setWords(next);
    setNotCode(false);
    setLostConnection(false);
  };
  const paste = async () => {
    const t = await Clipboard.getStringAsync().catch(() => '');
    if (t) fill(0, `${t} `);
  };
  const pick = (w: string) => {
    if (focus === null) return;
    const next = [...words];
    next[focus] = w;
    setWords(next);
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
      const found = await findShelf({ query: (url, f) => pool.query(url, f as never), defaults: await loadDefaults() }, pubkey);
      if (found === 'found') return void (await answerRecovered(mnemonic));
      if (found === 'none') setNotFound(true);
      else setLostConnection(true);
    } finally {
      setChecking(false);
    }
  };
  const retry = () => {
    setWords(empty());
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
      <View style={{ flexDirection: 'row', flexWrap: 'wrap', justifyContent: 'space-between', rowGap: 8 }}>
        {words.map((w, i) => {
          const wrong = bad(i) || (notCode && i === N - 1);
          return (
            <View key={i} style={{ width: '48.5%', height: 48, flexDirection: 'row', alignItems: 'center', gap: 8, paddingHorizontal: 12, borderRadius: radius.button, backgroundColor: c.surface, borderWidth: 1, borderColor: wrong ? c.error : c.lineStrong }}>
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
        })}
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
