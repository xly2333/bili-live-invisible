'use strict';
const assert = require('node:assert/strict');
const fs = require('node:fs');
const path = require('node:path');
const test = require('node:test');
const ts = require('typescript');

const files = [
  'be-plugin/installable/bili-live-invisible.be-plugin.js',
  'be-plugin/registry/lib/plugins/bili-live-invisible/interceptor.ts',
  'be-port/full-artifact/live.invisibleView.full.js',
  'be-port/fork/registry/lib/plugins/live/bili-live-invisible/invisible.ts',
  'be-port/fork/registry/dist/plugins/live/bili-live-invisible.js',
];

for (const file of files) {
  test(`plugin source parses: ${file}`, () => {
    const text = fs.readFileSync(path.join(__dirname, file), 'utf8');
    const source = ts.createSourceFile(file, text, ts.ScriptTarget.Latest, false);
    assert.deepEqual(source.parseDiagnostics.map(d => d.messageText), []);
  });
}
