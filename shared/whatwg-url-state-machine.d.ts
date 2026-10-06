// Types for whatwg-url's URL-record functions, imported straight from its state machine so the package's
// URL class and webidl-conversions never load: they read SharedArrayBuffer, which Hermes lacks.
declare module 'whatwg-url/lib/url-state-machine' {
  export { basicURLParse, serializeHost, serializePath, serializeURL } from 'whatwg-url';
}
