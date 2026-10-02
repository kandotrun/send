# 藍のビジュアル刷新 実装計画

> **For agentic workers:** REQUIRED SUB-SKILL: Use superpowers:subagent-driven-development (recommended) or superpowers:executing-plans to implement this plan task-by-task. Steps use checkbox (`- [ ]`) syntax for tracking.

**Goal:** [設計](2026-10-02-visual-refresh.md) の藍トーン・ダークモード・情報整理を、送受信の振る舞いを変えずに実装する。

**Architecture:** 見た目は `src/web/style.css` のトークン（`:root` とダーク上書き）に集約し、`index.html` は構造と文言、`src/web/main.ts` は表示状態（`data-view`・案内の表示・管理状態の `data-state`）だけを扱う。静的な制約は `tests/ui.test.ts`、実ブラウザーの表示条件は Playwright E2E で検証する。

**Tech Stack:** Vite 8、TypeScript、Vitest、Playwright、Biome、Cloudflare Workers（ローカルD1/R2）。

---

## ファイル
- Modify: `tests/ui.test.ts`（トークン・コントラスト・最小文字サイズ・文言・案内の初期状態）
- Modify: `src/web/style.css`（全面書き換え）
- Modify: `index.html`（構造・文言・インラインSVG・theme-color）
- Modify: `src/web/main.ts`（`setView`・案内の表示・管理状態・文章サイズ表示のリセット文言）
- Modify: `tests/e2e/transfer.spec.ts`、`tests/e2e/large-file.spec.ts`
- Modify: `public/favicon.svg`、`public/policy.css`

## Task 1: トークンとコントラスト（単体 RED→GREEN）

- [ ] **Step 1: 失敗するテストを追加** — `tests/ui.test.ts` の末尾に追加。

```ts
// 配色はトークンに集約し、両モードで本文コントラストAAを満たす。
describe("spec: indigo design tokens", () => {
  const names = [
    "ground", "surface", "surface-muted", "ink", "muted", "line", "line-strong",
    "accent", "accent-fill", "accent-fill-hover", "on-accent", "accent-soft", "accent-ink",
    "caution-bg", "caution-ink", "danger", "danger-bg", "success",
  ];
  const block = (pattern: RegExp) => css.match(pattern)?.[1] ?? "";
  const read = (source: string) =>
    Object.fromEntries(
      [...source.matchAll(/--([a-z-]+):\s*(#[0-9a-fA-F]{6})\s*;/g)].map((m) => [m[1], m[2]]),
    ) as Record<string, string>;
  const light = read(block(/:root\s*\{([\s\S]*?)\}/));
  const dark = read(block(/@media \(prefers-color-scheme: dark\)\s*\{\s*:root\s*\{([\s\S]*?)\}/));
  const luminance = (hex: string) => {
    const [r, g, b] = [1, 3, 5].map((i) => {
      const c = Number.parseInt(hex.slice(i, i + 2), 16) / 255;
      return c <= 0.04045 ? c / 12.92 : ((c + 0.055) / 1.055) ** 2.4;
    });
    return 0.2126 * r + 0.7152 * g + 0.0722 * b;
  };
  const contrast = (a: string, b: string) => {
    const [hi, lo] = [luminance(a), luminance(b)].sort((x, y) => y - x);
    return (hi + 0.05) / (lo + 0.05);
  };
  const pairs: [string, string][] = [
    ...["ink", "muted", "accent"].flatMap((fg) =>
      ["ground", "surface", "surface-muted"].map((bg) => [fg, bg] as [string, string]),
    ),
    ["on-accent", "accent-fill"], ["on-accent", "accent-fill-hover"],
    ["accent-ink", "accent-soft"], ["caution-ink", "caution-bg"],
    ["danger", "surface"], ["danger", "danger-bg"], ["success", "surface"],
  ];

  it("defines every token for light and dark color schemes", () => {
    expect(css).toContain("color-scheme: light dark");
    for (const name of names) {
      expect(light[name], `light --${name}`).toMatch(/^#/);
      expect(dark[name], `dark --${name}`).toMatch(/^#/);
    }
  });

  it("keeps text at WCAG AA contrast in both schemes", () => {
    for (const [mode, palette] of [["light", light], ["dark", dark]] as const)
      for (const [fg, bg] of pairs)
        expect(
          contrast(palette[fg] ?? "#000000", palette[bg] ?? "#000000"),
          `${mode} --${fg} on --${bg}`,
        ).toBeGreaterThanOrEqual(4.5);
  });

  it("never sets text smaller than 12px", () => {
    const sizes = [...css.matchAll(/font-size:\s*([\d.]+)px/g)].map((m) => Number(m[1]));
    expect(sizes.length).toBeGreaterThan(0);
    expect(sizes.filter((size) => size < 12)).toEqual([]);
  });
});
```

- [ ] **Step 2: RED を確認** — `npx vitest run tests/ui.test.ts` → `indigo design tokens` の3件が失敗（トークン未定義・9px等の文字サイズ）。
- [ ] **Step 3: `src/web/style.css` を書き換え** — 先頭に設計の表どおりのトークンを置く。

```css
:root {
  color-scheme: light dark;
  --ground: #eef2f5;
  /* …設計の表の全トークン（ライト値）… */
  --sans: "Hiragino Sans", "Hiragino Kaku Gothic ProN", "Yu Gothic UI", "Yu Gothic", "Noto Sans JP", "Noto Sans CJK JP", system-ui, sans-serif;
  --mono: ui-monospace, "SFMono-Regular", Menlo, Consolas, monospace;
}
@media (prefers-color-scheme: dark) {
  :root {
    --ground: #0f1620;
    /* …設計の表の全トークン（ダーク値）… */
  }
}
```

  続けて設計「タイポグラフィと形」「画面」の各コンポーネント（ヘッダー、導入、カード、セグメントタブ、ドロップ枠、選択済みファイル行、期限、主ボタン、チェックリスト、送る前に、完了の共有／控え、受信、管理、無効、進行状況、フッター、モバイル `@media (max-width: 640px)`、`prefers-reduced-motion`）を、トークン参照だけで記述する。既存の `[hidden]`・`.sr-only`・`:focus-visible`・`min-width: 0` は維持。色の直書きはトークン定義以外に置かない。
- [ ] **Step 4: GREEN を確認** — `npx vitest run tests/ui.test.ts` → 全件成功。
- [ ] **Step 5: Commit** — `git commit -m "style: 藍のデザイントークンとダークモードを追加"`

## Task 2: 構造と文言（単体 RED→GREEN）

- [ ] **Step 1: 失敗するテストを追加** — `spec: Japanese transfer stationery` に追加。

```ts
it("speaks with calm indigo copy and no decorative English labels", () => {
  expect(html).toContain("<title>send. — 鍵をかけて、リンクで渡す。</title>");
  for (const copy of [
    "鍵をかけて、リンクで渡す。",
    "暗号化して共有リンクをつくる",
    "内容とファイル名は、この端末で暗号化します",
    "復号の鍵はサーバーに送りません",
    "期限切れ・取り消し後は受け取れません",
    "共有リンクができました。",
    "管理リンク（控え）",
    "暗号化された内容が届いています。",
    "内容は、ボタンを押すまでダウンロードしません。",
  ])
    expect(html).toContain(copy);
  for (const label of ["A SMALL DELIVERY", "LINK DELIVERY", "FOR YOU", "SENDER'S COPY", "UNDELIVERED", "send. / 01", "screen-eyebrow", 'class="eyebrow"'])
    expect(html + main).not.toContain(label);
  expect(main).not.toMatch(/A DELIVERY FOR YOU|KEEP YOUR COPY/);
});

it("hides large-file guidance until it applies and themes the browser chrome", () => {
  expect(html).toMatch(/<p id="sender-browser-guide"[^>]*\shidden[\s>]/);
  expect(html).toMatch(/<p id="receiver-browser-guide"[^>]*\shidden[\s>]/);
  expect(html).toContain('<meta name="theme-color" content="#eef2f5" media="(prefers-color-scheme: light)" />');
  expect(html).toContain('<meta name="theme-color" content="#0f1620" media="(prefers-color-scheme: dark)" />');
  expect(main).toContain("main.dataset.view = next");
});
```

- [ ] **Step 2: RED を確認** — `npx vitest run tests/ui.test.ts` → 上記2件が失敗。
- [ ] **Step 3: `index.html` を書き換え** — 設計「画面」の構造と文言にする。全ての既存 id・role・aria・`data-testid`・`data-new-send` を維持。`#screen-eyebrow`・`.eyebrow`・`.paper-heading` を削除。アイコンは `aria-hidden="true"` のインラインSVG。
- [ ] **Step 4: `src/web/main.ts` の `setView` を更新**

```ts
const main = element("main-content");
const headings: Record<View, string> = {
  sender: "鍵をかけて、リンクで渡す。",
  created: "共有リンクの発行",
  receiver: "届いた内容の受け取り",
  management: "リンクの管理",
  invalid: "開けないリンク",
};

function setView(next: View): void {
  view = next;
  for (const name of viewNames) element(`${name}-view`).hidden = name !== next;
  element("service-notice").hidden = next !== "sender" || uploadsEnabled !== false;
  // 導入は送信画面だけに見せ、他の画面ではカード内の見出しを唯一の見出しにする。
  main.dataset.view = next;
  element("screen-title").textContent = headings[next];
}
```

  `reset()` の `text-size` 文言を HTML 初期値「文章は100 MBまで。この端末で暗号化します。」に揃える。
- [ ] **Step 5: GREEN を確認** — `npx vitest run` → 全件成功、`npm run typecheck` 成功。
- [ ] **Step 6: Commit** — `git commit -m "feat(web): 藍の画面構成と文言に刷新"`

## Task 3: 表示条件（E2E RED→GREEN）

- [ ] **Step 1: 失敗するE2Eを追加** — `tests/e2e/transfer.spec.ts` に追加。

```ts
// 導入見出しは送信画面だけ。大容量案内は該当時だけ表示する。
test("spec: each view shows one heading and only relevant large-file guidance", async ({
  page,
  context,
}) => {
  const introHeight = async (target: import("@playwright/test").Page) =>
    (await target.locator(".introduction").boundingBox())?.height ?? 0;
  await page.goto("/");
  expect(await introHeight(page)).toBeGreaterThan(40);
  await expect(page.locator("#sender-browser-guide")).toBeHidden();
  const { readUrl, manageUrl } = await sendText(page);
  expect(await introHeight(page)).toBeLessThanOrEqual(1);
  const recipient = await context.newPage();
  await recipient.goto(readUrl);
  await expect(recipient.locator("#receiver-download")).toBeEnabled();
  await expect(recipient.locator("#receiver-browser-guide")).toBeHidden();
  expect(await introHeight(recipient)).toBeLessThanOrEqual(1);
  const manage = await context.newPage();
  await manage.goto(manageUrl);
  await expect(manage.locator("#management-state")).toHaveAttribute("data-state", "ready");
  expect(await introHeight(manage)).toBeLessThanOrEqual(1);
});

test.describe("dark color scheme", () => {
  test.use({ colorScheme: "dark", viewport: { width: 390, height: 844 } });
  test("spec: dark mode repaints the page without horizontal overflow", async ({ page }) => {
    await page.goto("/");
    expect(await page.evaluate(() => getComputedStyle(document.body).backgroundColor)).toBe(
      "rgb(15, 22, 32)",
    );
    expect(await page.evaluate(() => document.documentElement.scrollWidth <= innerWidth)).toBe(true);
    await page.screenshot({ path: "test-results/send-mobile-dark.png", fullPage: true });
  });
});
```

  既存の取り消しテストで、管理画面の取り消し成功後に `await expect(manage.locator("#management-state")).toHaveAttribute("data-state", "revoked");` を追加。`tests/e2e/large-file.spec.ts` の `setInputFiles(path)` 直後に `await expect(page.locator("#sender-browser-guide")).toBeVisible();`、`unsupported browsers…` テストに `await expect(page.locator("#receiver-browser-guide")).toBeVisible();` を追加。
- [ ] **Step 2: RED を確認** — `npx playwright test tests/e2e/transfer.spec.ts` → 新規2件と取り消しテストが失敗（案内が常時表示・`data-state` なし）。
- [ ] **Step 3: `src/web/main.ts` を実装**

```ts
function showSenderGuide(file: File | null): void {
  element("sender-browser-guide").hidden = !file || !needsNativeSave({ kind: "file", size: file.size });
}
```

  `acceptFiles`（`selectedFile` 代入後）・`clearFile`・`reset` で `showSenderGuide(selectedFile)` を呼ぶ。`route()` の受信で manifest 取得後に `element("receiver-browser-guide").hidden = !needsNativeSave(transfer.manifest);`、`clearPrivateState()` で `element("receiver-browser-guide").hidden = true;`。`renderManagement` で表示文言と同じ分岐の `element("management-state").dataset.state = "expired" | "ready" | "revoked" | "uploading"` を設定。
- [ ] **Step 4: GREEN を確認** — `npx playwright test tests/e2e/transfer.spec.ts tests/e2e/large-file.spec.ts` → 全件成功。
- [ ] **Step 5: Commit** — `git commit -m "feat(web): 大容量案内と導入見出しを該当画面だけに表示"`

## Task 4: 周辺アセット

- [ ] **Step 1:** `public/favicon.svg` を藍の地＋白い鍵付き封筒に変更（`<title>send.</title>` 維持、`ui.test.ts` の `<svg` 検査が通る）。
- [ ] **Step 2:** `public/policy.css` の文字色・リンク・背景を藍トークン相当に揃える（`color-scheme: light dark` 維持、ダークも定義）。
- [ ] **Step 3:** `npx vitest run tests/ui.test.ts tests/build.test.ts` 成功を確認。
- [ ] **Step 4: Commit** — `git commit -m "style: ファビコンと規約ページの配色を揃える"`

## Task 5: 全体検証とPR

- [ ] **Step 1:** `npm run check` と `npm run test:e2e` が成功。
- [ ] **Step 2:** ローカル dev で 1280px・375px × ライト・ダークの送信・完了・受信（文章）・管理・無効画面を目視確認し、崩れを修正してコミット。
- [ ] **Step 3:** push して PR を作成（本文は日本語、検証内容と目視確認範囲を明記、本番デプロイなし）。
