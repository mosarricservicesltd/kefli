// Listen (mobile spec 5.7) is built in week 3; until then the tab shows its heading.
import { TabHead } from '../../screens/TabHead';
import { S } from '../../ui/strings';

export default function Listen() {
  return <TabHead title={S.tabs.listen} />;
}
