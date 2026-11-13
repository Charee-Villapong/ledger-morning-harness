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

console.log(failures === 0 ? "\nALL PASS" : "\n" + failures + " FAILURES");
process.exit(failures === 0 ? 0 : 1);
