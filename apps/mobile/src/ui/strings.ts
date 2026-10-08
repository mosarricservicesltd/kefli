// Every user-facing string, in British English, copied verbatim from its prototype state (mobile spec 6.11). The
// state id each comes from is beside it. "nostr" appears only on the routes the signed-off screens use it on, and
// "relay" only in Advanced (FD 86, FD 76).

/** One to nine in words, 10 and up in figures (the prototype's say()). */
export function say(n: number): string {
  return n >= 1 && n <= 9 ? ['one', 'two', 'three', 'four', 'five', 'six', 'seven', 'eight', 'nine'][n - 1] : String(n);
}

export const S = {
  // welcome, welcome-early, welcome-early-many
  welcome: {
    title: 'Shelf',
    lead: 'Save anything from your phone or browser. Read it clean and offline, or listen to it.',
    earlyOne: 'You’ve already saved one article. It’ll be on your shelf either way.',
    earlyMany: (n: number) => `You’ve already saved ${say(n)} articles. They’ll be on your shelf either way.`,
    newHere: 'New here',
    haveShelf: 'I already have a shelf',
    fine: 'No account, no email. Private to you.',
  },
  // return, return-offline
  ret: {
    title: 'Bring back your shelf',
    offline: 'Bringing back your shelf needs a connection',
    lead: 'Pick whichever you have to hand.',
    scan: ['Scan from my other phone', 'If you still have the phone your shelf is on'],
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
    emptyTitle: 'Your shelf is empty',
    emptyBody: 'Share any link from any app and it lands here, cleaned up and ready to read offline.',
    connectBrowser: 'Connect your browser',
    shareTo: 'Share to',
    shareApps: ['Messages', 'Mail', 'Shelf', 'Notes'],
    allReadTitle: 'All read',
    allReadBody: 'Nothing waiting. New saves will appear here.',
    seeArchive: 'See your archive',
    archiveEmptyTitle: 'Nothing archived yet',
    archiveEmptyBody: 'Swipe an article left, or tap Archive when you finish it, and it moves here.',
  },
  // you, you-done, you-offline, rec-hidden, rec-shown, rec-copied
  you: {
    title: 'You',
    saves: (n: number) => (n === 1 ? 'save' : 'saves'),
    listened: 'listened',
    backupTitle: 'Back up your shelf',
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
    advanced: 'Advanced',
    deleteData: 'Delete my data',
    sheetTitle: 'Your recovery code',
    sheetBody: 'These twelve words bring your shelf back on any phone. Write them down and keep them somewhere safe: anyone who has them can read your saves.',
    noOneLooking: 'Make sure nobody can see your screen',
    showWords: 'Show the words',
    notNow: 'Not now',
    copy: 'Copy',
    copied: 'Copied',
    done: 'Done',
    copyNote: 'Paste it somewhere safe, then clear your clipboard.',
  },
  // listen, listen-empty, listen-scrolled
  share: {
    saved: 'Saved to Shelf',
    again: 'Already on your shelf',
    savedSub: 'Private. Ready to read offline in a moment.',
    againSub: 'Still in Unread, where you left it.',
    offlineSub: 'Saved · will fetch when you’re online',
    xwaitSub: 'Saved · will check the post when X answers',
    checking: 'Checking the post',
    checkingSub: 'Looking for the article it links to.',
    noArticle: 'No article in that post',
    noArticleSub: 'Shelf saves web articles, and this post doesn’t link to one.',
    noLink: 'That wasn’t a link',
    noLinkSub: 'Shelf saves web pages. Try sharing the page itself, or copy its address and share that.',
    removed: 'Removed from Shelf',
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
    lead: 'Pages you save in a connected browser arrive here the next time you open Shelf.',
    offline: 'Connecting a browser needs a connection',
    connect: 'Connect a browser',
    emptyTitle: 'No browsers yet',
    emptyBody: 'Save pages from your laptop with the Shelf extension for Chrome or Firefox.',
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
    lead: 'On your laptop, install the Shelf extension and click its icon. If it isn’t in the toolbar, it’s under the puzzle piece. Scan the code it shows, or type the eight-character code.',
    typeInstead: 'Type the code instead',
    useCamera: 'Use the camera',
    cameraOnly: 'Shelf uses the camera only to read this code.',
    point: 'Point at the code in your browser',
    refusedTitle: 'The camera is switched off for Shelf',
    refusedBody: 'Turn it on in Android settings, or type the code instead.',
    settings: 'Open Android settings',
    expired: 'That code has expired. Show a new one in the extension, then scan again.',
    failed: 'Can’t connect right now. Check your connection and try again.',
    retry: 'Try again',
    typeLead: 'Type the code shown in the extension.',
    codeLabel: 'Code from your browser',
    wrong: 'That code didn’t match. Check it in your browser, or show a new one there.',
    confirmTitle: 'Connect this browser?',
    confirmLine: 'Pages you save there will come to this shelf.',
    go: 'Connect',
    busy: 'Connecting',
    cancel: 'Cancel',
    connected: (name: string) => `Connected to ${name}`,
  },
  listen: {
    title: 'Listen',
    played: (n: number) => `${n} played`,
    nowPlaying: 'Now playing',
    paused: 'Paused',
    playedHead: 'Played',
    playAll: 'Play all',
    emptyTitle: 'Nothing played yet',
    emptyBody: 'Tap Listen on any article to hear it here. It keeps playing when your screen is off.',
    goToSaves: 'Go to your saves',
    play: (t: string) => `Play ${t}`,
    pause: (t: string) => `Pause ${t}`,
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
  reader: {
    back: 'Back',
    listen: 'Listen',
    aa: 'Text and theme',
    more: 'More',
    archive: 'Archive',
    backToUnread: 'Back to Unread',
    archiveNext: 'Archive and next',
    endTitle: 'You’ve reached the end',
    savedYesterday: 'Saved yesterday',
    offlineWait: 'This page will be fetched when you’re online. Then it’s here to read, offline too.',
    errorNotice: 'We couldn’t get a clean copy of this page, so here’s the original. It won’t be available offline.',
    originalOffline: 'Opening the original needs a connection',
    pageFailed: 'This page won’t load here. Your browser may still open it.',
    openInBrowser: 'Open in browser',
    loadingPage: 'Loading the page',
    close: 'Close',
    iabMenu: { openInBrowser: 'Open in browser', copyLink: 'Copy link', delete: 'Delete' },
    menu: { speedRead: 'Speed read', backToUnread: 'Back to Unread', openOriginal: 'Open original', copyLink: 'Copy link', delete: 'Delete' },
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
