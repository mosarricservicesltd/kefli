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
  row: {
    mins: (n: number) => `${n} min`,
    minsLeft: (n: number) => `${n} min left`,
    getting: 'Getting the text…',
    willFetch: 'Will fetch when you’re online',
    failed: 'Couldn’t get the text',
    openOriginal: 'Open original',
    fromChrome: 'From Chrome',
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
