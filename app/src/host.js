// restricted-wasm-v1 host (KOTOBA-159). This page is the trusted shell: it holds the canonical
// runtime and broker, verifies the guest document against the SHA-256 and source commit pinned at
// build time, and mounts it with mountRestrictedClientApp in an opaque-origin sandbox. The guest
// reaches the network only through this broker, one consent per operation, for the downloads the
// descriptor declares, unless the user withdrew it in 設定 › 許可した送信. The host reads nothing
// but ./host-data.js.
import { createClientConsentHost, createClientOperationBroker, mountRestrictedClientApp, verifyClientArtifact } from "./kotoba-client-runtime.js";
import { WITHDRAWAL_TEXT, browserStorage, createAllowedSending, memoryStorage } from "./allowed-sending.js";
import host from "./host-data.js";

const container = document.getElementById("app");
const { descriptor } = host;
const consentHost = createClientConsentHost({ locale: "ja" });
const SERVICE_LABELS = { yataverse: "詳細な国境と道路データの取得（Yataverse）" };

let storage;
try { globalThis.localStorage.length; storage = browserStorage(); } catch { storage = memoryStorage(); }
const allowed = createAllowedSending(storage);
let mounted = null;

function problem(error) {
  const p = document.createElement("p");
  p.className = "problem";
  p.textContent = "アプリを起動できませんでした。 " + String(error?.message ?? error);
  container.replaceChildren(p);
}

async function mount() {
  mounted?.close();
  mounted = null;
  try {
    const eligible = allowed.eligible(descriptor.operations);
    const broker = createClientOperationBroker({
      runtime: descriptor,
      requestedCapabilities: descriptor.operations.map(({ capability }) => capability),
      hostSupportedOperations: eligible.map(({ capability, service, operation }) => [capability, service, operation]),
      approvedOperations: eligible,
      consentHost,
      app: { name: "地図" },
    });
    const artifact = await verifyClientArtifact(new TextEncoder().encode(host.guest), host.artifact);
    mounted = await mountRestrictedClientApp({ artifact, container, broker });
  } catch (error) { problem(error); }
}

function renderSettings() {
  const foreign = document.getElementById("foreign-info");
  if (host.foreignInfo) foreign.href = host.foreignInfo; else foreign.closest("p").hidden = true;
  document.getElementById("withdrawal-text").textContent = WITHDRAWAL_TEXT;
  const list = document.getElementById("allowed-list");
  const services = [...new Set(descriptor.operations.map(({ service }) => service))];
  list.replaceChildren(...services.map((service) => {
    const op = descriptor.operations.find((o) => o.service === service);
    const item = document.createElement("li");
    const withdrawn = allowed.isWithdrawn(service);
    item.append(`${SERVICE_LABELS[service] ?? service} — 送り先: ${op.disclosure.recipient}（${withdrawn ? "取り消し済み" : "送る前に毎回確認します"}）`);
    const button = document.createElement("button");
    button.type = "button";
    button.textContent = withdrawn ? "許可を戻す" : "許可を取り消す";
    button.addEventListener("click", () => (withdrawn ? allowed.restore(service) : allowed.withdraw(service)));
    item.append(button);
    return item;
  }));
  if (!services.length) list.replaceChildren(Object.assign(document.createElement("li"), { textContent: "今は外部へ送る操作はありません（送り先の確定待ち）。" }));
}

// The Tauri shell's read-only host info. The sandboxed guest cannot reach the Tauri IPC, so the
// host shows it (the guest's own line stays empty).
async function showEnvironment() {
  try {
    const info = await globalThis.__TAURI__?.core?.invoke("awai_host_info");
    if (info) document.getElementById("env").textContent = `実行環境: Awai shell（${info.app}）`;
  } catch { /* plain browser */ }
}

allowed.onChange(() => { renderSettings(); mount(); });
showEnvironment();
renderSettings();
await mount();
