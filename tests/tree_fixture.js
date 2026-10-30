// Run the real layout model against small traces with independently known timings.
'use strict';
const assert = require('node:assert/strict');
const fs = require('node:fs');
const vm = require('node:vm');
const source = fs.readFileSync(`${__dirname}/../web/layout.js`, 'utf8');
const sep = '\u0001',
  copy = (s) => '\u0002' + s;
function fixture(extra = {}) {
  const names = extra.names || [
    'Compile',
    'Prepare',
    'Annotate IO',
    'Optimize',
    'Annotate KQL',
    'Other',
    'Wait',
    'Async',
    'Async child',
  ];
  const rows = extra.rows || [
    0, -1, 0, 100000, 1, 1, 0, 0, 60000, 0, 2, 1, 10000, 10000, 0, 5, 1, 25000, 5000, 0, 3, 0, 60000, 40000, 0, 4, 4,
    65000, 5000, 0, 6, 4, 80000, 20000, 0, 7, 0, 20000, 80000, 1, 8, 7, 30000, 10000, 0,
  ];
  const count = extra.count || 1,
    events = new Map(),
    data = { units: Array.from({ length: count }, () => ({ ms: rows[3] / 1000, k: 0 })) };
  const X = {
    data,
    S: { factors: new Map() },
    meta: { unit: 'Compile', chunk: count },
    NU: count,
    GRID: 1000,
    ROOT: '~root',
    ROOT2: '~two',
    checkLayout: true,
    chunk: () => ({ names, trees: Array.from({ length: count }, () => ({ rows, links: extra.links || [] })) }),
    on: (n, f) => events.set(n, f),
    emit: () => {},
    render: () => {},
    tokens: () => {},
    chunksLoaded: () => 1,
    chunkCount: 1,
    reindex: () => {
      data.columnIndex = new Map(data.columns.map((c, k) => [c.id, k]));
    },
  };
  const context = { window: { TX: X }, localStorage: { getItem: () => null, setItem: () => {} } };
  vm.runInNewContext(fs.readFileSync(`${__dirname}/../web/flows.js`, 'utf8'), context);
  vm.runInNewContext(fs.readFileSync(`${__dirname}/../web/definition-model.js`, 'utf8'), context);
  vm.runInNewContext(fs.readFileSync(`${__dirname}/../web/tree-model.js`, 'utf8'), context);
  vm.runInNewContext(source, context);
  events.get('chunk')(0);
  const T = X.layout,
    path = (...xs) => xs.join(sep),
    root = 'Compile';
  return {
    X,
    T,
    root,
    a: path(root, 'Prepare'),
    b: path(root, 'Optimize'),
    x: path(root, 'Prepare', 'Annotate IO'),
    y: path(root, 'Optimize', 'Annotate KQL'),
    z: path(root, 'Prepare', 'Other'),
    async: path(root, 'Async'),
  };
}

module.exports = { fixture, assert };
