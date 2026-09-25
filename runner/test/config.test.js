// runner/lib/config.js 纯函数单测（issue #84 P5 后续：maxRounds env 化）。
import test from 'node:test';
import assert from 'node:assert/strict';
import { parseMaxRounds } from '../lib/config.js';

test('parseMaxRounds：合法值透传', () => {
  assert.equal(parseMaxRounds('16'), 16);
  assert.equal(parseMaxRounds('8'), 8);
  assert.equal(parseMaxRounds('1'), 1);
  assert.equal(parseMaxRounds('200'), 200);
});

test('parseMaxRounds：非法/越界/缺省 → 默认 16', () => {
  for (const bad of [undefined, null, '', 'abc', '16.5', '0', '-3', '201', '1e3', ' 16 ']) {
    assert.equal(parseMaxRounds(bad), 16, `应回退默认：${JSON.stringify(bad)}`);
  }
});

test('parseMaxRounds：边界可注入', () => {
  assert.equal(parseMaxRounds(undefined, { defaultValue: 8 }), 8);
  assert.equal(parseMaxRounds('999', { max: 100 }), 16);
  assert.equal(parseMaxRounds('64', { max: 100 }), 64);
});
