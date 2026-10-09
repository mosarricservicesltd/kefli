// The development gates (week 0, the fixture and live lists, Forget this phone's library): the local stack's build only.
import { Redirect } from 'expo-router';
import { LOCAL_STACK } from '../services/config';
import Root from '../Root';

export default function Gates() {
  return LOCAL_STACK ? <Root /> : <Redirect href="/" />;
}
