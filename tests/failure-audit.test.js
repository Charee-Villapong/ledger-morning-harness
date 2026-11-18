// Issue #35: 失敗未登録チェック（FAILURE-AUDIT区間）のテスト。
// 使い方: node tests/failure-audit.test.js [ワークフローファイルのパス]
"use strict";
const fs = require("fs");
const path = require("path");
const vm = require("vm");
const target = process.argv[2] ||
  path.join(__dirname, "..", "ledger-morning-pipeline.js");
const src = fs.readFileSync(target, "utf8");
const start = src.indexOf("// === FAILURE-AUDIT-BEGIN ===");
const end = src.indexOf("// === FAILURE-AUDIT-END ===");
if (start < 0 || end < 0) throw new Error("FAILURE-AUDIT block not found");
const sandbox = {};
vm.createContext(sandbox);
vm.runInContext(src.slice(start, end), sandbox);
const { detectUnregisteredFailures } = sandbox;

let failures = 0;
function check(name, cond) {
  if (cond) console.log("ok - " + name);
  else { failures++; console.log("FAIL - " + name); }
}
function eq(a, b) { return JSON.stringify(a) === JSON.stringify(b); }

let r = detectUnregisteredFailures([{ task: "a" }, { task: "b" }], ["a", "c"]);
check("未登録の失敗だけを返す", r.status === "ok" && eq(r.missing, ["b"]));
r = detectUnregisteredFailures([{ task: "a" }], ["a"]);
check("全て登録済みなら欠落0", r.status === "ok" && eq(r.missing, []));
r = detectUnregisteredFailures([{ task: "a" }], []);
check("台帳空＋失敗ありは incomplete で欠落を出さない",
  r.status === "incomplete" && eq(r.missing, []));
r = detectUnregisteredFailures([], []);
check("失敗なしは ok・欠落0", r.status === "ok" && eq(r.missing, []));
r = detectUnregisteredFailures([{ task: "x" }, { task: "x" }, { task: "" }, {}], ["y"]);
check("重複・空は除く", eq(r.missing, ["x"]));
r = detectUnregisteredFailures([{ task: " a " }], ["a"]);
check("前後空白はそろえる", eq(r.missing, []));

// 本人決定（2026-11-16）で登録しない失敗は、未登録でも提示しない。
// 実文字列は朝の実行ごとに表記が揺れるため、両日分＋変形で確認する。
r = detectUnregisteredFailures(
  [{ task: "FROM40登録" }, { task: "threads-tech-collection" }, { task: "typeログイン" }],
  ["何か別のタスク"]
);
check("決定済み3件（2026-11-16の実文字列）は欠落に出ない",
  r.status === "ok" && eq(r.missing, []) && r.suppressed.length === 3 && r.failures === 0);
r = detectUnregisteredFailures(
  [{ task: "FROM40の新規会員登録" }, { task: "転職サイトtypeへのログイン" }],
  ["何か別のタスク"]
);
check("決定済み（2026-11-15の表記ゆれ）も欠落に出ない",
  eq(r.missing, []) && r.suppressed.length === 2);
r = detectUnregisteredFailures([{ task: "ＦＲＯＭ４０ 登録" }, { task: "TYPE ログイン" }], ["x"]);
check("全角・大文字・空白のゆれも抑止する", eq(r.missing, []) && r.suppressed.length === 2);
r = detectUnregisteredFailures(
  [{ task: "FROM40登録" }, { task: "求人チェックパイプラインのdry-run失敗" }],
  ["x"]
);
check("決定済みと混ざっても他の失敗は従来どおり返す",
  eq(r.missing, ["求人チェックパイプラインのdry-run失敗"]) && r.suppressed.length === 1 && r.failures === 1);
r = detectUnregisteredFailures([{ task: "FROM40登録" }], []);
check("決定済みだけ＋台帳空は incomplete にしない",
  r.status === "ok" && eq(r.missing, []) && r.failures === 0);
r = detectUnregisteredFailures([{ task: "typeのプロフィール更新" }], ["x"]);
check("typeでもログインでなければ抑止しない", eq(r.missing, ["typeのプロフィール更新"]));

// 台帳側の突合も正規化する（2026-11-18 修正）：台帳タスク名の表記揺れで
// 登録済みの失敗を未登録と誤検知しない。
r = detectUnregisteredFailures([{ task: "求人チェックの失敗" }], ["求人チェック の 失敗"]);
check("台帳側の表記揺れ（空白）でも登録済みとみなす", eq(r.missing, []));
r = detectUnregisteredFailures([{ task: "ABCタスクの失敗" }], ["ａｂｃタスクの失敗"]);
check("台帳側の表記揺れ（全角・大文字小文字）でも登録済みとみなす", eq(r.missing, []));

// 汎用1語キーワードの複合化（2026-11-18 修正）：元の失敗は引き続き抑止し、
// 汎用語だけを含む無関係な失敗は抑止しない。
r = detectUnregisteredFailures(
  [{ task: "候補リスト収集パイプラインのLocationDivision enumエラー" },
   { task: "候補リストの行高バグ" },
   { task: "台帳ハーネスの完了報告欠落" }],
  ["x"]
);
check("元の失敗3件（複合キーワード化後）も欠落に出ない",
  eq(r.missing, []) && r.suppressed.length === 3);
r = detectUnregisteredFailures([{ task: "別ツールのenum定義ミス" }], ["x"]);
check("enum単独では抑止しない", eq(r.missing, ["別ツールのenum定義ミス"]));
r = detectUnregisteredFailures([{ task: "日記帳の行高ずれ" }], ["x"]);
check("行高単独では抑止しない", eq(r.missing, ["日記帳の行高ずれ"]));
r = detectUnregisteredFailures([{ task: "月次レポートの完了報告遅延" }], ["x"]);
check("完了報告単独では抑止しない", eq(r.missing, ["月次レポートの完了報告遅延"]));

console.log(failures === 0 ? "\nALL PASS" : "\n" + failures + " FAILURES");
process.exit(failures === 0 ? 0 : 1);
