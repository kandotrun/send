import {
  createTransfer,
  getManagement,
  openTransfer,
  parseManageLink,
  parseReadLink,
  revokeTransfer,
} from "../client/transfer.ts";
import type {
  CreatedTransfer,
  ManageLink,
  ManageRecord,
  OpenedTransfer,
  Progress,
  TransferInput,
} from "../shared/protocol.ts";
import { failureDetail } from "./failure.ts";
import {
  formatExpiry,
  formatSize,
  parseTtl,
  resolveFiles,
  safeDownloadName,
  validateFiles,
  validateText,
} from "./presentation.ts";
import {
  LARGE_FILE_GUIDE,
  needsNativeSave,
  saveFailureCode,
  saveFailureDetail,
  saveLargeFile,
  supportsNativeSave,
} from "./save.ts";
import "./style.css";

function element<T = HTMLElement>(id: string): T {
  const node = document.getElementById(id);
  if (!node) throw new Error("Missing application control");
  return node as T;
}

const main = element("main-content");
const fieldset = element<HTMLFieldSetElement>("send-fieldset");
const sendForm = element<HTMLFormElement>("send-form");
const fileInput = element<HTMLInputElement>("file-input");
const textInput = element<HTMLTextAreaElement>("text-input");
const ttlSelect = element<HTMLSelectElement>("expiry");
const sendButton = element<HTMLButtonElement>("send-button");
const dropzone = element("dropzone");
const fileTab = element<HTMLButtonElement>("file-tab");
const textTab = element<HTMLButtonElement>("text-tab");
const status = element("status");
const progress = element<HTMLProgressElement>("operation-progress");
const cancelButton = element<HTMLButtonElement>("cancel-button");
const readLinkInput = element<HTMLInputElement>("read-link");
const manageLinkInput = element<HTMLInputElement>("manage-link");
const receiveButton = element<HTMLButtonElement>("receiver-download");
const revokeCreatedButton = element<HTMLButtonElement>("revoke-created");
const revokeManagedButton = element<HTMLButtonElement>("revoke-button");
const viewNames = ["sender", "created", "receiver", "management", "invalid"] as const;
type View = (typeof viewNames)[number];
type StatusState = "pending" | "success" | "error" | "cancelled";

let view: View = "sender";
let mode: "file" | "text" = "file";
let selectedFile: File | null = null;
let busy = false;
let uploadsEnabled: boolean | null = null;
let controller: AbortController | null = null;
let routeVersion = 0;
let created: CreatedTransfer | null = null;
let createdRevoked = false;
let managementLink: ManageLink | null = null;
let managementRecord: ManageRecord | null = null;
let opened: OpenedTransfer | null = null;
let textBlob: Blob | null = null;
let textValue = "";
let dragDepth = 0;
const objectUrls = new Set<string>();

function setStatus(state: StatusState, title: string, detail = "", cancellable = false): void {
  status.hidden = false;
  status.dataset.state = state;
  element("status-title").textContent = title;
  element("status-detail").textContent = detail;
  element("status-detail").hidden = !detail;
  cancelButton.hidden = state !== "pending" || !cancellable;
  cancelButton.disabled = false;
  progress.hidden = state !== "pending";
  if (state === "pending") progress.removeAttribute("value");
  element("status-indicator").textContent =
    state === "success" ? "✓" : state === "error" ? "!" : "";
}

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
  // 導入は送信画面だけに見せ、他の画面ではカード内の見出しを唯一の見える見出しにする。
  main.dataset.view = next;
  element("screen-title").textContent = headings[next];
}

function refreshControls(): void {
  fieldset.disabled = busy;
  sendForm.setAttribute("aria-busy", String(busy));
  sendButton.disabled = busy || uploadsEnabled === false;
  for (const button of document.querySelectorAll<HTMLButtonElement>(
    "#created-view button, #receiver-view button, #management-view button, #invalid-view button",
  ))
    button.disabled = busy;
  receiveButton.disabled =
    busy ||
    !opened ||
    opened.expiresAt <= Date.now() ||
    textBlob !== null ||
    (needsNativeSave(opened.manifest) && !supportsNativeSave(window.showSaveFilePicker));
  revokeCreatedButton.disabled = busy || !created || createdRevoked;
  revokeManagedButton.disabled =
    busy ||
    !managementRecord ||
    managementRecord.state === "revoked" ||
    managementRecord.expiresAt <= Date.now();
}

function startOperation(title: string, detail: string, cancellable = true): AbortController {
  const active = new AbortController();
  controller = active;
  busy = true;
  refreshControls();
  setStatus("pending", title, detail, cancellable);
  return active;
}

function endOperation(active: AbortController): void {
  if (controller !== active) return;
  controller = null;
  busy = false;
  refreshControls();
}

function onProgress(update: Progress): void {
  if (!busy || !controller || controller.signal.aborted) return;
  const titles: Record<Progress["stage"], string> = {
    encrypting: "この端末で暗号化しています",
    uploading: "暗号化した内容を送信しています",
    downloading: "受け取り、復号しています",
  };
  element("status-title").textContent = titles[update.stage];
  const fraction = update.total > 0 ? Math.max(0, Math.min(1, update.done / update.total)) : 0;
  progress.value = Math.round(fraction * 100);
  element("status-detail").textContent =
    `${Math.round(fraction * 100)}% · この画面を開いたままお待ちください。`;
}

function inputError(message: string | null): void {
  const node = element("input-error");
  node.textContent = message ?? "";
  node.hidden = message === null;
  fileInput.setAttribute("aria-invalid", String(message !== null && mode === "file"));
  textInput.setAttribute("aria-invalid", String(message !== null && mode === "text"));
}

function setMode(next: "file" | "text", focus = false): void {
  if (busy) return;
  mode = next;
  for (const [tab, name] of [
    [fileTab, "file"],
    [textTab, "text"],
  ] as const) {
    tab.setAttribute("aria-selected", String(name === next));
    tab.tabIndex = name === next ? 0 : -1;
  }
  element("file-panel").hidden = next !== "file";
  element("text-panel").hidden = next !== "text";
  inputError(null);
  if (focus) (next === "file" ? fileTab : textTab).focus();
}

function acceptFiles(list: FileList | File[] | null | undefined): void {
  if (busy || view !== "sender") return;
  setMode("file");
  const files = Array.from(list ?? []);
  const selection = resolveFiles(files);
  fileInput.value = "";
  inputError(selection.error);
  selectedFile = selection.file;
  element("selected-name").textContent = selectedFile?.name ?? "";
  element("selected-size").textContent = selectedFile ? formatSize(selectedFile.size) : "";
  element("file-selection").hidden = selectedFile === null;
  element("file-pick").textContent = "ファイルを選ぶ";
}

function clearFile(): void {
  if (busy) return;
  selectedFile = null;
  fileInput.value = "";
  element("selected-name").textContent = "";
  element("selected-size").textContent = "";
  element("file-selection").hidden = true;
  inputError(null);
  element("file-pick").focus();
}

function setExpiry(id: string, timestamp: number): void {
  const node = element<HTMLTimeElement>(id);
  node.textContent = formatExpiry(timestamp);
  if (Number.isFinite(timestamp) && !Number.isNaN(new Date(timestamp).getTime())) {
    node.dateTime = new Date(timestamp).toISOString();
  }
}

async function send(): Promise<void> {
  if (busy || uploadsEnabled === false) return;
  let input: TransferInput;
  if (mode === "file") {
    const error = validateFiles(selectedFile ? [selectedFile] : []);
    inputError(error);
    if (error || !selectedFile) return;
    input = {
      blob: selectedFile,
      kind: "file",
      name: selectedFile.name,
      mime: selectedFile.type || "application/octet-stream",
    };
  } else {
    const error = validateText(textInput.value);
    inputError(error);
    if (error) return;
    input = {
      blob: new Blob([textInput.value], { type: "text/plain;charset=utf-8" }),
      kind: "text",
      name: "文章.txt",
      mime: "text/plain;charset=utf-8",
    };
  }
  let ttl: ReturnType<typeof parseTtl>;
  try {
    ttl = parseTtl(ttlSelect.value);
  } catch {
    inputError("有効期限を選び直してください。");
    return;
  }
  const version = routeVersion;
  const active = startOperation(
    "この端末で暗号化しています",
    "この画面を開いたままお待ちください。",
  );
  try {
    const result = await createTransfer(input, ttl, {
      signal: active.signal,
      onProgress: onProgress,
    });
    if (version !== routeVersion || active.signal.aborted) {
      // Creation may finish in the same turn as cancellation. Revoke that completed result too.
      try {
        await revokeTransfer(parseManageLink(result.manageUrl));
      } catch {
        /* Expiry remains the fallback. */
      }
      if (version === routeVersion)
        setStatus("cancelled", "送信を中止しました。", "共有リンクは発行していません。");
      return;
    }
    created = result;
    createdRevoked = false;
    readLinkInput.value = result.readUrl;
    manageLinkInput.value = result.manageUrl;
    setExpiry("created-expiry", result.expiresAt);
    setView("created");
    setStatus(
      "success",
      "送信が完了しました。",
      "共有リンクと管理リンクを、それぞれ保管してください。",
    );
    element("created-title").focus();
  } catch (error) {
    if (version !== routeVersion) return;
    if (active.signal.aborted) {
      setStatus(
        "cancelled",
        "送信を中止しました。",
        "共有リンクは発行していません。途中の送信データは取り消しを試み、残った場合も期限で受け取れなくなります。",
      );
    } else setStatus("error", "送信できませんでした。", failureDetail(error, "send"));
  } finally {
    endOperation(active);
  }
}

function saveBlob(blob: Blob, name: string): void {
  // Force an attachment: never navigate to or embed an untrusted file, including HTML and SVG.
  const url = URL.createObjectURL(blob);
  objectUrls.add(url);
  const anchor = document.createElement("a");
  anchor.href = url;
  anchor.download = safeDownloadName(name);
  anchor.rel = "noopener noreferrer";
  document.body.appendChild(anchor);
  anchor.click();
  anchor.remove();
  window.setTimeout(() => {
    URL.revokeObjectURL(url);
    objectUrls.delete(url);
  }, 60_000);
}

async function receive(): Promise<void> {
  const transfer = opened;
  if (busy || !transfer || textBlob) return;
  if (transfer.expiresAt <= Date.now()) {
    setStatus(
      "error",
      "有効期限が過ぎています。",
      "送り主に、新しいリンクを作ってもらってください。",
    );
    refreshControls();
    return;
  }
  const version = routeVersion;
  const active = startOperation(
    "受け取り、復号しています",
    needsNativeSave(transfer.manifest)
      ? "保存先を選んでください。保存先の空き容量と権限を確認してください。"
      : "すべての内容を確認してから保存します。",
  );
  try {
    if (needsNativeSave(transfer.manifest)) {
      await saveLargeFile(transfer, window.showSaveFilePicker?.bind(window), {
        signal: active.signal,
        onProgress: onProgress,
        isCurrent: () => version === routeVersion,
      });
      if (version !== routeVersion || active.signal.aborted) return;
      setStatus("success", "ファイルを保存しました。", "選んだ保存先を確認してください。");
      return;
    }
    const blob = await transfer.download({ signal: active.signal, onProgress: onProgress });
    if (version !== routeVersion || active.signal.aborted) return;
    if (transfer.manifest.kind === "text") {
      const value = await blob.text();
      if (version !== routeVersion || active.signal.aborted) return;
      textBlob = blob;
      textValue = value;
      element("received-text").textContent = value;
      element("received-text-panel").hidden = false;
      element("receive-button-label").textContent = "文章を開きました";
      setStatus(
        "success",
        "文章を受け取りました。",
        "必要なら、コピーまたはファイルとして保存できます。",
      );
      element("received-text").focus();
    } else {
      saveBlob(blob, transfer.manifest.name);
      setStatus(
        "success",
        "ファイルを復号しました。",
        "ブラウザーのダウンロード先を確認してください。",
      );
    }
  } catch (error) {
    if (version !== routeVersion) return;
    const saveDetail = saveFailureDetail(error);
    const cancelled = active.signal.aborted || saveFailureCode(error) === "cancelled";
    setStatus(
      cancelled ? "cancelled" : "error",
      cancelled ? "受け取りを中止しました。" : "受け取れませんでした。",
      saveDetail ??
        (active.signal.aborted
          ? "もう一度ボタンを押すと、はじめから受け取れます。"
          : failureDetail(error, "receive")),
    );
  } finally {
    if (version === routeVersion && active.signal.aborted && status.dataset.state === "pending") {
      setStatus(
        "cancelled",
        "受け取りを中止しました。",
        "もう一度ボタンを押すと、はじめから受け取れます。",
      );
    }
    endOperation(active);
  }
}

async function copy(value: string, label: string, input?: HTMLInputElement): Promise<void> {
  if (busy || !value) return;
  const version = routeVersion;
  try {
    await navigator.clipboard.writeText(value);
    if (version === routeVersion) setStatus("success", `${label}をコピーしました。`);
  } catch {
    if (version !== routeVersion) return;
    if (input) {
      input.focus();
      input.select();
    } else element("received-text").focus();
    setStatus(
      "error",
      "自動でコピーできませんでした。",
      "内容を選択して、ブラウザーのコピー操作を使ってください。",
    );
  }
}

function renderManagement(record: ManageRecord): void {
  managementRecord = record;
  element("management-state").textContent =
    record.expiresAt <= Date.now()
      ? "期限切れ"
      : record.state === "ready"
        ? "受け取り可能"
        : record.state === "revoked"
          ? "取り消し済み"
          : "アップロード中";
  element("management-chunks").textContent = `${record.uploadedChunks} / ${record.chunkCount} 完了`;
  setExpiry("management-expiry", record.expiresAt);
  refreshControls();
}

async function revoke(fromCreated: boolean): Promise<void> {
  if (busy) return;
  let link: ManageLink;
  try {
    if (fromCreated) {
      if (!created || createdRevoked) return;
      link = parseManageLink(created.manageUrl);
    } else {
      if (!managementLink || managementRecord?.state === "revoked") return;
      link = managementLink;
    }
  } catch {
    setStatus("error", "取り消せませんでした。", "管理リンク全体を確認してください。");
    return;
  }
  if (!window.confirm("この共有リンクを取り消しますか？\n相手が保存したコピーは取り消せません。"))
    return;
  const version = routeVersion;
  const active = startOperation(
    "リンクを取り消しています",
    "すでに保存されたコピーは取り消せません。",
    false,
  );
  try {
    await revokeTransfer(link);
    if (version !== routeVersion) return;
    if (fromCreated) createdRevoked = true;
    else if (managementRecord) renderManagement({ ...managementRecord, state: "revoked" });
    setStatus(
      "success",
      "リンクを取り消しました。",
      "新たな受け取りはできません。すでに保存されたコピーや開始済みの配信は残る場合があります。",
    );
    // A write response is not a status read. Confirm the exact capability separately.
    try {
      const record = await getManagement(link);
      if (version !== routeVersion) return;
      if (!fromCreated) renderManagement(record);
      if (record.state !== "revoked")
        setStatus(
          "error",
          "取り消しの状態を確認できません。",
          "管理リンクで状態を確認し直してください。",
        );
    } catch {
      if (version === routeVersion)
        setStatus(
          "success",
          "取り消しを受け付けました。",
          "状態の再確認はできませんでした。期限切れの場合も受け取りはできません。",
        );
    }
  } catch (error) {
    if (version === routeVersion)
      setStatus("error", "取り消せませんでした。", failureDetail(error, "manage"));
  } finally {
    endOperation(active);
  }
}

function showInvalid(detail: string): void {
  setView("invalid");
  element("invalid-description").textContent = detail;
  setStatus("error", "このリンクは開けません。", detail);
  element("invalid-title").focus();
}

function clearPrivateState(): void {
  opened = null;
  managementLink = null;
  managementRecord = null;
  created = null;
  createdRevoked = false;
  textBlob = null;
  textValue = "";
  readLinkInput.value = "";
  manageLinkInput.value = "";
  element("received-text").textContent = "";
  element("receive-name").textContent = "";
  element("received-text-panel").hidden = true;
  for (const url of objectUrls) URL.revokeObjectURL(url);
  objectUrls.clear();
}

function reset(): void {
  if (busy) return;
  if (
    created &&
    !window.confirm("リンクを保管しましたか？\n新しく送ると、この画面のリンクは再表示できません。")
  )
    return;
  routeVersion += 1;
  clearPrivateState();
  selectedFile = null;
  sendForm.reset();
  element("file-selection").hidden = true;
  element("selected-name").textContent = "";
  element("selected-size").textContent = "";
  element("text-size").textContent = "文章は100 MBまで。この端末で暗号化します。";
  window.history.replaceState(null, "", window.location.pathname);
  setMode("file");
  setView("sender");
  status.hidden = true;
  delete status.dataset.state;
  refreshControls();
  fileTab.focus();
}

async function route(): Promise<void> {
  const version = ++routeVersion;
  controller?.abort();
  controller = null;
  busy = false;
  clearPrivateState();
  status.hidden = true;
  delete status.dataset.state;
  if (!window.location.hash) {
    setView("sender");
    refreshControls();
    return;
  }
  if (window.location.hash.startsWith("#r=")) {
    try {
      const link = parseReadLink(window.location.href);
      setView("receiver");
      const active = startOperation(
        "お届けものを確認しています",
        "ファイル名と期限を、この端末で復号します。",
      );
      try {
        const transfer = await openTransfer(link, { signal: active.signal });
        if (version !== routeVersion || active.signal.aborted) return;
        opened = transfer;
        element("receive-name").textContent = transfer.manifest.name;
        element("receive-size").textContent =
          `${transfer.manifest.kind === "text" ? "文章" : "ファイル"} · ${formatSize(transfer.manifest.size)}`;
        setExpiry("receive-expiry", transfer.expiresAt);
        element("receive-button-label").textContent =
          transfer.manifest.kind === "text"
            ? "文章を開く"
            : needsNativeSave(transfer.manifest)
              ? "保存先を選んで受け取る"
              : "ファイルを保存する";
        if (needsNativeSave(transfer.manifest) && !supportsNativeSave(window.showSaveFilePicker)) {
          setStatus("error", "このブラウザーでは受け取れません。", LARGE_FILE_GUIDE);
        } else {
          setStatus(
            "success",
            "受け取る準備ができました。",
            "内容は、受け取りボタンを押すまでダウンロードしません。",
          );
        }
      } catch (error) {
        if (version === routeVersion)
          showInvalid(
            active.signal.aborted
              ? "確認を中止しました。リンクを開き直すと、もう一度確認できます。"
              : failureDetail(error, "receive"),
          );
      } finally {
        if (version === routeVersion && active.signal.aborted && status.dataset.state === "pending")
          showInvalid("確認を中止しました。リンクを開き直すと、もう一度確認できます。");
        endOperation(active);
      }
    } catch {
      if (version === routeVersion)
        showInvalid(
          "共有リンクが不完全です。送った相手に、リンク全体を送り直してもらってください。",
        );
    }
  } else if (window.location.hash.startsWith("#m=")) {
    try {
      const link = parseManageLink(window.location.href);
      managementLink = link;
      setView("management");
      const active = startOperation(
        "リンクの状態を確認しています",
        "管理リンクで、期限と取り消し状態を確認します。",
        false,
      );
      try {
        const record = await getManagement(link);
        if (version !== routeVersion) return;
        renderManagement(record);
        setStatus("success", "リンクの状態を確認しました。");
      } catch (error) {
        if (version === routeVersion) showInvalid(failureDetail(error, "manage"));
      } finally {
        endOperation(active);
      }
    } catch {
      if (version === routeVersion)
        showInvalid("管理リンクが不完全です。保管したリンク全体を確認してください。");
    }
  } else {
    showInvalid(
      "リンクの形式を確認できません。送った相手に、リンク全体を送り直してもらってください。",
    );
  }
  refreshControls();
}

async function checkService(): Promise<void> {
  try {
    const response = await fetch("/api/health", { cache: "no-store", credentials: "omit" });
    if (!response.ok) return;
    const health: unknown = await response.json();
    if (
      !health ||
      typeof health !== "object" ||
      !("uploadsEnabled" in health) ||
      typeof health.uploadsEnabled !== "boolean"
    )
      return;
    uploadsEnabled = health.uploadsEnabled;
    element("service-notice").textContent =
      "現在、新しい送信の受付を停止しています。既存の共有リンクからの受け取りは利用できます。";
    element("service-notice").hidden = view !== "sender" || uploadsEnabled;
    refreshControls();
  } catch {
    /* Optional readiness notice; the actual transfer request remains authoritative. */
  }
}

fileTab.addEventListener("click", () => setMode("file"));
textTab.addEventListener("click", () => setMode("text"));
for (const tab of [fileTab, textTab])
  tab.addEventListener("keydown", (event) => {
    if (!["ArrowLeft", "ArrowRight", "Home", "End"].includes(event.key) || busy) return;
    event.preventDefault();
    setMode(
      event.key === "Home"
        ? "file"
        : event.key === "End"
          ? "text"
          : mode === "file"
            ? "text"
            : "file",
      true,
    );
  });
element("file-pick").addEventListener("click", () => {
  if (!busy) fileInput.click();
});
fileInput.addEventListener("change", () => acceptFiles(fileInput.files));
element("file-clear").addEventListener("click", clearFile);
textInput.addEventListener("input", () => {
  inputError(null);
  element("text-size").textContent =
    `${formatSize(new TextEncoder().encode(textInput.value).byteLength)} / 100 MB`;
});
dropzone.addEventListener("dragenter", (event) => {
  event.preventDefault();
  if (busy || view !== "sender") return;
  dragDepth += 1;
  dropzone.classList.add("is-dragging");
});
dropzone.addEventListener("dragover", (event) => {
  event.preventDefault();
  if (event.dataTransfer) event.dataTransfer.dropEffect = busy ? "none" : "copy";
});
dropzone.addEventListener("dragleave", (event) => {
  event.preventDefault();
  dragDepth = Math.max(0, dragDepth - 1);
  if (dragDepth === 0) dropzone.classList.remove("is-dragging");
});
dropzone.addEventListener("drop", (event) => {
  event.preventDefault();
  dragDepth = 0;
  dropzone.classList.remove("is-dragging");
  acceptFiles(event.dataTransfer?.files);
});
// Dropping outside the target must not navigate away to the local file.
window.addEventListener("dragover", (event) => event.preventDefault());
window.addEventListener("drop", (event) => event.preventDefault());
sendForm.addEventListener("submit", (event) => {
  event.preventDefault();
  void send();
});
cancelButton.addEventListener("click", () => {
  if (!controller || !busy) return;
  controller.abort();
  cancelButton.disabled = true;
  element("status-title").textContent = "中止しています";
  element("status-detail").textContent = "途中の処理を終了しています。少しお待ちください。";
});
element("copy-read").addEventListener("click", () => {
  void copy(readLinkInput.value, "共有リンク", readLinkInput);
});
element("copy-manage").addEventListener("click", () => {
  void copy(manageLinkInput.value, "管理リンク", manageLinkInput);
});
receiveButton.addEventListener("click", () => {
  void receive();
});
element("copy-text").addEventListener("click", () => {
  void copy(textValue, "文章");
});
element("download-text").addEventListener("click", () => {
  if (!busy && textBlob && opened) saveBlob(textBlob, opened.manifest.name);
});
revokeCreatedButton.addEventListener("click", () => {
  void revoke(true);
});
revokeManagedButton.addEventListener("click", () => {
  void revoke(false);
});
element("new-send").addEventListener("click", reset);
for (const button of document.querySelectorAll<HTMLButtonElement>("[data-new-send]"))
  button.addEventListener("click", reset);
window.addEventListener("hashchange", () => {
  void route();
});
window.addEventListener("pagehide", () => {
  controller?.abort();
  clearPrivateState();
});
window.setInterval(() => {
  refreshControls();
  if (!busy && opened && opened.expiresAt <= Date.now() && view === "receiver" && !textBlob) {
    setStatus(
      "error",
      "有効期限が過ぎています。",
      "送り主に、新しいリンクを作ってもらってください。",
    );
  }
}, 1000);
void route();
void checkService();
