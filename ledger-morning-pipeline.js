export const meta = { name: "ledger-morning-pipeline", description: "タスク台帳の朝の4段（新規収集→現況更新・最新化→確認・前進→報告）を直列に実行するハーネス。各段は専任エージェントで、前の段の完了後に必ず次が実行される。段が失敗したらハーネスがその段を再実行する（最大3回）。", phases: ["collect", "refresh", "scan", "report"] };

const inputs = args ?? {};
const date = inputs.date;

const stageSchema = {
  type: "object",
  properties: {
    status: { type: "string", enum: ["success", "failed"] },
    summary: { type: "string" },
    reports: {
      type: "array",
      items: {
        type: "object",
        properties: {
          destination: { type: "string", enum: ["main", "ai-org"] },
          text: { type: "string" }
        },
        required: ["destination", "text"]
      }
    }
  },
  required: ["status", "summary", "reports"]
};

const candidateSchema = {
  type: "object",
  properties: {
    status: { type: "string", enum: ["success", "failed"] },
    summary: { type: "string" },
    reports: {
      type: "array",
      items: {
        type: "object",
        properties: {
          destination: { type: "string", enum: ["main", "ai-org"] },
          text: { type: "string" }
        },
        required: ["destination", "text"]
      }
    },
    candidates: {
      type: "array",
      items: {
        type: "object",
        properties: {
          task: { type: "string" },
          state: { type: "string" },
          reason: { type: "string" },
          checkMethod: { type: "string" },
          due: { type: "string" },
          link: { type: "string" }
        },
        required: ["task", "link"]
      }
    }
  },
  required: ["status", "summary", "reports"]
};

const auditSchema = {
  type: "object",
  properties: {
    status: { type: "string", enum: ["success", "failed"] },
    summary: { type: "string" },
    reports: {
      type: "array",
      items: {
        type: "object",
        properties: {
          destination: { type: "string", enum: ["main", "ai-org"] },
          text: { type: "string" }
        },
        required: ["destination", "text"]
      }
    },
    rows: {
      type: "array",
      items: {
        type: "object",
        properties: {
          task: { type: "string" },
          link: { type: "string" }
        },
        required: ["task"]
      }
    }
  },
  required: ["status", "summary", "reports"]
};

// === SCOPE-CHECK-BEGIN ===
// 台帳の対象範囲（AI組織のタスクのみ）の機械チェック。文章のルールではなく、この関数の判定が正。
// 関連リンク（G列）に、対象組織の GitHub リポジトリへのリンクが含まれていれば範囲内とする。
const ORG_REPO_OWNER = "__ORG_OWNER__";
const ORG_REPO_NAMES = [
  "__ORG_REPO_NAME__",
  "interview-notes",
  "cron-watchdog",
  "entropy-reduction",
  "job-candidate-list",
  "sheet-writer",
  "mac-connection",
  "ledger-morning-harness",
  "tool-catalog",
  "kids-mac-notify"
];
function extractUrls(text) {
  if (!text) return [];
  return String(text).match(/https?:\/\/[^\s"'<>\])）]+/g) || [];
}
function isOrgLink(linkText) {
  return extractUrls(linkText).some((u) => {
    let url;
    try {
      url = new URL(u);
    } catch (e) {
      return false;
    }
    if (url.hostname !== "github.com") return false;
    const parts = url.pathname.split("/").filter(Boolean);
    return parts.length >= 2 && parts[0] === ORG_REPO_OWNER && ORG_REPO_NAMES.indexOf(parts[1]) >= 0;
  });
}
function partitionByScope(candidates) {
  const accepted = [];
  const rejected = [];
  for (const c of candidates || []) {
    if (isOrgLink(c && c.link)) accepted.push(c);
    else rejected.push(c);
  }
  return { accepted, rejected };
}
function auditScope(rows) {
  const suspects = [];
  for (const r of rows || []) {
    if (!r || !r.task) continue;
    if (!isOrgLink(r.link)) suspects.push(r.task);
  }
  return suspects;
}
// === SCOPE-CHECK-END ===

const commonRules = [
  "今日の日付は " + date + " です。",
  "対象シート：スプレッドシート「Muse のタスク台帳」（ID: __SPREADSHEET_ID__, タブ「タスク台帳」）。列は A=不要チェックボックス、B=タスク、C=状態、D=止まってる理由・前提条件、E=前提の確認方法、F=期日・次回確認日、G=関連リンク、H=最終更新。",
  "シートの書き込みは sheet-writer の流儀（本表は8要素）に従い、書き込み後に必ず読み戻して検証すること。見切れが出たら検査役の --fix で書式のみ直す。行の削除は絶対にしない。",
  "失敗したら1回で諦めない。原因を特定し、手段や順序を変えて再試行する（最大3回。同じ手段の単純な繰り返しは数えない）。",
  "結果は必ず schema の形で返す：status（成功なら success、自分の役目を完了できなかったら failed）、summary（実施内容の短い要約）、reports（報告の配列、無ければ空配列）。"
].join("\n");

function retryNote(last, attempt) {
  if (!last) return "";
  return "これは再実行（" + attempt + "回目）です。前回の試行は次の理由で失敗しました：" + last.summary + "。原因を踏まえ、手段や順序を変えて実施してください。書き込みや送信は対象を読み直してから行い、済んだ分を二重に行わないでください。";
}

async function runStage(stageKey, label, buildPrompt, schema) {
  let last = null;
  for (let attempt = 1; attempt <= 3; attempt++) {
    let res = null;
    try {
      res = await agent(buildPrompt(last, attempt), {
        key: stageKey + "-" + attempt,
        label: attempt > 1 ? label + "（再実行" + attempt + "回目）" : label,
        schema: schema || stageSchema,
        timeoutMs: 1800000
      });
    } catch (e) {
      res = { status: "failed", summary: "エージェントが異常終了した: " + String((e && e.message) || e), reports: [] };
    }
    if (res && res.status === "success") return res;
    last = res || { status: "failed", summary: "結果が返らなかった", reports: [] };
    log(label + " attempt " + attempt + " failed", { summary: last.summary });
  }
  return last;
}

// 対象範囲チェック（コード側）の結果はここに集め、報告段へ必ず渡す。
const scopeReports = [];
const scopeRejectedNew = [];
let scopeSuspectExisting = [];

phase("collect");
// 1段目は「候補の収集（書き込まない）→ コードによる対象範囲チェック → 通過した候補だけ登録」の順で固定する。
const collectCandidates = await runStage("collect-candidates", "1段目：新規収集（候補の収集）", (last, attempt) =>
  [
    "あなたは「タスク台帳の新規収集」専任のエージェントです。毎朝の流れは4段（新規収集→現況更新→確認→報告）で、あなたは1段目です。役割は1つだけ：まだ台帳に載っていない新しいタスク・持ち越しを拾い、登録候補として構造化して返すこと。シートへの書き込みはまだしないでください（登録は、対象範囲の機械チェックを通った候補だけを、後段の登録係が行います）。既存行の現況更新と、前提確認・前進はあなたの仕事ではありません。報告は自分でチャットに送信せず、結果の reports に {destination, text} の形で入れて返すこと（destination は \"main\"＝メインチャット、\"ai-org\"＝AI組織チャット）。送信は4段目の報告係が行う。",
    commonRules,
    "対象範囲（2026-11-12 本人指示）：この台帳に載せるのは、AI組織が行うべきタスクのみ。",
    "- 対象：組織リポジトリ（__ORG_REPO__）の Issue、組織の運用（朝の台帳フロー・死活確認・企画会議など）、組織が開発・保守する仕組み（interview-notes／cron-watchdog／entropy-reduction／job-candidate-list／sheet-writer 等）に関するタスク。",
    "- 対象外：本人の転職活動の連絡待ち・応募判断、個人用ツールの管理判断、その他の個人的な確認事項。これらは拾う先に持ち越しとして現れても、候補に入れない。",
    "拾う先：",
    "1. GitHub リポジトリ __ORG_REPO__ の open な Issue と、その最新コメントで新たに生じた作業・残件・本人の決定事項（gh は gh）。",
    "2. 前日と当日の観測メモ（~/memory/YYYY-MM-DD.md）に書かれた持ち越し・未完了の申し送り。",
    "3. 他のゴールや仕組み（稼働見守り、エントロピー削減など）の状態変化で、新しく追うべき作業が生じていないか。",
    "候補の返し方：",
    "- まず台帳の既存行を全部読み、同じタスクが既にある場合は候補に入れない（重複を作らない）。",
    "- 候補は candidates に1件ずつ入れる：task（タスク名、短く具体的に）、state（未着手／待ち／進行中）、reason（止まってる理由・前提条件、現在の前提と残件だけ）、checkMethod（前提の確認方法。「何を・どこで見て・どうなったら解消か」が機械的に判定できる形）、due（期日・次回確認日。日付で。決まらなければ1週間後）、link（関連リンク。原則として対象組織の GitHub リンク＝組織リポジトリの Issue、または組織の実装リポジトリの URL を入れる。付けられない候補は link を空文字にする。その候補は機械チェックで登録対象から外れ、報告に載る）。",
    "- 拾ったものが「タスク」かどうか曖昧な場合は候補に入れない（推測で増やさない）。",
    "- reports は原則として空でよい（追加の通知は登録係が行う）。3回再試行しても収集作業自体ができなかった場合は status を failed にし、「今朝の新規収集は失敗した（理由）」という報告を reports（main）に入れる。",
    retryNote(last, attempt)
  ].join("\n"), candidateSchema
);

let collect;
if (collectCandidates.status !== "success") {
  collect = collectCandidates;
} else {
  const partition = partitionByScope(collectCandidates.candidates || []);
  for (const c of partition.rejected) {
    scopeRejectedNew.push(c.task);
    scopeReports.push({ destination: "main", text: "🤖AI組織・事務連絡 台帳の対象範囲チェック：新規行「" + c.task + "」は関連リンクが組織のものでないため登録しませんでした。" });
  }
  log("scope check (new rows)", { accepted: partition.accepted.length, rejected: partition.rejected.length });
  if (partition.accepted.length === 0) {
    collect = { status: "success", summary: collectCandidates.summary + "／範囲チェック通過0件のため登録なし（弾いた新規行 " + partition.rejected.length + " 件）", reports: collectCandidates.reports || [] };
  } else {
    const registered = await runStage("collect-register", "1段目：新規収集（登録）", (last, attempt) =>
      [
        "あなたは「タスク台帳の新規行の登録」専任のエージェントです。対象範囲の機械チェックを通った登録候補（JSON）を、台帳へ行として追加するのが役割です。候補以外の行は追加しないでください。既存行の現況更新と、前提確認・前進はあなたの仕事ではありません。報告は自分でチャットに送信せず、結果の reports に {destination, text} の形で入れて返すこと（destination は \"main\"＝メインチャット、\"ai-org\"＝AI組織チャット）。送信は4段目の報告係が行う。",
        commonRules,
        "登録候補（この全件を登録する）：",
        JSON.stringify(partition.accepted),
        "登録のルール：",
        "- 書き込みの直前に台帳の既存行を読み直し、同じタスクが既にある候補は登録しない（重複を作らない）。",
        "- 新規行は8要素で追加：A=FALSE、B=task、C=state、D=reason、E=checkMethod、F=due、G=link、H=今日の日付。",
        "- 登録したら、追加したタスク名を1件ずつ reports（destination は main）に入れる（本人が見て「不要」チェックや仕分けをするため）。",
        "- 書き込み後に読み戻し、追加した行の内容（特に関連リンク）が候補どおりか検証する。",
        "- 3回再試行しても登録作業自体ができなかった場合は status を failed にし、「今朝の新規収集は失敗した（理由）」という報告を reports（main）に入れる。",
        retryNote(last, attempt)
      ].join("\n")
    );
    collect = { status: registered.status, summary: collectCandidates.summary + "／範囲チェック通過 " + partition.accepted.length + " 件の登録：" + registered.summary, reports: (collectCandidates.reports || []).concat(registered.reports || []) };
  }
}
log("collect finished", { status: collect.status });

phase("refresh");
const refresh = await runStage("refresh", "2段目：現況更新・最新化", (last, attempt) =>
  [
    "あなたは「タスク台帳の現況更新・最新化」専任のエージェントです。毎朝の流れは4段で、あなたは2段目です。1段目（新規収集）の結果は「" + collect.status + "： " + collect.summary + "」でした。役割は1つだけ：台帳の既存行を現在の実態にそろえること。前提の解消チェック・次アクションの実行はあなたの仕事ではありません。報告は自分でチャットに送信せず、結果の reports に入れて返すこと。送信は4段目の報告係が行う。",
    commonRules,
    "手順：",
    "1. 台帳の全行を読む。A列「不要」がチェック済み（TRUE）の行は、本人が追跡対象から外したものなので触らない。",
    "2. 未完了の各行について、その行の「対象」を実際に見に行く。対象とは：関連リンク先（GitHub Issue の状態・最新コメント、関連スプレッドシート）、そのタスクの実物（関連ファイル・関連チャットの現況・対象システムの状態）。行の文面だけを見て「たぶん変わっていない」と判断しない。必ず対象の現物を確認してから、行の内容と突き合わせる。",
    "3. ズレている行は、実態に合わせて書き直す：C（状態）は実態どおりに（実際に終わっているものは「完了」）。D（止まってる理由・前提条件）は現在の前提・残件だけにし、終わった経緯の長文は削る。E（前提の確認方法）は「何を・どこで見て・どうなったら解消か」が機械的に判定できる形に。F（期日・次回確認日）に日付でない文字列やシリアル値（46336 のような数値）があれば、意味を保ちつつ扱える形に（日付にできるものは日付に、できないものは条件を D へ寄せて F には次回確認日を入れる）。H（最終更新）は変更した行を今日の日付にする。",
    "4. 対象の現物に届かず確認できなかった行は、推測で書き直さず据え置き、観測メモ ~/memory/" + date + ".md に行番号と理由を残す。",
    "- 更新があってもなくても reports は空でよい（報告はしない）。ただし3回再試行しても更新作業自体ができなかった場合は status を failed にし、「今朝の台帳の現況更新は失敗した（理由）」という報告を reports（main）に入れる。",
    retryNote(last, attempt)
  ].join("\n")
);
log("refresh finished", { status: refresh.status });

// 対象範囲の監査（既存行）：読み取り専用。判定はコード側で行い、疑いは報告に必ず含める（自動削除はしない）。
const scopeAudit = await runStage("scope-audit", "対象範囲の監査（既存行）", (last, attempt) =>
  [
    "あなたは「タスク台帳の対象範囲の監査」専任のエージェントです。役割は1つだけ：台帳の既存行を全部読み、各行のタスク名と関連リンクを構造化して返すこと。シートへの書き込みは絶対にしないでください。範囲内かどうかの判定はハーネスのコード側が行うので、あなたは読み取りだけを行います。報告は自分でチャットに送信せず、結果の reports に入れて返すこと。",
    commonRules,
    "返し方：タブ「タスク台帳」の全行（ヘッダー行を除く）を読み、B列（タスク）が空でない行をすべて rows に入れる：task（B列のタスク名）、link（G列の関連リンク。空なら空文字）。1行も漏らさないこと。",
    "- 読めなかった場合は status を failed にする（推測で rows を作らない）。reports は空でよい。",
    retryNote(last, attempt)
  ].join("\n"), auditSchema
);
if (scopeAudit.status === "success") {
  scopeSuspectExisting = auditScope(scopeAudit.rows || []);
  if (scopeSuspectExisting.length > 0) {
    scopeReports.push({ destination: "main", text: "🤖AI組織・事務連絡 台帳の範囲監査：関連リンクが組織のものでない行が " + scopeSuspectExisting.length + " 件あります（範囲漏れの疑い。自動削除はしません）：" + scopeSuspectExisting.map((t) => "「" + t + "」").join("、") });
  }
  log("scope audit finished", { rows: (scopeAudit.rows || []).length, suspects: scopeSuspectExisting.length });
} else {
  scopeReports.push({ destination: "main", text: "🤖AI組織・事務連絡 今朝の台帳の範囲監査は失敗しました（" + scopeAudit.summary + "）" });
  log("scope audit failed", { summary: scopeAudit.summary });
}

phase("scan");
const scan = await runStage("scan", "3段目：確認・前進", (last, attempt) =>
  [
    "あなたは「タスク確認・前進」の担当です。毎朝の流れは4段で、あなたは3段目です。1段目（新規収集）の結果は「" + collect.status + "： " + collect.summary + "」、2段目（現況更新）の結果は「" + refresh.status + "： " + refresh.summary + "」でした。この2段が済んだ台帳を前提に、前提の確認・次アクションの実行・停滞への対処を行ってください（行の文面そのものの書き直しは更新係の役目です。ここで書き換えるのは、確認結果の記録としての状態・最終更新・D列への現況追記だけに留めること）。報告は自分でチャットに送信せず、結果の reports に {destination, text} の形で入れて返すこと（destination は \"main\"＝メインチャット、\"ai-org\"＝AI組織チャット）。送信は4段目の報告係が行う。",
    commonRules,
    "基本姿勢：",
    "- 止まっているものは、報告して終わりにせず、既存の権限と手段の範囲で自分から前進させる。本人の判断がどうしても要る分だけを、判断材料つきで本人に上げる。",
    "- 確認待ち・期日ありの待ちも、朝の確認段で必ず実確認する。期日は確認を省く理由にならない。本人が忘れる前提で、組織側から確認する。",
    "台帳の確認（未完了行＝状態が「完了」以外、A列「不要」が TRUE の行は対象外）：",
    "1. 各行の「前提の確認方法」に書かれた方法で、前提が解消されたかどうかを実際に確認する（GitHub Issue の更新、関連シート・チャットの新着、ファイルの有無など、実状態を見る。推測で「解消したはず」としない）。その方法で確認しきれない場合は、別の確認手段を考えて確認する。",
    "2. 結果の分岐：解消していたら、既存の権限の範囲で次のアクションを実行し、その行の「状態」と「最終更新」（今日の日付）を更新する。まだ解消していない場合は理由を特定し、組織側で解消できる詰まり（確認手段の不備、手順の詰まり、未実施の次工程など）はその場で解消して前進させ行を更新する。解消できない場合は理由の現況を D 列に書き足す（「最終更新」は今日にする）。本人の判断・操作がどうしても要る場合は、判断材料（何を確認して、何が分かり、何を決めれば進むか）をそろえた報告を reports（main）へ1件ずつ入れる（一覧形式でまとめない）。",
    "3. 期日は自動で先に延ばさない。「期日・次回確認日」は本人の返答があった時にだけ動かす。同じ行について確認結果が変わらない間は再報告しない（状態が変わった場合と、前回報告から7日以上経過した場合は再報告してよい。再報告の有無は観測メモ ~/memory/" + date + ".md の記録で判断する）。",
    "AI組織Issueの停滞チェック：",
    "- GitHub リポジトリ __ORG_REPO__ の open な Issue を全部確認する（「実行中」ラベルの有無で対象を絞らない）。最終更新日時と最新コメントを読み、24時間動きがなければ「停滞」として扱い、前進させる。",
    "- 停滞への対処：組織側で動かせる分（未実施の次工程、詰まりの解消、関係チャットへの伝達など）は、報告の前にその場で動かし、その内容を該当 Issue か台帳へ記録する。本人の判断待ちが実態のものだけ、reports（destination は ai-org）へ1件ずつ、「何を・誰を待っているか」「いつから止まっているか」「Issue の URL」を含めて短く入れる。同じ停滞を毎日繰り返し入れない（観測メモに Issue 番号と報告日を記録し、状態が変わらない限り再報告しない。状態変化時と前回報告から7日以上経過時は可）。",
    "- 台帳や GitHub が読めず確認自体ができなかった場合は、「今朝のタスク確認は失敗した（理由）」という報告を reports（main）に入れ、status を failed にする。「変化なし」と「確認できなかった」を混ぜない。報告すべきことが何もなければ reports は空でよい。",
    retryNote(last, attempt)
  ].join("\n")
);
log("scan finished", { status: scan.status });

const allReports = []
  .concat(collect.reports || [])
  .concat(refresh.reports || [])
  .concat(scan.reports || [])
  .concat(scopeReports);

phase("report");
const report = await runStage("report", "4段目：報告", (last, attempt) =>
  [
    "あなたは「報告」専任のエージェントです。毎朝の流れは4段で、あなたは最後の4段目です。仕事は、1〜3段目が出した報告を整え、完了報告を作って、結果として返すことです。チャットへの送信は行いません（送信はハーネスの呼び出し側が行います）。台帳の確認・更新もしないでください。",
    "今日の日付は " + date + " です。",
    "1〜3段目の結果：",
    "- 1段目（新規収集）: " + collect.status + " — " + collect.summary,
    "- 2段目（現況更新・最新化）: " + refresh.status + " — " + refresh.summary,
    "- 3段目（確認・前進）: " + scan.status + " — " + scan.summary,
    "対象範囲チェック（ハーネスのコードが実施）：弾いた新規行 " + scopeRejectedNew.length + " 件、範囲漏れの疑い " + scopeSuspectExisting.length + " 件。該当する報告は次の一覧に含まれているので、そのまま reports へ入れること。",
    "1〜3段目が出した報告の一覧（JSON）：",
    JSON.stringify(allReports),
    "やること：",
    "1. 一覧の報告はそのまま（文面を書き換えずに）結果の reports へ入れる。",
    "2. 失敗した段（status が failed）があり、その段の失敗報告が一覧に含まれていない場合は、「🤖AI組織・事務連絡 今朝の台帳チェックで【段の名前】が失敗しました。（summary の要約）」という報告を destination \"main\" で reports に追加する。",
    "3. 最後に必ず、完了報告を1件、destination \"ai-org\" で reports に追加する。形は「🤖AI組織・事務連絡 朝の台帳チェック完了：収集 成功／更新 成功／確認 成功（各段は 成功 または 失敗 で書く）。報告は○件（この完了報告自体は数えない）」のようにし、他の報告が無い場合は「報告なし」と明記する。これが無い日が異常だと分かるようにするためなので、必ず入れること。",
    "結果は schema の形で返す：status、summary（整えた報告の件数と内訳）、reports（宛先つきの全報告）。",
    retryNote(last, attempt)
  ].join("\n")
);
log("report finished", { status: report.status });

return {
  date: date,
  stages: {
    collect: { status: collect.status, summary: collect.summary },
    refresh: { status: refresh.status, summary: refresh.summary },
    scan: { status: scan.status, summary: scan.summary },
    report: { status: report.status, summary: report.summary }
  },
  reports: allReports,
  scope: { rejectedNew: scopeRejectedNew, suspectExisting: scopeSuspectExisting }
};