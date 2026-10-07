// Shelf, the Android test build (CLAUDE.md, "First task"). A throwaway harness, not Shelf's UI: four tests on one
// screen, each logging its results to logcat under [shelf-test] so they can be read over USB.
//   1. Fetch a typed link and parse it with the vendored Readability + Turndown in a hidden WebView (sharing
//      now goes to the share activity, shelf-share, on the gates tab).
//   2. Speak a paragraph with expo-speech and record what onBoundary reports (word positions for highlighting).
//   3. Five minutes locked: a file through expo-audio with lock-screen controls, and the phone's own voice
//      (v1 listening is on-device only, flow decision 22), with or without a media session held open.
//   4. Time the typed-code scrypt (contract 4.4) on Hermes and check it against Node's answer.
import { useEffect, useRef, useState } from 'react';
import { Pressable, ScrollView, StyleSheet, Switch, Text, TextInput, View } from 'react-native';
import { StatusBar } from 'expo-status-bar';
import * as Speech from 'expo-speech';
import { setAudioModeAsync, useAudioPlayer, useAudioPlayerStatus } from 'expo-audio';
import { scrypt, scryptAsync } from '@noble/hashes/scrypt.js';
import { base64 } from '@scure/base';
import { countWords } from '@shelf/protocol';
import { ShelfParser, type Parsed } from './modules/shelf-parser/src';
import { LONG_TEXT, PARAGRAPH } from './src/spikeText';

const TAG = '[shelf-test]';
const log = (what: string, data?: unknown) => console.log(`${TAG} ${what} ${data === undefined ? '' : JSON.stringify(data)}`);

/* ---------- 1. share and parse ---------- */
const UA = 'Mozilla/5.0 (Windows NT 10.0; Win64; x64) AppleWebKit/537.36 (KHTML, like Gecko) Chrome/141.0.0.0 Safari/537.36';

/* ---------- 4. the typed-code scrypt ---------- */
const CODE = 'K7QM4XPD', SALT = 'shelf/pair-code/v1';
const EXPECTED = '8a0b73e641602ecd6e49f3c64dee51f053f79edfdea90594c8df40de02202d7609d5019a13dd7f175087632c13c3538550999a4c9c02f5f72f1af06a55b54fd0'; // Node 24, crypto.scryptSync
const ascii = (s: string) => Uint8Array.from(s, c => c.charCodeAt(0));
const hex = (b: Uint8Array) => Array.from(b, x => x.toString(16).padStart(2, '0')).join('');

export default function App() {
  /* 1 */
  const [manualUrl, setManualUrl] = useState('');
  const [parse, setParse] = useState<string>('Share a link to "Shelf test" from X, or type a URL.');
  const [parsed, setParsed] = useState<Parsed | null>(null);

  // Fetch the page's bytes and parse them in shelf-parser, the detached WebView (mobile spec 8.2).
  async function fetchAndParse(url: string) {
    setParse(`Fetching ${url}`); setParsed(null);
    const t0 = Date.now();
    try {
      const res = await fetch(url, { headers: { 'User-Agent': UA, Accept: 'text/html,application/xhtml+xml', 'Accept-Language': 'en-GB,en;q=0.9' } });
      const bytes = new Uint8Array(await res.arrayBuffer());
      const finalUrl = res.url || url;
      const fetchMs = Date.now() - t0;
      log('fetched', { url, finalUrl, status: res.status, bytes: bytes.length, ms: fetchMs });
      setParse(`Parsing ${bytes.length.toLocaleString()} bytes from ${finalUrl}`);
      const t1 = Date.now();
      const r = await ShelfParser.parse(base64.encode(bytes), res.headers.get('content-type') ?? '', finalUrl);
      const parseMs = Date.now() - t1;
      const words = r.ok ? countWords(r.markdown) : null;
      log('parsed', { ...r, markdown: r.ok ? r.markdown.slice(0, 300) : undefined, words, fetchMs, parseMs });
      setParsed(r);
      setParse(r.ok ? `Parsed in ${parseMs} ms (fetch ${fetchMs} ms), ${words} words` : `Parse failed: ${r.reason}`);
    } catch (e) {
      log('fetch-error', { url, error: String(e) });
      setParse(`Fetch failed: ${String(e)}`);
    }
  }

  /* 2 */
  const [word, setWord] = useState<{ i: number; n: number } | null>(null);
  const [speech, setSpeech] = useState('Not run');
  function speakParagraph() {
    Speech.stop();
    const events: { i: number; n: number; t: number; w: string }[] = [];
    const t0 = Date.now();
    Speech.speak(PARAGRAPH, {
      language: 'en-GB',
      onStart: () => log('tts-start'),
      onBoundary: (ev: { charIndex: number; charLength: number }) => {
        const e = { i: ev.charIndex, n: ev.charLength, t: Date.now() - t0, w: PARAGRAPH.slice(ev.charIndex, ev.charIndex + ev.charLength) };
        events.push(e); setWord({ i: e.i, n: e.n });
        log('boundary', e);
      },
      onDone: () => {
        const words = PARAGRAPH.split(/\s+/).filter(Boolean).length;
        const summary = { events: events.length, words, withLength: events.filter(e => e.n > 0).length, first: events.slice(0, 5), last: events.slice(-3), ms: Date.now() - t0 };
        log('tts-done', summary);
        setSpeech(`${events.length} boundary events for ${words} words; ${summary.withLength} with a length`);
        setWord(null);
      },
      onError: err => { log('tts-error', String(err)); setSpeech(`Error: ${String(err)}`); },
    });
    setSpeech('Speaking…');
  }

  /* 3 */
  const player = useAudioPlayer(require('./assets/spike/ticks-6min.wav'), { updateInterval: 1000 });
  const status = useAudioPlayerStatus(player);
  const [holdSession, setHoldSession] = useState(true);
  const [locked, setLocked] = useState('Not run');
  const lastLogged = useRef(-10);
  useEffect(() => {
    const s = Math.floor(status.currentTime);
    if (status.playing && s - lastLogged.current >= 10) { lastLogged.current = s; log('audio-position', { s, playing: status.playing, at: new Date().toISOString() }); }
  }, [status.currentTime, status.playing]);

  async function startSession(volume: number, title: string) {
    await setAudioModeAsync({ playsInSilentMode: true, shouldPlayInBackground: true, interruptionMode: 'doNotMix' });
    player.volume = volume;
    player.seekTo(0);
    player.setActiveForLockScreen(true, { title, artist: 'Shelf test' }, { showSeekForward: true, showSeekBackward: true });
    player.play();
    lastLogged.current = -10;
  }
  async function playFile() {
    Speech.stop();
    await startSession(1, 'Six minutes of ticks');
    log('file-start', { at: new Date().toISOString() });
    setLocked('Playing the file. Lock the phone now; a beep group marks each minute.');
  }
  async function speakLong() {
    player.pause();
    if (holdSession) await startSession(0, 'Reading aloud');
    const parts = LONG_TEXT;
    const t0 = Date.now();
    let done = 0, boundaries = 0;
    parts.forEach((p, k) => Speech.speak(p, {
      language: 'en-GB',
      onStart: () => log('long-start', { part: k, s: Math.round((Date.now() - t0) / 1000), at: new Date().toISOString() }),
      onBoundary: () => { boundaries++; if (boundaries % 50 === 0) log('long-boundary', { boundaries, s: Math.round((Date.now() - t0) / 1000) }); },
      onDone: () => { done++; log('long-done', { part: k, done, of: parts.length, s: Math.round((Date.now() - t0) / 1000), at: new Date().toISOString() }); if (done === parts.length) { player.pause(); setLocked('Finished reading.'); } },
      onError: err => log('long-error', { part: k, error: String(err) }),
    }));
    log('long-queued', { parts: parts.length, chars: parts.reduce((a, p) => a + p.length, 0), holdSession, at: new Date().toISOString() });
    setLocked(`Reading aloud${holdSession ? ' with a media session held' : ''}. Lock the phone now.`);
  }
  function stopAll() { Speech.stop(); player.pause(); player.setActiveForLockScreen(false); log('stopped', { at: new Date().toISOString() }); setLocked('Stopped'); }

  /* 4 */
  const [kdf, setKdf] = useState('Not run');
  async function runScrypt() {
    setKdf('Running…');
    await new Promise(r => setTimeout(r, 50));
    const runs: number[] = [];
    let out: Uint8Array = new Uint8Array();
    for (let k = 0; k < 3; k++) {
      const t = Date.now();
      out = scrypt(ascii(CODE), ascii(SALT), { N: 16384, r: 8, p: 1, dkLen: 64 });
      runs.push(Date.now() - t);
    }
    const t = Date.now();
    const outAsync = await scryptAsync(ascii(CODE), ascii(SALT), { N: 16384, r: 8, p: 1, dkLen: 64, asyncTick: 10 });
    const asyncMs = Date.now() - t;
    const match = hex(out) === EXPECTED && hex(outAsync) === EXPECTED;
    log('scrypt', { runs, asyncMs, match, lookup: hex(out).slice(0, 64) });
    setKdf(`${match ? 'Matches Node' : 'DOES NOT MATCH Node'}: ${runs.join(', ')} ms blocking, ${asyncMs} ms async`);
  }

  const para = word ? <Text>{PARAGRAPH.slice(0, word.i)}<Text style={s.hl}>{PARAGRAPH.slice(word.i, word.i + word.n)}</Text>{PARAGRAPH.slice(word.i + word.n)}</Text> : <Text>{PARAGRAPH}</Text>;
  return (
    <View style={s.root}>
      <StatusBar style="dark" />
      <ScrollView contentContainerStyle={s.scroll}>
        <Text style={s.h1}>Shelf · Android test build</Text>

        <Text style={s.h2}>1 · Share and parse</Text>
        <Text style={s.body}>{parse}</Text>
        <View style={s.row}>
          <TextInput style={s.input} value={manualUrl} onChangeText={setManualUrl} placeholder="https://…" autoCapitalize="none" autoCorrect={false} />
          <Btn label="Parse" onPress={() => manualUrl && fetchAndParse(manualUrl.trim())} />
        </View>
        {parsed?.ok ? <View style={s.card}><Text style={s.title}>{parsed.title}</Text><Text style={s.meta}>{[parsed.site, parsed.byline, `${countWords(parsed.markdown)} words`].filter(Boolean).join(' · ')}</Text><Text style={s.md}>{parsed.markdown?.slice(0, 600)}</Text></View> : null}

        <Text style={s.h2}>2 · Word positions</Text>
        <Text style={s.body}>{para}</Text>
        <View style={s.row}><Btn label="Speak" onPress={speakParagraph} /><Text style={s.meta}>{speech}</Text></View>

        <Text style={s.h2}>3 · Five minutes locked</Text>
        <Text style={s.meta}>{locked} · file at {Math.floor(status.currentTime)} s{status.playing ? ', playing' : ''}</Text>
        <View style={s.row}><Btn label="Play the file" onPress={playFile} /><Btn label="Read aloud" onPress={speakLong} /><Btn label="Stop" onPress={stopAll} /></View>
        <View style={s.row}><Switch value={holdSession} onValueChange={setHoldSession} /><Text style={s.meta}>Hold a media session while reading aloud</Text></View>

        <Text style={s.h2}>4 · Pairing code (scrypt)</Text>
        <View style={s.row}><Btn label="Time it" onPress={runScrypt} /><Text style={s.meta}>{kdf}</Text></View>
      </ScrollView>
      {/* the hidden parser: a blank page with the vendored bundle; HTML is passed in, parsed into a detached document */}
    </View>
  );
}

function Btn({ label, onPress }: { label: string; onPress: () => void }) {
  return <Pressable onPress={onPress} style={({ pressed }) => [s.btn, pressed && { opacity: 0.7 }]}><Text style={s.btnText}>{label}</Text></Pressable>;
}

// Harness colours only (ink and paper from tokens.json); this screen is never shipped.
const s = StyleSheet.create({
  root: { flex: 1, backgroundColor: '#F3F2EE' },
  scroll: { padding: 16, paddingTop: 56, paddingBottom: 48 },
  h1: { fontSize: 22, fontWeight: '700', color: '#17171A', marginBottom: 8 },
  h2: { fontSize: 16, fontWeight: '700', color: '#17171A', marginTop: 24, marginBottom: 6 },
  body: { fontSize: 15, lineHeight: 22, color: '#17171A' },
  meta: { fontSize: 13, color: '#5C5B56', flexShrink: 1 },
  row: { flexDirection: 'row', alignItems: 'center', gap: 8, marginTop: 8, flexWrap: 'wrap' },
  input: { flex: 1, minWidth: 180, height: 40, borderWidth: 1, borderColor: '#8C8A83', borderRadius: 8, paddingHorizontal: 10, backgroundColor: '#FFFFFF', color: '#17171A' },
  btn: { height: 40, paddingHorizontal: 14, borderRadius: 12, backgroundColor: '#17171A', alignItems: 'center', justifyContent: 'center' },
  btnText: { color: '#F3F2EE', fontWeight: '600' },
  card: { marginTop: 10, padding: 12, borderRadius: 14, backgroundColor: '#FFFFFF', borderWidth: 1, borderColor: '#DEDCD5' },
  title: { fontSize: 16, fontWeight: '700', color: '#17171A' },
  md: { marginTop: 8, fontSize: 13, lineHeight: 19, color: '#17171A' },
  hl: { backgroundColor: '#F2D98C' },
  hidden: { position: 'absolute', width: 1, height: 1, opacity: 0, left: -10, top: -10 },
});
