// 台帳ハーネスの範囲チェック（SCOPE-CHECK区間）のテスト。
// 対象のワークフローファイルから SCOPE-CHECK 区間と auditSchema を抽出して評価し、
// 実コードそのものを検証する（コピーではない）。
// 使い方: node tests/scope-check.test.js [ワークフローファイルのパス]
//   既定はこのリポジトリの ledger-morning-pipeline.js（伏せ字は実値に置き換えて評価する）。
"use strict";

const fs = require("fs");
const path = require("path");
const vm = require("vm");

const target = process.argv[2] ||
  path.join(__dirname, "..", "ledger-morning-pipeline.js");
let src = fs.readFileSync(target, "utf8");

// 公開コピーの伏せ字を実値に置き換えて評価する（実働ファイルには影響しない）。
src = src.replace(/__ORG_OWNER__/g, "Charee-Villapong");
src = src.replace(/__ORG_REPO_NAME__/g, "ai-organization");

function extractBlock(startMarker, endMarker) {
  const start = src.indexOf(startMarker);
  const end = src.indexOf(endMarker, start);
  if (start < 0 || end < 0) throw new Error("marker not found: " + startMarker);
  return src.slice(start, end);
}

// SCOPE-CHECK 区間を評価する。
const scopeCode = extractBlock(
  "// === SCOPE-CHECK-BEGIN ===", "// === SCOPE-CHECK-END ===");
const scopeSandbox = { URL: URL };
vm.createContext(scopeSandbox);
vm.runInContext(scopeCode, scopeSandbox);
const { isOrgLink, partitionByScope, auditScope } = scopeSandbox;

// auditSchema を抽出して評価する（波括弧の対応で切り出す）。
function extractConstObject(name) {
  const marker = "const " + name + " = ";
  const start = src.indexOf(marker);
  if (start < 0) throw new Error("const not found: " + name);
  let i = src.indexOf("{", start);
  let depth = 0;
  for (; i < src.length; i++) {
    if (src[i] === "{") depth++;
    else if (src[i] === "}") {
      depth--;
      if (depth === 0) return src.slice(src.indexOf("{", start), i + 1);
    }
  }
  throw new Error("unbalanced braces: " + name);
}
const auditSchema = vm.runInNewContext(
  "(" + extractConstObject("auditSchema") + ")");

const realRows = JSON.parse(fs.readFileSync(
  path.join(__dirname, "fixtures", "real-rows-2026-11-14.json"), "utf8"));

let failures = 0;
function check(name, cond) {
  if (cond) {
    console.log("ok - " + name);
  } else {
    failures++;
    console.log("FAIL - " + name);
  }
}
function eq(a, b) { return JSON.stringify(a) === JSON.stringify(b); }

// --- isOrgLink ---
check("isOrgLink: inventory-harness は組織リンク",
  isOrgLink("https://github.com/Charee-Villapong/inventory-harness") === true);
check("isOrgLink: ai-organization の Issue は組織リンク",
  isOrgLink("https://github.com/Charee-Villapong/ai-organization/issues/11") === true);
check("isOrgLink: Google スプレッドシートのリンクは組織リンクではない",
  isOrgLink("https://docs.google.com/spreadsheets/d/19wGlth8THbDMBJCi4ppIVTz0u7dE8L2X0IqnK8ZSoRw/edit") === false);
check("isOrgLink: 空文字は組織リンクではない", isOrgLink("") === false);
check("isOrgLink: 他 owner の GitHub リンクは組織リンクではない",
  isOrgLink("https://github.com/SomeoneElse/ai-organization/issues/1") === false);
check("isOrgLink: 複数 URL 中に組織リンクがあれば true",
  isOrgLink("https://docs.google.com/spreadsheets/d/xxx/edit\nhttps://github.com/Charee-Villapong/ai-organization/issues/1") === true);

// --- partitionByScope（新規行チェックの既存動作） ---
const part = partitionByScope([
  { task: "a", link: "https://github.com/Charee-Villapong/inventory-harness" },
  { task: "b", link: "" },
  { task: "c", link: "https://example.com/x" },
]);
check("partitionByScope: 組織リンクの候補だけ通過する",
  eq(part.accepted.map((c) => c.task), ["a"]) &&
  eq(part.rejected.map((c) => c.task), ["b", "c"]));

// --- auditScope: 実G値 ---
const real = auditScope(realRows);
check("auditScope: 実G値22行で疑い0件",
  real && real.status === "ok" && eq(real.suspects, []) && real.rows === 22);

// --- auditScope: 今朝の事故の再現（全行リンクなし） ---
const allEmpty = auditScope(realRows.map((r) => ({ task: r.task, link: "" })));
check("auditScope: 全行リンクなしは監査失敗（incomplete）で疑いリストを出さない",
  allEmpty && allEmpty.status === "incomplete" && eq(allEmpty.suspects, []));

// --- auditScope: 大半がリンクなし ---
const majorityEmpty = auditScope(realRows.map((r, i) =>
  ({ task: r.task, link: i < 12 ? "" : r.link })));
check("auditScope: 大半（12/22行）がリンクなしは監査失敗",
  majorityEmpty && majorityEmpty.status === "incomplete");

// --- auditScope: 少数だけリンクなし（正常系・疑いはその行だけ） ---
const oneEmpty = auditScope(realRows.map((r, i) =>
  ({ task: r.task, link: i === 0 ? "" : r.link })));
check("auditScope: 1行だけリンクなしは疑い1件で監査は成功",
  oneEmpty && oneEmpty.status === "ok" &&
  eq(oneEmpty.suspects, [realRows[0].task]));

// --- auditScope: 空行・task なし行 ---
check("auditScope: 行なしは疑い0件で成功",
  (() => { const r = auditScope([]); return r && r.status === "ok" && eq(r.suspects, []); })());
check("auditScope: task なし行は無視する",
  (() => {
    const r = auditScope([{ link: "" }, { task: "x", link: "https://github.com/Charee-Villapong/ai-organization/issues/1" }]);
    return r && r.status === "ok" && eq(r.suspects, []);
  })());

// --- auditSchema: rows[].link が必須 ---
const rowRequired = auditSchema &&
  auditSchema.properties && auditSchema.properties.rows &&
  auditSchema.properties.rows.items &&
  auditSchema.properties.rows.items.required;
check("auditSchema: rows の各項目に link が必須",
  Array.isArray(rowRequired) &&
  rowRequired.indexOf("task") >= 0 && rowRequired.indexOf("link") >= 0);

console.log(failures === 0 ? "\nALL PASS" : "\n" + failures + " FAILURES");
process.exit(failures === 0 ? 0 : 1);
