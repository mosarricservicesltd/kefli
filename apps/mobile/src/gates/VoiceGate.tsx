// The shelf-voice gate (mobile spec 12, week 0): the phone's voice through Shelf's own media session, with
// ±15 on the lock-screen card, for 30 minutes locked on battery. The engine logs progress every 30 s to a
// file read back here afterwards.
import { useEffect, useMemo, useState } from 'react';
import { Pressable, StyleSheet, Text, View } from 'react-native';
import { normaliseMarkdown, project, sentences } from '@shelf/protocol';
import { ShelfVoice } from '../../modules/shelf-voice/src';

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
      ShelfVoice.addListener('word', (e) => setWord(e.word)),
      ShelfVoice.addListener('state', (e) => { setPlaying(e.playing); setWord(e.word); }),
      ShelfVoice.addListener('ended', () => setPlaying(false)),
      ShelfVoice.addListener('error', (e) => console.log(`[shelf-gates] ${JSON.stringify({ id: 'voice-error', ok: false, detail: e.code, ms: 0 })}`)),
    ];
    return () => subs.forEach((s) => s.remove());
  }, []);

  const start = async () => {
    ShelfVoice.clearLog();
    await ShelfVoice.start({
      hash: 'gate'.padEnd(64, '0'), title: 'Thirty minutes locked', site: 'Week 0 gate',
      sentences: reading.sentences, startWord: 0, totalWords: reading.totalWords, rate: 1, wps: 3.9,
    });
  };
  const minutes = (w: number) => (w / 3.9 / 60).toFixed(1);

  return (
    <View style={s.box}>
      <Text style={s.h2}>shelf-voice: 30 minutes locked on battery</Text>
      <Text style={s.meta}>
        {reading.totalWords.toLocaleString()} words in {reading.sentences.length} sentences, about {minutes(reading.totalWords)} minutes. Now at word {word} ({minutes(word)} min), {playing ? 'speaking' : 'stopped'}.
      </Text>
      <View style={s.row}>
        <Btn label="Start" onPress={start} />
        <Btn label={playing ? 'Pause' : 'Play'} onPress={() => (playing ? ShelfVoice.pause() : ShelfVoice.play())} />
        <Btn label="−15" onPress={() => ShelfVoice.skip(-15)} />
        <Btn label="+15" onPress={() => ShelfVoice.skip(15)} />
        <Btn label="✕" onPress={() => ShelfVoice.close()} />
      </View>
      <Btn label="Show the log" onPress={() => { const l = ShelfVoice.readLog(); setLog(l); console.log(`[shelf-voice-log]\n${l}`); }} />
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
