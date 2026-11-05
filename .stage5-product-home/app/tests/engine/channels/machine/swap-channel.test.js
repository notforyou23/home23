import { test } from 'node:test';
import assert from 'node:assert/strict';
import { SwapChannel, _test } from '../../../../engine/src/channels/machine/swap-channel.js';

test('SwapChannel parses sysctl swap usage', () => {
  const parsed = _test.parseSwapUsage('vm.swapusage: total = 5120.00M  used = 4463.38M  free = 656.62M  (encrypted)');
  assert.equal(parsed.totalMb, 5120);
  assert.equal(parsed.usedMb, 4463.38);
  assert.equal(parsed.freeMb, 656.62);
  assert.equal(parsed.usedPct, 87.2);
});

test('SwapChannel parses vm_stat counters', () => {
  const parsed = _test.parseVmStat(`Mach Virtual Memory Statistics: (page size of 16384 bytes)\nPages free:                               29128.\nPages active:                            319188.\nPages inactive:                          296701.\nPages wired down:                        253125.\nPages occupied by compressor:             94707.\nSwapins:                                 674030.\nSwapouts:                               1110537.\nPageins:                               15880412.\nPageouts:                                 70709.`);
  assert.equal(parsed.pageSize, 16384);
  assert.equal(parsed.pagesFree, 29128);
  assert.equal(parsed.pagesOccupiedByCompressor, 94707);
  assert.equal(parsed.swapins, 674030);
  assert.equal(parsed.swapouts, 1110537);
});

test('SwapChannel emits collected observation and crystallizes high swap', async () => {
  const channel = new SwapChannel({
    sample: async () => ({
      at: '2026-05-02T16:21:02.965Z',
      swap: { totalMb: 5120, usedMb: 4463.38, freeMb: 656.62, usedPct: 87.2 },
      vm: { pageSize: 16384, swapins: 674030, swapouts: 1110537 },
    }),
    highSwapThresholdPct: 70,
  });
  const raw = (await channel.poll())[0];
  const parsed = channel.parse(raw);
  const obs = channel.verify(parsed);
  assert.equal(obs.channelId, 'machine.swap');
  assert.equal(obs.flag, 'COLLECTED');
  assert.equal(obs.verifierId, 'os:vm-swapusage');
  assert.equal(obs.payload.swap.usedPct, 87.2);
  assert.ok(channel.crystallize(obs));
});
