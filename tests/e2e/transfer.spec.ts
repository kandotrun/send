import { readFile } from "node:fs/promises";
import { expect, test } from "@playwright/test";

const sentence = "送信テスト：秘密の文章です。<script>window.untrusted=true</script>";

async function sendText(page: import("@playwright/test").Page) {
  await page.goto("/");
  await page.getByRole("tab", { name: "文章", exact: true }).click();
  await page.locator("#text-input").fill(sentence);
  await page.locator("#send-button").click();
  await expect(page.locator("#read-link")).toHaveValue(/#r=/);
  return {
    readUrl: await page.locator("#read-link").inputValue(),
    manageUrl: await page.locator("#manage-link").inputValue(),
  };
}

test("spec: real encrypted text delivery keeps keys/plaintext off HTTP and renders text safely", async ({
  page,
  context,
}) => {
  const apiRequests: Array<{ url: string; body: string; headers: Record<string, string> }> = [];
  page.on("request", (request) => {
    if (request.url().includes("/api/"))
      apiRequests.push({
        url: request.url(),
        body: request.postData() ?? "",
        headers: request.headers(),
      });
  });
  const { readUrl, manageUrl } = await sendText(page);
  const key = readUrl.split(".").at(-1) as string;
  const manageToken = manageUrl.split(".").at(-1) as string;
  expect(readUrl).not.toContain(manageToken);
  const observed = JSON.stringify(apiRequests);
  expect(observed).not.toContain(key);
  expect(observed).not.toContain(sentence);
  const recipient = await context.newPage();
  await recipient.goto(readUrl);
  await recipient.locator("#receiver-download").click();
  await expect(recipient.locator("#received-text")).toHaveText(sentence);
  expect(await recipient.evaluate(() => "untrusted" in window)).toBe(false);
  expect(await recipient.evaluate(() => localStorage.length)).toBe(0);
});

test("spec: a multi-chunk binary file downloads byte-for-byte through real D1/R2", async ({
  page,
  context,
}) => {
  const bytes = Buffer.alloc(4_194_304 + 101);
  for (let index = 0; index < bytes.length; index++) bytes[index] = index % 251;
  await page.goto("/");
  await page.locator("#file-input").setInputFiles({
    name: "file-<safe>.bin",
    mimeType: "application/octet-stream",
    buffer: bytes,
  });
  await page.locator("#send-button").click();
  await expect(page.locator("#read-link")).toHaveValue(/#r=/);
  const recipient = await context.newPage();
  await recipient.goto(await page.locator("#read-link").inputValue());
  const [download] = await Promise.all([
    recipient.waitForEvent("download"),
    recipient.locator("#receiver-download").click(),
  ]);
  expect(await readFile((await download.path()) as string)).toEqual(bytes);
  expect(download.suggestedFilename()).toBe("file-_safe_.bin");
});

test("spec: management revoke denies a fresh receiver without giving management decryption authority", async ({
  page,
  context,
}) => {
  const { readUrl, manageUrl } = await sendText(page);
  const manage = await context.newPage();
  await manage.goto(manageUrl);
  page.on("dialog", (dialog) => dialog.accept());
  manage.on("dialog", (dialog) => dialog.accept());
  await manage.locator("#revoke-button").click();
  await expect(manage.locator("#status")).toHaveAttribute("data-state", "success");
  await expect(manage.locator("#status")).toContainText("リンクを取り消しました。");
  await expect(manage.locator("#management-state")).toHaveAttribute("data-state", "revoked");
  const recipient = await context.newPage();
  await recipient.goto(readUrl);
  await expect(recipient.locator("#status")).toContainText(/期限|失効|受け取れ|見つか/);
  await expect(recipient.locator("#receiver-download")).not.toBeVisible();
});

test("spec: real drag-and-drop uses the same validation and sends a usable file", async ({
  page,
  context,
}) => {
  await page.goto("/");
  const data = await page.evaluateHandle(() => {
    const transfer = new DataTransfer();
    transfer.items.add(new File(["drop fixture"], "dropped.txt", { type: "text/plain" }));
    return transfer;
  });
  await page.getByTestId("dropzone").dispatchEvent("drop", { dataTransfer: data });
  await page.locator("#send-button").click();
  await expect(page.locator("#read-link")).toHaveValue(/#r=/);
  const recipient = await context.newPage();
  await recipient.goto(await page.locator("#read-link").inputValue());
  const [download] = await Promise.all([
    recipient.waitForEvent("download"),
    recipient.locator("#receiver-download").click(),
  ]);
  expect(await readFile((await download.path()) as string, "utf8")).toBe("drop fixture");
});

test("spec: invalid fragments fail closed without initiating a transfer read", async ({ page }) => {
  const api: string[] = [];
  page.on("request", (r) => {
    if (r.url().includes("/api/transfers/")) api.push(r.url());
  });
  await page.goto("/#r=invalid");
  await expect(page.locator("#status")).toContainText(/リンク|形式/);
  expect(api).toHaveLength(0);
});

test("spec: real served assets and API enforce CSP, no-store and no-referrer", async ({
  request,
}) => {
  for (const path of ["/", "/api/health"]) {
    const response = await request.get(path);
    expect(response.ok()).toBe(true);
    const headers = response.headers();
    expect(headers["content-security-policy"]).toContain("script-src 'self'");
    expect(headers["content-security-policy"]).not.toContain("unsafe-inline");
    expect(headers["referrer-policy"]).toBe("no-referrer");
    expect(headers["cache-control"]).toContain("no-store");
    expect(headers["x-content-type-options"]).toBe("nosniff");
  }
});

// 光沢・グラデ見出し・点線ドロップを実ブラウザーのCSP下で描画し、違反を出さない。
test("spec: glossy giga-site surfaces render under the real CSP without violations", async ({
  page,
}) => {
  await page.addInitScript(() => {
    const seen: string[] = [];
    Object.defineProperty(window, "__cspViolations", { value: seen });
    document.addEventListener("securitypolicyviolation", (event) =>
      seen.push(`${event.violatedDirective} ${event.blockedURI}`),
    );
  });
  await page.goto("/");
  await expect(page.locator("#send-button")).toBeVisible();
  const look = await page.evaluate(() => {
    const style = (selector: string) => {
      const node = document.querySelector(selector);
      if (!node) throw new Error(`missing ${selector}`);
      return getComputedStyle(node);
    };
    const title = style("#screen-title");
    return {
      buttonColor: style("#send-button").backgroundColor,
      button: style("#send-button").backgroundImage,
      buttonShadow: style("#send-button").boxShadow,
      clip: title.backgroundClip || title.getPropertyValue("-webkit-background-clip"),
      header: style(".site-header").position,
      dash: style("#dropzone").borderTopStyle,
      tile: style(".drop-tile").backgroundImage,
    };
  });
  expect(look.button).toContain("linear-gradient");
  expect(look.buttonShadow).toContain("inset");
  expect(look.clip).toBe("text");
  expect(look.header).toBe("sticky");
  expect(look.dash).toBe("dashed");
  expect(look.tile).toContain("linear-gradient");
  expect(look.buttonColor).toBe("rgb(0, 77, 196)");
  const title = await page.locator("#screen-title").evaluate((node) => {
    const style = getComputedStyle(node);
    return {
      image: style.backgroundImage,
      size: style.backgroundSize,
      name: style.animationName,
      // 無限ループは JSON で null になる。
      iterations: node
        .getAnimations()
        .map((motion) => motion.effect?.getComputedTiming().iterations),
    };
  });
  expect(title.image.startsWith("linear-gradient(105deg")).toBe(true);
  expect(title.size).toBe("200% 100%");
  expect(title.name).toBe("hero-shimmer");
  expect(title.iterations).toEqual([1]);
  await page.locator("#send-button").hover();
  await expect
    .poll(() =>
      page.locator("#send-button").evaluate((node) => getComputedStyle(node).backgroundColor),
    )
    .toBe("rgb(0, 58, 154)");
  await page.getByTestId("dropzone").dispatchEvent("dragenter");
  await expect(page.locator("#dropzone")).toHaveClass(/is-dragging/);
  await expect
    .poll(() => page.locator("#dropzone").evaluate((node) => getComputedStyle(node).borderTopColor))
    .toBe("rgb(10, 132, 255)");
  expect(
    await page.evaluate(() => (window as unknown as { __cspViolations: string[] }).__cspViolations),
  ).toEqual([]);
});

// 角丸カードの overflow でフォーカスの輪郭が切れない（WCAG 2.4.7）。
test("spec: keyboard focus rings are never clipped by rounded cards", async ({ page }) => {
  await page.goto("/");
  await expect(page.locator("#send-button")).toBeEnabled();
  const clipped: string[] = [];
  for (let step = 0; step < 14; step += 1) {
    await page.keyboard.press("Tab");
    const issue = await page.evaluate(() => {
      const node = document.activeElement;
      if (!(node instanceof HTMLElement) || node === document.body) return null;
      const name = node.id || node.tagName.toLowerCase();
      const style = getComputedStyle(node);
      if (style.outlineStyle === "none") return `${name}: no outline`;
      const grow = Number.parseFloat(style.outlineOffset) + Number.parseFloat(style.outlineWidth);
      const box = node.getBoundingClientRect();
      for (let parent = node.parentElement; parent; parent = parent.parentElement) {
        const own = getComputedStyle(parent);
        if (own.overflowX === "visible" && own.overflowY === "visible") continue;
        const clip = parent.getBoundingClientRect();
        if (
          box.left - grow < clip.left ||
          box.right + grow > clip.right ||
          box.top - grow < clip.top ||
          box.bottom + grow > clip.bottom
        )
          return `${name} clipped by .${parent.className || parent.tagName}`;
      }
      return null;
    });
    if (issue) clipped.push(issue);
  }
  expect(clipped).toEqual([]);
});

// 固定ヘッダーの下にフォーカス先が隠れない（WCAG 2.4.11）。
test("spec: the sticky header never hides the focused control", async ({ page }) => {
  await page.setViewportSize({ width: 390, height: 640 });
  await page.goto("/");
  await expect(page.locator("#send-button")).toBeEnabled();
  const obscured = () =>
    page.evaluate(() => {
      const node = document.activeElement;
      const header = document.querySelector(".site-header");
      if (!(node instanceof HTMLElement) || !header || node.closest(".site-header")) return "";
      return node.getBoundingClientRect().top < header.getBoundingClientRect().bottom
        ? node.id || node.tagName.toLowerCase()
        : "";
    });
  await page.evaluate(() => window.scrollTo(0, document.documentElement.scrollHeight));
  // 新しく送るときの main.ts と同じく、プログラムからタブへ戻す。
  await page.locator("#file-tab").focus();
  expect(await obscured()).toBe("");
  await page.evaluate(() => window.scrollTo(0, document.documentElement.scrollHeight));
  await page.locator("#security-details summary").focus();
  for (let step = 0; step < 5; step += 1) {
    await page.keyboard.press("Shift+Tab");
    expect(await obscured()).toBe("");
  }
});

// スマホ幅でも長いファイル名を読める幅で出し、取り除くボタンは下へ回す。
test("spec: a long file name keeps a readable width on mobile", async ({ page }) => {
  await page.setViewportSize({ width: 390, height: 844 });
  await page.goto("/");
  await page.locator("#file-input").setInputFiles({
    name: "2026年度_第3四半期_事業計画書_最終確定版_共有用.pdf",
    mimeType: "application/pdf",
    buffer: Buffer.alloc(16, 1),
  });
  await expect(page.locator("#file-selection")).toBeVisible();
  const layout = await page.evaluate(() => {
    const rect = (selector: string) => {
      const node = document.querySelector(selector);
      if (!node) throw new Error(`missing ${selector}`);
      return node.getBoundingClientRect();
    };
    return {
      width: rect("#file-selection .file-information").width,
      nameBottom: rect("#selected-name").bottom,
      clearTop: rect("#file-clear").top,
    };
  });
  expect(layout.width).toBeGreaterThanOrEqual(200);
  expect(layout.clearTop).toBeGreaterThanOrEqual(layout.nameBottom);
});

test.describe("reduced motion", () => {
  test.use({ reducedMotion: "reduce" });

  test("spec: reduced motion stops the shimmer and the drag lift", async ({ page }) => {
    await page.goto("/");
    await expect(page.locator("#send-button")).toBeVisible();
    expect(
      await page.locator("#screen-title").evaluate((node) => getComputedStyle(node).animationName),
    ).toBe("none");
    await page.getByTestId("dropzone").dispatchEvent("dragenter");
    await expect(page.locator("#dropzone")).toHaveClass(/is-dragging/);
    expect(
      await page.locator("#dropzone").evaluate((node) => getComputedStyle(node).transform),
    ).toBe("none");
  });
});

test("spec: mobile first paint has no horizontal overflow and usable controls", async ({
  page,
}) => {
  await page.setViewportSize({ width: 390, height: 844 });
  await page.goto("/");
  await expect(page.locator("#send-button")).toBeVisible();
  expect(await page.evaluate(() => document.documentElement.scrollWidth <= innerWidth)).toBe(true);
  await page.locator("#security-details summary").click();
  await expect(
    page.locator(".security-content").getByText("ウイルス検査", { exact: false }),
  ).toBeVisible();
  await page.screenshot({ path: "test-results/send-mobile.png", fullPage: true });
});

// 通信障害は期限切れ・復号失敗と区別し、固定の案内だけを表示する。
test("spec: receiver network failure gives connection guidance, not expiry or decryption guidance", async ({
  page,
  context,
}) => {
  const { readUrl } = await sendText(page);
  const recipient = await context.newPage();
  await recipient.route(
    (url) => /^\/api\/transfers\/[^/]+$/.test(url.pathname),
    (route) => route.abort("connectionfailed"),
  );
  await recipient.goto(readUrl);
  await expect(recipient.locator("#status")).toHaveAttribute("data-state", "error");
  await expect(recipient.locator("#status-detail")).toContainText(/通信|接続/);
  await expect(recipient.locator("#status-detail")).not.toContainText(/期限|不完全|復号/);
  await expect(recipient.locator("#receiver-download")).not.toBeVisible();
});

// 形式は正しいが鍵が違う場合、復号できないことを明示する。
test("spec: a valid-shaped wrong key gives decryption guidance without a plaintext preview", async ({
  page,
  context,
}) => {
  const { readUrl } = await sendText(page);
  const url = new URL(readUrl);
  const fields = url.hash.split(".");
  fields[2] = Buffer.alloc(32, 1).toString("base64url");
  url.hash = fields.join(".");
  const recipient = await context.newPage();
  await recipient.goto(url.href);
  await expect(recipient.locator("#status")).toHaveAttribute("data-state", "error");
  await expect(recipient.locator("#status-detail")).toContainText(/復号|鍵/);
  await expect(recipient.locator("#status-detail")).not.toContainText(/期限|不完全/);
  await expect(recipient.locator("#received-text")).not.toBeVisible();
  await expect(recipient.locator("#receiver-download")).not.toBeVisible();
});

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
  // 無効画面は説明文が同じ案内を表示するため、状態欄は読み上げ専用にする。
  await manage.goto("/#r=invalid");
  await expect(manage.locator("#invalid-view")).toBeVisible();
  await expect(manage.locator("#status")).toContainText(/リンク|形式/);
  expect((await manage.locator("#status").boundingBox())?.height ?? 0).toBeLessThanOrEqual(1);
});

test.describe("dark color scheme", () => {
  test.use({ colorScheme: "dark", viewport: { width: 390, height: 844 } });

  test("spec: dark mode repaints the page without horizontal overflow", async ({ page }) => {
    await page.goto("/");
    expect(await page.evaluate(() => getComputedStyle(document.body).backgroundColor)).toBe(
      "rgb(11, 12, 16)",
    );
    expect(
      await page.locator("#send-button").evaluate((node) => getComputedStyle(node).backgroundColor),
    ).toBe("rgb(76, 154, 255)");
    expect(await page.evaluate(() => document.documentElement.scrollWidth <= innerWidth)).toBe(
      true,
    );
    await page.screenshot({ path: "test-results/send-mobile-dark.png", fullPage: true });
  });
});

// キーボードで受け取った文章へ移ったフォーカスは、視認できる輪郭を保つ。
test("spec: keyboard focus on received text keeps a visible outline", async ({ page, context }) => {
  const { readUrl } = await sendText(page);
  const recipient = await context.newPage();
  await recipient.goto(readUrl);
  await expect(recipient.locator("#receiver-download")).toBeEnabled();
  await recipient.locator("#receiver-download").focus();
  await recipient.keyboard.press("Enter");
  await expect(recipient.locator("#received-text")).toBeFocused();
  expect(
    await recipient
      .locator("#received-text")
      .evaluate((node) => getComputedStyle(node).outlineStyle),
  ).not.toBe("none");
});
