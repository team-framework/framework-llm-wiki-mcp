import test from 'node:test';
import assert from 'node:assert/strict';
import {displayMetadata} from '../src/display.js';
import {hashContent} from '../src/sections.js';

test('display prose is separated from AI metadata and bound to canonical body',()=>{
  const body='# 원문\n조건과 수치를 보존한다.\n';
  const value=displayMetadata({DisplayTitle:'읽기 쉬운 제목',DisplayContent:'짧은 설명',DisplaySourceHash:hashContent(body),verification:'verified'},body);
  assert.deepEqual(value.metadata,{verification:'verified'});
  assert.equal(value.display?.title,'읽기 쉬운 제목');
  assert.equal(value.display?.stale,false);
  assert.equal(displayMetadata({DisplayContent:'기존 설명',DisplaySourceHash:hashContent(body)},body+'변경').display?.stale,true);
});

test('snake case aliases and invalid display values do not change canonical body metadata',()=>{
  assert.equal(displayMetadata({display_title:'사람 제목'},'body').display?.title,'사람 제목');
  assert.equal(displayMetadata({DisplayContent:['not markdown'],DisplayTitle:'x'.repeat(201)},'body').display,undefined);
});
