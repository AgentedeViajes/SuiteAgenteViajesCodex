'use strict';
const test = require('node:test');
const assert = require('node:assert/strict');
const fs = require('node:fs');
const path = require('node:path');

const sql = fs.readFileSync(path.join(__dirname, '..', 'supabase', 'preflight_tresor_deletions.sql'), 'utf8');

test('Tresor deletion preflight contains only read-only SELECT statements', () => {
  const statements = sql
    .replace(/--[^\n]*/g, '')
    .split(';')
    .map((statement) => statement.trim())
    .filter(Boolean);
  assert.equal(statements.length, 8);
  for (const statement of statements) assert.match(statement, /^SELECT\b/i);
  assert.doesNotMatch(sql, /^\s*(?:CREATE|ALTER|DROP|INSERT|UPDATE|DELETE|TRUNCATE|GRANT|REVOKE|DO)\b/im);
});

test('preflight inspects every storage.objects policy and relevant referential behavior', () => {
  assert.match(sql, /schemaname\s*=\s*'storage'[\s\S]*tablename\s*=\s*'objects'/i);
  assert.match(sql, /pg_get_constraintdef/i);
  assert.match(sql, /confdeltype/i);
  assert.match(sql, /can_manage_document_object/i);
  assert.match(sql, /pg_get_triggerdef/i);
});
