import test from 'node:test';
import assert from 'node:assert/strict';
import { sanitizeWarnings } from '../lib/ai-intake.mjs';

const lab = (date, evidence = '') => ({ kind: 'lab', payload: { date }, evidence });
const event = (type, evidence = '') => ({ kind: 'event', payload: { type, date: '2025-01-01' }, evidence });

test('完整日期误报“仅精确到月”被删除', () => {
  const out = sanitizeWarnings(
    ['日期仅精确到月: 2023-04-10'],
    [lab('2023-04-10', '2023-04-10 复查')],
    '2023-04-10 复查'
  );
  assert.deepEqual(out, []);
});

test('真实年月回填保留 date_precision', () => {
  const out = sanitizeWarnings(
    ['[date_precision] 原文仅到年月，已回填为 2023-04-01'],
    [lab('2023-04-01', '2023年4月复查')],
    '2023年4月复查'
  );
  assert.equal(out.length, 1);
  assert.match(out[0], /date_precision/);
});

test('没有字典外事件时删除 custom_event', () => {
  const out = sanitizeWarnings(
    ['[custom_event] 事件类型“新术式”不在字典'],
    [event('随访DRE')],
    '随访DRE'
  );
  assert.deepEqual(out, []);
});

test('确有字典外事件时保留 custom_event，诊断建议类仍删除', () => {
  const out = sanitizeWarnings(
    ['[custom_event] 事件类型“新术式”不在字典', '[custom_event] 事件类型“诊断建议”不在字典'],
    [event('新术式')],
    '行新术式'
  );
  assert.equal(out.length, 1);
  assert.match(out[0], /新术式/);
});

test('重复与临床建议 warning 不进入审核主提示', () => {
  const out = sanitizeWarnings(
    ['[other] 建议复查', '[other] 建议复查', '[other] 日期格式异常'],
    [lab('2025-01-01')],
    '2025-01-01'
  );
  assert.equal(out.length, 1);
  assert.match(out[0], /日期格式异常/);
});
