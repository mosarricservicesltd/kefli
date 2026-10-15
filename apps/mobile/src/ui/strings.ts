// Every user-facing string, in British English, copied verbatim from its prototype state (mobile spec 6.11). The
// state id each comes from is beside it. "nostr" appears only on the routes the signed-off screens use it on, and
// "relay" only in Advanced (FD 86, FD 76).
import type { Notice, Space } from '../data/account';

/**
 * A count's figures with a comma each three from the right, "1,200", as the fine print's "about 2,000 articles" (FD
 * 119): a whole number of zero or more; anything else as it is. Written out rather than as a regex, which the code
 * gate misreads.
 */
function grouped(n: number): string {
  if (!Number.isInteger(n) || n < 0) return String(n);
  const digits = String(n);
  let out = '';
  for (let i = 0; i < digits.length; i++) out += (i && (digits.length - i) % 3 === 0 ? ',' : '') + digits[i];
  return out;
}

/** One to nine in words, 10 and up in figures, a thousand and up with a comma: "1,200" (the prototype's say(), FD 119). */
export function say(n: number): string {
  return n >= 1 && n <= 9 ? ['one', 'two', 'three', 'four', 'five', 'six', 'seven', 'eight', 'nine'][n - 1] : grouped(n);
}

/** "one save", "three saves", "12 saves" (the prototype's saves()). */
const saves = (n: number) => `${say(n)} ${n === 1 ? 'save' : 'saves'}`;

/**
 * Bytes in megabytes of 1,048,576, as Kefli's server counts them, to one decimal, rounded down, so a library short of
 * its quota never reads as the quota (FD 117, the prototype's mb()): 0 MB, 12.4 MB, 49.9 MB, 50 MB. Worked in tenths,
 * which are whole numbers, so no binary fraction rounds a figure up or down.
 */
export function mb(bytes: number): string {
  const tenths = Math.floor((Math.max(0, bytes) * 10) / 1_048_576);
  const rest = tenths % 10;
  return `${(tenths - rest) / 10}${rest ? `.${rest}` : ''} MB`;
}

/** About how many articles a quota holds, at 25 KB of text each, rounded to the hundred: "2,000" for 50 MB (FD 117). */
export function articles(quota: number): string {
  return grouped(Math.round(quota / 25_600 / 100) * 100);
}

// the Backup space row's sub with no figures held (adv-space-loading, adv-space-offline, adv-space-error)
const SPACE_WAIT = { checking: 'Checking…', offline: 'Checks when you’re online', failed: 'Couldn’t check' } as const;

/** The Backup space row's sub (adv, adv-space-nearly, adv-full, adv-space-empty and the three above). */
function spaceSub(s: Space): string {
  if (s.kind !== 'figures') return SPACE_WAIT[s.kind];
  const of = `${mb(s.used)} of ${mb(s.quota)}`;
  return s.level === 'full' ? `Full · ${of}` : s.level === 'nearly' ? `${of} · nearly full` : of;
}

export const S = {
  // the launch screen on a cold open (FD 97): the website's Hávamál line, in Old Norse with the English beneath
  launch: {
    name: 'Kefli',
    norse: 'Deyr fé, deyja frændr …\nen orðstírr deyr aldregi.',
    english: 'Cattle die, kinsmen die …\nbut the good name\nnever dies.',
    source: 'Hávamál',
    label: 'Kefli. Cattle die, kinsmen die, but the good name never dies. Hávamál.',
    hint: 'Tap to continue',
  },
  // welcome, welcome-early, welcome-early-many
  welcome: {
    title: 'Kefli',
    lead: 'Save anything from your phone or browser. Read it clean and offline, or listen to it.',
    earlyOne: 'You’ve already saved one article. It’ll be in your library either way.',
    earlyMany: (n: number) => `You’ve already saved ${say(n)} articles. They’ll be in your library either way.`,
    newHere: 'New here',
    haveLibrary: 'I already have a library',
    fine: 'No account, no email. Private to you.',
  },
  // return, return-offline
  ret: {
    title: 'Bring back your library',
    offline: 'Bringing back your library needs a connection',
    lead: 'Pick whichever you have to hand.',
    scan: ['Scan from my other phone', 'If you still have the phone your library is on'],
    code: ['Enter my recovery code', 'The twelve words you wrote down'],
    nostr: ['Sign in with your nostr app', 'If you already use nostr elsewhere'],
  },
  back: 'Back',
  tabs: { saves: 'Saves', listen: 'Listen', you: 'You' },
  // saves, saves-empty, saves-cleared, archive, archive-empty, saves-offline, saves-loading
  saves: {
    title: 'Saves',
    unreadCount: (n: number) => `${n} unread`,
    archivedCount: (n: number) => `${n} archived`,
    search: 'Search your saves',
    unread: 'Unread',
    archive: 'Archive',
    whichList: 'Which list',
    offline: 'Offline · showing saved copies',
    offlineFirst: 'Connecting a browser needs a connection',
    emptyTitle: 'Your library is empty',
    emptyBody: 'Share any link from any app and it lands here, cleaned up and ready to read offline.',
    connectBrowser: 'Connect your browser',
    shareTo: 'Share to',
    shareApps: ['Messages', 'Mail', 'Kefli', 'Notes'],
    allReadTitle: 'All read',
    allReadBody: 'Nothing waiting. New saves will appear here.',
    seeArchive: 'See your archive',
    archiveEmptyTitle: 'Nothing archived yet',
    archiveEmptyBody: 'Swipe an article left, or tap Archive when you finish it, and it moves here.',
  },
  // you, you-done, you-offline, you-nostr, you-voices, rec-hidden, rec-shown, rec-copied
  // FD 105: Your nostr app on You, and signing out (prototype nostrapp, nostrapp-asks, nostrapp-disc, nostrapp-disc-unsent)
  nostrApp: {
    title: 'Your nostr app',
    lead: 'Your library lives under your key, in your nostr app. Kefli asks the app to sign your saves and keep them private.',
    signedInWith: 'Signed in with',
    link: 'A sign-in link',
    saving: 'Saving',
    withoutAsking: 'Without asking',
    asks: 'Asks before each save',
    signOut: 'Sign out',
    sheetTitle: 'Sign out?',
    sheetBody: 'Kefli removes your library from this phone. Your saves stay under your key, and signing in with your nostr app again brings them back. You can remove Kefli in your nostr app too.',
    unsent: (n: number) => (n === 1
      ? 'One save hasn’t been sent yet and will be lost.'
      : `${say(n).replace(/^./, (ch) => ch.toUpperCase())} saves haven’t been sent yet and will be lost.`),
    cancel: 'Cancel',
    done: 'You’re signed out',
    // RULED: the design's one error, worded as the screens' other retries
    failed: 'Kefli couldn’t sign out. Try again.',
  },
  // FD 104: saving without asking (prototype nostr-bg, nostr-bg-waiting, nostr-bg-partial, nostr-bg-declined)
  bg: {
    title: 'Save without asking',
    lead: 'Your nostr app asks you to approve each save before Kefli can back it up. Approve once now and choose to remember it, and saving from any app needs nothing more from you.',
    open: 'Open my nostr app',
    retry: 'Try again',
    each: 'Ask me each time',
    waiting: 'Waiting for your nostr app',
    waitingLead: (n: number, of: number) => `Approve the request there and choose to remember it, then come back to Kefli. Request ${n} of ${of}.`,
    cancel: 'Cancel',
    partial: 'Your nostr app still asks before some saves. In your nostr app, let Kefli sign without asking, then try again.',
    declined: 'The request was declined in your nostr app. Kefli will ask each time you save.',
    approved: 'Saving no longer asks your nostr app',
  },
  you: {
    signedInWith: 'Signed in with your nostr app',
    nostrApp: 'Your nostr app',
    signedIn: 'Signed in',
    title: 'You',
    saves: (n: number) => (n === 1 ? 'save' : 'saves'),
    listened: 'listened',
    backupTitle: 'Back up your library',
    backupBody: 'Your saves are yours alone. A recovery code brings them back on any phone, even if this one is lost.',
    later: 'Later',
    showCode: 'Show recovery code',
    snoozed: 'Backup reminder in ten more saves',
    recovery: 'Recovery code',
    notWritten: 'Not written down',
    written: 'Written down',
    addDevice: 'Add another device',
    needsConnection: 'Needs a connection',
    browsers: 'Connected browsers',
    voice: 'Voice',
    advanced: 'Advanced',
    deleteData: 'Delete my data',
    sheetTitle: 'Your recovery code',
    sheetBody: 'These twelve words bring your library back on any phone. Write them down and keep them somewhere safe: anyone who has them can read your saves.',
    noOneLooking: 'Make sure nobody can see your screen',
    showWords: 'Show the words',
    notNow: 'Not now',
    copy: 'Copy',
    copied: 'Copied',
    done: 'Done',
    copyNote: 'Paste it somewhere safe, then clear your clipboard.',
  },
  code: {
    title: 'Enter your recovery code',
    lead: 'The twelve words from when you backed up your library, in order.',
    words: 'Your twelve words',
    paste: 'Paste',
    word: (n: number) => `Word ${n}`,
    notWord: (n: number, w: string) => `Word ${n}, “${w}”, isn’t one of the recovery words. Check the spelling.`,
    // drafted for this build: the prototype has no copy for a checksum failure (spec 5.3, "at the last field")
    notCode: 'These words aren’t a recovery code. Check each one against what you wrote down.',
    go: 'Bring back my library',
    checking: 'Checking',
    notFoundTitle: 'No saves found for this code.',
    notFoundBody: 'The words are valid, but nothing has been saved with them. Check it’s the code from Kefli’s You tab.',
    retry: 'Try again',
    fresh: 'Start fresh instead',
    offline: 'Bringing back your library needs a connection',
  },
  addDevice: {
    title: 'Add another device',
    lead: 'On the new phone, install Kefli, choose **I already have a library**, then **Scan from my other phone**. It scans this code, then asks for the six digits under it.',
    expiresIn: (t: string) => `Code expires in ${t}`,
    expired: 'This code has expired.',
    newCode: 'Show a new one',
    offline: 'Adding a device needs a connection',
    offlineLead: 'Try again when you’re online.',
    qr: 'Code for your other phone to scan',
    six: (d: string) => `Six digits: ${d.split('').join(' ')}`,
  },
  scan: {
    title: 'Scan from your other phone',
    lead: 'On your other phone, open Kefli, go to **You**, then **Add another device**. A code will appear for this phone to scan.',
    useCamera: 'Use the camera',
    cameraOnly: 'Kefli uses the camera only to read this code.',
    refusedTitle: 'The camera is switched off for Kefli',
    refusedBody: 'Scanning needs the camera. Turn it on in Android settings, or use your recovery code instead.',
    useCode: 'Use my recovery code instead',
    settings: 'Open Android settings',
    point: 'Point at the code on your other phone',
    expired: 'That code has expired. Show a new one on your other phone, then scan again.',
    scanned: 'Scanned. The six digits under the code make sure only you can use it.',
    sixLabel: 'Type the six-digit code shown on your other phone',
    wrong: 'That code didn’t match. Check the six digits on your other phone.',
    connecting: 'Connecting to your other phone',
    connectingLead: 'This takes a few seconds.',
    offline: 'Bringing back your library needs a connection',
  },
  del: {
    title: 'Delete my data',
    lead: 'This removes your library from all your devices and from Kefli’s server.',
    server: 'Your saves and their text on Kefli’s server',
    phone: 'Everything on this phone',
    phoneSub: 'Kefli starts fresh afterwards, as if just installed.',
    backups: (n: number) => (n === 1 ? 'Copies on one independent backup server' : `Copies on ${say(n)} independent backup servers`),
    backupsSub: 'We ask each to delete your copies. Each server decides for itself.',
    typeLabel: 'Type DELETE to confirm',
    go: 'Delete everything',
    offline: 'Deleting needs a connection',
    failed: 'Couldn’t reach Kefli’s server, so nothing has been deleted. Check your connection and try again.',
    running: 'Deleting your data',
    partial: 'Almost everything is gone',
    stepServer: 'Kefli’s server',
    stepBackup: (host: string) => `Backup: ${host}`,
    stepPhone: 'This phone',
    deleted: 'Deleted',
    asked: 'Asked to delete',
    notConfirmed: 'Didn’t confirm',
    otherServers: (n: number) => (n === 1 ? 'Copies on one other server' : `Copies on ${say(n)} other servers`),
    ownSub: (own: number) => `${say(own).charAt(0).toUpperCase()}${say(own).slice(1)} of them ${own === 1 ? 'is' : 'are'} your own. We ask each to delete your copies. Each server decides for itself.`,
    stepOwn: (host: string) => `Your server: ${host}`,
    waiting: 'Waiting for your nostr app',
    waitingLead: 'Approve the request there, then come back to Kefli.',
    cancel: 'Cancel',
    declined: 'The request was declined in your nostr app. Nothing has been deleted.',
    partialLineNostr: (who: string[]) => `${listOf(who)} didn’t confirm the deletion. What’s left there is encrypted, and only the key in your nostr app could open it.`,
    partialLine: (who: string[]) => `${listOf(who)} didn’t confirm the deletion. What’s left there is encrypted, and only your recovery code could open it. To be sure, destroy any copy of your recovery code.`,
    finish: 'Finish',
    done: 'Your data is deleted',
  },
  adv: {
    title: 'Advanced',
    relays: 'Relays',
    operator: 'Kefli',
    backup: (n: number) => `Backup ${n}`,
    // FD 113: a relay of the person's own (prototype adv-mine, adv-remove, adv-add, adv-add-bad, adv-add-checking,
    // adv-add-unreachable, adv-add-refused, adv-add-offline)
    yours: 'Your relay',
    add: 'Add a relay',
    addChecking: 'Checking the relay',
    addSub: 'Copy your saves to a relay you choose',
    removeHint: 'Asks whether to remove it',
    addLead: 'Kefli copies your saves to it as well as to the relays it already uses. They stay encrypted, so only you can read them.',
    addLeadShared: 'It joins the relay list your other apps share too.',
    addLabel: 'Relay address',
    addButton: 'Add relay',
    addOffline: 'You’re offline. Adding a relay needs a connection.',
    addBad: 'That isn’t a relay address. It looks like wss://relay.example.com.',
    addListed: 'Kefli already copies your saves to that relay.',
    addUnreachable: 'That relay didn’t answer. Check the address, or try again later.',
    addRefused: 'That relay won’t take your saves. It may need an account or a payment.',
    added: (host: string, copying: boolean) => (copying ? `Copying your saves to ${host}` : `Added ${host}`),
    removeTitle: 'Remove this relay?',
    removeBody: (host: string) => `Kefli stops copying your saves to ${host}. What it already holds stays there, encrypted.`,
    remove: 'Remove',
    cancel: 'Cancel',
    removed: (host: string) => `Removed ${host}`,
    connected: 'Connected',
    down: 'Not responding',
    off: 'Unreachable',
    copied: (other: boolean, n: number) => `Your ${other ? 'other ' : ''}saves are copied to ${n === 2 ? 'both' : `all ${say(n)}`}. Any one of them is enough to bring your library back.`,
    willReach: (hosts: string[]) => `Saves will reach ${listOf(hosts)} when ${hosts.length > 1 ? 'they answer' : 'it answers'} again.`,
    notBacked: (n: number) => (n === 1
      ? 'One save isn’t backed up yet. Kefli keeps trying until a backup server accepts it.'
      : `${say(n).charAt(0).toUpperCase()}${say(n).slice(1)} saves aren’t backed up yet. Kefli keeps trying until a backup server accepts them.`),
    // FD 117: saves whose text waits on the phone (prototype adv-full, adv-daily, adv-toolarge)
    full: (n: number) => `Your backup space is full, so the text of ${saves(n)} is only on this phone. Kefli tries again each day, and deleting saves makes room.`,
    daily: (n: number) => `You’ve saved a lot today, so the text of ${saves(n)} is only on this phone for now. Kefli tries again tomorrow.`,
    tooLong: (n: number) => `The text of ${saves(n)} is too long to back up, so it’s only on this phone. ${n === 1 ? 'Its link is' : 'Their links are'} backed up.`,
    // FD 117: Backup space (prototype adv-space-nearly, adv-full, adv-space-empty, adv-space-loading, adv-space-offline,
    // adv-space-error), its figures the library's own from Kefli's server, the defaults until the first answer
    space: 'Backup space',
    server: 'Kefli’s server',
    spaceSub,
    spaceNote: (quota: number, daily: number) =>
      `Kefli’s server keeps up to ${mb(quota)} of your saves’ text, about ${articles(quota)} articles, and takes up to ${mb(daily)} a day. Past that, a save’s text stays on this phone. Every save’s link is backed up whatever the space.`,
    export: 'Export my saves',
    exportSub: 'One file with every link and its text',
    exported: 'Saved kefli-export.html to Downloads',
    exportFail: 'The export didn’t save. Check the phone has space, then try again.',
    tryAgain: 'Try again',
    nostr: 'Use my nostr app instead',
    nostrSub: 'Move your saves to your nostr account',
    needsConnection: 'Needs a connection',
  },
  nostr: {
    title: 'Sign in with your nostr app',
    lead: 'Kefli asks your nostr app to confirm it’s you. Your saves stay private: only you can read them.',
    keep: 'Keep backup copies',
    keepSub: 'Adds Kefli’s server and one independent backup to the list your nostr apps share, so your saves survive any one server closing.',
    open: 'Open my nostr app',
    fresh: 'Start a new library',
    useLink: 'Use a sign-in link instead',
    waiting: 'Waiting for your nostr app',
    waitingLead: 'Approve the request there, then come back to Kefli.',
    cancel: 'Cancel',
    declined: 'The request was declined in your nostr app. Nothing has changed.',
    timeout: 'Your nostr app didn’t answer. Nothing has changed.',
    probe: 'Your nostr app can’t keep your saves private yet. Try another app, or start a new library on this phone.',
    noneTitle: 'No nostr app on this phone',
    noneLead: 'Install a nostr sign-in app, or paste a sign-in link from the one you use elsewhere.',
    linkLabel: 'Sign-in link',
    badLink: 'That link didn’t work. Copy it again from your nostr app.',
    connect: 'Connect with the link',
    importTitle: 'Bring in your bookmarks?',
    importLine: (n: number) => (n === 1
      ? 'We found one bookmark in your nostr account. In your library it’ll be private, like everything else.'
      : `We found ${say(n)} bookmarks in your nostr account. In your library they’ll be private, like everything else.`),
    importNo: 'Not now',
    importYes: 'Bring them in',
    offline: 'Bringing back your library needs a connection',
  },
  voice: {
    title: 'Voice',
    lead: 'These voices come from your phone and work offline.',
    defaultSpeed: 'Default speed',
    slower: 'Slower',
    faster: 'Faster',
    note: 'To add more voices, open Android settings, then Text-to-speech output.',
    sampleOf: (v: string) => `Play a sample of ${v}`,
    language: 'Language',
    voiceFor: (lang: string) => `${lang} voice`,
    // the prototype's short names for its locales; any other is the phone's own name for it
    short: { 'en-GB': 'UK English', 'en-US': 'US English' } as Record<string, string>,
    // RULED: a sample reads the opening of the last article played, in its language, or this line before any has been
    sampleLine: 'This is how your saves will sound.',
  },
  sw: {
    title: 'Use my nostr app instead',
    lead: 'Your saves move to your nostr account, and your nostr app keeps you signed in from then on.',
    comes: 'Every save and its text comes with you',
    comesSub: 'Nothing is lost, and it stays private.',
    stops: 'Your recovery code stops working',
    stopsSub: 'Afterwards you can throw it away. Your nostr app is how you get back in.',
    go: 'Continue with my nostr app',
    offline: 'Moving your saves needs a connection',
    declined: 'The request was declined in your nostr app. Nothing has changed.',
    probe: 'Your nostr app can’t keep your saves private yet. Try another app. Nothing has changed.',
    moving: 'Moving your saves',
    movingHead: 'Moving to your nostr account',
    count: (n: number, m: number) => `${n} of ${m}`,
    keepOpen: 'Keep Kefli open until this finishes.',
    newer: 'Some saves come from a newer version of Kefli. Update Kefli, then try again.',
    newerLead: 'Your saves are still on this phone, and your recovery code still works.',
    update: 'Update Kefli',
    done: 'Saves moved to your nostr account',
  },
  restore: {
    title: 'Bringing back your library',
    count: (found: number, total: number) => `${found} of ${total}`,
    body: 'Your saves are kept in several independent places, so this works even if Kefli’s own server is down.',
    paused: 'Paused. It will carry on when you’re online.',
    done: (n: number) => (n === 1 ? 'Your save is back' : `All ${n} saves are back`),
  },
  share: {
    saved: 'Saved to Kefli',
    again: 'Already in your library',
    savedSub: 'Private. Ready to read offline in a moment.',
    // FD 117: share-full, share-daily
    fullSub: 'Private. Your backup space is full, so its text stays on this phone.',
    dailySub: 'Private. You’ve saved a lot today, so its text stays on this phone for now.',
    againSub: 'Still in Unread, where you left it.',
    offlineSub: 'Saved · will fetch when you’re online',
    xwaitSub: 'Saved · will check the post when X answers',
    checking: 'Checking the post',
    checkingSub: 'Looking for the article it links to.',
    noArticle: 'No article in that post',
    noArticleSub: 'Kefli saves web articles, and this post doesn’t link to one.',
    noLink: 'That wasn’t a link',
    noLinkSub: 'Kefli saves web pages. Try sharing the page itself, or copy its address and share that.',
    removed: 'Removed from Kefli',
    failed: 'That didn’t save',
    failedSub: 'Try sharing it again.',
    undo: 'Undo',
    readNow: 'Read now',
    done: 'Done',
    ok: 'OK',
    cancel: 'Cancel',
  },
  browsers: {
    title: 'Connected browsers',
    lead: 'Pages you save in a connected browser arrive here the next time you open Kefli.',
    offline: 'Connecting a browser needs a connection',
    connect: 'Connect a browser',
    emptyTitle: 'No browsers yet',
    emptyBody: 'Save pages from your laptop with the Kefli extension for Chrome or Firefox.',
    disconnect: 'Disconnect',
    justNow: 'Connected just now',
    connectedOn: (date: string) => `Connected ${date}`,
    sheetTitle: (name: string) => `Disconnect ${name}?`,
    sheetBody: 'Pages saved from that browser will be ignored. Uninstall the extension there or connect it again.',
    cancel: 'Cancel',
    disconnected: (name: string) => `Disconnected from ${name}`,
  },
  conn: {
    title: 'Connect a browser',
    lead: 'On your laptop, install the Kefli extension and click its icon. If it isn’t in the toolbar, it’s under the puzzle piece. Scan the code it shows, or type the eight-character code.',
    typeInstead: 'Type the code instead',
    useCamera: 'Use the camera',
    cameraOnly: 'Kefli uses the camera only to read this code.',
    point: 'Point at the code in your browser',
    refusedTitle: 'The camera is switched off for Kefli',
    refusedBody: 'Turn it on in Android settings, or type the code instead.',
    settings: 'Open Android settings',
    expired: 'That code has expired. Show a new one in the extension, then scan again.',
    failed: 'Can’t connect right now. Check your connection and try again.',
    retry: 'Try again',
    typeLead: 'Type the code shown in the extension.',
    codeLabel: 'Code from your browser',
    wrong: 'That code didn’t match. Check it in your browser, or show a new one there.',
    confirmTitle: 'Connect this browser?',
    confirmLine: 'Pages you save there will come to this library.',
    go: 'Connect',
    busy: 'Connecting',
    cancel: 'Cancel',
    connected: (name: string) => `Connected to ${name}`,
  },
  // listen, listen-ready, listen-first, listen-empty, listen-scrolled, listen-cued, listen-scrub
  listen: {
    title: 'Listen',
    unread: (n: number) => `${n} unread`,
    nowPlaying: 'Now playing',
    paused: 'Paused',
    lastPlayed: 'Last played',
    upNext: 'Up next',
    listHead: 'Unread',
    playAll: 'Play all',
    emptyTitle: 'Nothing to listen to',
    emptyBody: 'Save an article and it’s ready to play here. It keeps playing when your screen is off.',
    goToSaves: 'Go to your saves',
    play: (t: string) => `Play ${t}`,
    pause: (t: string) => `Pause ${t}`,
    // listen-cued (FD 115): a row's body puts its article in the card
    cueHint: 'Puts it in the player',
    cued: (t: string) => `Up next: ${t}`,
    // listen-scrub (FD 115): the card's ruler, an adjustable control
    position: 'Position',
    positionValue: (elapsed: string, total: string) => `${elapsed} of ${total}`,
  },
  // search, search-none, search-reader
  search: {
    field: 'Search your saves',
    caption: 'Searches the full text of everything you’ve saved, on this phone.',
    results: (n: number) => `${n} result${n > 1 ? 's' : ''}`,
    noneTitle: (q: string) => `Nothing matches “${q}”`,
    noneBody: 'Search looks through titles, sources and full text in Unread and Archive.',
    clear: 'Clear search',
  },
  row: {
    mins: (n: number) => `${n} min`,
    minsLeft: (n: number) => `${n} min left`,
    getting: 'Getting the text…',
    willFetch: 'Will fetch when you’re online',
    // saves-embedfail (G3)
    xWaiting: 'Will check the post when X answers',
    failed: 'Couldn’t get the text',
    openOriginal: 'Open original',
    from: (browser: string) => `From ${browser}`,
    archive: 'Archive',
    backToUnread: 'Back to Unread',
    more: (title: string) => `More for ${title}`,
    delete: 'Delete',
  },
  toast: {
    archived: 'Archived',
    unarchived: 'Moved back to Unread',
    deleted: 'Deleted',
    linkCopied: 'Link copied',
    undo: 'Undo',
  },
  // reader, reader-loading, reader-offline, reader-error, reader-menu, reader-aa, reader-end
  // rsvp-start, rsvp, rsvp-paused, rsvp-done, rsvp-done-archived
  rsvp: {
    exit: 'Back to article',
    minLeft: (n: number) => `${n} min left`,
    hintStart: 'Tap to start · swipe to move by sentence',
    hintPaused: 'Tap to carry on · swipe to move by sentence',
    hintPlaying: 'Tap to pause',
    prev: 'Previous sentence',
    next: 'Next sentence',
    play: 'Play',
    pause: 'Pause',
    slower: 'Slower',
    faster: 'Faster',
    wpm: (n: number) => `${n} wpm`,
    doneTitle: 'You’ve reached the end',
    doneLine: (site: string, wpm: number) => `${site} · read at ${wpm} wpm`,
    archive: 'Archive',
    backToUnread: 'Back to Unread',
  },
  reader: {
    back: 'Back',
    listen: 'Listen',
    aa: 'Text and theme',
    speedRead: 'Speed read',
    more: 'More',
    archive: 'Archive',
    backToUnread: 'Back to Unread',
    archiveNext: 'Archive and next',
    endTitle: 'You’ve reached the end',
    savedYesterday: 'Saved yesterday',
    offlineWait: 'This page will be fetched when you’re online. Then it’s here to read, offline too.',
    errorNotice: 'We couldn’t get a clean copy of this page, so here’s the original. It won’t be available offline.',
    // flow decision 103: a PDF Kefli can't take text from says why
    pdfNoText: 'This PDF is pictures of pages, with no text to read or listen to, so here’s the original. It won’t be available offline.',
    pdfLocked: 'This PDF is locked with a password, so here’s the original. It won’t be available offline.',
    originalOffline: 'Opening the original needs a connection',
    pageFailed: 'This page won’t load here. Your browser may still open it.',
    openInBrowser: 'Open in browser',
    loadingPage: 'Loading the page',
    close: 'Close',
    iabMenu: { openInBrowser: 'Open in browser', copyLink: 'Copy link', delete: 'Delete' },
    menu: { backToUnread: 'Back to Unread', openOriginal: 'Open original', copyLink: 'Copy link', delete: 'Delete' },
    aaSheet: {
      title: 'Text',
      sub: 'Size and colours for reading. The rest of the app follows your phone.',
      smaller: 'Smaller text',
      larger: 'Larger text',
      size: (n: number) => `Text size ${n}`,
      colours: 'Reader colours',
      light: 'Light',
      sepia: 'Sepia',
      dark: 'Dark',
    },
  },
} as const;

/** "Saved today", "Saved yesterday", else "Saved on 3 October" (the prototype draws the yesterday case). */
export function savedWhen(savedAt: number, now = Date.now() / 1000): string {
  const day = (t: number) => Math.floor((t - new Date().getTimezoneOffset() * 60) / 86_400);
  const d = day(now) - day(savedAt);
  if (d <= 0) return 'Saved today';
  if (d === 1) return S.reader.savedYesterday;
  return `Saved on ${new Date(savedAt * 1000).toLocaleDateString('en-GB', { day: 'numeric', month: 'long' })}`;
}

/** "Connected just now" for the first minute, else "Connected 27 September", with the year once it isn't this one. */
export function connectedWhen(at: number, now = Date.now() / 1000): string {
  if (now - at < 60) return S.browsers.justNow;
  const d = new Date(at * 1000);
  const year = d.getFullYear() !== new Date(now * 1000).getFullYear();
  return S.browsers.connectedOn(d.toLocaleDateString('en-GB', { day: 'numeric', month: 'long', ...(year ? { year: 'numeric' } : {}) }));
}

/** Advanced's notice about saves not backed up, in the words of its state (adv-full, adv-daily, adv-notbacked, adv-toolarge). */
export function noticeText(n: Notice): string {
  const line = { full: S.adv.full, daily: S.adv.daily, trying: S.adv.notBacked, toolarge: S.adv.tooLong }[n.kind];
  return line(n.n);
}

/** a, b and c */
export function listOf(xs: string[]): string {
  return xs.length > 1 ? `${xs.slice(0, -1).join(', ')} and ${xs[xs.length - 1]}` : (xs[0] ?? '');
}
