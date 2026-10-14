// What the Original view may load (mobile spec 7.1, F25): a saved page is someone else's code, so its navigations
// stay on the web. react-native-webview hands anything outside its origin whitelist to Linking.openURL with no tap
// asked for, and the phone declares nostrsigner: in its queries, so a page could open the person's signer app over
// Kefli with a request of its own making; and it logs what it can't open, page addresses included. The view
// therefore whitelists everything and decides here: http(s), and the blank frames pages make, load; nothing else
// does, and nothing is handed on to another app. Open in browser stays the person's own choice, from the menu.

const LOADS = /^(https?:\/\/|about:(blank|srcdoc)$)/i;

/** Whether the Original view loads a navigation, in any frame. */
export function originalMayLoad(url: string): boolean {
  return LOADS.test(url);
}
