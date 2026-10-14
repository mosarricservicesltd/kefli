// The Saved sheet (mobile spec 5.4, FD 38, FD 39, FD 78, FD 89; prototype share, share-undone, share-again,
// share-offline, share-nolink, share-checking, share-noarticle, share-embedfail), on the share activity's own
// surface over the app shared from. The save runs as the sheet rises: it says Saved at once, its cover drawing
// from the shared address, while the page is fetched behind it; an X post is checked first, with nothing written.
//
// - Saved: Undo and Read now; the countdown, getRecommendedTimeoutMillis(4000) along the top edge in the
//   article's ink, then back to the host app. It pauses while touched and never runs with a screen reader on.
// - Already saved and unread (G2): nothing changes; Done and Read now, no Undo.
// - Offline, or X not answering (G3): saved and waiting; Undo and Done, no countdown.
// - Not a link; an X post with no article: nothing saved; OK. Checking an X post: Cancel.
// - Undo: "Removed from Kefli" for 1.5 s, then back to the host app.
//
// The spool goes once the save is written, so a process that dies before then leaves it for the start-up pickup
// (pickup.ts). A sheet that leaves the screen closes without Undo (stage 1 gate, share then lock).
import { useEffect, useMemo, useRef, useState } from 'react';
import { AccessibilityInfo, AppState, BackHandler, Pressable, StyleSheet, View } from 'react-native';
import * as Haptics from 'expo-haptics';
import { File } from 'expo-file-system';
import Animated, { Easing, cancelAnimation, useAnimatedStyle, useSharedValue, withDelay, withTiming } from 'react-native-reanimated';
import { SafeAreaProvider, useSafeAreaInsets } from 'react-native-safe-area-context';
import { ITEM_D_PREFIX, isXPost, itemHash } from '@kefli/protocol';
import { motion, radius } from '@kefli/tokens';
import { enter, exit, mark } from '@kefli/tokens/reanimated';
import { KefliShare } from '../../modules/kefli-share/src';
import { drawMs } from '../data/covers';
import { release } from '../data/outbox';
import { undoSave } from '../data/saves';
import { removeAllFiles, runOutbox } from '../services/runner';
import { saveLink, type Queued } from '../services/save';
import { store } from '../services/store';
import { Button } from '../ui/Button';
import { Cover } from '../ui/Cover';
import { ShelfCover } from '../ui/cover';
import { Dots } from '../ui/Dots';
import { Icon } from '../ui/Icon';
import { S } from '../ui/strings';
import { T, ui } from '../ui/text';
import { useTheme } from '../ui/theme';
import { activeSpools, firstLink, readSpool } from './pickup';
import { hostOf } from '../screens/SaveRow';

type Mode = 'saving' | 'checking' | 'saved' | 'again' | 'offline' | 'xwait' | 'noarticle' | 'nolink' | 'failed' | 'removed';

const log = (r: unknown) => console.log(`[kefli-save] ${JSON.stringify(r)}`);
const REMOVED_MS = 1500;

function modeOf(q: Queued): Mode {
  if (q.kind === 'unarchived') return 'saved';
  return q.kind as Mode;
}

/** The heading's check: it lands with the cover's last leaf (at most 1 s in), or sits still on a save already drawn. */
function Check({ landAfter }: { landAfter: number | null }) {
  const { c } = useTheme();
  const s = useSharedValue(landAfter === null ? 1 : 0.4);
  const o = useSharedValue(landAfter === null ? 1 : 0);
  useEffect(() => {
    if (landAfter === null) {
      // a save already drawn: the check is simply there
      s.value = 1;
      o.value = 1;
      return;
    }
    s.value = withDelay(landAfter, withTiming(1, mark));
    o.value = withDelay(landAfter, withTiming(1, mark));
  }, [landAfter, s, o]);
  const st = useAnimatedStyle(() => ({ opacity: o.value, transform: [{ scale: s.value }] }));
  return (
    <Animated.View style={[{ width: 28, height: 28, borderRadius: 14, backgroundColor: c.success, alignItems: 'center', justifyContent: 'center' }, st]}>
      <Icon name="check" size={16} color={c.onFill} />
    </Animated.View>
  );
}

export default function ShareRoot({ spoolId }: { spoolId?: string }) {
  return (
    <SafeAreaProvider>
      <SavedSheet spoolId={spoolId} />
    </SafeAreaProvider>
  );
}

function SavedSheet({ spoolId }: { spoolId?: string }) {
  const { c } = useTheme();
  const insets = useSafeAreaInsets();
  // a spool that can't be read is no share: Not a link, rather than a sheet that throws while it draws
  const entry = useMemo(() => (spoolId ? readSpool(spoolId) : null), [spoolId]);
  // once, not at every render: each address tried is normalised
  const url = useMemo(() => firstLink(entry?.text ?? null), [entry]);
  const first = useMemo(() => {
    try {
      return url ? itemHash(url) : null;
    } catch {
      return null;
    }
  }, [url]);
  const [mode, setMode] = useState<Mode>(!url ? 'nolink' : isXPost(url) ? 'checking' : 'saving');
  const [shown, setShown] = useState<{ hash: string | null; title: string | null; site: string | null }>({ hash: first, title: null, site: url ? hostOf(url) : null });
  const [drawFrom] = useState(() => Date.now());

  const result = useRef<Queued | null>(null);
  const done = useRef(false);
  const undone = useRef(false);
  const wantRead = useRef(false);
  const cancelled = useRef(false);
  const leaving = useRef(false);

  // this sheet's spool is its own; the start-up pickup leaves it alone
  useEffect(() => {
    if (!spoolId) return;
    activeSpools.add(spoolId);
    return () => void activeSpools.delete(spoolId);
  }, [spoolId]);

  // ---- the sheet's rise and fall ----
  const [h, setH] = useState(0);
  const y = useSharedValue(1000);
  const sheetStyle = useAnimatedStyle(() => ({ transform: [{ translateY: y.value }] }));
  const scrimStyle = useAnimatedStyle(() => ({ opacity: h ? Math.max(0, 1 - y.value / h) : 0 }));
  const end = (mode: 'host' | 'read', hash: string | null) => {
    if (leaving.current) return;
    leaving.current = true;
    y.value = withTiming(h || 600, exit);
    setTimeout(() => {
      const ok = KefliShare.finish(mode, mode === 'read' ? hash : null, spoolId ?? null);
      log({ step: 'finish', ok, detail: mode });
    }, motion.exit.duration);
  };

  // ---- the save's outcome ----
  const dropSpool = () => {
    if (spoolId && result.current && (done.current || undone.current)) KefliShare.deleteSpool(spoolId);
  };
  const releaseHeld = () => {
    const r = result.current;
    if (!r?.held.length) return;
    release(store(), r.held);
    r.held = [];
    runOutbox()
      .then((n) => log({ step: 'sent', ok: true, detail: `${n} outbox rows sent` }))
      .catch((e) => log({ step: 'sent', ok: false, detail: String((e as Error).message) }));
  };
  const takeBack = () => {
    const r = result.current;
    if (!r?.hash) return;
    const { staged } = undoSave(store(), store().get<{ pubkey: string }>("SELECT pubkey FROM identities WHERE role = 'active'")!.pubkey, r.hash, r.held, r.prior);
    r.held = [];
    if (!r.prior) {
      removeAllFiles(r.hash);
      for (const p of staged) {
        const f = new File(p);
        if (f.exists) f.delete();
      }
    }
    log({ step: 'undo', ok: true, detail: ITEM_D_PREFIX + r.hash });
  };

  /** Closed without Undo: the rows go to the queue and the outbox starts sending. */
  const close = (how: 'host' | 'read') => {
    if (done.current || undone.current) return;
    done.current = true;
    if (how === 'read' && !result.current) {
      wantRead.current = true; // the Reader opens once the save is written
      return;
    }
    dropSpool();
    releaseHeld();
    end(how, result.current?.hash ?? null);
  };
  const doUndo = () => {
    if (done.current || undone.current) return;
    undone.current = true;
    if (result.current) {
      takeBack();
      dropSpool();
    }
    setMode('removed');
    setTimeout(() => end('host', null), REMOVED_MS);
  };

  useEffect(() => {
    if (!url) return;
    saveLink(url, (st) => log(st))
      .then((r) => {
        result.current = r;
        log({ step: 'done', ok: true, detail: `${r.kind}: ${ITEM_D_PREFIX}${r.hash}, ${r.held.length} rows held` });
        if (undone.current) {
          takeBack();
          dropSpool();
          return;
        }
        if (done.current) {
          // closed while saving: Cancel on an X post's check saves nothing; the countdown, Done or leaving the
          // screen keep the save
          if (cancelled.current) takeBack();
          else releaseHeld();
          dropSpool();
          if (wantRead.current) {
            leaving.current = false;
            end('read', r.hash);
          }
          return;
        }
        setShown({ hash: r.hash ?? first, title: r.title, site: r.site ?? (url ? hostOf(url) : null) });
        const next = modeOf(r);
        setMode(next);
        if (next === 'saved') Haptics.notificationAsync(Haptics.NotificationFeedbackType.Success).catch(() => undefined);
        if (!r.hash) dropSpool();
      })
      .catch((e) => {
        log({ step: 'error', ok: false, detail: String((e as Error).message) });
        setMode('failed');
      });
    // eslint-disable-next-line react-hooks/exhaustive-deps
  }, []);

  // ---- the countdown ----
  const counts = mode === 'saving' || mode === 'saved' || mode === 'again';
  const bar = useSharedValue(0);
  const left = useRef<number | null>(null);
  const started = useRef(0);
  const timer = useRef<ReturnType<typeof setTimeout> | null>(null);
  const reader = useRef(false);
  const touching = useRef(false);
  const pause = () => {
    if (timer.current === null || left.current === null) return;
    clearTimeout(timer.current);
    timer.current = null;
    left.current = Math.max(0, left.current - (Date.now() - started.current));
    cancelAnimation(bar);
  };
  const run = () => {
    if (timer.current !== null || left.current === null || reader.current || touching.current || !counts) return;
    started.current = Date.now();
    const total = left.current;
    timer.current = setTimeout(() => close('host'), total);
    bar.value = withTiming(1, { duration: total, easing: Easing.linear });
  };
  useEffect(() => {
    let live = true;
    Promise.all([AccessibilityInfo.getRecommendedTimeoutMillis(motion.countdown.share), AccessibilityInfo.isScreenReaderEnabled()]).then(([ms, sr]) => {
      if (!live) return;
      left.current = ms;
      reader.current = sr;
      run();
    });
    return () => {
      live = false;
      if (timer.current !== null) clearTimeout(timer.current);
    };
    // eslint-disable-next-line react-hooks/exhaustive-deps
  }, []);
  // a save that waits (offline, X) has no countdown
  useEffect(() => (counts ? run() : pause()), [counts]); // eslint-disable-line react-hooks/exhaustive-deps
  const barStyle = useAnimatedStyle(() => ({ transform: [{ translateX: `${-100 * bar.value}%` }] }));

  // RULED: a sheet that leaves the screen (locked, or another app on top) closes without Undo, since Undo can't be
  // pressed there: its rows are released and sent at once rather than waiting for a countdown that doesn't run
  // with the screen off (stage 1 gate, share then lock; mobile spec 4.8).
  // Back and the scrim close as Done does; on the X check they cancel, as Cancel does.
  const scrimTap = () => {
    if (mode === 'removed') return;
    if (mode === 'checking') cancelled.current = true;
    close('host');
  };
  const latest = useRef({ close, scrimTap });
  latest.current = { close, scrimTap };
  useEffect(() => {
    const sub = AppState.addEventListener('change', (state) => state === 'background' && latest.current.close('host'));
    const back = BackHandler.addEventListener('hardwareBackPress', () => (latest.current.scrimTap(), true));
    return () => {
      sub.remove();
      back.remove();
    };
  }, []);

  // ---- what the sheet says ----
  const ink = shown.hash ? ShelfCover.lineInk(shown.hash, c.surface, c.text) : c.text;
  const isNew = !result.current?.prior && mode !== 'again';
  const landAfter = useMemo(
    () => (mode === 'again' || !shown.hash ? null : Math.min(1000, Math.max(0, drawMs(ShelfCover.leaves(shown.hash, { depth: 3 }).length) - (Date.now() - drawFrom)))),
    // eslint-disable-next-line react-hooks/exhaustive-deps
    [mode === 'again', shown.hash],
  );
  const heading = (icon: 'alert' | null, text: string, busy = false) => (
    <View style={{ flexDirection: 'row', alignItems: 'center', gap: 8, marginBottom: 4 }}>
      {busy && <Dots color={c.text} size={6} gap={4} />}
      {icon && <Icon name={icon} size={22} color={c.error} />}
      <T accessibilityRole="header" accessibilityLiveRegion="polite" style={[ui(20, 'emptyHeading', 1.3, -0.01), { flexShrink: 1 }]}>{text}</T>
    </View>
  );
  const sub = (text: string) => <T muted style={[ui(13, 'body', 1.45), { marginBottom: 16 }]}>{text}</T>;
  const row = (children: React.ReactNode) => <View style={{ flexDirection: 'row', gap: 8 }}>{children}</View>;

  let body: React.ReactNode;
  if (mode === 'removed') {
    body = heading(null, S.share.removed);
  } else if (mode === 'checking') {
    body = <>{heading(null, S.share.checking, true)}{sub(S.share.checkingSub)}{row(<Button label={S.share.cancel} kind="secondary" style={{ flex: 1 }} onPress={() => ((cancelled.current = true), close('host'))} />)}</>;
  } else if (mode === 'noarticle' || mode === 'nolink' || mode === 'failed') {
    const [h1, s1] = mode === 'noarticle' ? [S.share.noArticle, S.share.noArticleSub] : mode === 'nolink' ? [S.share.noLink, S.share.noLinkSub] : [S.share.failed, S.share.failedSub];
    body = <>{heading('alert', h1)}{sub(s1)}{row(<Button label={S.share.ok} kind="secondary" style={{ flex: 1 }} onPress={() => close('host')} />)}</>;
  } else {
    const again = mode === 'again';
    const waits = mode === 'offline' || mode === 'xwait';
    const line = again ? S.share.againSub : mode === 'offline' ? S.share.offlineSub : mode === 'xwait' ? S.share.xwaitSub : S.share.savedSub;
    const title = shown.title ?? (url ?? '').replace(/^https?:\/\//, '');
    body = (
      <>
        <View style={{ flexDirection: 'row', alignItems: 'center', gap: 8, marginBottom: 4 }}>
          <Check landAfter={landAfter} />
          <T accessibilityRole="header" style={[ui(20, 'emptyHeading', 1.3, -0.01), { flexShrink: 1 }]}>{again ? S.share.again : S.share.saved}</T>
        </View>
        {sub(line)}
        <View style={{ flexDirection: 'row', alignItems: 'center', gap: 12, padding: 12, borderRadius: radius.container, backgroundColor: c.background, marginBottom: 16 }}>
          {shown.hash && (
            <Animated.View key={shown.hash}>
              <Cover hash={shown.hash} size={48} radius={radius.control} drawFrom={isNew ? drawFrom : 0} />
            </Animated.View>
          )}
          <View style={{ flex: 1, minWidth: 0 }}>
            <T numberOfLines={2} style={shown.title ? ui(15, 'title', 1.35) : [ui(15, 'meta', 1.35), { color: c.muted }]}>{title}</T>
            {shown.site && <T muted numberOfLines={1} style={ui(13, 'body', 1.3)}>{shown.site}</T>}
          </View>
        </View>
        {row(
          <>
            {again
              ? <Button label={S.share.done} kind="secondary" style={{ flex: 1 }} onPress={() => close('host')} />
              : <Button label={S.share.undo} kind="secondary" style={{ flex: 1 }} onPress={doUndo} />}
            {waits
              ? <Button label={S.share.done} style={{ flex: 1 }} onPress={() => close('host')} />
              : <Button label={S.share.readNow} style={{ flex: 1 }} onPress={() => close('read')} />}
          </>,
        )}
      </>
    );
  }

  return (
    <View style={StyleSheet.absoluteFill}>
      <Animated.View style={[StyleSheet.absoluteFill, { backgroundColor: c.scrim }, scrimStyle]}>
        <Pressable accessibilityElementsHidden importantForAccessibility="no" style={StyleSheet.absoluteFill} onPress={scrimTap} />
      </Animated.View>
      <Animated.View
        accessibilityViewIsModal
        onLayout={(e) => {
          const nh = e.nativeEvent.layout.height;
          if (!h) {
            y.value = nh;
            y.value = withTiming(0, enter);
          }
          setH(nh);
        }}
        onTouchStart={() => ((touching.current = true), pause())}
        onTouchEnd={() => ((touching.current = false), run())}
        style={[{ position: 'absolute', left: 0, right: 0, bottom: 0, backgroundColor: c.surface, borderTopLeftRadius: radius.sheet, borderTopRightRadius: radius.sheet, paddingTop: 8, paddingHorizontal: 16, paddingBottom: 24 + insets.bottom }, sheetStyle]}
      >
        {counts && (
          <View style={{ position: 'absolute', left: radius.sheet, right: radius.sheet, top: 0, height: 2, borderRadius: 2, overflow: 'hidden' }}>
            <Animated.View style={[{ flex: 1, backgroundColor: ink }, barStyle]} />
          </View>
        )}
        <View style={{ width: 36, height: 4, borderRadius: 2, backgroundColor: c.lineStrong, opacity: 0.6, alignSelf: 'center', marginBottom: 16 }} />
        {body}
      </Animated.View>
    </View>
  );
}
