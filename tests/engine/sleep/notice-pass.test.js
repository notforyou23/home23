import assert from 'node:assert/strict';
import { createRequire } from 'node:module';
import test from 'node:test';

const require = createRequire(import.meta.url);
const { NoticePass } = require('../../../engine/src/sleep/notice-pass.js');

function isoDate(daysFromToday) {
  const date = new Date(Date.now() + daysFromToday * 24 * 60 * 60 * 1000);
  return date.toISOString().slice(0, 10);
}

function makeNoticePass(concepts) {
  const nodes = new Map(concepts.map((concept, index) => [
    `n${index}`,
    {
      id: `n${index}`,
      concept,
      created: new Date().toISOString(),
    },
  ]));

  return new NoticePass({ nodes, edges: new Map() }, {}, {
    warn() {},
    info() {},
    debug() {},
    error() {},
  });
}

test('time-sensitive scan ignores past dates and labels today separately from upcoming dates', async () => {
  const yesterday = isoDate(-1);
  const today = isoDate(0);
  const tomorrow = isoDate(1);
  const noticePass = makeNoticePass([
    `Past cutoff was ${yesterday}.`,
    `Check same-day event on ${today}.`,
    `Prepare tomorrow item for ${tomorrow}.`,
  ]);

  const results = await noticePass.scanTimeSensitive();

  assert.deepEqual(results.map((item) => item.subject), [
    `Date mentioned today: ${today}`,
    `Upcoming date mentioned: ${tomorrow}`,
  ]);
  assert.ok(results.every((item) => !item.subject.includes(yesterday)));
});
