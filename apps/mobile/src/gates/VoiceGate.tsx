// The kefli-voice gate (mobile spec 12, week 0): the phone's voice through Kefli's own media session, with
// ±15 on the lock-screen card, for 30 minutes locked on battery. The engine logs progress every 30 s to a
// file read back here afterwards.
import { useEffect, useMemo, useState } from 'react';
import { Pressable, StyleSheet, Text, View } from 'react-native';
import { normaliseMarkdown, project, sentences } from '@kefli/protocol';
import { KefliVoice } from '../../modules/kefli-voice/src';
import { LOCAL_STACK } from '../services/config';

const PARTS = [
  'A saved article waits quietly until there is time for it.',
  'When it opens on the train, the words are already on the phone, clean and easy to read.',
  'Reading aloud uses the voice the phone already has, and it keeps going with the screen locked.',
  'Each word lights up as it is spoken, so the eye can find its place again.',
  'The cover is drawn from the address, so it looks the same on every device.',
  'Nothing here needs the network once a page is saved.',
];

// About 7,500 words: over 30 minutes at 3.9 words a second.
function longReading() {
  const paras: string[] = [];
  for (let i = 0; i < 115; i++) {
    const body = Array.from({ length: 6 }, (_, k) => PARTS[(i + k) % PARTS.length]).join(' ');
    paras.push(i % 10 === 0 ? `## Part ${i / 10 + 1}\n\n${body} This is paragraph ${i + 1}.` : `${body} This is paragraph ${i + 1}.`);
  }
  return normaliseMarkdown(paras.join('\n\n'));
}

export function VoiceGate() {
  const reading = useMemo(() => {
    const p = project(longReading());
    return { sentences: sentences(p), totalWords: p.wordStarts.length };
  }, []);
  const [word, setWord] = useState(0);
  const [playing, setPlaying] = useState(false);
  const [log, setLog] = useState('');

  useEffect(() => {
    const subs = [
      KefliVoice.addListener('word', (e) => setWord(e.word)),
      KefliVoice.addListener('state', (e) => { setPlaying(e.playing); setWord(e.word); }),
      KefliVoice.addListener('ended', () => setPlaying(false)),
      KefliVoice.addListener('error', (e) => console.log(`[kefli-gates] ${JSON.stringify({ id: 'voice-error', ok: false, detail: e.code, ms: 0 })}`)),
    ];
    return () => subs.forEach((s) => s.remove());
  }, []);

  // 0.8× stretches the reading to about 56 minutes: the stage 2 gate's locked hour (FD 87)
  const start = async (rate = 1) => {
    KefliVoice.clearLog();
    // the test log is written only for this gate, and only in the local build (F7)
    KefliVoice.setLogging(LOCAL_STACK);
    await KefliVoice.start({
      hash: 'gate'.padEnd(64, '0'), title: 'Thirty minutes locked', site: 'Week 0 gate',
      sentences: reading.sentences, startWord: 0, totalWords: reading.totalWords, rate, wps: 3.9,
    });
  };
  const minutes = (w: number) => (w / 3.9 / 60).toFixed(1);

  return (
    <View style={s.box}>
      <Text style={s.h2}>kefli-voice: 30 minutes locked on battery</Text>
      <Text style={s.meta}>
        {reading.totalWords.toLocaleString()} words in {reading.sentences.length} sentences, about {minutes(reading.totalWords)} minutes. Now at word {word} ({minutes(word)} min), {playing ? 'speaking' : 'stopped'}.
      </Text>
      <View style={s.row}>
        <Btn label="Start" onPress={() => start()} />
        <Btn label="Hour (0.8×)" onPress={() => start(0.8)} />
        <Btn label={playing ? 'Pause' : 'Play'} onPress={() => (playing ? KefliVoice.pause() : KefliVoice.play())} />
        <Btn label="−15" onPress={() => KefliVoice.skip(-15)} />
        <Btn label="+15" onPress={() => KefliVoice.skip(15)} />
        <Btn label="✕" onPress={() => KefliVoice.close()} />
      </View>
      <Btn label="Show the log" onPress={() => { const l = KefliVoice.readLog(); setLog(l); console.log(`[kefli-voice-log]\n${l}`); }} />
      {log ? <Text style={s.log}>{log.trim().split('\n').slice(-14).join('\n')}</Text> : null}
    </View>
  );
}

function Btn({ label, onPress }: { label: string; onPress: () => void }) {
  return (
    <Pressable style={s.btn} onPress={onPress}>
      <Text style={s.btnText}>{label}</Text>
    </Pressable>
  );
}

const s = StyleSheet.create({
  box: { gap: 8, marginTop: 16 },
  h2: { fontSize: 17, fontWeight: '600' },
  meta: { fontSize: 13, color: '#5C5B56' },
  row: { flexDirection: 'row', flexWrap: 'wrap', gap: 8 },
  btn: { height: 44, paddingHorizontal: 14, borderRadius: 12, backgroundColor: '#17171A', justifyContent: 'center', alignSelf: 'flex-start' },
  btnText: { color: '#F3F2EE', fontSize: 15, fontWeight: '600' },
  log: { fontSize: 11, fontFamily: 'monospace', color: '#17171A' },
});
