import { existsSync, readFileSync } from "node:fs";
import { fileURLToPath } from "node:url";
import { describe, expect, it } from "vitest";

const root = fileURLToPath(new URL("../", import.meta.url));
const source = (path: string) =>
  existsSync(`${root}${path}`) ? readFileSync(`${root}${path}`, "utf8") : "";
const html = source("index.html");
const main = source("src/web/main.ts");
const css = source("src/web/style.css").replace(/\/\*[\s\S]*?\*\//g, "");

// 静的な配信面の仕様。実ブラウザーと実APIの往復は別のE2Eが検証する。
describe("spec: Japanese transfer stationery", () => {
  it("places a usable single-file and text form in the first screen", () => {
    expect(html).toContain('id="send-form"');
    for (const id of [
      "file-tab",
      "text-tab",
      "dropzone",
      "file-input",
      "file-clear",
      "text-input",
    ]) {
      expect(html).toContain(`id="${id}"`);
    }
    expect(html).toContain("100 MB");
    expect(html).toContain("ファイルを選ぶ");
    expect(html).toContain('type="file"');
    expect(html).not.toMatch(/<input[^>]*\bmultiple\b/);
    expect(html).toContain('role="tablist"');
    expect(html).toContain('role="tabpanel"');
    expect(html).toContain('id="send-button"');
    expect(html).toContain("共有リンクをつくる");
  });

  it("offers the fixed TTLs with a 24-hour default", () => {
    expect(html).toContain('for="expiry"');
    expect(html).toMatch(/<option value="3600">1時間<\/option>/);
    expect(html).toMatch(/<option value="86400" selected>24時間<\/option>/);
    expect(html).toMatch(/<option value="604800">7日<\/option>/);
  });

  it("states the upload deadline as the earlier of share expiry and 24 hours after creation", () => {
    const sender = html.split('id="sender-view"')[1]?.split('id="created-view"')[0] ?? "";
    expect(sender).toContain(
      "送信は共有期限、または作成から24時間の早い方までに完了する必要があります。",
    );
    expect(sender).not.toMatch(/15分|15\s*minutes?/i);
  });

  it("provides an in-flow live progress region and a real cancel hook", () => {
    expect(html).toContain('id="status"');
    expect(html).toContain('aria-live="polite"');
    expect(html).toContain('id="operation-progress"');
    expect(html).toContain('id="cancel-button"');
    expect(main).toContain("new AbortController()");
    expect(main).toContain(".abort()");
    expect(main).toContain("onProgress:");
    expect(main).toContain("signal:");
    expect(main).toContain("fieldset.disabled = busy");
    expect(main).toContain("status.dataset.state = state");
    expect(html).toContain('data-testid="dropzone"');
  });

  it("connects genuine drag events and the picker to the same validation path", () => {
    for (const event of ["dragenter", "dragover", "dragleave", "drop"]) {
      expect(main).toMatch(new RegExp(`['"]${event}['"]`));
    }
    expect(main).toContain("event.preventDefault()");
    expect(main).toContain("acceptFiles(fileInput.files)");
    expect(main).toContain("acceptFiles(event.dataTransfer");
    expect(main).toContain("validateFiles(");
  });

  it("keeps read and management capabilities visibly separate", () => {
    expect(html).toContain('for="read-link"');
    expect(html).toContain("共有リンク");
    expect(html).toContain('for="manage-link"');
    expect(html).toContain("管理リンク");
    expect(html).toMatch(/id="read-link"[^>]*readonly/);
    expect(html).toMatch(/id="manage-link"[^>]*readonly/);
    for (const id of ["copy-read", "copy-manage", "created-expiry", "new-send", "revoke-created"]) {
      expect(html).toContain(`id="${id}"`);
    }
    expect(html).toContain(
      "共有リンクを知っている人は受け取れます。管理リンクは送らず、自分で保管してください。",
    );
  });

  it("has explicit receiver actions and a management-only surface", () => {
    for (const id of [
      "receiver-view",
      "receive-name",
      "receive-size",
      "receive-expiry",
      "receiver-download",
      "received-text",
      "copy-text",
      "download-text",
      "management-view",
      "management-state",
      "management-expiry",
      "revoke-button",
      "invalid-view",
    ]) {
      expect(html).toContain(`id="${id}"`);
    }
    expect(main).toMatch(/from ['"]\.\.\/client\/transfer\.ts['"]/);
    for (const call of ["createTransfer(", "openTransfer(", "getManagement(", "revokeTransfer("]) {
      expect(main).toContain(call);
    }
    expect(main).toContain("parseReadLink(window.location.href)");
    expect(main).toContain("parseManageLink(window.location.href)");
    expect(main).toContain("URL.createObjectURL(blob)");
    expect(main).toContain("URL.revokeObjectURL(");
    expect(main).toContain("textContent =");
    expect(main).not.toMatch(/\binnerHTML\b|\blocalStorage\b|\bsessionStorage\b|console\./);
    expect(html).not.toMatch(/<iframe|<object|<embed|<img[^>]*receive/i);
  });

  it("explains the actual security limits without absolute promises", () => {
    for (const copy of [
      "内容とファイル名は、この端末で暗号化",
      "受け取った相手が保存したコピーは取り消せません",
      "リンクを持つ人は、ほかの人に転送できます",
      "サイズ・期限・IPアドレス",
      "ウイルス検査は行っていません。信頼できる相手からのファイルだけ開いてください。",
      "第三者によるセキュリティ監査は未実施",
      "配信されるJavaScript",
      "端末や拡張機能",
    ]) {
      expect(html).toContain(copy);
    }
    expect(html).toContain('id="security-details"');
    expect(html).toContain("https://github.com/kandotrun/send");
    expect(html).not.toMatch(/完全に安全|絶対に|100%安全/);
  });

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
    for (const label of [
      "A SMALL DELIVERY",
      "LINK DELIVERY",
      "FOR YOU",
      "SENDER'S COPY",
      "UNDELIVERED",
      "send. / 01",
      "screen-eyebrow",
      'class="eyebrow"',
    ])
      expect(html + main).not.toContain(label);
    expect(main).not.toMatch(/A DELIVERY FOR YOU|KEEP YOUR COPY/);
  });

  it("hides large-file guidance until it applies and themes the browser chrome", () => {
    expect(html).toMatch(/<p id="sender-browser-guide"[^>]*\shidden[\s>]/);
    expect(html).toMatch(/<p id="receiver-browser-guide"[^>]*\shidden[\s>]/);
    expect(html).toContain(
      '<meta name="theme-color" content="#f5f7fc" media="(prefers-color-scheme: light)" />',
    );
    expect(html).toContain(
      '<meta name="theme-color" content="#0b0c10" media="(prefers-color-scheme: dark)" />',
    );
    expect(main).toContain("main.dataset.view = next");
  });

  it("uses only self-hosted assets and accessible responsive styling", () => {
    expect(html).toContain('lang="ja"');
    expect(html).toContain('name="viewport"');
    expect(html).toContain('name="referrer" content="no-referrer"');
    expect(html).toContain('<script type="module" src="/src/web/main.ts"></script>');
    expect(html).not.toMatch(/<script(?![^>]*\bsrc=)|\sonclick=|\sstyle=/);
    expect(css).toMatch(/\[hidden\]\s*\{\s*display:\s*none\s*!important/);
    expect(css).toContain("prefers-reduced-motion: reduce");
    expect(css).toContain(":focus-visible");
    // 画面遷移で移す見出しのフォーカスは読み上げ用のため枠を出さない。受信文章など操作対象は対象外。
    expect(css).toMatch(/h2\[tabindex="-1"\]:focus\s*\{\s*outline:\s*none;/);
    expect(css).not.toMatch(/(^|[\s,}])\[tabindex="-1"\]:focus/);
    expect(css).toContain("min-width: 0");
    expect(css).not.toContain("@import");
    expect(source("public/favicon.svg")).toContain("<svg");
  });
});

// 純粋な境界処理はブラウザーなしでも実装そのものを検証できる。
describe("spec: UI input boundaries", () => {
  async function helpers() {
    expect(source("src/web/presentation.ts")).toContain("export function validateFiles");
    return import("../src/web/presentation.ts");
  }

  it("accepts exactly one file at the limit, including empty files", async () => {
    const { validateFiles } = await helpers();
    expect(validateFiles([{ size: 10_000_000_000 }])).toBeNull();
    expect(validateFiles([{ size: 0 }])).toBeNull();
    expect(validateFiles([{ size: 10_000_000_001 }])).toBe("ファイルは10 GBまでです。");
    for (const size of [-1, 0.5, Number.NaN, Number.POSITIVE_INFINITY]) {
      expect(validateFiles([{ size }])).toBe("ファイルは10 GBまでです。");
    }
    expect(validateFiles([{ size: 1 }, { size: 1 }])).toBe("一度に送れるファイルは1個です。");
    expect(validateFiles([])).toBe("ファイルを1個選んでください。");
  });

  it("never retains a previous file when replacement input is invalid", async () => {
    expect(source("src/web/presentation.ts")).toContain("export function resolveFiles");
    const { resolveFiles } = await helpers();
    const valid = { size: 5, name: "first.txt" };
    expect(resolveFiles([valid])).toEqual({ file: valid, error: null });
    expect(resolveFiles([valid, valid])).toEqual({
      file: null,
      error: "一度に送れるファイルは1個です。",
    });
    expect(resolveFiles([{ size: 10_000_000_001 }]).file).toBeNull();
    expect(main).toContain("selectedFile = selection.file");
  });

  it("validates the exact UTF-8 text size and does not trim the content", async () => {
    const { validateText } = await helpers();
    expect(validateText("")).toBe("文章を入力してください。");
    expect(validateText("  \n")).toBeNull();
    expect(validateText("あ", 3)).toBeNull();
    expect(validateText("あ", 2)).toBe("文章は100 MBまでです。");
    expect(validateText("x".repeat(100_000_001))).toBe("文章は100 MBまでです。");
  });

  it("formats decimal gigabytes without disguising 10 GB as 10,000 MB", async () => {
    const { formatSize } = await helpers();
    expect(formatSize(10_000_000_000)).toBe("10 GB");
    expect(formatSize(1_010_000_000)).toBe("1.01 GB");
    expect(formatSize(100_000_000)).toBe("100 MB");
  });

  it("discloses large-file browser and storage constraints before send and receive", () => {
    const guide = "100 MBを超えるファイルの受け取りには、PC版ChromeまたはEdgeを使ってください。";
    const sender = html.split('id="sender-view"')[1]?.split('id="created-view"')[0] ?? "";
    const receiver = html.split('id="receiver-view"')[1]?.split('id="management-view"')[0] ?? "";
    expect(sender).toContain(guide);
    expect(receiver).toContain(guide);
    expect(html).toMatch(/id="sender-browser-guide" class="notice"/);
    expect(html).toMatch(/id="receiver-browser-guide" class="notice"/);
    expect(sender).toContain("10 GBまで");
    expect(html).toContain("文章は100 MBまで");
    expect(html).toContain("1 GB = 1,000,000,000 bytes");
    expect(html).toContain("自動再試行・途中再開はできません");
    expect(html).toContain("タブを開いたまま");
    expect(html).toContain("作成時から");
    expect(html).toContain("初期ベータ版");
    expect(html).toContain('href="/policy.html"');
    expect(main).toContain("saveLargeFile(");
    expect(main).toContain("supportsNativeSave(");
  });

  it("rejects nonprotocol TTLs rather than silently normalizing values", async () => {
    const { parseTtl } = await helpers();
    expect(parseTtl("3600")).toBe(3600);
    expect(parseTtl("86400")).toBe(86400);
    expect(parseTtl("604800")).toBe(604800);
    expect(() => parseTtl("1")).toThrow();
    expect(() => parseTtl("086400")).toThrow();
  });

  it("formats an absolute local expiry including seconds and timezone", async () => {
    const { formatExpiry } = await helpers();
    const timestamp = Date.UTC(2026, 8, 30, 12, 34, 56);
    const formatted = formatExpiry(timestamp);
    expect(formatted).toMatch(/2026/);
    expect(formatted).toMatch(/\d{2}:\d{2}:56/);
    expect(formatted).toContain(Intl.DateTimeFormat().resolvedOptions().timeZone);
    expect(formatExpiry(Number.NaN)).toBe("期限を確認できません");
  });

  it("strips dangerous path characters from saved names without evaluating them", async () => {
    const { safeDownloadName } = await helpers();
    expect(safeDownloadName("../../report\u0000.txt")).toBe(".._.._report_.txt");
    expect(safeDownloadName("")).toBe("download");
    expect(safeDownloadName("<img onerror=alert(1)>.txt")).toBe("<img onerror=alert(1)>.txt");
  });
});

// 配色はトークンに集約し、両モードで本文コントラストAAを満たす。
describe("spec: blue design tokens", () => {
  const names = [
    "ground",
    "surface",
    "surface-muted",
    "ink",
    "muted",
    "line",
    "line-strong",
    "accent",
    "accent-fill",
    "accent-fill-hover",
    "on-accent",
    "accent-soft",
    "accent-ink",
    "caution-bg",
    "caution-ink",
    "danger",
    "danger-bg",
    "success",
  ];
  const block = (pattern: RegExp) => css.match(pattern)?.[1] ?? "";
  const read = (source: string) =>
    Object.fromEntries(
      [...source.matchAll(/--([a-z-]+):\s*(#[0-9a-fA-F]{6})\s*;/g)].map((m) => [m[1], m[2]]),
    ) as Record<string, string>;
  const light = read(block(/:root\s*\{([\s\S]*?)\}/));
  const dark = read(block(/@media \(prefers-color-scheme: dark\)\s*\{\s*:root\s*\{([\s\S]*?)\}/));
  const luminance = (hex: string) => {
    const [r = 0, g = 0, b = 0] = [1, 3, 5].map((index) => {
      const channel = Number.parseInt(hex.slice(index, index + 2), 16) / 255;
      return channel <= 0.04045 ? channel / 12.92 : ((channel + 0.055) / 1.055) ** 2.4;
    });
    return 0.2126 * r + 0.7152 * g + 0.0722 * b;
  };
  const contrast = (a: string, b: string) => {
    const [high = 0, low = 0] = [luminance(a), luminance(b)].sort((x, y) => y - x);
    return (high + 0.05) / (low + 0.05);
  };
  const pairs: [string, string][] = [
    ...["ink", "muted", "accent"].flatMap((fg) =>
      ["ground", "surface", "surface-muted"].map((bg): [string, string] => [fg, bg]),
    ),
    ["on-accent", "accent-fill"],
    ["on-accent", "accent-fill-hover"],
    ["accent-ink", "accent-soft"],
    ["caution-ink", "caution-bg"],
    ["danger", "surface"],
    ["danger", "danger-bg"],
    ["success", "surface"],
  ];

  it("defines every token for light and dark color schemes", () => {
    expect(css).toContain("color-scheme: light dark");
    for (const name of names) {
      expect(light[name], `light --${name}`).toMatch(/^#/);
      expect(dark[name], `dark --${name}`).toMatch(/^#/);
    }
  });

  it("keeps text at WCAG AA contrast in both schemes", () => {
    for (const [mode, palette] of [
      ["light", light],
      ["dark", dark],
    ] as const)
      for (const [fg, bg] of pairs)
        expect(
          contrast(palette[fg] ?? "#000000", palette[bg] ?? "#000000"),
          `${mode} --${fg} on --${bg}`,
        ).toBeGreaterThanOrEqual(4.5);
  });

  it("marks the selected tab with a non-text indicator of at least 3:1", () => {
    const rule = css.match(/\.tab\[aria-selected="true"\]\s*\{([^}]*)\}/)?.[1] ?? "";
    const token = rule.match(/border-color:\s*var\(--([a-z-]+)\)/)?.[1] ?? "";
    for (const [mode, palette] of [
      ["light", light],
      ["dark", dark],
    ] as const)
      for (const bg of ["ground", "surface"])
        expect(
          contrast(palette[token] ?? "#000000", palette[bg] ?? "#000000"),
          `${mode} selected tab --${token} on --${bg}`,
        ).toBeGreaterThanOrEqual(3);
  });

  it("never sets text smaller than 12px", () => {
    const sizes = [...css.matchAll(/font-size:\s*([\d.]+)px/g)].map((m) => Number(m[1]));
    expect(sizes.length).toBeGreaterThan(0);
    expect(sizes.filter((size) => size < 12)).toEqual([]);
  });

  // 光沢は塗りの上に白と黒を重ねるため、最も明るい点と暗い点の両方で文字AAを確かめる。
  it("keeps button text AA at the lightest and darkest point of the gloss", () => {
    const lightBlock = block(/:root\s*\{([\s\S]*?)\}/);
    const darkBlock = block(/@media \(prefers-color-scheme: dark\)\s*\{\s*:root\s*\{([\s\S]*?)\}/);
    const raw = (source: string, name: string) =>
      source.match(new RegExp(`--${name}:\\s*([^;]+);`))?.[1] ?? "";
    // 最も強い白・黒の重なりを採る。表記が変わって読めなければ NaN で失敗させる。
    const strongest = (gradient: string, rgb: string) =>
      Math.max(
        ...[...gradient.matchAll(new RegExp(`rgb\\(${rgb} \\/ (\\d+)%\\)`, "g"))].map((m) =>
          Number(m[1]),
        ),
      ) / 100;
    const alphas = (gradient: string) => ({
      white: strongest(gradient, "255 255 255"),
      black: strongest(gradient, "0 0 0"),
    });
    const blend = (hex: string, overlay: number, alpha: number) =>
      `#${[1, 3, 5]
        .map((index) => {
          const channel = Number.parseInt(hex.slice(index, index + 2), 16);
          return Math.round(channel * (1 - alpha) + overlay * alpha)
            .toString(16)
            .padStart(2, "0");
        })
        .join("")}`;
    for (const [mode, palette, source] of [
      ["light", light, lightBlock],
      ["dark", dark, darkBlock],
    ] as const)
      for (const [fill, gloss] of [
        ["accent-fill", "gloss"],
        ["accent-fill-hover", "gloss-hover"],
        ["accent-fill-hover", "gloss-active"],
      ] as const) {
        const { white, black } = alphas(raw(source, gloss) || raw(lightBlock, gloss));
        expect(white, `${mode} --${gloss} top highlight`).toBeGreaterThan(0);
        expect(black, `${mode} --${gloss} bottom shade`).toBeGreaterThan(0);
        const base = palette[fill] ?? "#000000";
        const text = palette["on-accent"] ?? "#000000";
        expect(
          contrast(text, blend(base, 255, white)),
          `${mode} --${fill} gloss top`,
        ).toBeGreaterThanOrEqual(4.5);
        expect(
          contrast(text, blend(base, 0, black)),
          `${mode} --${fill} gloss bottom`,
        ).toBeGreaterThanOrEqual(4.5);
      }
  });

  it("keeps every hero gradient stop at least 3:1 as large text", () => {
    for (const [mode, palette, pattern] of [
      ["light", light, /:root\s*\{([\s\S]*?)\}/],
      ["dark", dark, /@media \(prefers-color-scheme: dark\)\s*\{\s*:root\s*\{([\s\S]*?)\}/],
    ] as const) {
      const stops = block(pattern).match(/--hero-ink-stops:\s*([^;]+);/)?.[1] ?? "";
      const segments = stops.split(",").map((segment) => segment.trim());
      expect(segments.length, `${mode} hero stops`).toBeGreaterThanOrEqual(6);
      // 6桁hex以外の停止点は検査をすり抜けるため、書式そのものを固定する。
      for (const segment of segments)
        expect(segment, `${mode} hero stop format`).toMatch(/^#[0-9a-fA-F]{6}\s+\d+%$/);
      const colors = segments.map((segment) => segment.split(/\s+/)[0] ?? "");
      for (const color of colors)
        for (const bg of ["ground", "hero-top", "surface"])
          expect(
            contrast(color, palette[bg] ?? "#000000"),
            `${mode} hero stop ${color} on --${bg}`,
          ).toBeGreaterThanOrEqual(3);
    }
  });

  it("draws the focus ring as a non-text indicator of at least 3:1", () => {
    const rule = css.match(/(^|\})\s*:focus-visible\s*\{([^}]*)\}/)?.[2] ?? "";
    const token = rule.match(/outline:\s*2px solid var\(--([a-z-]+)\)/)?.[1] ?? "";
    expect(token).not.toBe("");
    for (const [mode, palette] of [
      ["light", light],
      ["dark", dark],
    ] as const)
      for (const bg of ["ground", "surface", "surface-muted"])
        expect(
          contrast(palette[token] ?? "#000000", palette[bg] ?? "#000000"),
          `${mode} focus --${token} on --${bg}`,
        ).toBeGreaterThanOrEqual(3);
  });
});

// ギガサイト便の構造と質感（光沢・ベベル・点線ドロップ）を、CSPの範囲で再現する。
describe("spec: giga-site glossy surfaces", () => {
  const all = [...css.matchAll(/([^{}]+)\{([^{}]*)\}/g)].map((m) => ({
    selectors: (m[1] ?? "").split(",").map((part) => part.trim()),
    body: m[2] ?? "",
  }));
  const rules = (selector: string) =>
    all.filter((rule) => rule.selectors.includes(selector)).map((rule) => rule.body);
  const px = (body: string, property: string) =>
    Number(body.match(new RegExp(`(^|[;{\\s])${property}:\\s*([\\d.]+)px`))?.[2] ?? Number.NaN);

  it("paints glossy fills as color plus gloss layers, never the background shorthand", () => {
    for (const [selector, gloss] of [
      [".primary-button", "--gloss"],
      [".copy-button.is-primary", "--gloss"],
      [".drop-tile", "--gloss-tile"],
      [".logo-tile", "--gloss"],
      [".heading-icon", "--gloss-tile"],
    ] as const) {
      const body = rules(selector).join("\n");
      expect(body, selector).toMatch(/background-color:\s*var\(--accent-fill\)/);
      expect(body, selector).toContain(`background-image: var(${gloss})`);
      // 状態違い（:hover や @media 内の上書き）でも、ショートハンドは光沢の層を消してしまう。
      for (const rule of all.filter((candidate) =>
        candidate.selectors.some(
          (part) =>
            part === selector ||
            (/^[:.[]/.test(part.slice(selector.length)) && part.startsWith(selector)),
        ),
      ))
        expect(rule.body, rule.selectors.join(", ")).not.toMatch(/(^|[;{\s])background\s*:/);
    }
    for (const [state, gloss] of [
      [":hover:not(:disabled)", "--gloss-hover"],
      [":active:not(:disabled)", "--gloss-active"],
    ] as const)
      for (const selector of [".primary-button", ".copy-button.is-primary"]) {
        const body = rules(`${selector}${state}`).join("\n");
        expect(body, `${selector}${state}`).toMatch(
          /background-color:\s*var\(--accent-fill-hover\)/,
        );
        expect(body, `${selector}${state}`).toContain(`background-image: var(${gloss})`);
      }
  });

  it("frames the page with an announcement band, a translucent sticky header and a logo tile", () => {
    const announce = html.indexOf('<aside class="announce" aria-label="お知らせ">');
    expect(announce).toBeGreaterThan(-1);
    expect(announce).toBeLessThan(html.indexOf('<header class="site-header"'));
    const header = html.split('<header class="site-header"')[1]?.split("</header>")[0] ?? "";
    expect(header).toMatch(/class="logo-tile" aria-hidden="true"/);
    expect(header).toContain('href="https://github.com/kandotrun/send"');
    const sticky = rules(".site-header").join("\n");
    expect(sticky).toMatch(/position:\s*sticky/);
    expect(sticky).toMatch(/backdrop-filter:\s*blur\(/);
    // 固定ヘッダーの下にフォーカス先が隠れないよう、スクロール位置に余白を取る（WCAG 2.4.11）。
    const padding = px(rules("html").join("\n"), "scroll-padding-top");
    expect(padding).toBeGreaterThanOrEqual(px(rules(".header-inner").join("\n"), "min-height") + 8);
  });

  it("shimmers the hero heading itself so view titles can keep using textContent", () => {
    const supports =
      css.match(/@supports[^{]*background-clip:\s*text[^{]*\{([\s\S]*?\})\s*\}/)?.[1] ?? "";
    expect(supports).toMatch(/#screen-title\s*\{/);
    expect(supports).toMatch(/background-clip:\s*text/);
    expect(supports).toMatch(/-webkit-text-fill-color:\s*transparent/);
    expect(supports).toMatch(/var\(--hero-ink-stops\)/);
    // 自動で動く表示は5秒以内に止める（WCAG 2.2.2）。
    const animation = supports.match(/animation:\s*hero-shimmer\s+([\d.]+)s([^;]*);/);
    expect(animation).not.toBeNull();
    expect(Number(animation?.[1])).toBeLessThanOrEqual(5);
    expect(animation?.[2]).not.toMatch(/infinite/);
    expect(animation?.[2]).toMatch(/\b(forwards|both)\b/);
    expect(rules("#screen-title").join("\n")).toMatch(/color:\s*var\(--ink\)/);
    expect(css).toMatch(/@keyframes hero-shimmer/);
    // 強制カラーでは背景のグラデーションが外れるため、透明にした文字の塗りを戻す。
    const forced = css.match(/@media \(forced-colors: active\)\s*\{([\s\S]*?\})\s*\}/)?.[1] ?? "";
    expect(forced).toMatch(/#screen-title\s*\{[^}]*-webkit-text-fill-color:\s*CanvasText/);
  });

  it("draws the dropzone as a dashed well with a glossy icon tile", () => {
    const zone = html.split('<div id="dropzone"')[1]?.split('id="file-selection"')[0] ?? "";
    expect(zone).toMatch(/<span class="drop-tile" aria-hidden="true"><svg/);
    expect(rules(".dropzone").join("\n")).toMatch(/border:\s*2px dashed var\(--drop-dash\)/);
    const dragging = rules(".dropzone.is-dragging").join("\n");
    expect(dragging).toMatch(/border-color:\s*var\(--brand\)/);
    // 強制カラーでも分かるよう、色だけでなく線種も変える。
    expect(dragging).toMatch(/border-style:\s*solid/);
  });

  it("uses no CSS url() that the img-src 'self' policy would block", () => {
    expect(css).not.toMatch(/url\(/);
  });
});
