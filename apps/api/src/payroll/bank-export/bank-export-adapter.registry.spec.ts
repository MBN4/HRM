import { BankExportAdapterRegistry } from './bank-export-adapter.registry';
import type { BankExportAdapter, BankExportFile } from './bank-export-adapter.interface';

function fakeAdapter(format: string): BankExportAdapter {
  return {
    generate: (): BankExportFile => ({ format, fileName: `${format}.txt`, contentType: 'text/plain', body: Buffer.from('x') }),
  };
}

describe('BankExportAdapterRegistry', () => {
  it('resolves a registered format to its own adapter, distinct from another registered format', () => {
    const registry = new BankExportAdapterRegistry();
    const csv = fakeAdapter('GENERIC_CSV');
    const nacha = fakeAdapter('NACHA_STUB');
    registry.register('GENERIC_CSV', csv);
    registry.register('NACHA_STUB', nacha);

    expect(registry.resolve('GENERIC_CSV')).toBe(csv);
    expect(registry.resolve('NACHA_STUB')).toBe(nacha);
  });

  it('an unregistered format resolves to undefined rather than silently falling back', () => {
    const registry = new BankExportAdapterRegistry();
    expect(registry.resolve('SOME_UNKNOWN_FORMAT')).toBeUndefined();
  });
});
