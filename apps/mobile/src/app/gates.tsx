// The development gates (week 0, the fixture and live lists, Forget this phone's library): the local stack's build only.
// Root, and through it the gates' code and their fixtures, is required only in a local build. Where the bundler knows
// the variant (process.env.KEFLI_VARIANT inlined by babel.config.js), the test below folds to false in any other
// build before Metro collects dependencies, so none of it enters that bundle (F51); where it doesn't, the variant the
// build recorded decides at run time.
import type { ComponentType } from 'react';
import { Redirect } from 'expo-router';
import { LOCAL_STACK } from '../services/config';

const Root: ComponentType | null = (process.env.KEFLI_VARIANT ?? (LOCAL_STACK ? 'local' : 'release')) === 'local'
  ? (require('../Root') as typeof import('../Root')).default
  : null;

export default function Gates() {
  return Root ? <Root /> : <Redirect href="/" />;
}
