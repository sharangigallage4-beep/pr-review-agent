import { test, describe } from 'node:test';
import assert from 'node:assert/strict';
import { findIfsIssues, isIfsFile, parsePatchLines } from './ifsCheck.js';
import type { IfsFile } from './ifsCheck.js';

/** A patch for a brand-new file: every line added. */
function addedPatch(lines: string[]): string {
  return [`@@ -0,0 +1,${lines.length} @@`, ...lines.map((l) => `+${l}`)].join('\n');
}

/** A patch that adds `added` after `before` context lines (starting at new line `before.length + 1`). */
function modifiedPatch(before: string[], added: string[]): string {
  return [
    `@@ -1,${before.length} +1,${before.length + added.length} @@`,
    ...before.map((l) => ` ${l}`),
    ...added.map((l) => `+${l}`),
  ].join('\n');
}

const titles = (files: IfsFile[]) => findIfsIssues(files).map((i) => i.title);
const START = '//(+)230203 damilk M-M001-LPS-2345-1(start)';
const FINISH = '//(+)230203 damilk M-M001-LPS-2345-1(finish)';

function added(filename: string, lines: string[], content?: string): IfsFile {
  return { filename, status: 'added', patch: addedPatch(lines), content: content ?? lines.join('\n') };
}

describe('isIfsFile / parsePatchLines', () => {
  test('recognizes only IFS model and PL/SQL extensions', () => {
    for (const f of ['a.projection', 'x/B-Cust.client', 'c.fragment', 'd.plsvc', 'e.plsql']) assert.equal(isIfsFile(f), true, f);
    for (const f of ['a.js', 'b.ts', 'c.md', 'projection']) assert.equal(isIfsFile(f), false, f);
  });

  test('numbers new-file lines, skipping removed lines', () => {
    const lines = parsePatchLines('@@ -1,3 +10,3 @@\n keep\n-gone\n+new\n keep2');
    assert.deepEqual(
      lines.map((l) => [l.n, l.text, l.added]),
      [[10, 'keep', false], [11, 'new', true], [12, 'keep2', false]]
    );
  });
});

describe('file names (BP1, NM9, NM11)', () => {
  test('a modified file with no -Cust suffix and no C prefix is a core file change', () => {
    const issue = findIfsIssues([{ filename: 'src/ShopOrderHandling.projection', status: 'modified', patch: null }])[0];
    assert.match(issue.title, /^BP1/);
    assert.equal(issue.severity, 'high');
  });

  test('-Cust files and C-prefixed files are fine to modify', () => {
    for (const filename of ['ShopOrderHandling-Cust.projection', 'CCrmCustomerHandling.projection', 'ShopOrder-Cust.plsvc']) {
      assert.deepEqual(titles([{ filename, status: 'modified', patch: null }]), [], filename);
    }
  });

  test('"Customer..." is not a C prefix (needs C followed by a capital)', () => {
    const t = titles([added('CustomerHandling.projection', ['-- Logical unit: X'])]);
    assert.ok(t.some((x) => x.startsWith('NM9')));
  });

  test('a new projection must end in Handling or Service', () => {
    assert.ok(titles([added('CFoo.projection', ['-- Logical unit: X'])]).some((x) => /NM9\/NM11/.test(x)));
    assert.deepEqual(titles([added('CFooHandling.projection', ['-- Logical unit: X'])]), []);
    assert.deepEqual(titles([added('CMsCrmInterfaceService-Cust.projection', ['-- Logical unit: X'])]), []);
  });

  test('new PL/SQL files are not held to the model-file naming rule', () => {
    assert.deepEqual(titles([added('Helpers.plsql', ['--(+)230203 damilk M-M001-LPS-2345-1(start)', '--(+)230203 damilk M-M001-LPS-2345-1(finish)'])]), []);
  });
});

describe('comment tags (CM3, CM4, CM7)', () => {
  test('the documented tagged block produces no findings', () => {
    const body = ['@Override', 'list TbwMaterialAlloc for ShopMaterialAlloc {', '   field CTfmBarcode {', '   }', '}'];
    const content = ['field Existing {', '}', START, ...body, FINISH].join('\n');
    const file: IfsFile = {
      filename: 'ShopOrderHandling-Cust.client',
      status: 'modified',
      patch: modifiedPatch(['field Existing {', '}'], [START, ...body, FINISH]),
      content,
    };
    assert.deepEqual(titles([file]), []);
  });

  test('a start tag that is never closed is reported on the start line', () => {
    const lines = [START, 'attribute CFoo Text;'];
    const issues = findIfsIssues([{ ...added('CFooHandling.projection', ['-- Logical unit: X', ...lines]) }]);
    const unclosed = issues.find((i) => /never closed/.test(i.title));
    assert.ok(unclosed);
    assert.equal(unclosed.line, 2);
  });

  test('a finish tag with a different ID than its start is reported (CM7)', () => {
    const lines = [START, 'attribute CFoo Text;', '//(+)230203 damilk M-M001-LPS-9999-1(finish)'];
    assert.ok(titles([added('CFooHandling.projection', ['-- Logical unit: X', ...lines])]).some((t) => t.startsWith('CM7')));
  });

  test('a finish tag with no start is reported', () => {
    assert.ok(titles([added('CFooHandling.projection', ['-- Logical unit: X', FINISH])]).some((t) => /without a start/.test(t)));
  });

  test('a malformed tag is reported, a legacy-looking tag line counts as malformed too', () => {
    const t = titles([added('CFooHandling.projection', ['-- Logical unit: X', '//(+) 191017 SAJILK C_DIS502-11(START)'])]);
    assert.ok(t.some((x) => /malformed/.test(x)));
  });

  test('tags use // in model files and -- in PL/SQL files (CM4)', () => {
    const wrongModel = titles([added('CFooHandling.projection', ['-- Logical unit: X', '--(+)230203 damilk M-M001-LPS-2345-1(start)', '--(+)230203 damilk M-M001-LPS-2345-1(finish)'])]);
    assert.ok(wrongModel.some((t) => t.startsWith('CM4')));
    const wrongPl = titles([added('Foo-Cust.plsvc', [START, FINISH])]);
    assert.ok(wrongPl.some((t) => t.startsWith('CM4')));
    assert.deepEqual(titles([added('Foo-Cust.plsvc', ['-- Logical unit: X', '--(+)230203 damilk M-M001-LPS-2345-1(start)', '--(+)230203 damilk M-M001-LPS-2345-1(finish)'])]), []);
  });
});

describe('untagged new code (CM3)', () => {
  const before = ['field Existing {', '}'];

  test('code added to an existing file outside any tag block is reported', () => {
    const file: IfsFile = {
      filename: 'ShopOrderHandling-Cust.client',
      status: 'modified',
      patch: modifiedPatch(before, ['field CNew {', '}']),
      content: [...before, 'field CNew {', '}'].join('\n'),
    };
    const issue = findIfsIssues([file])[0];
    assert.match(issue.title, /not wrapped in tag lines/);
    assert.equal(issue.line, 3);
  });

  test('code added inside an existing tag block is fine', () => {
    const content = [START, 'one;', 'two;', FINISH].join('\n');
    const file: IfsFile = {
      filename: 'ShopOrderHandling-Cust.client',
      status: 'modified',
      patch: '@@ -1,4 +1,4 @@\n //(+)230203 damilk M-M001-LPS-2345-1(start)\n one;\n+two;\n //(+)230203 damilk M-M001-LPS-2345-1(finish)',
      content,
    };
    assert.deepEqual(titles([file]), []);
  });

  test('without full content it only complains when no tag line was added at all', () => {
    const untagged: IfsFile = { filename: 'X-Cust.client', status: 'modified', patch: modifiedPatch(before, ['field CNew {']) };
    assert.equal(titles([untagged]).length, 1);
    const tagged: IfsFile = { filename: 'X-Cust.client', status: 'modified', patch: modifiedPatch(before, [START, 'field CNew {', FINISH]) };
    assert.deepEqual(titles([tagged]), []);
  });

  test('comment-only additions are not code', () => {
    const file: IfsFile = { filename: 'X-Cust.client', status: 'modified', patch: modifiedPatch(before, ['// just a note', '']) };
    assert.deepEqual(titles([file]), []);
  });
});

describe('@Overtake and declaration naming (BP4, NM)', () => {
  test('@Overtake is flagged, @Override is not', () => {
    const t = titles([added('CFooHandling.projection', ['-- Logical unit: X', START, '@Overtake', 'query CFoo {', '}', FINISH])]);
    assert.ok(t.some((x) => x.startsWith('BP4')));
    assert.deepEqual(titles([added('CFooHandling.projection', ['-- Logical unit: X', START, '@Override', 'query CFoo {', '}', FINISH])]), []);
  });

  test('a reference must end in Ref, and needs the C prefix in a core-named -Cust projection', () => {
    const t = titles([added('ShopHandling-Cust.projection', [START, 'reference UnitcodeLink(Unitcode) to IsoUnit(UnitCode);', FINISH])]);
    assert.ok(t.some((x) => /reference name should end with Ref/.test(x)));
    assert.ok(t.some((x) => /reference name needs the C prefix/.test(x)));
    assert.deepEqual(titles([added('ShopHandling-Cust.projection', ['-- Logical unit: X', START, 'reference CUnitcodeRef(Unitcode) to IsoUnit(UnitCode);', FINISH])]), []);
  });

  test('inside a new C-prefixed projection the elements do not need the C prefix (note in NM8)', () => {
    const t = titles([added('CCrmCustomerHandling-Cust.projection', ['-- Logical unit: X', START, 'reference UnitcodeRef(Unitcode) to IsoUnit(UnitCode);', FINISH])]);
    assert.deepEqual(t, []);
  });

  test('LOV/Query/Entity/Qry affixes in an entity or entityset name are flagged (NM2)', () => {
    const t = titles([added('CCrmHandling.projection', ['-- Logical unit: X', START, 'entityset CCompanyLovs for CCompanyLov;', 'entity CCompanyLov {', '}', FINISH])]);
    assert.equal(t.filter((x) => x.startsWith('NM2')).length, 2);
    assert.deepEqual(titles([added('CCrmHandling.projection', ['-- Logical unit: X', START, 'entityset CUserAllowedCompanies for CUserAllowedCompany;', FINISH])]), []);
  });

  test('an element redeclared under @Override keeps its core name', () => {
    const lines = ['-- Logical unit: X', START, '@Override', 'list TbwMaterialAlloc for ShopMaterialAlloc {', '}', FINISH];
    assert.deepEqual(titles([added('ShopHandling-Cust.client', lines)]), []);
  });

  test('client elements need their documented suffix, but a plain use of a command does not', () => {
    const lines = [START, 'dialog CTransferDlg for CFoo {', '}', 'command SaveCommand;', FINISH];
    const t = titles([added('CFoo.client', ['-- Logical unit: X', ...lines])]);
    assert.ok(t.some((x) => /dialog name should end with Dialog/.test(x)));
    assert.equal(t.some((x) => /command name/.test(x)), false);
  });

  test('SQL lines in PL/SQL files are never read as declarations', () => {
    const t = titles([added('Foo-Cust.plsql', ['--(+)230203 damilk M-M001-LPS-2345-1(start)', 'group by order_no', '--(+)230203 damilk M-M001-LPS-2345-1(finish)'])]);
    assert.deepEqual(t, []);
  });
});

describe('header comment (CM1)', () => {
  test('a new projection without the generated header is reported, with it is not', () => {
    assert.ok(titles([added('CFooHandling.projection', ['projection CFooHandling;'])]).some((x) => x.startsWith('CM1')));
    assert.deepEqual(titles([added('CFooHandling.projection', ['-- Logical unit: ShopOrderHandling', 'projection CFooHandling;'])]), []);
  });
});
