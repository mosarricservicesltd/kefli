// You (mobile spec 5.8) is built in weeks 3 and 4; until then the tab shows its heading.
import { TabHead } from '../../screens/TabHead';
import { S } from '../../ui/strings';

export default function You() {
  return <TabHead title={S.tabs.you} />;
}
