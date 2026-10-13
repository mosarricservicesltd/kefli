import { readFileSync } from 'node:fs';
import { join } from 'node:path';
import { CONTRACT_VERSION } from '../src';

// The one constant that names the protocol's version follows the contract it codes against (F51): a contract bump
// without a matching change here fails.
test('CONTRACT_VERSION is the version at the top of shared/contract/contract.md', () => {
  const contract = readFileSync(join(__dirname, '../../../shared/contract/contract.md'), 'utf8');
  const header = /\*\*Version (\d+\.\d+), [A-Z][a-z]+ \d{4}\.\*\*/.exec(contract);
  expect(header?.[1]).toBe(CONTRACT_VERSION);
});
