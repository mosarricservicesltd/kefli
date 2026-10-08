// eslint-disable-next-line @typescript-eslint/no-require-imports
const { addNip55Query } = require('../plugins/with-nip55-queries.js');

describe('the NIP-55 manifest query (mobile spec 8.4)', () => {
  test('is added once, beside queries already there', () => {
    const scheme = (m: { queries: { intent: { data?: { $: Record<string, string> }[] }[] }[] }) =>
      m.queries[0].intent.filter((i) => i.data?.some((d) => d.$['android:scheme'] === 'nostrsigner')).length;
    const empty = addNip55Query({});
    expect(scheme(empty)).toBe(1);
    expect(scheme(addNip55Query(empty))).toBe(1);
    const other = addNip55Query({ queries: [{ intent: [{ action: [{ $: { 'android:name': 'android.intent.action.VIEW' } }], data: [{ $: { 'android:scheme': 'https' } }] }] }] });
    expect(other.queries[0].intent).toHaveLength(2);
    const noIntent = addNip55Query({ queries: [{ package: [] }] });
    expect(scheme(noIntent)).toBe(1);
  });
});
