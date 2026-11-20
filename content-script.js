const STATE = {
  panel: null,
  statusEl: null,
  contentEl: null,
  progressEl: null,
  progressTextEl: null,
  headerSubEl: null,
  marketBadgeEl: null,
  scoreBadgeEl: null,
  modelBadgeEl: null,
  chatPanelEl: null,
  chatMessagesEl: null,
  chatInputEl: null,
  chatSendBtnEl: null,
  chatToggleBtnEl: null,
  chatOpen: false,
  chatSending: false,
  chatHistory: [],
  chatPanelPos: null,
  panelWidth: 428,
  uiTheme: "night",
  isAnalyzing: false,
  lastTriggerAt: 0,
  triggerIntervalMs: 1500,
  lastResult: null,
  clickTriggerEnabled: false,
  prefetchSymbolSet: new Set(),
  prefetchTimer: null,
  prefetchLoopTimer: null,
  prefetchStatusEl: null,
  prefetchErrorHoldUntil: 0,
  autoPreviewStarted: false,
  batchRunning: false,
  batchProgressPanelEl: null,
  batchProgressBarEl: null,
  batchProgressTextEl: null,
  batchAutoStarted: false,
};
const PREFETCH_ERROR_LOG_KEY = "prefetchErrorLogsV1";
const UI_STYLE_ID = "xq-ai-theme-style-v2";
const UI_PREFS_KEY = "xqUiPrefsV1";
const PANEL_MIN_WIDTH = 380;
const PANEL_MAX_WIDTH = 860;
const FULL_PREFETCH_TARGET_URL = "https://xueqiu.com/hq/detail?market=CN&first_name=0&second_name=0&type=sh_sz";
const FULL_PREFETCH_AUTO_PARAM = "xq_full_prefetch_auto";
const FULL_PREFETCH_MAX_PAGES = 220;
const PREFETCH_CHUNK_SIZE = 60;
let uiPrefsSaveTimer = null;

const DISPLAY_PERIOD_ORDER = ["q1", "h1", "q3", "annual"];
const EXT_INVALIDATED_MSG = "扩展已更新或重载，请刷新当前雪球页面后重试。";

function ensureUiStyles() {
  if (document.getElementById(UI_STYLE_ID)) return;
  const style = document.createElement("style");
  style.id = UI_STYLE_ID;
  style.textContent = `
    :root {
      --xq-bg-1: #06111f;
      --xq-bg-2: #0a1f36;
      --xq-accent: #16b9b3;
      --xq-accent-2: #1e7bf2;
      --xq-good: #0f9d6e;
      --xq-warn: #d97706;
      --xq-bad: #dc2626;
      --xq-text: #e5effa;
      --xq-subtle: #8ba2bf;
      --xq-card: #0f1e32;
      --xq-card-soft: #132843;
      --xq-border: #2a4567;
    }
    #xq-value-analyzer-panel {
      position: fixed;
      top: 78px;
      right: 14px;
      width: 428px;
      max-height: 80vh;
      overflow: hidden;
      display: flex;
      flex-direction: column;
      background: linear-gradient(160deg, rgba(6,17,31,.97), rgba(10,31,54,.97));
      border: 1px solid var(--xq-border);
      border-radius: 16px;
      box-shadow: 0 16px 42px rgba(0, 8, 20, 0.45);
      z-index: 2147483647;
      font-family: "Manrope", "SF Pro Display", "Segoe UI", "PingFang SC", sans-serif;
      font-size: 13px;
      color: var(--xq-text);
      backdrop-filter: blur(8px);
      animation: xq-panel-in .22s ease-out;
    }
    #xq-value-analyzer-panel.xq-collapsed {
      max-height: none !important;
    }
    #xq-value-analyzer-panel.xq-fullscreen {
      max-height: 100vh !important;
      top: 0; right: 0;
      border-radius: 0;
    }
    @keyframes xq-panel-in {
      from { transform: translateY(10px); opacity: .35; }
      to { transform: translateY(0); opacity: 1; }
    }
    #xq-value-analyzer-panel .xq-sticky-head {
      flex-shrink: 0;
      background: linear-gradient(180deg, rgba(13,31,53,.98), rgba(13,31,53,.82));
      z-index: 2;
    }
    #xq-value-analyzer-panel .xq-head {
      padding: 10px 10px 10px 14px;
      display: flex;
      align-items: center;
      justify-content: space-between;
      gap: 8px;
    }
    #xq-value-analyzer-panel .xq-title {
      display: flex;
      flex-direction: column;
      gap: 2px;
      min-width: 0;
      flex: 1 1 auto;
    }
    #xq-value-analyzer-panel .xq-title strong {
      font-size: 14px;
      letter-spacing: .2px;
    }
    #xq-value-analyzer-panel .xq-subtitle {
      font-size: 11px;
      color: var(--xq-subtle);
      font-weight: 600;
      white-space: nowrap;
      overflow: hidden;
      text-overflow: ellipsis;
      margin-left: 6px;
    }
    #xq-value-analyzer-panel .xq-head-badges {
      display: flex;
      gap: 6px;
      align-items: center;
      flex-wrap: nowrap;
      justify-content: flex-end;
      flex: 0 0 auto;
      white-space: nowrap;
    }
    .xq-window-btns { display: flex; gap: 3px; flex-shrink: 0; }
    .xq-btn-icon {
      width: 24px; height: 24px; border-radius: 50%; display: flex; align-items: center;
      justify-content: center; font-size: 13px; padding: 0; border: 1px solid #325074;
      background: #12253d; color: #8ba2bf; cursor: pointer; transition: background .15s;
      font-family: inherit;
    }
    .xq-btn-icon:hover { background: #1e3a5f; }
    .xq-btn-icon.xq-close-icon:hover { background: #7f1d1d; color: #fca5a5; }
    #xq-value-analyzer-panel .xq-top-badge {
      border: 1px solid #375778;
      background: #112842;
      color: #dcecff;
      border-radius: 999px;
      padding: 4px 11px;
      font-size: 12px;
      font-weight: 700;
      letter-spacing: .1px;
      white-space: nowrap;
    }
    #xq-value-analyzer-panel .xq-top-badge.market {
      background: rgba(15, 157, 110, .18);
      border-color: rgba(62, 227, 171, .4);
      color: #8bf4c3;
    }
    #xq-value-analyzer-panel .xq-top-badge.market-neutral {
      background: rgba(217,119,6,.18);
      border-color: rgba(255,196,114,.45);
      color: #ffc879;
    }
    #xq-value-analyzer-panel .xq-top-badge.market-risk {
      background: rgba(220,38,38,.16);
      border-color: rgba(255,120,120,.4);
      color: #ff9a9a;
    }
    #xq-value-analyzer-panel .xq-top-badge.model-badge {
      background: rgba(99,102,241,.18);
      border-color: rgba(139,92,246,.4);
      color: #c4b5fd;
      cursor: default;
    }
    .xq-model-tag {
      border: 1px solid rgba(139,92,246,.4);
      background: rgba(99,102,241,.15);
      color: #c4b5fd;
      border-radius: 4px;
      padding: 4px 10px;
      font-size: 12px;
      font-weight: 600;
      white-space: nowrap;
      cursor: default;
      line-height: 1;
      display: inline-flex;
      align-items: center;
    }
    #xq-value-analyzer-panel .xq-actions {
      display: flex;
      gap: 5px;
      align-items: center;
      flex-wrap: nowrap;
      overflow-x: auto;
      scrollbar-width: none;
      justify-content: flex-start;
      padding: 0 14px 10px;
      max-height: 50px;
      overflow-y: hidden;
      transition: max-height .3s ease, padding .3s ease, opacity .2s ease;
    }
    #xq-value-analyzer-panel .xq-actions::-webkit-scrollbar {
      display: none;
    }
    #xq-value-analyzer-panel.xq-collapsed .xq-actions {
      max-height: 0; padding-top: 0; padding-bottom: 0; opacity: 0; pointer-events: none;
    }
    .xq-head-divider { height: 1px; background: rgba(44,74,112,.3); margin: 0 14px; }
    #xq-value-analyzer-panel.xq-collapsed .xq-body {
      display: none;
    }
    #xq-value-analyzer-panel .xq-body {
      flex: 1; overflow-y: auto; padding: 0 14px 14px;
    }
    .xq-btn {
      border: 1px solid #325074;
      background: #12253d;
      color: var(--xq-text);
      border-radius: 999px;
      padding: 4px 10px;
      cursor: pointer;
      font-size: 12px;
      transition: transform .15s ease, background .15s ease, box-shadow .15s ease;
    }
    .xq-btn:hover {
      transform: translateY(-1px);
      background: #16314f;
      box-shadow: 0 8px 18px rgba(8, 21, 36, 0.45);
    }
    .xq-btn-primary {
      background: linear-gradient(135deg, var(--xq-accent-2), #3aa3ff);
      border-color: transparent;
      color: #f8fbff;
    }
    .xq-btn-chat-active {
      background: linear-gradient(135deg, var(--xq-accent), #16d0c8);
      border-color: transparent;
      color: #031723;
      font-weight: 700;
    }
    #xq-value-analyzer-panel .xq-body {
      padding: 12px;
    }
    #xq-value-analyzer-panel .xq-status {
      color: #9ab2ce;
      margin-bottom: 8px;
    }
    #xq-value-analyzer-panel .xq-progress-wrap {
      margin-bottom: 10px;
      display: none;
    }
    #xq-value-analyzer-panel .xq-progress-outer {
      height: 7px;
      background: #0b1829;
      border: 1px solid #224160;
      border-radius: 999px;
      overflow: hidden;
    }
    #xq-value-analyzer-panel .xq-progress-inner {
      height: 100%;
      width: 0%;
      background: linear-gradient(90deg, var(--xq-accent), var(--xq-accent-2));
      transition: width .2s ease;
    }
    #xq-value-analyzer-panel .xq-progress-text {
      font-size: 12px;
      color: var(--xq-subtle);
      margin-top: 4px;
    }
    #xq-value-analyzer-panel .xq-card {
      border: 1px solid #284667;
      background: linear-gradient(160deg, #102038, #132b48);
      border-radius: 12px;
      padding: 10px;
      margin-bottom: 10px;
    }
    #xq-value-analyzer-panel .xq-hero {
      border: 1px solid #2f5a82;
      background: linear-gradient(95deg, #1e7bf2, #16b9b3);
      border-radius: 14px;
      padding: 12px 14px;
      margin-bottom: 10px;
    }
    #xq-value-analyzer-panel .xq-hero-title {
      font-size: 18px;
      font-weight: 800;
      color: #eef8ff;
      margin-bottom: 6px;
      letter-spacing: .2px;
    }
    #xq-value-analyzer-panel .xq-hero-sub {
      color: #dbf7ff;
      font-size: 13px;
    }
    #xq-value-analyzer-panel .xq-grid {
      display: grid;
      grid-template-columns: 1fr 1fr;
      gap: 10px;
      margin-bottom: 10px;
    }
    #xq-value-analyzer-panel .xq-subcard {
      border: 1px solid #2b4d70;
      background: linear-gradient(160deg, #0f233b, #122f4d);
      border-radius: 12px;
      padding: 10px;
    }
    #xq-value-analyzer-panel .xq-subcard-title {
      font-size: 14px;
      font-weight: 700;
      color: #ddecff;
      margin-bottom: 8px;
    }
    #xq-value-analyzer-panel .xq-metric-row {
      display: flex;
      justify-content: space-between;
      align-items: center;
      gap: 8px;
      padding: 6px 0;
      border-bottom: 1px dashed rgba(98, 126, 158, .28);
    }
    #xq-value-analyzer-panel .xq-metric-row:last-child {
      border-bottom: none;
      padding-bottom: 0;
    }
    #xq-value-analyzer-panel .xq-metric-key {
      color: #89a5c2;
      font-size: 13px;
      flex: 0 0 92px;
    }
    #xq-value-analyzer-panel .xq-metric-val {
      color: #ecf5ff;
      font-size: 14px;
      font-weight: 700;
      text-align: right;
      flex: 1;
      min-width: 0;
      overflow-wrap: anywhere;
    }
    #xq-value-analyzer-panel .xq-muted {
      color: var(--xq-subtle);
      font-size: 12px;
    }
    #xq-value-analyzer-panel .xq-title-row {
      display: flex;
      align-items: baseline;
      justify-content: space-between;
      gap: 8px;
      margin-bottom: 6px;
    }
    #xq-value-analyzer-panel .xq-title-row .xq-name {
      font-size: 15px;
      font-weight: 800;
      color: #f5fbff;
    }
    #xq-value-analyzer-panel .xq-table {
      width: 100%;
      border-collapse: collapse;
      margin-bottom: 8px;
    }
    #xq-value-analyzer-panel .xq-table td {
      padding: 5px 0;
      border-bottom: 1px dashed rgba(93, 125, 160, .25);
      vertical-align: top;
    }
    #xq-value-analyzer-panel .xq-table td:first-child {
      color: #88a0bc;
      width: 116px;
    }
    #xq-value-analyzer-panel .xq-table td:last-child {
      font-weight: 700;
      color: #ecf5ff;
      letter-spacing: .2px;
    }
    #xq-value-analyzer-panel .xq-badge {
      display: inline-flex;
      align-items: center;
      border-radius: 999px;
      padding: 2px 8px;
      font-size: 11px;
      border: 1px solid transparent;
      font-weight: 700;
    }
    #xq-value-analyzer-panel .xq-badge-good {
      background: rgba(7, 97, 66, .35);
      color: #d8ffef;
      border-color: rgba(101, 231, 181, .6);
    }
    #xq-value-analyzer-panel .xq-badge-warn {
      background: rgba(217,119,6,.18);
      color: #ffc879;
      border-color: rgba(255,196,114,.45);
    }
    #xq-value-analyzer-panel .xq-badge-bad {
      background: rgba(120, 33, 33, .34);
      color: #ffe0e0;
      border-color: rgba(255, 140, 140, .58);
    }
    #xq-value-analyzer-panel .xq-analysis {
      white-space: pre-wrap;
      word-break: break-word;
      margin: 0;
      padding: 12px;
      background: linear-gradient(160deg, #0f2238, #143355);
      border-radius: 12px;
      border: 1px solid #2b4e73;
      line-height: 1.62;
      color: #e4f0ff;
    }
    #xq-value-analyzer-panel .xq-warn-box {
      margin: 8px 0;
      padding: 8px;
      border: 1px solid #b97912;
      border-radius: 8px;
      background: rgba(217,119,6,.16);
      color: #ffd28f;
    }
    #xq-chat-overlay {
      position: fixed;
      inset: 0;
      background: rgba(2, 10, 19, 0.52);
      z-index: 2147483647;
      display: none;
      align-items: center;
      justify-content: center;
      padding: 20px;
      box-sizing: border-box;
    }
    #xq-chat-overlay.xq-open {
      display: flex;
      animation: xq-overlay-in .15s ease-out;
    }
    @keyframes xq-overlay-in {
      from { opacity: 0; }
      to { opacity: 1; }
    }
    #xq-chat-panel {
      width: min(820px, 93vw);
      max-height: 80vh;
      background: linear-gradient(160deg, #071425, #10243c);
      border: 1px solid #2a4567;
      border-radius: 14px;
      box-shadow: 0 24px 46px rgba(1, 7, 16, .48);
      overflow: hidden;
      display: flex;
      flex-direction: column;
      position: fixed;
      left: 50%;
      top: 50%;
      transform: translate(-50%, -50%);
    }
    .xq-chat-head {
      padding: 12px;
      border-bottom: 1px solid #2a4567;
      display: flex;
      align-items: center;
      justify-content: space-between;
      color: #dcecff;
      font-weight: 700;
      cursor: move;
      user-select: none;
    }
    .xq-chat-title-wrap {
      display: flex;
      flex-direction: column;
      gap: 2px;
    }
    .xq-chat-title-main {
      font-size: 14px;
      letter-spacing: .2px;
    }
    .xq-chat-title-sub {
      color: #89a9c9;
      font-size: 11px;
      font-weight: 500;
    }
    #xq-chat-messages {
      padding: 10px;
      height: 340px;
      overflow-y: auto;
      background: radial-gradient(circle at 40% 15%, #122e4f, #0a1b30 62%);
    }
    .xq-chat-composer {
      padding: 10px;
      border-top: 1px solid #2a4567;
      display: flex;
      flex-direction: column;
      gap: 6px;
    }
    .xq-chat-input {
      resize: vertical;
      min-height: 56px;
      max-height: 120px;
      border: 1px solid #32567d;
      border-radius: 10px;
      background: rgba(5, 18, 31, .55);
      color: #e8f4ff;
      padding: 8px 10px;
      font-size: 13px;
      font-family: inherit;
    }
    .xq-chat-input::placeholder {
      color: #7f9ab8;
    }
    .xq-chat-actions {
      display: flex;
      justify-content: space-between;
      align-items: center;
      gap: 8px;
    }
    .xq-chat-hint {
      font-size: 11px;
      color: #88a0bc;
    }
    .xq-chat-bubble-row {
      display: flex;
      margin-bottom: 8px;
    }
    .xq-chat-bubble-row.user {
      justify-content: flex-end;
    }
    .xq-chat-bubble-row.assistant {
      justify-content: flex-start;
    }
    .xq-chat-bubble {
      max-width: 88%;
      white-space: pre-wrap;
      word-break: break-word;
      line-height: 1.5;
      font-size: 12px;
      padding: 8px 10px;
      border-radius: 10px;
    }
    .xq-chat-bubble.user {
      background: linear-gradient(135deg, #17b7f2, #1e7bf2);
      color: #ffffff;
      box-shadow: 0 8px 20px rgba(30, 123, 242, .32);
    }
    .xq-chat-bubble.assistant {
      background: rgba(14, 33, 55, .9);
      border: 1px solid #34567e;
      color: #deecff;
    }
    #xq-prefetch-status {
      position: fixed;
      top: 12px;
      right: 12px;
      z-index: 2147483646;
      background: linear-gradient(120deg, rgba(22,185,179,.95), rgba(30,123,242,.95));
      color: #f4fbff;
      padding: 7px 10px;
      border-radius: 10px;
      font-size: 12px;
      font-family: "Manrope", "SF Pro Display", "Segoe UI", sans-serif;
      border: 1px solid rgba(116, 212, 255, 0.35);
      box-shadow: 0 10px 22px rgba(0, 16, 36, .32);
      max-width: 520px;
      line-height: 1.3;
    }
    #xq-batch-progress {
      position: fixed;
      right: 14px;
      top: 78px;
      width: min(380px, calc(100vw - 28px));
      z-index: 2147483646;
      border-radius: 12px;
      border: 1px solid rgba(56, 189, 248, 0.42);
      background: linear-gradient(160deg, rgba(8,24,41,.96), rgba(12,36,62,.96));
      box-shadow: 0 14px 30px rgba(0, 16, 36, 0.34);
      backdrop-filter: blur(6px);
      font-family: "Manrope", "SF Pro Display", "Segoe UI", sans-serif;
      padding: 10px 12px;
      color: #e5effa;
      display: none;
    }
    #xq-batch-progress .xq-batch-title {
      font-size: 13px;
      font-weight: 700;
      margin-bottom: 7px;
      color: #d8ecff;
    }
    #xq-batch-progress .xq-batch-outer {
      height: 8px;
      border-radius: 999px;
      overflow: hidden;
      border: 1px solid #27496f;
      background: #0a1829;
    }
    #xq-batch-progress .xq-batch-inner {
      height: 100%;
      width: 0%;
      background: linear-gradient(90deg, #14b8a6, #3b82f6);
      transition: width .22s ease;
    }
    #xq-batch-progress.xq-indeterminate .xq-batch-inner {
      width: 38%;
      animation: xq-batch-indeterminate 1.2s ease-in-out infinite;
    }
    #xq-batch-progress .xq-batch-text {
      margin-top: 7px;
      font-size: 12px;
      color: #95b1ce;
      line-height: 1.4;
      word-break: break-word;
    }
    @keyframes xq-batch-indeterminate {
      0% { transform: translateX(-110%); }
      100% { transform: translateX(280%); }
    }
    #xq-value-analyzer-panel[data-theme="light"] {
      background: linear-gradient(160deg, rgba(245, 250, 255, .98), rgba(232, 242, 251, .98));
      border-color: #bfd2e6;
      color: #1d2a39;
      box-shadow: 0 14px 34px rgba(86, 112, 138, .26);
    }
    #xq-value-analyzer-panel[data-theme="light"] .xq-sticky-head {
      background: linear-gradient(180deg, rgba(234, 244, 253, .98), rgba(234, 244, 253, .82));
    }
    #xq-value-analyzer-panel[data-theme="light"] .xq-head-divider {
      background: #c7d9ec;
    }
    #xq-value-analyzer-panel[data-theme="light"] .xq-btn-icon {
      background: #edf4fb;
      border-color: #c6d9eb;
      color: #5f7a95;
    }
    #xq-value-analyzer-panel[data-theme="light"] .xq-btn-icon:hover { background: #dce8f2; }
    #xq-value-analyzer-panel[data-theme="light"] .xq-btn-icon.xq-close-icon:hover { background: #fde8e8; color: #a63a3a; }
    #xq-value-analyzer-panel[data-theme="light"] .xq-title strong {
      color: #1a2f45;
    }
    #xq-value-analyzer-panel[data-theme="light"] .xq-subtitle,
    #xq-value-analyzer-panel[data-theme="light"] .xq-status,
    #xq-value-analyzer-panel[data-theme="light"] .xq-muted,
    #xq-value-analyzer-panel[data-theme="light"] .xq-progress-text {
      color: #5e738a;
    }
    #xq-value-analyzer-panel[data-theme="light"] .xq-top-badge {
      background: #edf4fb;
      color: #2a4662;
      border-color: #c6d9eb;
    }
    #xq-value-analyzer-panel[data-theme="light"] .xq-top-badge.market {
      background: #eaf7ef;
      color: #148c5a;
      border-color: #b5e0c8;
    }
    #xq-value-analyzer-panel[data-theme="light"] .xq-badge-good {
      background: #d9f5e9;
      color: #0b7a4d;
      border-color: #8fd6b6;
    }
    #xq-value-analyzer-panel[data-theme="light"] .xq-badge-bad {
      background: #fde8e8;
      color: #a63a3a;
      border-color: #e8a5a5;
    }
    #xq-value-analyzer-panel[data-theme="light"] .xq-top-badge.market-neutral {
      background: #fff6e9;
      color: #9f6710;
      border-color: #efd2a1;
    }
    #xq-value-analyzer-panel[data-theme="light"] .xq-top-badge.market-risk {
      background: #fff0f0;
      color: #b34545;
      border-color: #e7c2c2;
    }
    #xq-value-analyzer-panel[data-theme="light"] .xq-top-badge.model-badge {
      background: #eef2ff;
      color: #5b21b6;
      border-color: #c4b5fd;
    }
    #xq-value-analyzer-panel[data-theme="light"] .xq-model-tag {
      background: #eef2ff;
      color: #5b21b6;
      border-color: #c4b5fd;
    }
    #xq-value-analyzer-panel[data-theme="light"] .xq-progress-outer {
      background: #eaf2f8;
      border-color: #c4d7ea;
    }
    #xq-value-analyzer-panel[data-theme="light"] .xq-card {
      background: linear-gradient(160deg, #ffffff, #f2f8fd);
      border-color: #c7d9eb;
    }
    #xq-value-analyzer-panel[data-theme="light"] .xq-hero {
      background: linear-gradient(95deg, #1e7bf2, #16b9b3);
      border-color: transparent;
    }
    #xq-value-analyzer-panel[data-theme="light"] .xq-subcard {
      background: linear-gradient(160deg, #ffffff, #f4f9fe);
      border-color: #c7d9eb;
    }
    #xq-value-analyzer-panel[data-theme="light"] .xq-subcard-title {
      color: #1f3348;
    }
    #xq-value-analyzer-panel[data-theme="light"] .xq-metric-key {
      color: #5f7a95;
    }
    #xq-value-analyzer-panel[data-theme="light"] .xq-metric-val {
      color: #243548;
    }
    #xq-value-analyzer-panel[data-theme="light"] .xq-title-row .xq-name,
    #xq-value-analyzer-panel[data-theme="light"] .xq-table td:last-child {
      color: #243548;
    }
    #xq-value-analyzer-panel[data-theme="light"] .xq-table td:first-child {
      color: #667f97;
    }
    #xq-value-analyzer-panel[data-theme="light"] .xq-analysis {
      background: linear-gradient(160deg, #ffffff, #f3f8fd);
      border-color: #c9dced;
      color: #203244;
    }
    #xq-value-analyzer-panel[data-theme="light"] .xq-warn-box {
      background: #fff7ea;
      color: #91580a;
      border-color: #efcc98;
    }
    #xq-chat-panel[data-theme="light"] {
      background: linear-gradient(160deg, #f8fcff, #eaf3fb);
      border-color: #bfd2e6;
      box-shadow: 0 20px 44px rgba(88, 114, 140, .24);
    }
    #xq-chat-panel[data-theme="light"] .xq-chat-head {
      color: #1f344a;
      border-bottom-color: #c8daec;
    }
    #xq-chat-panel[data-theme="light"] #xq-chat-messages {
      background: radial-gradient(circle at 40% 15%, #f4faff, #edf4fb 62%);
    }
    #xq-chat-panel[data-theme="light"] .xq-chat-composer {
      border-top-color: #c8daec;
    }
    #xq-chat-panel[data-theme="light"] .xq-chat-input {
      background: #ffffff;
      border-color: #bfd2e6;
      color: #1e3146;
    }
    #xq-chat-panel[data-theme="light"] .xq-chat-input::placeholder,
    #xq-chat-panel[data-theme="light"] .xq-chat-hint,
    #xq-chat-panel[data-theme="light"] .xq-chat-title-sub {
      color: #677f97;
    }
    #xq-chat-panel[data-theme="light"] .xq-chat-bubble.assistant {
      background: #ffffff;
      border-color: #c6d8ea;
      color: #213447;
    }
    #xq-chat-panel[data-theme="light"] .xq-btn {
      background: #f3f8fd;
      color: #1f3348;
      border-color: #b9cee3;
    }
    #xq-chat-panel[data-theme="light"] .xq-btn:hover {
      background: #e8f2fb;
      box-shadow: 0 8px 18px rgba(91, 119, 145, 0.2);
    }
    #xq-chat-panel[data-theme="light"] .xq-btn-primary {
      color: #ffffff;
      border-color: transparent;
      background: linear-gradient(135deg, #1e7bf2, #16b9b3);
    }
    #xq-value-analyzer-panel[data-theme="light"] .xq-btn {
      background: #f3f8fd;
      color: #1f3348;
      border-color: #b9cee3;
    }
    #xq-value-analyzer-panel[data-theme="light"] .xq-btn:hover {
      background: #e8f2fb;
      box-shadow: 0 8px 18px rgba(91, 119, 145, 0.2);
    }
    #xq-value-analyzer-panel[data-theme="light"] .xq-btn-primary {
      color: #ffffff;
      border-color: transparent;
      background: linear-gradient(135deg, #1e7bf2, #16b9b3);
    }
    #xq-value-analyzer-panel[data-theme="light"] .xq-btn-chat-active {
      color: #0f2f3f;
      border-color: transparent;
      background: linear-gradient(135deg, #16b9b3, #65d7d2);
    }
    /* ===== 投研看板 Tab 系统 ===== */
    #xq-value-analyzer-panel .xq-dashboard-tabs {
      display: flex; gap: 2px; margin: 4px 0 8px; padding: 2px;
      background: rgba(30,50,80,.35); border-radius: 10px;
      flex-shrink: 0; overflow-x: auto;
    }
    #xq-value-analyzer-panel .xq-dashboard-tab {
      flex: 1; min-width: 52px;
      padding: 5px 4px; border: none; border-radius: 8px;
      font-size: 10px; font-weight: 700; text-align: center; white-space: nowrap;
      color: var(--xq-subtle); background: transparent;
      cursor: pointer; transition: all .15s;
    }
    #xq-value-analyzer-panel .xq-dashboard-tab:hover { color: var(--xq-text); background: rgba(255,255,255,.06); }
    #xq-value-analyzer-panel .xq-dashboard-tab.active {
      color: #fff; background: linear-gradient(135deg, var(--xq-accent-2), var(--xq-accent));
      box-shadow: 0 2px 8px rgba(30,123,242,.3);
    }
    /* ===== 巴菲特评分卡 ===== */
    #xq-value-analyzer-panel .xq-scorecard {
      display: grid; grid-template-columns: 1fr 1fr 1fr; gap: 6px; margin-top: 8px;
    }
    #xq-value-analyzer-panel .xq-scorecard-item {
      padding: 8px 6px; border-radius: 10px; text-align: center;
      background: rgba(22,185,179,.08); border: 1px solid rgba(22,185,179,.15);
    }
    #xq-value-analyzer-panel .xq-scorecard-item .xq-sc-label {
      font-size: 9px; color: var(--xq-subtle); margin-bottom: 2px;
    }
    #xq-value-analyzer-panel .xq-scorecard-item .xq-sc-value {
      font-size: 18px; font-weight: 800; letter-spacing: -0.3px;
    }
    #xq-value-analyzer-panel .xq-scorecard-item .xq-sc-detail {
      font-size: 9px; color: var(--xq-subtle); margin-top: 1px;
    }
    #xq-value-analyzer-panel .xq-scorecard-item.xq-sc-good { background: rgba(15,157,110,.12); border-color: rgba(15,157,110,.25); }
    #xq-value-analyzer-panel .xq-scorecard-item.xq-sc-good .xq-sc-value { color: var(--xq-good); }
    #xq-value-analyzer-panel .xq-scorecard-item.xq-sc-warn { background: rgba(217,119,6,.1); border-color: rgba(217,119,6,.2); }
    #xq-value-analyzer-panel .xq-scorecard-item.xq-sc-warn .xq-sc-value { color: var(--xq-warn); }
    #xq-value-analyzer-panel .xq-scorecard-item.xq-sc-bad { background: rgba(220,38,38,.08); border-color: rgba(220,38,38,.15); }
    #xq-value-analyzer-panel .xq-scorecard-item.xq-sc-bad .xq-sc-value { color: var(--xq-bad); }
    /* ===== 行业内排行 ===== */
    #xq-value-analyzer-panel .xq-sector-rank {
      max-height: 200px; overflow-y: auto; margin-top: 6px;
    }
    #xq-value-analyzer-panel .xq-sector-rank-item {
      display: flex; align-items: center; gap: 6px;
      padding: 4px 6px; border-radius: 6px; font-size: 10px;
    }
    #xq-value-analyzer-panel .xq-sector-rank-item:nth-child(odd) { background: rgba(255,255,255,.03); }
    #xq-value-analyzer-panel .xq-sector-rank-item .xq-sr-pos {
      width: 18px; font-weight: 700; color: var(--xq-subtle); text-align: center; flex-shrink: 0;
    }
    #xq-value-analyzer-panel .xq-sector-rank-item .xq-sr-name { flex: 1; overflow: hidden; text-overflow: ellipsis; white-space: nowrap; }
    #xq-value-analyzer-panel .xq-sector-rank-item .xq-sr-score { font-family: ui-monospace,monospace; font-weight: 700; }
    /* ===== 综合评分环形显示 ===== */
    #xq-value-analyzer-panel .xq-ring-wrap {
      display: flex; align-items: center; justify-content: center; margin: 6px 0;
    }
    #xq-value-analyzer-panel .xq-ring-svg { width: 80px; height: 80px; }
    #xq-value-analyzer-panel .xq-progress-bar-wrap {
      height: 4px; border-radius: 2px; background: rgba(255,255,255,.08); margin: 4px 0; overflow: hidden;
    }
    #xq-value-analyzer-panel .xq-progress-bar-fill {
      height: 100%; border-radius: 2px; transition: width .6s ease;
    }
    #xq-value-analyzer-panel .xq-light-badge {
      display: inline-block; padding: 1px 6px; border-radius: 4px;
      font-size: 9px; font-weight: 700;
    }
    #xq-value-analyzer-panel[data-theme="light"] .xq-dashboard-tabs { background: rgba(180,200,220,.35); }
    #xq-value-analyzer-panel[data-theme="light"] .xq-dashboard-tab { color: #5f7a95; }
    #xq-value-analyzer-panel[data-theme="light"] .xq-dashboard-tab:hover { background: rgba(0,0,0,.04); color: #1e3246; }
    #xq-value-analyzer-panel[data-theme="light"] .xq-dashboard-tab.active {
      color: #fff; background: linear-gradient(135deg, #1e7bf2, #16b9b3);
    }
    #xq-value-analyzer-panel[data-theme="light"] .xq-scorecard-item { background: rgba(22,185,179,.06); border-color: rgba(22,185,179,.12); }
    #xq-value-analyzer-panel[data-theme="light"] .xq-scorecard-item.xq-sc-good { background: rgba(15,157,110,.08); }
    #xq-value-analyzer-panel[data-theme="light"] .xq-scorecard-item.xq-sc-warn { background: rgba(217,119,6,.06); }
    #xq-value-analyzer-panel[data-theme="light"] .xq-scorecard-item.xq-sc-bad { background: rgba(220,38,38,.05); }
    #xq-value-analyzer-panel[data-theme="light"] .xq-sector-rank-item:nth-child(odd) { background: rgba(0,0,0,.02); }
    #xq-value-analyzer-panel[data-theme="light"] .xq-progress-bar-wrap { background: rgba(0,0,0,.06); }
    /* ===== 看板样式 end ===== */
    #xq-prefetch-status[data-theme="light"] {
      background: linear-gradient(120deg, rgba(44,133,229,.92), rgba(34,177,160,.92));
      border-color: rgba(117, 171, 230, 0.5);
      color: #f8fcff;
    }
    #xq-batch-progress[data-theme="light"] {
      background: linear-gradient(160deg, rgba(246,250,255,.98), rgba(234,243,251,.98));
      border-color: #b8d0e8;
      color: #1d2a39;
      box-shadow: 0 14px 30px rgba(86, 112, 138, 0.22);
    }
    #xq-batch-progress[data-theme="light"] .xq-batch-title {
      color: #1f344a;
    }
    #xq-batch-progress[data-theme="light"] .xq-batch-outer {
      background: #eaf2f8;
      border-color: #c4d7ea;
    }
    #xq-batch-progress[data-theme="light"] .xq-batch-text {
      color: #5f7a95;
    }
    @media (max-width: 900px) {
      #xq-value-analyzer-panel {
        right: 10px;
        left: 10px;
        width: calc(100vw - 20px);
        top: 68px;
      }
      #xq-value-analyzer-panel .xq-grid {
        grid-template-columns: 1fr;
      }
    }
    #xq-prefetch-done-toast {
      position: fixed; top: 50px; right: 12px; z-index: 2147483647;
      background: linear-gradient(120deg, rgba(22,185,179,.95), rgba(30,123,242,.95));
      color: #f4fbff; padding: 10px 16px; border-radius: 10px;
      font-size: 13px; font-weight: 600; line-height: 1.4;
      font-family: "Manrope", "SF Pro Display", "Segoe UI", sans-serif;
      border: 1px solid rgba(116,212,255,.35);
      box-shadow: 0 10px 28px rgba(0,16,36,.4);
      opacity: 0; transform: translateX(40px);
      transition: opacity .4s ease, transform .4s ease;
      pointer-events: none;
    }
    #xq-prefetch-done-toast.xq-toast-show {
      opacity: 1; transform: translateX(0);
    }
    #xq-prefetch-done-toast.xq-toast-hide {
      opacity: 0; transform: translateX(40px);
      transition: opacity .6s ease, transform .6s ease;
    }
    #xq-prefetch-done-toast[data-theme="light"] {
      background: linear-gradient(120deg, rgba(44,133,229,.95), rgba(34,177,160,.95));
      border-color: rgba(117,171,230,.5); color: #f8fcff;
      box-shadow: 0 10px 28px rgba(86,112,138,.25);
    }
    #xq-comparison-overlay {
      position: fixed; top: 0; left: 0; right: 0; bottom: 0;
      z-index: 2147483645; background: rgba(0,0,0,0.4);
      display: none; align-items: center; justify-content: center;
    }
    #xq-comparison-overlay.open { display: flex; }
    #xq-comparison-panel {
      background: linear-gradient(160deg, rgba(6,17,31,.98), rgba(10,31,54,.98));
      border: 1px solid #1e3a5f;
      border-radius: 12px; width: 92vw; max-width: 1100px; max-height: 85vh;
      display: flex; flex-direction: column; box-shadow: 0 20px 60px rgba(0,0,0,0.5);
      overflow: hidden; color: #c8d8e8;
    }
    .xq-cmp-head {
      display: flex; justify-content: space-between; align-items: center;
      padding: 12px 16px; border-bottom: 1px solid #1e3a5f;
      background: linear-gradient(180deg, rgba(14,30,50,.9), rgba(10,24,42,.7));
      cursor: move; user-select: none;
    }
    .xq-cmp-title { font-size: 14px; font-weight: 700; color: #e0ecf6; }
    .xq-cmp-body { flex: 1; overflow-y: auto; padding: 12px 16px; }
    .xq-cmp-table-wrap { overflow-x: auto; margin-bottom: 12px; }
    .xq-cmp-table {
      border-collapse: collapse; font-size: 12px; width: 100%; min-width: 600px;
    }
    .xq-cmp-table th, .xq-cmp-table td {
      padding: 5px 8px; border: 1px solid rgba(93,125,160,.15);
      white-space: nowrap; text-align: right;
    }
    .xq-cmp-table th { background: rgba(18,37,61,.6); color: #88a0bc; text-align: center; font-weight: 600; }
    .xq-cmp-table td:first-child { text-align: left; color: #88a0bc; font-weight: 600; }
    .xq-cmp-table .xq-cmp-current { background: rgba(58,163,255,.08); }
    .xq-cmp-table .xq-cmp-best { color: #4ade80; font-weight: 700; }
    .xq-cmp-table .xq-cmp-worst { color: #f87171; }
    .xq-cmp-ai { margin-top: 8px; padding-top: 10px; border-top: 1px dashed rgba(93,125,160,.2); }
    .xq-cmp-ai-title { font-size: 13px; font-weight: 700; color: #3aa3ff; margin-bottom: 6px; }
    #xq-comparison-panel[data-theme="light"] {
      background: linear-gradient(160deg, rgba(245,250,255,.98), rgba(232,242,251,.98));
      border-color: #bfd2e6; color: #1d2a39;
      box-shadow: 0 14px 34px rgba(86,112,138,.26);
    }
    #xq-comparison-panel[data-theme="light"] .xq-cmp-head {
      background: linear-gradient(180deg, rgba(234,244,253,.98), rgba(234,244,253,.82));
      border-bottom-color: #c7d9ec;
    }
    #xq-comparison-panel[data-theme="light"] .xq-cmp-title { color: #1a2f45; }
    #xq-comparison-panel[data-theme="light"] .xq-cmp-table th {
      background: #edf4fb; color: #2a4662; border-color: #d0dfed;
    }
    #xq-comparison-panel[data-theme="light"] .xq-cmp-table td { border-color: #dce8f2; color: #243548; }
    #xq-comparison-panel[data-theme="light"] .xq-cmp-table td:first-child { color: #5f7a95; }
    #xq-comparison-panel[data-theme="light"] .xq-cmp-table .xq-cmp-current { background: rgba(30,123,242,.06); }
    #xq-comparison-panel[data-theme="light"] .xq-cmp-table .xq-cmp-best { color: #0b7a4d; }
    #xq-comparison-panel[data-theme="light"] .xq-cmp-table .xq-cmp-worst { color: #a63a3a; }
    #xq-comparison-panel[data-theme="light"] .xq-cmp-ai-title { color: #1e7bf2; }
    #xq-comparison-panel[data-theme="light"] .xq-analysis {
      background: linear-gradient(160deg, #ffffff, #f3f8fd);
      border-color: #c9dced; color: #203244;
    }
  `;
  document.head.appendChild(style);
}

function isExtensionContextValid() {
  return !!(chrome?.runtime?.id);
}

function isContextInvalidatedErrorMessage(message) {
  if (!message) return false;
  const text = String(message);
  return (
    text.includes("Extension context invalidated") ||
    text.includes("message port closed") ||
    text.includes("Receiving end does not exist")
  );
}

function extractSymbolFromUrl() {
  const path = window.location.pathname || "";

  const fullMatch = path.match(/\/S\/([A-Z]{2}\d{5,6})/i);
  if (fullMatch) {
    return fullMatch[1].toUpperCase();
  }

  const shortMatch = path.match(/\/S\/(\d{6})/);
  if (shortMatch) {
    const code = shortMatch[1];
    const market = code.startsWith("6") ? "SH" : "SZ";
    return `${market}${code}`;
  }

  return null;
}

function normalizeSymbol(raw) {
  const text = String(raw || "").toUpperCase().trim();
  const full = text.match(/^([A-Z]{2}\d{5,6})$/);
  if (full) return full[1];
  const short = text.match(/^(\d{6})$/);
  if (short) {
    const code = short[1];
    const market = code.startsWith("6") ? "SH" : "SZ";
    return `${market}${code}`;
  }
  return "";
}

function extractSymbolsFromDocument() {
  const symbols = new Set();
  const anchors = document.querySelectorAll('a[href*="/S/"]');
  anchors.forEach((anchor) => {
    const href = anchor.href || anchor.getAttribute("href") || "";
    if (!href) return;
    let parsedUrl;
    try {
      parsedUrl = new URL(href, window.location.origin);
    } catch {
      return;
    }
    if (!/^https?:$/i.test(parsedUrl.protocol)) return;
    if (!/xueqiu\.com$/i.test(parsedUrl.hostname)) return;
    const m = parsedUrl.pathname.match(/\/S\/([A-Z]{2}\d{5,6}|\d{6})/i);
    if (!m) return;
    const symbol = normalizeSymbol(m[1]);
    if (symbol) symbols.add(symbol);
  });
  return Array.from(symbols);
}

function ensurePrefetchStatus() {
  if (STATE.prefetchStatusEl && document.body.contains(STATE.prefetchStatusEl)) {
    return STATE.prefetchStatusEl;
  }
  if (!document.body) return null;
  ensureUiStyles();
  const el = document.createElement("div");
  el.id = "xq-prefetch-status";
  el.setAttribute("data-theme", normalizeTheme(STATE.uiTheme));
  el.textContent = "预分析待启动";
  document.body.appendChild(el);
  STATE.prefetchStatusEl = el;
  return el;
}

function setPrefetchStatus(text, color = "rgba(17, 85, 204, 0.92)", options = {}) {
  const now = Date.now();
  const isError = !!options.isError;
  if (!isError && now < STATE.prefetchErrorHoldUntil) {
    return;
  }
  if (isError) {
    STATE.prefetchErrorHoldUntil = now + 5000;
  }
  const el = ensurePrefetchStatus();
  if (!el) return;
  el.textContent = text;
  el.style.background = color;
}

let prefetchDoneToastTimer = null;

function showPrefetchDoneToast(total, generated, cached) {
  let toast = document.getElementById("xq-prefetch-done-toast");
  if (!toast) {
    toast = document.createElement("div");
    toast.id = "xq-prefetch-done-toast";
    toast.setAttribute("data-theme", normalizeTheme(STATE.uiTheme));
    document.body.appendChild(toast);
  }
  toast.className = "";
  toast.setAttribute("data-theme", normalizeTheme(STATE.uiTheme));
  toast.textContent = `当前页面预分析完毕 (共${total}只，新增${generated}，缓存${cached})`;
  void toast.offsetWidth;
  toast.className = "xq-toast-show";
  if (prefetchDoneToastTimer) clearTimeout(prefetchDoneToastTimer);
  prefetchDoneToastTimer = setTimeout(() => {
    toast.className = "xq-toast-hide";
  }, 3500);
}

function ensureBatchProgressPanel() {
  if (STATE.batchProgressPanelEl && document.body.contains(STATE.batchProgressPanelEl)) {
    return STATE.batchProgressPanelEl;
  }
  if (!document.body) return null;
  ensureUiStyles();
  const panel = document.createElement("div");
  panel.id = "xq-batch-progress";
  panel.setAttribute("data-theme", normalizeTheme(STATE.uiTheme));

  const title = document.createElement("div");
  title.className = "xq-batch-title";
  title.textContent = "全量预分析";

  const outer = document.createElement("div");
  outer.className = "xq-batch-outer";

  const inner = document.createElement("div");
  inner.className = "xq-batch-inner";
  outer.appendChild(inner);

  const text = document.createElement("div");
  text.className = "xq-batch-text";
  text.textContent = "准备中...";

  panel.append(title, outer, text);
  document.body.appendChild(panel);

  STATE.batchProgressPanelEl = panel;
  STATE.batchProgressBarEl = inner;
  STATE.batchProgressTextEl = text;
  return panel;
}

function setBatchProgress(message, percent = null) {
  const panel = ensureBatchProgressPanel();
  if (!panel || !STATE.batchProgressBarEl || !STATE.batchProgressTextEl) return;
  panel.style.display = "block";
  if (Number.isFinite(percent)) {
    panel.classList.remove("xq-indeterminate");
    const safePercent = Math.max(0, Math.min(100, Number(percent)));
    STATE.batchProgressBarEl.style.width = `${safePercent}%`;
    STATE.batchProgressBarEl.style.transform = "none";
  } else {
    panel.classList.add("xq-indeterminate");
    STATE.batchProgressBarEl.style.width = "38%";
    STATE.batchProgressBarEl.style.transform = "";
  }
  STATE.batchProgressTextEl.textContent = String(message || "");
}

function hideBatchProgress() {
  if (!STATE.batchProgressPanelEl) return;
  STATE.batchProgressPanelEl.style.display = "none";
  STATE.batchProgressPanelEl.classList.remove("xq-indeterminate");
  if (STATE.batchProgressBarEl) {
    STATE.batchProgressBarEl.style.width = "0%";
    STATE.batchProgressBarEl.style.transform = "none";
  }
  if (STATE.batchProgressTextEl) {
    STATE.batchProgressTextEl.textContent = "";
  }
}

function setPanelStatusIfExists(message, color = "#475569") {
  if (!STATE.statusEl || !STATE.panel || !document.body.contains(STATE.panel)) return;
  const text = String(message || "");
  STATE.statusEl.textContent = text;
  STATE.statusEl.style.color = color;
  STATE.statusEl.style.display = text ? "block" : "none";
}

function sleep(ms) {
  return new Promise((resolve) => setTimeout(resolve, ms));
}

function chunkArray(list, size) {
  const out = [];
  const arr = Array.isArray(list) ? list : [];
  const chunkSize = Math.max(1, Number(size) || 1);
  for (let i = 0; i < arr.length; i += chunkSize) {
    out.push(arr.slice(i, i + chunkSize));
  }
  return out;
}

function buildFullPrefetchUrl(autoStart = false) {
  const url = new URL(FULL_PREFETCH_TARGET_URL);
  if (autoStart) {
    url.searchParams.set(FULL_PREFETCH_AUTO_PARAM, "1");
  } else {
    url.searchParams.delete(FULL_PREFETCH_AUTO_PARAM);
  }
  return url.toString();
}

function isTargetFullPrefetchPage(rawUrl = window.location.href) {
  try {
    const url = rawUrl instanceof URL ? rawUrl : new URL(String(rawUrl), window.location.origin);
    if (!/xueqiu\.com$/i.test(url.hostname)) return false;
    if (url.pathname !== "/hq/detail") return false;
    return url.searchParams.get("market") === "CN" && url.searchParams.get("type") === "sh_sz";
  } catch {
    return false;
  }
}

function isAutoPrefetchRequestedByUrl() {
  try {
    const url = new URL(window.location.href);
    return url.searchParams.get(FULL_PREFETCH_AUTO_PARAM) === "1";
  } catch {
    return false;
  }
}

function clearAutoPrefetchFlagFromUrl() {
  try {
    const url = new URL(window.location.href);
    if (!url.searchParams.has(FULL_PREFETCH_AUTO_PARAM)) return;
    url.searchParams.delete(FULL_PREFETCH_AUTO_PARAM);
    const query = url.searchParams.toString();
    const next = `${url.pathname}${query ? `?${query}` : ""}${url.hash || ""}`;
    window.history.replaceState(null, "", next);
  } catch {
    // ignore clean-url errors
  }
}

function isElementVisible(el) {
  if (!el || !(el instanceof Element)) return false;
  const rect = el.getBoundingClientRect();
  return rect.width > 0 && rect.height > 0;
}

function toClickablePaginationElement(el) {
  if (!el) return null;
  if (el.tagName === "A" || el.tagName === "BUTTON") return el;
  return el.querySelector?.("a,button") || el;
}

function isPaginationControlDisabled(el) {
  if (!el) return true;
  const node = toClickablePaginationElement(el);
  if (!node) return true;
  if (node.disabled) return true;
  const ariaDisabled = String(node.getAttribute?.("aria-disabled") || "").toLowerCase();
  if (ariaDisabled === "true") return true;
  const cls = String(node.className || "").toLowerCase();
  if (/disabled|is-disabled|forbid|ban|stop/.test(cls)) return true;
  const parentCls = String(node.parentElement?.className || "").toLowerCase();
  if (/disabled|is-disabled/.test(parentCls)) return true;
  return false;
}

function findNextPageControl() {
  const selectors = [
    'a[rel="next"]',
    'a[aria-label*="下一页"]',
    'button[aria-label*="下一页"]',
    ".pagination__next",
    '[class*="pagination"] [class*="next"]',
    '[class*="pager"] [class*="next"]',
  ];
  for (const selector of selectors) {
    const nodes = Array.from(document.querySelectorAll(selector));
    for (const raw of nodes) {
      const node = toClickablePaginationElement(raw);
      if (!node || !isElementVisible(node) || isPaginationControlDisabled(node)) continue;
      return node;
    }
  }

  const roots = Array.from(document.querySelectorAll('[class*="pagination"], .pagination, [class*="pager"], .pager'));
  for (const root of roots) {
    const candidates = Array.from(root.querySelectorAll("a,button,li,span"));
    for (const raw of candidates) {
      const text = String(raw.textContent || "").replace(/\s+/g, "");
      if (!/(下一页|下页|›|»)/.test(text)) continue;
      const node = toClickablePaginationElement(raw);
      if (!node || !isElementVisible(node) || isPaginationControlDisabled(node)) continue;
      return node;
    }
  }
  return null;
}

function getCurrentPageToken() {
  const selectors = [
    '[class*="pagination"] [aria-current="page"]',
    '[class*="pagination"] .active',
    '[class*="pagination"] .current',
    '[class*="pager"] [aria-current="page"]',
    '[class*="pager"] .active',
    '[class*="pager"] .current',
  ];
  for (const selector of selectors) {
    const node = document.querySelector(selector);
    if (!node) continue;
    const text = String(node.textContent || "").trim();
    if (text) return text;
  }
  return "";
}

function buildPageSignature(symbols = []) {
  const list = Array.isArray(symbols) ? symbols : [];
  const token = getCurrentPageToken();
  const head = list.slice(0, 5).join("|");
  const tail = list.slice(-3).join("|");
  return `${token}::${list.length}::${head}::${tail}`;
}

function clickPaginationControl(node) {
  const el = toClickablePaginationElement(node);
  if (!el) return false;
  try {
    el.click();
    return true;
  } catch {
    try {
      el.dispatchEvent(new MouseEvent("click", { bubbles: true, cancelable: true, view: window }));
      return true;
    } catch {
      return false;
    }
  }
}

async function waitForPageTurn(prevSignature, timeoutMs = 12000) {
  const start = Date.now();
  while (Date.now() - start < timeoutMs) {
    await sleep(320);
    const symbols = extractSymbolsFromDocument();
    if (!symbols.length) continue;
    const nextSig = buildPageSignature(symbols);
    if (nextSig !== prevSignature) return true;
  }
  return false;
}

async function runManualFullPrefetch() {
  if (STATE.batchRunning) {
    setPanelStatusIfExists("全量预分析执行中，请勿重复启动。", "#8a4b00");
    return;
  }

  if (!isTargetFullPrefetchPage()) {
    const target = buildFullPrefetchUrl(true);
    const opened = window.open(target, "_blank", "noopener,noreferrer");
    if (!opened) {
      window.location.href = target;
    }
    setPanelStatusIfExists("已打开全市场页面，新标签页将自动开始全量预分析。", "#166534");
    return;
  }

  STATE.batchRunning = true;
  setBatchProgress("正在初始化页面数据...", null);
  setPanelStatusIfExists("全量预分析启动中...", "#1155cc");

  const seenSymbols = new Set();
  const stats = {
    pages: 0,
    generated: 0,
    cachedHits: 0,
    failed: 0,
    processed: 0,
  };
  const aggregatedErrors = {};

  try {
    for (let page = 1; page <= FULL_PREFETCH_MAX_PAGES; page += 1) {
      stats.pages = page;
      await sleep(page === 1 ? 480 : 680);
      const currentSymbols = Array.from(new Set(extractSymbolsFromDocument()));
      const pageNewSymbols = [];
      currentSymbols.forEach((symbol) => {
        if (seenSymbols.has(symbol)) return;
        seenSymbols.add(symbol);
        pageNewSymbols.push(symbol);
      });

      setBatchProgress(
        `第${page}页：识别${currentSymbols.length}只，新增${pageNewSymbols.length}只，累计${seenSymbols.size}只`,
        null
      );

      if (pageNewSymbols.length) {
        const chunks = chunkArray(pageNewSymbols, PREFETCH_CHUNK_SIZE);
        for (let i = 0; i < chunks.length; i += 1) {
          const chunk = chunks[i];
          setBatchProgress(
            `第${page}页：执行第${i + 1}/${chunks.length}批，累计${seenSymbols.size}只`,
            null
          );
          const response = await requestPrefetchSymbols(chunk);
          if (!response?.ok) {
            throw new Error(response?.error || `第${page}页第${i + 1}批预分析失败`);
          }
          const d = response.data || {};
          stats.generated += Number(d.generated || 0);
          stats.cachedHits += Number(d.cachedHits || 0);
          stats.failed += Number(d.failed || 0);
          stats.processed += Number(d.processed || chunk.length);
          if (d.errors && typeof d.errors === "object") {
            Object.assign(aggregatedErrors, d.errors);
          }
        }
      }

      const nextControl = findNextPageControl();
      if (!nextControl) break;
      const prevSignature = buildPageSignature(currentSymbols);
      const clicked = clickPaginationControl(nextControl);
      if (!clicked) break;
      const turned = await waitForPageTurn(prevSignature, 12000);
      if (!turned) break;
    }

    const reasonSummary = summarizePrefetchErrors(aggregatedErrors);
    const doneMessage =
      `全量预分析完成：累计${seenSymbols.size}只，新增${stats.generated}，缓存${stats.cachedHits}，失败${stats.failed}` +
      (reasonSummary ? `（${reasonSummary}）` : "");
    setBatchProgress(doneMessage, 100);
    showPrefetchDoneToast(seenSymbols.size, stats.generated, stats.cachedHits);
    setPanelStatusIfExists(doneMessage, stats.failed > 0 ? "#b45309" : "#166534");
    if (stats.failed > 0) {
      await appendPrefetchErrorLog(`全量预分析失败${stats.failed}条: ${reasonSummary || "未知原因"}`);
    }
    await sleep(900);
    hideBatchProgress();
  } catch (error) {
    const message = error?.message || String(error);
    setBatchProgress(`全量预分析中断：${message}`, null);
    setPanelStatusIfExists(`全量预分析失败：${message}`, "#b91c1c");
    await appendPrefetchErrorLog(`全量预分析失败: ${message}`);
    await sleep(2500);
    hideBatchProgress();
  } finally {
    STATE.batchRunning = false;
  }
}

function readLocalStorage(key) {
  return new Promise((resolve) => {
    chrome.storage.local.get([key], (items) => resolve(items?.[key]));
  });
}

function writeLocalStorage(payload) {
  return new Promise((resolve) => {
    chrome.storage.local.set(payload, () => resolve());
  });
}

function clampPanelWidth(width) {
  const maxByViewport = Math.max(PANEL_MIN_WIDTH, window.innerWidth - 36);
  return Math.min(Math.min(PANEL_MAX_WIDTH, maxByViewport), Math.max(PANEL_MIN_WIDTH, Number(width) || 428));
}

function normalizeTheme(theme) {
  return theme === "light" ? "light" : "night";
}

async function loadUiPrefs() {
  try {
    const raw = await readLocalStorage(UI_PREFS_KEY);
    if (!raw || typeof raw !== "object") return;
    if (raw.panelWidth !== undefined) {
      STATE.panelWidth = clampPanelWidth(raw.panelWidth);
    }
    if (raw.uiTheme !== undefined) {
      STATE.uiTheme = normalizeTheme(raw.uiTheme);
    }
    if (
      raw.chatPanelPos &&
      Number.isFinite(raw.chatPanelPos.left) &&
      Number.isFinite(raw.chatPanelPos.top)
    ) {
      STATE.chatPanelPos = {
        left: Number(raw.chatPanelPos.left),
        top: Number(raw.chatPanelPos.top),
      };
    }
  } catch {
    // ignore ui prefs load errors
  }
}

function scheduleSaveUiPrefs() {
  if (uiPrefsSaveTimer) clearTimeout(uiPrefsSaveTimer);
  uiPrefsSaveTimer = setTimeout(() => {
    uiPrefsSaveTimer = null;
    writeLocalStorage({
      [UI_PREFS_KEY]: {
        panelWidth: clampPanelWidth(STATE.panelWidth),
        chatPanelPos: STATE.chatPanelPos,
        uiTheme: normalizeTheme(STATE.uiTheme),
        updatedAt: Date.now(),
      },
    }).catch(() => {});
  }, 120);
}

function getThemeToggleLabel(theme) {
  return normalizeTheme(theme) === "night" ? "日间" : "夜间";
}

function applyThemeToElements(theme) {
  const normalized = normalizeTheme(theme);
  const panel = document.getElementById("xq-value-analyzer-panel");
  if (panel) {
    panel.setAttribute("data-theme", normalized);
  }
  const chatPanel = document.getElementById("xq-chat-panel");
  if (chatPanel) {
    chatPanel.setAttribute("data-theme", normalized);
  }
  const prefetch = document.getElementById("xq-prefetch-status");
  if (prefetch) {
    prefetch.setAttribute("data-theme", normalized);
  }
  const batchProgress = document.getElementById("xq-batch-progress");
  if (batchProgress) {
    batchProgress.setAttribute("data-theme", normalized);
  }
  const themeBtn = document.getElementById("xq-theme-toggle-btn");
  if (themeBtn) {
    themeBtn.textContent = getThemeToggleLabel(normalized);
    themeBtn.title = normalized === "night" ? "切换到白天主题" : "切换到夜间主题";
  }
}

function switchTheme(theme) {
  STATE.uiTheme = normalizeTheme(theme);
  applyThemeToElements(STATE.uiTheme);
  scheduleSaveUiPrefs();
}

async function appendPrefetchErrorLog(message) {
  try {
    const raw = await readLocalStorage(PREFETCH_ERROR_LOG_KEY);
    const list = Array.isArray(raw) ? raw : [];
    const entry = {
      ts: Date.now(),
      page: window.location.href,
      message: String(message || "unknown_error").slice(0, 400),
    };
    const next = [entry, ...list].slice(0, 20);
    await writeLocalStorage({ [PREFETCH_ERROR_LOG_KEY]: next });
  } catch {
    // ignore logging errors
  }
}

function summarizePrefetchErrors(errors) {
  if (!errors || typeof errors !== "object") return "";
  const buckets = new Map();
  Object.values(errors).forEach((raw) => {
    const msg = String(raw || "unknown_error")
      .replace(/\s+/g, " ")
      .slice(0, 80);
    buckets.set(msg, (buckets.get(msg) || 0) + 1);
  });
  const top = Array.from(buckets.entries())
    .sort((a, b) => b[1] - a[1])
    .slice(0, 2)
    .map(([msg, count]) => `${count}x ${msg}`);
  return top.join(" | ");
}

function fmt(value, suffix = "") {
  if (value === null || value === undefined || value === "") return "N/A";
  if (typeof value === "number") {
    return `${value.toLocaleString("zh-CN", { maximumFractionDigits: 2 })}${suffix}`;
  }
  return `${value}${suffix}`;
}

function formatPeriodSeries(series, suffix = "") {
  return DISPLAY_PERIOD_ORDER.map((key) => {
    const value = series?.[key];
    return value === null || value === undefined ? "NULL" : `${fmt(value)}${suffix}`;
  }).join(" | ");
}

function escapeHtml(text) {
  const div = document.createElement("div");
  div.textContent = text;
  return div.innerHTML;
}

function downloadText(filename, content, mime = "text/plain;charset=utf-8") {
  const blob = new Blob([content], { type: mime });
  const url = URL.createObjectURL(blob);
  const a = document.createElement("a");
  a.href = url;
  a.download = filename;
  a.style.display = "none";
  document.body.appendChild(a);
  a.click();
  a.remove();
  setTimeout(() => URL.revokeObjectURL(url), 1000);
}

function ensurePanel() {
  if (STATE.panel && document.body.contains(STATE.panel)) {
    return;
  }
  ensureUiStyles();

  const panel = document.createElement("section");
  panel.id = "xq-value-analyzer-panel";
  panel.setAttribute("data-theme", normalizeTheme(STATE.uiTheme));
  panel.style.width = `${clampPanelWidth(STATE.panelWidth)}px`;

  // ── sticky head: title row + divider + actions ──
  const stickyHead = document.createElement("div");
  stickyHead.className = "xq-sticky-head";

  const header = document.createElement("div");
  header.className = "xq-head";

  const titleBlock = document.createElement("div");
  titleBlock.className = "xq-title";

  const title = document.createElement("strong");
  title.textContent = "雪球AI投资伴侣";

  const subtitle = document.createElement("span");
  subtitle.textContent = "";
  subtitle.className = "xq-subtitle";

  titleBlock.append(title, subtitle);

  const headBadges = document.createElement("div");
  headBadges.className = "xq-head-badges";

  const marketBadge = document.createElement("div");
  marketBadge.className = "xq-top-badge market";
  marketBadge.textContent = "市场中性";

  const scoreBadge = document.createElement("div");
  scoreBadge.className = "xq-top-badge";
  scoreBadge.textContent = "0 / 0";

  const modelBadge = document.createElement("div");
  modelBadge.className = "xq-model-tag";
  modelBadge.textContent = "AI: --";
  modelBadge.title = "当前使用的AI模型";

  headBadges.append(marketBadge, scoreBadge);

  const windowBtns = document.createElement("div");
  windowBtns.className = "xq-window-btns";

  const collapseBtn = document.createElement("button");
  collapseBtn.className = "xq-btn-icon";
  collapseBtn.textContent = "_";
  collapseBtn.title = "最小化";

  const fullscreenBtn = document.createElement("button");
  fullscreenBtn.className = "xq-btn-icon";
  fullscreenBtn.textContent = "□";
  fullscreenBtn.title = "全屏";

  const closeBtn = document.createElement("button");
  closeBtn.className = "xq-btn-icon xq-close-icon";
  closeBtn.textContent = "\u00d7";
  closeBtn.title = "关闭";

  windowBtns.append(collapseBtn, fullscreenBtn, closeBtn);
  header.append(titleBlock, headBadges, windowBtns);

  const headDivider = document.createElement("div");
  headDivider.className = "xq-head-divider";

  const actions = document.createElement("div");
  actions.className = "xq-actions";

  const reAnalyzeBtn = document.createElement("button");
  reAnalyzeBtn.className = "xq-btn xq-btn-primary";
  reAnalyzeBtn.textContent = "重跑";

  const compareBtn = document.createElement("button");
  compareBtn.className = "xq-btn";
  compareBtn.textContent = "对比";

  const exportTxtBtn = document.createElement("button");
  exportTxtBtn.className = "xq-btn";
  exportTxtBtn.textContent = "导出TXT";

  const themeBtn = document.createElement("button");
  themeBtn.className = "xq-btn";
  themeBtn.id = "xq-theme-toggle-btn";
  themeBtn.textContent = getThemeToggleLabel(STATE.uiTheme);
  themeBtn.title = normalizeTheme(STATE.uiTheme) === "night" ? "切换到白天主题" : "切换到夜间主题";

  const chatToggleBtn = document.createElement("button");
  chatToggleBtn.className = "xq-btn";
  chatToggleBtn.textContent = "对话";

  const fullPrefetchBtn = document.createElement("button");
  fullPrefetchBtn.className = "xq-btn";
  fullPrefetchBtn.textContent = "预分";
  fullPrefetchBtn.title = "打开全市场列表并自动翻页预分析全部股票";

  actions.append(reAnalyzeBtn, compareBtn, exportTxtBtn, themeBtn, chatToggleBtn, modelBadge, fullPrefetchBtn);
  stickyHead.append(header, headDivider, actions);

  const chatOverlay = document.createElement("div");
  chatOverlay.id = "xq-chat-overlay";

  const chatPanel = document.createElement("div");
  chatPanel.id = "xq-chat-panel";
  chatPanel.setAttribute("data-theme", normalizeTheme(STATE.uiTheme));

  const chatHead = document.createElement("div");
  chatHead.className = "xq-chat-head";

  const chatTitle = document.createElement("div");
  chatTitle.className = "xq-chat-title-wrap";
  chatTitle.innerHTML = `<div class="xq-chat-title-main">股票AI对话</div><div class="xq-chat-title-sub">可拖动窗口位置，不再固定居中</div>`;

  const chatCloseBtn = document.createElement("button");
  chatCloseBtn.textContent = "关闭";
  chatCloseBtn.className = "xq-btn";

  chatHead.append(chatTitle, chatCloseBtn);

  const chatMessages = document.createElement("div");
  chatMessages.id = "xq-chat-messages";

  const chatComposer = document.createElement("div");
  chatComposer.className = "xq-chat-composer";

  const chatInput = document.createElement("textarea");
  chatInput.className = "xq-chat-input";
  chatInput.rows = 3;
  chatInput.placeholder = "输入你的问题，例如：现在适合分批建仓吗？";

  const chatActions = document.createElement("div");
  chatActions.className = "xq-chat-actions";

  const chatHint = document.createElement("div");
  chatHint.textContent = "自动带入当前浮窗分析上下文";
  chatHint.className = "xq-chat-hint";

  const chatButtons = document.createElement("div");
  chatButtons.className = "xq-actions";

  const chatClearBtn = document.createElement("button");
  chatClearBtn.className = "xq-btn";
  chatClearBtn.textContent = "清空";

  const chatSendBtn = document.createElement("button");
  chatSendBtn.className = "xq-btn xq-btn-primary";
  chatSendBtn.textContent = "发送";

  chatButtons.append(chatClearBtn, chatSendBtn);
  chatActions.append(chatHint, chatButtons);
  chatComposer.append(chatInput, chatActions);
  chatPanel.append(chatHead, chatMessages, chatComposer);
  chatOverlay.appendChild(chatPanel);

  function applyChatPanelPosition() {
    if (!STATE.chatPanelPos) {
      chatPanel.style.left = "50%";
      chatPanel.style.top = "50%";
      chatPanel.style.transform = "translate(-50%, -50%)";
      return;
    }
    chatPanel.style.left = `${STATE.chatPanelPos.left}px`;
    chatPanel.style.top = `${STATE.chatPanelPos.top}px`;
    chatPanel.style.transform = "none";
  }

  function keepChatPanelInViewport(left, top) {
    const rect = chatPanel.getBoundingClientRect();
    const minLeft = Math.max(8, rect.width / 2);
    const maxLeft = Math.max(minLeft, window.innerWidth - rect.width / 2 - 8);
    const minTop = 12;
    const maxTop = Math.max(minTop, window.innerHeight - 80);
    return {
      left: Math.min(maxLeft, Math.max(minLeft, left)),
      top: Math.min(maxTop, Math.max(minTop, top)),
    };
  }

  let dragging = false;
  let dragOffsetX = 0;
  let dragOffsetY = 0;

  function onDragMove(event) {
    if (!dragging) return;
    const pointX = event.clientX;
    const pointY = event.clientY;
    const next = keepChatPanelInViewport(pointX - dragOffsetX, pointY - dragOffsetY);
    STATE.chatPanelPos = next;
    chatPanel.style.left = `${next.left}px`;
    chatPanel.style.top = `${next.top}px`;
    chatPanel.style.transform = "none";
  }

  function onDragEnd() {
    if (!dragging) return;
    dragging = false;
    document.removeEventListener("mousemove", onDragMove);
    document.removeEventListener("mouseup", onDragEnd);
    scheduleSaveUiPrefs();
  }

  chatHead.addEventListener("mousedown", (event) => {
    if (event.button !== 0) return;
    applyChatPanelPosition();
    const rect = chatPanel.getBoundingClientRect();
    dragging = true;
    dragOffsetX = event.clientX - rect.left;
    dragOffsetY = event.clientY - rect.top;
    document.addEventListener("mousemove", onDragMove);
    document.addEventListener("mouseup", onDragEnd);
    event.preventDefault();
  });

  window.addEventListener("resize", () => {
    if (STATE.chatPanelPos) {
      const next = keepChatPanelInViewport(STATE.chatPanelPos.left, STATE.chatPanelPos.top);
      STATE.chatPanelPos = next;
      if (STATE.chatOpen) {
        chatPanel.style.left = `${next.left}px`;
        chatPanel.style.top = `${next.top}px`;
        chatPanel.style.transform = "none";
      }
    }
    panel.style.width = `${clampPanelWidth(STATE.panelWidth)}px`;
    scheduleSaveUiPrefs();
  });


  const body = document.createElement("div");
  body.className = "xq-body";

  const status = document.createElement("div");
  status.className = "xq-status";

  const progressWrap = document.createElement("div");
  progressWrap.className = "xq-progress-wrap";

  const progressOuter = document.createElement("div");
  progressOuter.className = "xq-progress-outer";

  const progressInner = document.createElement("div");
  progressInner.className = "xq-progress-inner";

  const progressText = document.createElement("div");
  progressText.className = "xq-progress-text";

  progressOuter.appendChild(progressInner);
  progressWrap.append(progressOuter, progressText);

  const content = document.createElement("div");
  content.innerHTML = `<div class="xq-card"><p style="margin:0; color:#c6dbf2;">正在加载雪球数据并计算估值指标...</p></div>`;

  body.append(status, progressWrap, content);
  panel.append(stickyHead, body);
  document.body.appendChild(panel);
  document.body.appendChild(chatOverlay);

  STATE.panel = panel;
  STATE.statusEl = status;
  STATE.contentEl = content;
  STATE.progressEl = progressInner;
  STATE.progressTextEl = progressText;
  STATE.headerSubEl = subtitle;
  STATE.marketBadgeEl = marketBadge;
  STATE.scoreBadgeEl = scoreBadge;
  STATE.modelBadgeEl = modelBadge;
  STATE.chatPanelEl = chatOverlay;
  STATE.chatMessagesEl = chatMessages;
  STATE.chatInputEl = chatInput;
  STATE.chatSendBtnEl = chatSendBtn;
  STATE.chatToggleBtnEl = chatToggleBtn;
  STATE.chatOpen = false;

  reAnalyzeBtn.addEventListener("click", () =>
    startAnalysis({ forceRefresh: false, trigger: "button", skipLlm: true, materialSearch: false })
  );
  compareBtn.addEventListener("click", () =>
    openIndustryComparison()
  );
  exportTxtBtn.addEventListener("click", () => exportAnalysis());
  themeBtn.addEventListener("click", () => {
    const next = normalizeTheme(STATE.uiTheme) === "night" ? "light" : "night";
    switchTheme(next);
  });
  chatToggleBtn.addEventListener("click", () => toggleChatPanel());
  fullPrefetchBtn.addEventListener("click", () => {
    runManualFullPrefetch();
  });
  chatCloseBtn.addEventListener("click", () => closeChatPanel());
  chatOverlay.addEventListener("click", (event) => {
    if (event.target === chatOverlay) {
      closeChatPanel();
    }
  });
  chatSendBtn.addEventListener("click", () => sendChatMessage());
  chatClearBtn.addEventListener("click", () => clearChatMessages());
  chatInput.addEventListener("keydown", (event) => {
    if (event.key === "Enter" && !event.shiftKey) {
      event.preventDefault();
      sendChatMessage();
    }
  });
  collapseBtn.addEventListener("click", () => {
    const isCollapsed = panel.classList.toggle("xq-collapsed");
    collapseBtn.textContent = isCollapsed ? "□" : "_";
    collapseBtn.title = isCollapsed ? "恢复" : "最小化";
  });
  fullscreenBtn.addEventListener("click", () => {
    panel.classList.toggle("xq-fullscreen");
  });
  closeBtn.addEventListener("click", () => {
    STATE.clickTriggerEnabled = false;
    panel.remove();
    chatOverlay.remove();
    STATE.panel = null;
    STATE.chatPanelEl = null;
    STATE.chatMessagesEl = null;
    STATE.chatInputEl = null;
    STATE.chatSendBtnEl = null;
    STATE.chatToggleBtnEl = null;
    STATE.chatOpen = false;
    STATE.chatSending = false;
    STATE.chatHistory = [];
  });

  appendChatMessage(
    "assistant",
    "可直接提问当前股票。建议先点击“重跑/强刷”生成最新分析后再问。"
  );
}

function setStatus(message, color = "#475569") {
  ensurePanel();
  const text = String(message || "");
  STATE.statusEl.textContent = text;
  STATE.statusEl.style.color = color;
  STATE.statusEl.style.display = text ? "block" : "none";
}

function setProgress(percent, message) {
  ensurePanel();
  const wrap = STATE.progressEl.parentElement.parentElement;
  wrap.style.display = "block";
  STATE.progressEl.style.width = `${percent}%`;
  STATE.progressTextEl.textContent = message;
}

function hideProgress() {
  if (!STATE.progressEl) return;
  const wrap = STATE.progressEl.parentElement.parentElement;
  wrap.style.display = "none";
  STATE.progressEl.style.width = "0%";
  STATE.progressTextEl.textContent = "";
}

function updateModelBadge(provider) {
  if (!STATE.modelBadgeEl) return;
  if (!provider || (!provider.name && !provider.model)) {
    STATE.modelBadgeEl.textContent = "--";
    return;
  }
  const name = (provider.name || "").toLowerCase();
  const label = name.includes("gemini") ? "gemini"
    : name.includes("newapi") ? "newapi"
    : name.includes("deepseek") ? "deepseek"
    : provider.model || provider.name;
  STATE.modelBadgeEl.textContent = label;
}

function appendChatMessage(role, text) {
  if (!STATE.chatMessagesEl) return;
  const row = document.createElement("div");
  row.className = `xq-chat-bubble-row ${role === "user" ? "user" : "assistant"}`;

  const bubble = document.createElement("div");
  bubble.className = `xq-chat-bubble ${role === "user" ? "user" : "assistant"}`;

  bubble.textContent = text;
  row.appendChild(bubble);
  STATE.chatMessagesEl.appendChild(row);
  STATE.chatMessagesEl.scrollTop = STATE.chatMessagesEl.scrollHeight;
}

function setChatSending(sending) {
  STATE.chatSending = sending;
  if (STATE.chatSendBtnEl) {
    STATE.chatSendBtnEl.disabled = sending;
    STATE.chatSendBtnEl.style.opacity = sending ? "0.7" : "1";
    STATE.chatSendBtnEl.textContent = sending ? "发送中..." : "发送";
  }
  if (STATE.chatInputEl) {
    STATE.chatInputEl.disabled = sending;
  }
}

function clearChatMessages() {
  STATE.chatHistory = [];
  if (!STATE.chatMessagesEl) return;
  STATE.chatMessagesEl.innerHTML = "";
  appendChatMessage("assistant", "对话已清空。可继续提问。");
}

function openChatPanel() {
  ensurePanel();
  if (!STATE.chatPanelEl || !STATE.chatToggleBtnEl) return;
  STATE.chatOpen = true;
  STATE.chatPanelEl.classList.add("xq-open");
  STATE.chatToggleBtnEl.classList.add("xq-btn-chat-active");
  const panel = document.getElementById("xq-chat-panel");
  if (panel) {
    if (STATE.chatPanelPos) {
      panel.style.left = `${STATE.chatPanelPos.left}px`;
      panel.style.top = `${STATE.chatPanelPos.top}px`;
      panel.style.transform = "none";
    } else {
      panel.style.left = "50%";
      panel.style.top = "50%";
      panel.style.transform = "translate(-50%, -50%)";
    }
  }
  if (STATE.chatInputEl) {
    STATE.chatInputEl.focus();
  }
}

function closeChatPanel() {
  if (!STATE.chatPanelEl || !STATE.chatToggleBtnEl) return;
  STATE.chatOpen = false;
  STATE.chatPanelEl.classList.remove("xq-open");
  STATE.chatToggleBtnEl.classList.remove("xq-btn-chat-active");
}

function toggleChatPanel() {
  if (STATE.chatOpen) {
    closeChatPanel();
  } else {
    openChatPanel();
  }
}

async function requestChatReply(userMessage) {
  return new Promise((resolve) => {
    if (!isExtensionContextValid()) {
      resolve({ ok: false, error: EXT_INVALIDATED_MSG });
      return;
    }

    const context = STATE.lastResult
      ? {
          symbol: STATE.lastResult.symbol,
          name: STATE.lastResult.name,
          snapshot: STATE.lastResult.snapshot,
          analysis: STATE.lastResult.analysis,
          researchMaterials: STATE.lastResult.researchMaterials,
        }
      : {
          symbol: extractSymbolFromUrl(),
        };

    try {
      chrome.runtime.sendMessage(
        {
          type: "chatWithStockAssistant",
          userMessage,
          history: STATE.chatHistory.slice(-8),
          context,
        },
        (response) => {
          const err = chrome.runtime.lastError;
          if (err) {
            resolve({ ok: false, error: isContextInvalidatedErrorMessage(err.message) ? EXT_INVALIDATED_MSG : err.message });
            return;
          }
          resolve(response);
        }
      );
    } catch (error) {
      resolve({
        ok: false,
        error: isContextInvalidatedErrorMessage(error?.message) ? EXT_INVALIDATED_MSG : (error?.message || String(error)),
      });
    }
  });
}

async function requestValuationSummaryLLM(result) {
  const summaryEl = document.getElementById("xq-valuation-summary");
  if (!summaryEl) return;

  try {
    if (!isExtensionContextValid()) {
      summaryEl.textContent = result.valuationSummary || "估值汇总不可用";
      return;
    }

    const response = await new Promise((resolve) => {
      chrome.runtime.sendMessage(
        {
          type: "getValuationSummaryLLM",
          snapshot: result.snapshot,
          valuationTables: result.valuationTables,
          ruleSummary: result.valuationSummary,
        },
        (resp) => {
          const err = chrome.runtime.lastError;
          if (err) {
            resolve({ ok: false, error: err.message });
            return;
          }
          resolve(resp);
        }
      );
    });

    if (response?.ok && response.data?.summary) {
      summaryEl.textContent = response.data.summary;
      updateModelBadge(response.data.usedProvider);
    } else {
      summaryEl.textContent = result.valuationSummary || "估值汇总不可用";
    }
  } catch (error) {
    summaryEl.textContent = result.valuationSummary || "估值汇总不可用";
  }
}

let comparisonPanelCreated = false;

function ensureComparisonPanel() {
  if (comparisonPanelCreated) {
    document.getElementById("xq-comparison-overlay")?.classList.add("open");
    return;
  }
  comparisonPanelCreated = true;

  const overlay = document.createElement("div");
  overlay.id = "xq-comparison-overlay";

  const panel = document.createElement("div");
  panel.id = "xq-comparison-panel";
  panel.setAttribute("data-theme", normalizeTheme(STATE.uiTheme));

  const head = document.createElement("div");
  head.className = "xq-cmp-head";

  const title = document.createElement("div");
  title.className = "xq-cmp-title";
  title.textContent = "行业对比分析";

  const closeBtn = document.createElement("button");
  closeBtn.className = "xq-btn";
  closeBtn.textContent = "关闭";

  head.append(title, closeBtn);
  panel.appendChild(head);

  const body = document.createElement("div");
  body.className = "xq-cmp-body";
  panel.appendChild(body);

  overlay.appendChild(panel);
  document.body.appendChild(overlay);

  closeBtn.addEventListener("click", () => overlay.classList.remove("open"));
  overlay.addEventListener("click", (e) => {
    if (e.target === overlay) overlay.classList.remove("open");
  });

  makeDraggable(head, panel);
}

function makeDraggable(handle, target) {
  let startX, startY, origX, origY;
  handle.addEventListener("mousedown", (e) => {
    if (e.target.tagName === "BUTTON") return;
    startX = e.clientX; startY = e.clientY;
    const rect = target.getBoundingClientRect();
    origX = rect.left; origY = rect.top;
    target.style.position = "fixed";
    target.style.left = origX + "px";
    target.style.top = origY + "px";
    target.style.margin = "0";

    function onMove(ev) {
      target.style.left = (origX + ev.clientX - startX) + "px";
      target.style.top = (origY + ev.clientY - startY) + "px";
    }
    function onUp() {
      document.removeEventListener("mousemove", onMove);
      document.removeEventListener("mouseup", onUp);
    }
    document.addEventListener("mousemove", onMove);
    document.addEventListener("mouseup", onUp);
  });
}

async function openIndustryComparison() {
  const symbol = extractSymbolFromUrl();
  if (!symbol) return;

  ensureComparisonPanel();
  const body = document.querySelector("#xq-comparison-panel .xq-cmp-body");
  if (!body) return;
  body.innerHTML = '<div style="color:#88a0bc; padding:20px; text-align:center;">正在加载行业对比数据...</div>';
  document.getElementById("xq-comparison-overlay")?.classList.add("open");

  try {
    const response = await requestIndustryComparison(symbol);
    if (response?.ok && response.data) {
      renderComparison(response.data, body);
    } else {
      body.innerHTML = `<div style="color:#f87171; padding:20px;">加载失败: ${escapeHtml(response?.error || "未知错误")}</div>`;
    }
  } catch (error) {
    body.innerHTML = `<div style="color:#f87171; padding:20px;">加载异常: ${escapeHtml(error?.message || String(error))}</div>`;
  }
}

async function requestIndustryComparison(symbol) {
  return new Promise((resolve) => {
    if (!isExtensionContextValid()) {
      resolve({ ok: false, error: EXT_INVALIDATED_MSG });
      return;
    }
    try {
      chrome.runtime.sendMessage(
        { type: "getIndustryComparison", currentSymbol: symbol },
        (response) => {
          const err = chrome.runtime.lastError;
          if (err) {
            resolve({ ok: false, error: isContextInvalidatedErrorMessage(err.message) ? EXT_INVALIDATED_MSG : err.message });
            return;
          }
          resolve(response);
        }
      );
    } catch (error) {
      resolve({ ok: false, error: error?.message || String(error) });
    }
  });
}

function renderComparison(data, container) {
  const { comparisonData, aiAnalysis } = data;
  updateModelBadge(data.usedProvider);
  const { industryName, stockData } = comparisonData;

  if (!stockData || stockData.length === 0) {
    container.innerHTML = `<div style="color:#88a0bc; padding:20px; text-align:center;">${escapeHtml(aiAnalysis || "当前缓存中无同行业股票数据。")}</div>`;
    return;
  }

  const titleEl = document.querySelector("#xq-comparison-panel .xq-cmp-title");
  if (titleEl) titleEl.textContent = `行业对比分析（${escapeHtml(industryName || "全部")}，${stockData.length}只）`;

  const metricDefs = [
    { label: "现价(元)", key: "currentPrice" },
    { label: "市值(亿)", key: "marketCap" },
    { label: "PE(TTM)", key: "pe", lowerBetter: true },
    { label: "PB", key: "pb", lowerBetter: true },
    { label: "ROE(%)", key: "roe" },
    { label: "EPS", key: "eps" },
    { label: "净利润增长(%)", key: "netProfitGrowth" },
    { label: "营收增长(%)", key: "revenueGrowth" },
    { label: "毛利率(%)", key: "grossMargin" },
    { label: "净利率(%)", key: "netMargin" },
    { label: "EV/EBITDA", key: "evEbitda", lowerBetter: true },
    { label: "股息率(%)", key: "dividendYield" },
    { label: "FCF Yield(%)", key: "fcfYield" },
    { label: "DCF判定", key: "dcfVerdict", isText: true },
    { label: "安全边际(%)", key: "dcfSafetyMargin" },
    { label: "Graham(元)", key: "grahamValue" },
    { label: "Lynch(元)", key: "lynchValue" },
    { label: "RSI14", key: "rsi14" },
    { label: "趋势", key: "trendBias", isText: true },
    { label: "量比5/20", key: "volumeRatio" },
    { label: "板块强弱(%)", key: "sectorRelStrength" },
    { label: "Piotroski", key: "piotroskiScore" },
    { label: "负债率(%)", key: "debtAssetRatio", lowerBetter: true },
    { label: "信号", key: "signalTriggered", isBool: true },
  ];

  const colCount = stockData.length;

  const thCells = [
    '<th style="text-align:left;">指标</th>',
    ...stockData.map((s) =>
      `<th class="${s.isCurrent ? "xq-cmp-current" : ""}">${escapeHtml(s.name)}<br><span style="font-size:10px;color:#6888a8;">${escapeHtml(s.symbol)}</span>${s.isCurrent ? '<br><span style="font-size:10px;color:#3aa3ff;">当前</span>' : ""}</th>`
    ),
  ].join("");

  const trRows = metricDefs.map(({ label, key, isText, isBool, lowerBetter }) => {
    const values = stockData.map((s) => s.metrics[key]);

    let bestIdx = -1, worstIdx = -1;
    if (!isText && !isBool && values.some((v) => v !== null && v !== undefined)) {
      const numericVals = values.map((v, i) => ({ v, i })).filter((x) => x.v !== null && x.v !== undefined);
      if (numericVals.length >= 2) {
        numericVals.sort((a, b) => a.v - b.v);
        bestIdx = lowerBetter ? numericVals[0].i : numericVals[numericVals.length - 1].i;
        worstIdx = lowerBetter ? numericVals[numericVals.length - 1].i : numericVals[0].i;
      }
    }

    const tdCells = stockData.map((s, i) => {
      const v = s.metrics[key];
      let text;
      if (isBool) text = v ? "已触发" : "-";
      else if (isText) text = v || "-";
      else if (v === null || v === undefined) text = "N/A";
      else text = typeof v === "number" ? (Number.isInteger(v) ? String(v) : v.toFixed(2)) : String(v);

      const cls = i === bestIdx ? "xq-cmp-best" : i === worstIdx ? "xq-cmp-worst" : "";
      return `<td class="${cls} ${s.isCurrent ? "xq-cmp-current" : ""}">${escapeHtml(text)}</td>`;
    }).join("");

    return `<tr><td>${escapeHtml(label)}</td>${tdCells}</tr>`;
  }).join("");

  // 计算行业内关键指标排名
  const rankDefs = [
    { label: "ROE", key: "roe", higherBetter: true },
    { label: "PE", key: "pe", higherBetter: false },
    { label: "FCF Yield", key: "fcfYield", higherBetter: true },
    { label: "股息率", key: "dividendYield", higherBetter: true },
  ];
  const rankSummary = stockData.map(s => {
    const ranks = {};
    rankDefs.forEach(def => {
      const vals = stockData.map(d => ({v: d.metrics[def.key], i: stockData.indexOf(d)}))
        .filter(x => x.v !== null && x.v !== undefined);
      vals.sort((a, b) => def.higherBetter ? b.v - a.v : a.v - b.v);
      const pos = vals.findIndex(x => x.i === stockData.indexOf(s));
      ranks[def.label] = pos >= 0 ? pos + 1 : "-";
    });
    return { name: escapeHtml(s.name), symbol: escapeHtml(s.symbol), isCurrent: s.isCurrent, ranks };
  });
  const rankHtml = stockData.length > 2 ? `
    <div class="xq-subcard" style="margin-top:10px;">
      <div class="xq-subcard-title">🏆 行业内关键指标排名 (1=${stockData.length}最差)</div>
      <table class="xq-cmp-table" style="font-size:10px;">
        <thead><tr><th>公司</th>${rankDefs.map(d => `<th>${escapeHtml(d.label)}</th>`).join("")}</tr></thead>
        <tbody>${rankSummary.map(s => `<tr>
          <td style="${s.isCurrent ? 'color:#3aa3ff;font-weight:700;' : ''}">${s.isCurrent ? '▶ ' : ''}${s.name}</td>
          ${rankDefs.map(d => {
            const r = s.ranks[d.label];
            const cls = r === 1 ? 'xq-cmp-best' : r === stockData.length ? 'xq-cmp-worst' : '';
            return `<td class="${cls}">${r}</td>`;
          }).join("")}
        </tr>`).join("")}</tbody>
      </table>
    </div>` : "";

  const tableHtml = `
    <div class="xq-cmp-table-wrap">
      <table class="xq-cmp-table">
        <thead><tr>${thCells}</tr></thead>
        <tbody>${trRows}</tbody>
      </table>
    </div>
  `;

  const aiHtml = aiAnalysis
    ? `<div class="xq-cmp-ai">
        <div class="xq-cmp-ai-title">AI 对比分析</div>
        <pre class="xq-analysis" style="margin:0;">${escapeHtml(aiAnalysis)}</pre>
      </div>`
    : "";

  container.innerHTML = tableHtml + rankHtml + aiHtml;
}

async function sendChatMessage() {
  ensurePanel();
  if (STATE.chatSending) return;
  const text = (STATE.chatInputEl?.value || "").trim();
  if (!text) return;

  if (!STATE.chatOpen) {
    toggleChatPanel();
  }

  STATE.chatInputEl.value = "";
  appendChatMessage("user", text);
  STATE.chatHistory.push({ role: "user", content: text });
  setChatSending(true);

  try {
    const response = await requestChatReply(text);
    if (!response?.ok) {
      throw new Error(response?.error || "未知错误");
    }
    const answer = String(response.data?.answer || "").trim() || "未收到有效回复";
    updateModelBadge(response.data?.usedProvider);
    appendChatMessage("assistant", answer);
    STATE.chatHistory.push({ role: "assistant", content: answer });
  } catch (error) {
    const rawMessage = error?.message || String(error);
    const message = isContextInvalidatedErrorMessage(rawMessage) ? EXT_INVALIDATED_MSG : rawMessage;
    appendChatMessage("assistant", `对话失败：${message}`);
  } finally {
    setChatSending(false);
  }
}

function renderSignalBadge(triggered) {
  if (triggered) return `<span class="xq-badge xq-badge-good">触发</span>`;
  return `<span class="xq-badge xq-badge-bad">未触发</span>`;
}

function renderTrendBiasBadge(bias) {
  const value = String(bias || "neutral").toLowerCase();
  if (value.includes("bull")) return `<span class="xq-badge xq-badge-good">bullish</span>`;
  if (value.includes("bear")) return `<span class="xq-badge xq-badge-bad">bearish</span>`;
  if (value.includes("insufficient")) return `<span class="xq-badge xq-badge-warn">data_low</span>`;
  return `<span class="xq-badge xq-badge-warn">neutral</span>`;
}

function renderMacdCrossBadge(value) {
  const v = String(value || "none").toLowerCase();
  if (v === "golden") return `<span class="xq-badge xq-badge-good">golden</span>`;
  if (v === "dead") return `<span class="xq-badge xq-badge-bad">dead</span>`;
  return `<span class="xq-badge xq-badge-warn">none</span>`;
}

function renderKdjCrossBadge(value) {
  const v = String(value || "none").toLowerCase();
  if (v === "golden") return `<span class="xq-badge xq-badge-good">golden</span>`;
  if (v === "dead") return `<span class="xq-badge xq-badge-bad">dead</span>`;
  return `<span class="xq-badge xq-badge-warn">none</span>`;
}

function renderBollStateBadge(trend, signal) {
  const badges = [];
  if (trend?.boll?.squeeze) badges.push(`<span class="xq-badge xq-badge-warn">收窄</span>`);
  if (trend?.boll?.breakoutUp) badges.push(`<span class="xq-badge xq-badge-good">上轨突破</span>`);
  if (signal?.sidewaysRiskHigh) badges.push(`<span class="xq-badge xq-badge-bad">震荡风险</span>`);
  if (!badges.length) badges.push(`<span class="xq-badge xq-badge-warn">常态</span>`);
  return badges.join(" ");
}

function renderOpportunityType(type) {
  const value = String(type || "");
  if (value === "best_value_opportunity") return `<span class="xq-badge xq-badge-good">强基本面+强板块</span>`;
  if (value === "defensive_value") return `<span class="xq-badge xq-badge-warn">防御型价值</span>`;
  if (value === "high_risk_growth") return `<span class="xq-badge xq-badge-bad">高风险成长</span>`;
  return `<span class="xq-badge xq-badge-bad">回避区间</span>`;
}

function renderMetricRows(rows) {
  return rows
    .map(
      ([key, value]) =>
        `<div class="xq-metric-row"><div class="xq-metric-key">${escapeHtml(key)}</div><div class="xq-metric-val">${
          String(value).includes("xq-badge") ? value : escapeHtml(value)
        }</div></div>`
    )
    .join("");
}

/* ===== 巴菲特六维价值投资评分卡 ===== */
function computeBuffettScore(snapshot, signal) {
  if (!snapshot) return null;
  const quote = snapshot.quote || {};
  const valuation = snapshot.valuation || {};
  const profitability = snapshot.profitability || {};
  const balanceSheet = snapshot.balanceSheet || {};
  const cashFlow = snapshot.cashFlow || {};
  const quality = snapshot.quality || {};

  // 维度1: 盈利能力 ROE
  const roe = profitability.roe;
  let roeScore = 0;
  if (roe !== null && roe !== undefined) {
    if (roe >= 25) roeScore = 10;
    else if (roe >= 20) roeScore = 8;
    else if (roe >= 15) roeScore = 6;
    else if (roe >= 10) roeScore = 4;
    else if (roe >= 5) roeScore = 2;
  }
  const roeText = roe !== null && roe !== undefined ? fmt(roe, "%") : "N/A";

  // 维度2: 安全边际 (PE估值)
  const peTtm = valuation.peTtm;
  // 结合ROE看PE是否合理：PE < ROE*2 为合理
  let peScore = 0;
  let peDetail = "";
  if (peTtm !== null && peTtm !== undefined && peTtm > 0) {
    if (peTtm < 10) { peScore = 10; peDetail = "极低"; }
    else if (peTtm < 15) { peScore = 8; peDetail = "偏低"; }
    else if (peTtm < 25) { peScore = 6; peDetail = "合理"; }
    else if (peTtm < 40) { peScore = 4; peDetail = "偏高"; }
    else { peScore = 2; peDetail = "极高"; }
    // 调整项：ROE高时PE容忍度高
    if (roe !== null && roe !== undefined && roe > 20 && peTtm < roe * 1.5) peScore = Math.min(10, peScore + 1);
    if (roe !== null && roe !== undefined && roe > 15 && peTtm < roe * 1.2) peScore = Math.min(10, peScore + 1);
  }
  const peText = peTtm !== null && peTtm !== undefined ? fmt(peTtm) : "N/A";

  // 维度3: 财务健康 (负债率 + Piotroski F-Score)
  const debtRatio = balanceSheet.debtAssetRatio;
  let healthScore = 0;
  if (debtRatio !== null && debtRatio !== undefined) {
    if (debtRatio < 30) healthScore = 5;
    else if (debtRatio < 50) healthScore = 4;
    else if (debtRatio < 65) healthScore = 3;
    else if (debtRatio < 80) healthScore = 2;
    else healthScore = 1;
  } else {
    healthScore = 3; // 默认中性
  }
  const piotroski = quality.piotroskiFScore;
  if (piotroski !== null && piotroski !== undefined) {
    if (piotroski >= 7) healthScore += 4;
    else if (piotroski >= 5) healthScore += 2;
    else healthScore += 0;
  }
  healthScore = Math.round(healthScore * 10 / 9 * 10) / 10; // 归一化到10分制
  healthScore = Math.min(10, Math.max(0, healthScore));
  const debtText = debtRatio !== null && debtRatio !== undefined ? fmt(debtRatio, "%") : "N/A";

  // 维度4: 现金流质量 (FCF Yield + 净现比)
  const fcfYield = cashFlow.fcfYield;
  const cashToProfit = cashFlow.cashToProfitRatio;
  let cashScore = 0;
  if (fcfYield !== null && fcfYield !== undefined) {
    if (fcfYield >= 5) cashScore += 5;
    else if (fcfYield >= 3) cashScore += 4;
    else if (fcfYield >= 1) cashScore += 3;
    else if (fcfYield >= 0) cashScore += 2;
    else cashScore += 1;
  }
  if (cashToProfit !== null && cashToProfit !== undefined) {
    if (cashToProfit >= 1.2) cashScore += 5;
    else if (cashToProfit >= 0.8) cashScore += 4;
    else if (cashToProfit >= 0.5) cashScore += 2;
    else cashScore += 0;
  }
  cashScore = Math.min(10, cashScore);
  const fcfText = fcfYield !== null && fcfYield !== undefined ? fmt(fcfYield, "%") : "N/A";

  // 维度5: 成长性 (营收CAGR + 净利增速)
  const revenueCagr = profitability.revenueCagr3y;
  const netProfitGrowth = profitability.netProfitGrowth;
  let growthScore = 0;
  if (revenueCagr !== null && revenueCagr !== undefined) {
    if (revenueCagr >= 20) growthScore += 5;
    else if (revenueCagr >= 10) growthScore += 4;
    else if (revenueCagr >= 5) growthScore += 3;
    else if (revenueCagr >= 0) growthScore += 2;
    else growthScore += 0;
  }
  if (netProfitGrowth !== null && netProfitGrowth !== undefined) {
    if (netProfitGrowth >= 30) growthScore += 5;
    else if (netProfitGrowth >= 15) growthScore += 4;
    else if (netProfitGrowth >= 5) growthScore += 3;
    else if (netProfitGrowth >= 0) growthScore += 2;
    else if (netProfitGrowth >= -10) growthScore += 1;
  }
  growthScore = Math.min(10, growthScore);
  const growthText = netProfitGrowth !== null && netProfitGrowth !== undefined ? fmt(netProfitGrowth, "%") : "N/A";

  // 维度6: 股东回报 (股息率 + 回购)
  const dividendYield = valuation.dividendYield;
  let yieldScore = 0;
  if (dividendYield !== null && dividendYield !== undefined) {
    if (dividendYield >= 5) yieldScore = 10;
    else if (dividendYield >= 4) yieldScore = 8;
    else if (dividendYield >= 3) yieldScore = 7;
    else if (dividendYield >= 2) yieldScore = 5;
    else if (dividendYield >= 1) yieldScore = 3;
    else yieldScore = 1;
  }
  const yieldText = dividendYield !== null && dividendYield !== undefined ? fmt(dividendYield, "%") : "N/A";

  const totalScore = Math.round((roeScore + peScore + healthScore + cashScore + growthScore + yieldScore) / 6 * 10) / 10;

  return {
    totalScore,
    dimensions: [
      { key: "roe", label: "盈利能力", score: roeScore, value: roeText, detail: "ROE" },
      { key: "pe", label: "安全边际", score: peScore, value: peText, detail: peDetail },
      { key: "health", label: "财务健康", score: healthScore, value: debtText, detail: "负债率" },
      { key: "cash", label: "现金流", score: cashScore, value: fcfText, detail: "FCF Yield" },
      { key: "growth", label: "成长性", score: growthScore, value: growthText, detail: "净利增速" },
      { key: "yield", label: "股东回报", score: yieldScore, value: yieldText, detail: "股息率" },
    ],
  };
}

function renderScoreRing(score) {
  const r = 34, circ = 2 * Math.PI * r;
  const offset = circ * (1 - score / 10);
  const color = score >= 7 ? "#0f9d6e" : score >= 5 ? "#d97706" : "#dc2626";
  const label = score >= 8 ? "优秀" : score >= 6 ? "良好" : score >= 4 ? "一般" : "较差";
  return `
    <div class="xq-ring-wrap">
      <svg class="xq-ring-svg" viewBox="0 0 80 80">
        <circle cx="40" cy="40" r="${r}" fill="none" stroke="rgba(255,255,255,.08)" stroke-width="5"/>
        <circle cx="40" cy="40" r="${r}" fill="none" stroke="${color}" stroke-width="5"
          stroke-dasharray="${circ}" stroke-dashoffset="${offset}" stroke-linecap="round"
          transform="rotate(-90 40 40)" style="transition: stroke-dashoffset 1s ease;"/>
        <text x="40" y="36" text-anchor="middle" fill="${color}" font-size="22" font-weight="800">${Math.round(score * 10)}</text>
        <text x="40" y="52" text-anchor="middle" fill="var(--xq-subtle)" font-size="9">${label}</text>
      </svg>
    </div>`;
}

function renderBuffettScorecard(snapshot, signal) {
  const scoreData = computeBuffettScore(snapshot, signal);
  if (!scoreData) return "";
  const { totalScore, dimensions } = scoreData;

  const items = dimensions.map(d => {
    let cssClass = "xq-scorecard-item";
    if (d.score >= 7) cssClass += " xq-sc-good";
    else if (d.score >= 4) cssClass += " xq-sc-warn";
    else cssClass += " xq-sc-bad";
    return `<div class="${cssClass}">
      <div class="xq-sc-label">${escapeHtml(d.label)}</div>
      <div class="xq-sc-value">${escapeHtml(d.value)}</div>
      <div class="xq-sc-detail">${escapeHtml(d.detail)} · ${Math.round(d.score * 10)}分</div>
    </div>`;
  }).join("");

  return `
    <div class="xq-subcard" style="margin-top:10px;">
      <div class="xq-subcard-title">🧠 巴菲特六维价值评分</div>
      ${renderScoreRing(totalScore)}
      <div class="xq-scorecard">${items}</div>
    </div>`;
}

/* ===== 行业内排行渲染 ===== */
function renderSectorRanking(stockData, currentSymbol) {
  if (!Array.isArray(stockData) || stockData.length < 2) return "";
  // 提取关键指标做排序
  const rows = stockData
    .map(s => ({
      symbol: s.symbol,
      name: s.name || s.symbol,
      score: s.score !== undefined ? s.score : (s.current || 0),
      roe: s.roe,
      pe: s.pe_ttm || s.pe,
      fcfYield: s.fcf_yield,
      isCurrent: s.symbol === currentSymbol,
    }))
    .filter(r => r.score > 0)
    .sort((a, b) => b.score - a.score)
    .slice(0, 20);

  return `<div class="xq-sector-rank">
    ${rows.map((r, i) => `<div class="xq-sector-rank-item"${r.isCurrent ? ' style="background:rgba(30,123,242,.15);border-radius:6px;"' : ''}>
      <div class="xq-sr-pos">${i + 1}</div>
      <div class="xq-sr-name">${r.isCurrent ? '▶ ' : ''}${escapeHtml(r.name)}</div>
      <div class="xq-sr-score" style="color:${r.isCurrent ? 'var(--xq-accent-2)' : 'var(--xq-text)'}">${fmt(r.score)}</div>
    </div>`).join("")}
  </div>`;
}

/* ===== 估值温度计 ===== */
function renderValuationThermometer(valuationTables, snapshot) {
  if (!valuationTables) return "";
  const multiModel = valuationTables.multiModel;
  if (!multiModel || !multiModel.available) return "";

  const currentPrice = snapshot?.quote?.current;
  const lowTarget = multiModel.lowTarget;
  const highTarget = multiModel.highTarget;
  const midTarget = multiModel.midTarget;

  if (currentPrice === null || currentPrice === undefined || !lowTarget || !highTarget) return "";

  const pct = highTarget !== lowTarget
    ? Math.round(((currentPrice - lowTarget) / (highTarget - lowTarget)) * 100)
    : 50;
  const clampedPct = Math.max(0, Math.min(100, pct));
  const barColor = clampedPct <= 30 ? "var(--xq-good)" : clampedPct <= 60 ? "var(--xq-warn)" : "var(--xq-bad)";
  const zoneLabel = clampedPct <= 30 ? "低估区" : clampedPct <= 60 ? "合理区" : "高估区";

  return `<div class="xq-subcard" style="margin-top:8px;">
    <div class="xq-subcard-title">🌡️ 估值温度计</div>
    <div style="display:flex;justify-content:space-between;font-size:10px;color:var(--xq-subtle);margin-bottom:2px;">
      <span>低估 ${fmt(lowTarget)}</span>
      <span style="font-weight:700;color:${barColor}">${zoneLabel} ${clampedPct}%</span>
      <span>高估 ${fmt(highTarget)}</span>
    </div>
    <div class="xq-progress-bar-wrap">
      <div class="xq-progress-bar-fill" style="width:${clampedPct}%;background:${barColor};"></div>
    </div>
    <div style="display:flex;justify-content:space-between;font-size:9px;color:var(--xq-subtle);margin-top:2px;">
      <span>现价: ${fmt(currentPrice)}</span>
      <span>中位: ${fmt(midTarget)}</span>
      <span>空间: ${fmt(multiModel.upsidePct, "%")}</span>
    </div>
  </div>`;
}

/* ===== 看板Tab内容 ===== */
function renderDashboardTabs(activeTab) {
  const tabs = [
    { id: "scorecard", label: "评分" },
    { id: "valuation", label: "估值" },
    { id: "sector", label: "行业" },
    { id: "report", label: "报告" },
  ];
  return `<div class="xq-dashboard-tabs" id="xq-dashboard-tabs">
    ${tabs.map(t => `<button class="xq-dashboard-tab${t.id === activeTab ? " active" : ""}" data-tab="${t.id}">${t.label}</button>`).join("")}
  </div>`;
}

function buildSnapshotPanels(snapshot, signal) {
  const quote = snapshot.quote || {};
  const valuation = snapshot.valuation || {};
  const profitability = snapshot.profitability || {};
  const balanceSheet = snapshot.balanceSheet || {};
  const cashFlow = snapshot.cashFlow || {};
  const quality = snapshot.quality || {};
  const business = snapshot.business || {};
  const valueCoverage = snapshot.valueCoverage || {};
  const trend = snapshot.trend || {};
  const macd = trend.macd || {};
  const market = snapshot.market || {};
  const sectorTrend = snapshot.sectorTrend || {};
  const sectorIndicator = sectorTrend.trend || {};

  const valueRows = [
    ["现价", fmt(quote.current)],
    ["PE(TTM)", fmt(valuation.peTtm)],
    ["PB", fmt(valuation.pb)],
    ["PEG", fmt(valuation.peg)],
    [
      "ROE",
      `${fmt(profitability.roe, "%")}${
        profitability.roePeriod ? ` (${String(profitability.roePeriod).toUpperCase()})` : ""
      }`,
    ],
    ["净利增速", fmt(profitability.netProfitGrowth, "%")],
    ["营收3年CAGR", fmt(profitability.revenueCagr3y, "%")],
    ["资产负债率", fmt(balanceSheet.debtAssetRatio, "%")],
    [
      "净现比",
      `${fmt(cashFlow.cashToProfitRatio)}${
        cashFlow.cashToProfitRatioPeriod ? ` (${String(cashFlow.cashToProfitRatioPeriod).toUpperCase()})` : ""
      }`,
    ],
    ["FCF(亿元)", fmt(cashFlow.fcf)],
    ["FCF Yield", fmt(cashFlow.fcfYield, "%")],
    ["股息率", fmt(valuation.dividendYield, "%")],
    ["股息支付率", fmt(valuation.payoutRatio, "%")],
    ["海外/新兴占比", fmt(business.overseasOrNewRevenueRatio, "%")],
    ["Piotroski F-Score", fmt(quality.piotroskiFScore)],
    [
      "机构目标价(均值/区间)",
      `${fmt(valuation.targetPriceConsensus)} / ${fmt(valuation.targetPriceLow)}-${fmt(
        valuation.targetPriceHigh
      )}`,
    ],
    ["目标价折扣(现价/目标)", fmt(valuation.targetDiscountPctToRef, "%")],
    [
      "价值覆盖评分",
      `${fmt(valueCoverage.normalizedScore10)} (${fmt(valueCoverage.passCount)}/${fmt(
        valueCoverage.availableCount
      )})`,
    ],
    ["行业", `${fmt(sectorTrend.industryName)} ${sectorTrend.industryCode ? `(${fmt(sectorTrend.industryCode)})` : ""}`],
    ["板块趋势", renderTrendBiasBadge(sectorIndicator.trendBias)],
    ["板块强度", `${fmt(signal?.sectorTrendScore)} (${fmt(signal?.sectorTrendLevel)})`],
    ["板块相对强弱20D", fmt(sectorTrend.relativeStrength20d, "%")],
    ["四象限", renderOpportunityType(signal?.opportunityType)],
    ["板块共振", signal?.sectorResonance || "N/A"],
    ["仓位建议", signal?.positionGuidance || "N/A"],
    ["存货周转率", fmt(balanceSheet.inventoryTurnover)],
    ["DSO(天)", fmt(balanceSheet.dso)],
    ["价值买点", renderSignalBadge(!!signal?.valueTriggered)],
  ];
  const trendRows = [
    ["涨跌幅", fmt(quote.percent, "%")],
    ["趋势偏向", renderTrendBiasBadge(trend.trendBias)],
    ["MA10 / MA20 / MA60", `${fmt(trend.ma10)} / ${fmt(trend.ma20)} / ${fmt(trend.ma60)}`],
    ["MA120 / MA250", `${fmt(trend.ma120)} / ${fmt(trend.ma250)}`],
    ["MA金叉状态", renderMacdCrossBadge(signal?.maCross)],
    ["MA120斜率 / MA250斜率", `${fmt(trend.ma120Slope)} / ${fmt(trend.ma250Slope)}`],
    ["BOLL(上/中/下)", `${fmt(trend?.boll?.upper)} / ${fmt(trend?.boll?.middle)} / ${fmt(trend?.boll?.lower)}`],
    ["BOLL带宽(今/昨)", `${fmt(trend?.boll?.bandwidthNow)} / ${fmt(trend?.boll?.bandwidthPrev)}`],
    ["BOLL状态", renderBollStateBadge(trend, signal)],
    ["均量比(5日/20日)", fmt(trend.volumeRatio5_20)],
    ["均量比(10日/20日)", fmt(trend.volumeRatio10_20)],
    ["当日量比(1日/20日)", fmt(trend.volumeRatio1_20)],
    ["RSI14", fmt(trend.rsi14)],
    ["KDJ(K/D/J)", `${fmt(trend?.kdj?.k)} / ${fmt(trend?.kdj?.d)} / ${fmt(trend?.kdj?.j)}`],
    ["KDJ金叉状态", renderKdjCrossBadge(signal?.kdjCross)],
    ["MACD(HIST)", fmt(macd.hist)],
    ["MACD金叉状态", renderMacdCrossBadge(signal?.macdCross)],
    ["价离MA20", fmt(signal?.priceDepartureMa20Pct, "%")],
    ["趋势强度(类ADX)", `${fmt(signal?.trendStrengthScore)} (${fmt(signal?.trendStrengthLevel)})`],
    ["三重突破", renderSignalBadge(!!signal?.tripleGoldenBreakout)],
    [
      "震荡风险",
      signal?.sidewaysRiskHigh
        ? `<span class="xq-badge xq-badge-bad">高</span>`
        : `<span class="xq-badge xq-badge-good">低</span>`,
    ],
    ["中性观察", (signal?.neutralFocusNotes || []).join("；") || "无"],
    ["趋势评分", `${fmt(signal?.trendScore)} / ${fmt(signal?.trendThreshold)}`],
    ["长周期过滤", renderSignalBadge(!!signal?.longTrendFilterPass)],
    ["底部形态评分", fmt(signal?.bottomPatternScore)],
    ["MACD底背离", renderSignalBadge(!!signal?.macdBullishDivergenceFlag)],
    ["周线确认", fmt(signal?.weeklyTrendConfirmScore)],
    ["市场环境", fmt(market.bias)],
    ["综合买点", renderSignalBadge(!!signal?.triggered)]
  ];

  return `
    <div class="xq-grid">
      <div class="xq-subcard">
        <div class="xq-subcard-title">价值分析（基本面+板块）</div>
        ${renderMetricRows(valueRows)}
      </div>
      <div class="xq-subcard">
        <div class="xq-subcard-title">交易趋势（个股技术）</div>
        ${renderMetricRows(trendRows)}
      </div>
    </div>
  `;
}

function buildValuationTablesHtml(valuationTables) {
  if (!valuationTables) return "";
  const dcfHtml = buildDcfTableHtml(valuationTables.dcf);
  const multiModelHtml = buildMultiModelTableHtml(valuationTables.multiModel);
  const relativeHtml = buildRelativeTableHtml(valuationTables.relative);
  const assetHtml = buildAssetTableHtml(valuationTables.asset);
  return `
    <div style="margin-top:8px;">
      ${dcfHtml}
      <div style="margin-top:10px;">
        ${multiModelHtml}
      </div>
      <div style="margin-top:10px;">
        ${relativeHtml}
      </div>
      <div style="margin-top:10px;">
        ${assetHtml}
      </div>
    </div>
  `;
}

function buildDcfTableHtml(dcf) {
  if (!dcf || !dcf.available) {
    const reason = dcf?.reason || "数据不足，无法计算DCF估值。";
    return `
      <div class="xq-subcard">
        <div class="xq-subcard-title">绝对估值（DCF模型）</div>
        <div class="xq-metric-row"><div class="xq-metric-val" style="color:#88a0bc;">${escapeHtml(reason)}</div></div>
      </div>
    `;
  }

  const scenarioRows = (dcf.scenarios || []).map((s) => {
    const badgeClass =
      s.verdict === "低估" || s.verdict === "合理偏低" ? "good"
      : s.verdict === "高估" ? "bad"
      : "warn";
    return `
      <div class="xq-metric-row">
        <div class="xq-metric-key">${escapeHtml(s.name)}</div>
        <div class="xq-metric-val">
          内在价值 ${fmt(s.intrinsicPerShare, "元")}
          <span class="xq-badge xq-badge-${badgeClass}">安全边际 ${fmt(s.safetyMargin, "%")}</span>
          ${escapeHtml(s.verdict)}
        </div>
      </div>
    `;
  }).join("");

  const assumptionRows = [
    ["基础FCF(亿元)", fmt(dcf.baseFcfYiYuan)],
    ["预估增长率", fmt(dcf.estimatedGrowthRate, "%")],
    ["WACC(折现率)", fmt(dcf.wacc, "%")],
    ["无风险利率", fmt(dcf.assumptions?.riskFreeRate, "%")],
    ["Beta代理", fmt(dcf.assumptions?.betaProxy)],
    ["永续增长率", fmt(dcf.assumptions?.perpetuityGrowthRate, "%")],
  ];

  let sensitivityHtml = "";
  if (dcf.sensitivity) {
    sensitivityHtml = buildSensitivityTableHtml(dcf.sensitivity);
  }

  return `
    <div class="xq-subcard">
      <div class="xq-subcard-title">绝对估值（DCF模型）</div>
      ${scenarioRows}
      <div style="margin-top:6px; border-top:1px dashed rgba(93,125,160,.2); padding-top:4px;">
        ${renderMetricRows(assumptionRows)}
      </div>
      ${dcf.fcfIsNegative ? `<div class="xq-metric-row"><div class="xq-metric-val" style="color:#f59e0b; font-size:12px;">注意：当前FCF为负，基于净利润替代估算，结果可靠性降低。</div></div>` : ""}
      ${sensitivityHtml}
    </div>
  `;
}

function buildSensitivityTableHtml(sensitivity) {
  if (!sensitivity || !sensitivity.grid || !sensitivity.grid.length) return "";

  const colLabels = sensitivity.colLabels || [];
  const headerCells = ["增长率 \\ WACC", ...colLabels].map(
    (label) => `<td style="font-size:11px; color:#88a0bc; padding:2px 4px;">${escapeHtml(label)}</td>`
  ).join("");

  const bodyRows = (sensitivity.grid || []).map((row) => {
    const cells = [
      `<td style="font-size:11px; color:#88a0bc;">${escapeHtml(row.growthLabel)}</td>`,
      ...row.values.map((val) => {
        const color = val > 20 ? "#4ade80" : val > 0 ? "#facc15" : val > -20 ? "#fb923c" : "#f87171";
        return `<td style="font-size:11px; font-weight:700; color:${color}; padding:2px 4px;">${fmt(val, "%")}</td>`;
      }),
    ];
    return `<tr>${cells.join("")}</tr>`;
  }).join("");

  return `
    <div style="margin-top:6px; font-size:11px; color:#88a0bc;">安全边际敏感性分析（行=增长率，列=折现率）</div>
    <div style="overflow-x:auto;">
      <table class="xq-table" style="min-width:280px;">
        <thead><tr>${headerCells}</tr></thead>
        <tbody>${bodyRows}</tbody>
      </table>
    </div>
  `;
}

function buildRelativeTableHtml(relative) {
  if (!relative || !relative.available) {
    return `
      <div class="xq-subcard">
        <div class="xq-subcard-title">相对估值</div>
        <div class="xq-metric-row"><div class="xq-metric-val" style="color:#88a0bc;">数据不足。</div></div>
      </div>
    `;
  }

  const metricRows = (relative.metrics || []).map((m) => {
    const rangeText = m.range ? `${m.range[0]} / ${m.range[1]} / ${m.range[2]}` : "N/A";
    return `
      <div class="xq-metric-row">
        <div class="xq-metric-key">${escapeHtml(m.name)}</div>
        <div class="xq-metric-val">
          ${fmt(m.value)}
          <span style="color:#6888a8; font-size:11px;">参考 ${rangeText}</span>
          <span class="xq-badge xq-badge-${m.badgeClass}">${escapeHtml(m.interpretation)}</span>
        </div>
      </div>
    `;
  }).join("");

  return `
    <div class="xq-subcard">
      <div class="xq-subcard-title">相对估值${relative.industryName ? `（${escapeHtml(relative.industryName)}）` : ""}</div>
      ${metricRows}
      <div style="margin-top:4px; font-size:11px; color:#6888a8;">${escapeHtml(relative.note || "")}</div>
    </div>
  `;
}

function buildMultiModelTableHtml(multiModel) {
  if (!multiModel || !multiModel.available) {
    return `
      <div class="xq-subcard">
        <div class="xq-subcard-title">多模型绝对估值</div>
        <div class="xq-metric-row"><div class="xq-metric-val" style="color:#88a0bc;">数据不足，无法计算多模型估值。</div></div>
      </div>
    `;
  }

  const modelRows = (multiModel.models || []).map((m) => {
    const badgeClass =
      m.verdict === "低估" || m.verdict === "合理偏低" ? "good"
      : m.verdict === "高估" || m.verdict === "合理偏高" ? "bad"
      : m.verdict === "不适用" ? ""
      : "warn";
    const badgeHtml = badgeClass
      ? `<span class="xq-badge xq-badge-${badgeClass}">${escapeHtml(m.verdict)}</span>`
      : `<span class="xq-badge" style="background:rgba(100,120,140,.15); color:#88a0bc;">${escapeHtml(m.verdict)}</span>`;
    return `
      <div class="xq-metric-row">
        <div class="xq-metric-key">${escapeHtml(m.name)}</div>
        <div class="xq-metric-val">
          ${m.fairValue !== null ? `公允价值 ${fmt(m.fairValue, "元")} | 上行空间 ${fmt(m.upsidePct, "%")}` : ""}
          ${badgeHtml}
          <div style="font-size:11px; color:#6888a8; margin-top:1px;">${escapeHtml(m.reason || "")}</div>
        </div>
      </div>
    `;
  }).join("");

  const avgLine = multiModel.averageUpside !== null
    ? `<div class="xq-metric-row"><div class="xq-metric-val" style="font-weight:700;">平均上行空间: ${fmt(multiModel.averageUpside, "%")}</div></div>`
    : "";

  return `
    <div class="xq-subcard">
      <div class="xq-subcard-title">多模型绝对估值（DDM / Graham / Lynch）</div>
      ${modelRows}
      ${avgLine}
      <div style="margin-top:4px; font-size:11px; color:#6888a8;">三种经典模型交叉验证，综合考虑分红、净资产、增长率。</div>
    </div>
  `;
}

function buildAssetTableHtml(asset) {
  if (!asset || !asset.available) {
    return `
      <div class="xq-subcard">
        <div class="xq-subcard-title">资产估值</div>
        <div class="xq-metric-row"><div class="xq-metric-val" style="color:#88a0bc;">数据不足，无法计算资产估值。</div></div>
      </div>
    `;
  }

  const navBadgeClass =
    asset.navVerdict === "破净" || asset.navVerdict === "显著破净" ? "good"
    : asset.navVerdict === "合理" ? "warn"
    : "bad";

  const rows = [
    ["每股净资产(NAV)", `${fmt(asset.navPerShare, "元")} | Price/NAV = ${fmt(asset.priceToNav)}`],
  ];

  if (asset.ncavPerShare !== null) {
    rows.push(["每股NCAV(净流动资产)", `${fmt(asset.ncavPerShare, "元")} | Price/NCAV = ${fmt(asset.priceToNcav)}`]);
  }

  const metricRowsHtml = rows.map(([key, val]) => `
    <div class="xq-metric-row">
      <div class="xq-metric-key">${escapeHtml(key)}</div>
      <div class="xq-metric-val">${escapeHtml(val)}</div>
    </div>
  `).join("");

  return `
    <div class="xq-subcard">
      <div class="xq-subcard-title">资产估值（NAV / NCAV）</div>
      ${metricRowsHtml}
      <div class="xq-metric-row">
        <div class="xq-metric-key">NAV判定</div>
        <div class="xq-metric-val">
          <span class="xq-badge xq-badge-${navBadgeClass}">${escapeHtml(asset.navVerdict || "")}</span>
        </div>
      </div>
      <div style="margin-top:4px; font-size:11px; color:#6888a8;">NAV=每股净资产；NCAV=净流动资产(流动资产-总负债)，Graham Net-Net策略核心指标。</div>
    </div>
  `;
}

function renderResult(result) {
  ensurePanel();
  const snapshot = result.snapshot || {};
  const sourceErrors = result.sourceErrors || {};
  const market = snapshot.market || {};

  const errorsText = Object.keys(sourceErrors).length
    ? `<div class="xq-warn-box">部分数据接口失败：${escapeHtml(
        JSON.stringify(sourceErrors)
      )}</div>`
    : "";

  const signalReasons = [];
  if (result?.signal?.trendTriggered) signalReasons.push("趋势条件成立");
  if (result?.signal?.valueTriggered) signalReasons.push("价值条件成立");
  if (!signalReasons.length) signalReasons.push("暂未满足综合触发条件");
  const scoreText = `${fmt(result?.signal?.trendScore)} / ${fmt(result?.signal?.trendThreshold)}`;
  const materialTotal = Number(result?.researchMaterials?.total || 0);
  const relevantCount = Number(result?.researchMaterials?.relevantCount || 0);
  const filteredOut = Number(result?.researchMaterials?.filteredOut || 0);
  const filterStats = result?.researchMaterials?.filterStats || null;
  const materialLine = materialTotal > 0
    ? `材料检索：最近3个月 共${materialTotal}份（有效关联${relevantCount}，过滤干扰${filteredOut}）`
    : "";
  const analysisBody = result.analysis || "";
  if (STATE.headerSubEl) {
    STATE.headerSubEl.textContent = `${result.symbol || ""} ${result.name || ""} · 更新于 ${new Date(
      result.fetchedAt
    ).toLocaleTimeString()}`;
  }
  if (STATE.marketBadgeEl) {
    const bias = String(market.bias || "neutral");
    STATE.marketBadgeEl.className = "xq-top-badge";
    STATE.marketBadgeEl.textContent =
      bias === "supportive" ? "市场支持" : bias === "risk_off" ? "市场谨慎" : "市场中性";
    if (bias === "supportive") STATE.marketBadgeEl.classList.add("market");
    else if (bias === "risk_off") STATE.marketBadgeEl.classList.add("market-risk");
    else STATE.marketBadgeEl.classList.add("market-neutral");
  }
  if (STATE.scoreBadgeEl) {
    STATE.scoreBadgeEl.textContent = scoreText;
  }

  const currentTab = STATE._activeDashboardTab || "scorecard";

  // 缓冲区：所有Tab的内容预生成
  const tabContents = {
    scorecard: `
      ${buildSnapshotPanels(snapshot, result.signal)}
      ${renderBuffettScorecard(snapshot, result.signal)}
      ${renderValuationThermometer(result.valuationTables, snapshot)}
    `,
    valuation: `
      ${buildSnapshotPanels(snapshot, result.signal)}
      ${buildValuationTablesHtml(result.valuationTables)}
      ${renderValuationThermometer(result.valuationTables, snapshot)}
    `,
    sector: `
      <div class="xq-hero">
        <div class="xq-hero-title">行业板块分析</div>
        <div class="xq-hero-sub">${escapeHtml(snapshot?.sectorTrend?.industryName || "行业对比")}</div>
      </div>
      ${buildSnapshotPanels(snapshot, result.signal)}
      ${errorsText}
      <pre class="xq-analysis">${escapeHtml(analysisBody)}</pre>
    `,
    report: `
      <div class="xq-hero">
        <div class="xq-hero-title">综合买点：${result?.signal?.triggered ? "已触发" : "未触发"}（评分 ${escapeHtml(scoreText)}）</div>
        <div class="xq-hero-sub">${escapeHtml(signalReasons.join(" · "))}</div>
      </div>
      ${errorsText}
      <div class="xq-subcard" style="margin-top:10px;">
        <div class="xq-subcard-title">估值分析汇总中心</div>
        <pre id="xq-valuation-summary" class="xq-analysis" style="margin:0;">${escapeHtml(result.valuationSummary || "")}\n\nAI 正在生成深度分析...</pre>
      </div>
      <pre class="xq-analysis">${escapeHtml(analysisBody)}</pre>
    `,
  };

  STATE.contentEl.innerHTML = `
    ${renderDashboardTabs(currentTab)}
    <div id="xq-dashboard-content">${tabContents[currentTab]}</div>
  `;

  // Tab 切换事件绑定
  const tabsContainer = document.getElementById("xq-dashboard-tabs");
  if (tabsContainer) {
    tabsContainer.addEventListener("click", (e) => {
      const tabBtn = e.target.closest(".xq-dashboard-tab");
      if (!tabBtn) return;
      const tabId = tabBtn.dataset.tab;
      if (!tabId || tabId === STATE._activeDashboardTab) return;
      STATE._activeDashboardTab = tabId;
      // 更新tab高亮
      tabsContainer.querySelectorAll(".xq-dashboard-tab").forEach(btn => btn.classList.remove("active"));
      tabBtn.classList.add("active");
      // 更新内容
      const contentDiv = document.getElementById("xq-dashboard-content");
      if (contentDiv && tabContents[tabId]) {
        contentDiv.innerHTML = tabContents[tabId];
      }
    });
  }

  requestValuationSummaryLLM(result);
}

async function fetchXueqiuBundleFromPage(symbol) {
  const base = "https://stock.xueqiu.com/v5";
  const requests = {
    realtime: [`${base}/stock/realtime/quotec.json`, { symbol }],
    detail: [`${base}/stock/quote.json`, { symbol, extend: "detail" }],
    indicator: [
      `${base}/stock/finance/cn/indicator.json`,
      { symbol, type: "all", is_detail: true, count: 6 },
    ],
    income: [
      `${base}/stock/finance/cn/income.json`,
      { symbol, type: "all", is_detail: true, count: 6 },
    ],
    balance: [
      `${base}/stock/finance/cn/balance.json`,
      { symbol, type: "all", is_detail: true, count: 6 },
    ],
    cashFlow: [
      `${base}/stock/finance/cn/cash_flow.json`,
      { symbol, type: "all", is_detail: true, count: 6 },
    ],
    kline: [
      `${base}/stock/chart/kline.json`,
      { symbol, begin: Date.now(), period: "day", type: "before", count: -320, indicator: "kline" },
    ],
    weeklyKline: [
      `${base}/stock/chart/kline.json`,
      { symbol, begin: Date.now(), period: "week", type: "before", count: -260, indicator: "kline" },
    ],
    marketMain: [
      `${base}/stock/chart/kline.json`,
      { symbol: "SH000001", begin: Date.now(), period: "day", type: "before", count: -320, indicator: "kline" },
    ],
    marketBroad: [
      `${base}/stock/chart/kline.json`,
      { symbol: "SH000300", begin: Date.now(), period: "day", type: "before", count: -320, indicator: "kline" },
    ],
    industry: [`${base}/stock/f10/cn/industry/compare.json`, { symbol, type: "single" }],
    shareholders: [`${base}/stock/f10/cn/skholder.json`, { symbol }],
    bonus: [`${base}/stock/f10/cn/bonus.json`, { symbol, page: 1, size: 5 }],
  };

  const entries = Object.entries(requests);
  const settled = await Promise.allSettled(
    entries.map(async ([, [url, params]]) => {
      const requestUrl = new URL(url);
      Object.entries(params).forEach(([key, value]) => {
        if (value !== undefined && value !== null) {
          requestUrl.searchParams.set(key, String(value));
        }
      });

      const resp = await fetch(requestUrl.toString(), {
        credentials: "include",
        headers: {
          Accept: "application/json, text/plain, */*",
        },
      });

      if (!resp.ok) {
        const text = await resp.text();
        throw new Error(`${resp.status}: ${text.slice(0, 200)}`);
      }

      return resp.json();
    })
  );

  const data = {};
  const errors = {};
  settled.forEach((item, index) => {
    const key = entries[index][0];
    if (item.status === "fulfilled") {
      data[key] = item.value;
    } else {
      errors[key] = item.reason?.message || "unknown_error";
    }
  });

  return { data, errors };
}

async function requestAnalysisWithBundle(symbol, forceRefresh, prefetchedBundle, options = {}) {
  return new Promise((resolve) => {
    if (!isExtensionContextValid()) {
      resolve({ ok: false, error: EXT_INVALIDATED_MSG });
      return;
    }

    try {
      chrome.runtime.sendMessage(
        {
          type: "getStockAnalysis",
          symbol,
          forceRefresh,
          prefetchedBundle,
          skipLlm: options?.skipLlm === true,
          materialSearch: options?.materialSearch === true,
        },
        (response) => {
          const err = chrome.runtime.lastError;
          if (err) {
            resolve({ ok: false, error: isContextInvalidatedErrorMessage(err.message) ? EXT_INVALIDATED_MSG : err.message });
            return;
          }
          resolve(response);
        }
      );
    } catch (error) {
      resolve({
        ok: false,
        error: isContextInvalidatedErrorMessage(error?.message) ? EXT_INVALIDATED_MSG : (error?.message || String(error)),
      });
    }
  });
}

async function requestPrefetchSymbols(symbols) {
  if (!Array.isArray(symbols) || !symbols.length) return;
  return new Promise((resolve) => {
    if (!isExtensionContextValid()) {
      resolve({ ok: false, error: EXT_INVALIDATED_MSG });
      return;
    }
    try {
      chrome.runtime.sendMessage(
        {
          type: "prefetchStockAnalyses",
          symbols,
          maxSymbols: 60,
          concurrency: 2,
        },
        (response) => {
          const err = chrome.runtime.lastError;
          if (err) {
            resolve({ ok: false, error: isContextInvalidatedErrorMessage(err.message) ? EXT_INVALIDATED_MSG : err.message });
            return;
          }
          resolve(response);
        }
      );
    } catch (error) {
      resolve({
        ok: false,
        error: isContextInvalidatedErrorMessage(error?.message) ? EXT_INVALIDATED_MSG : (error?.message || String(error)),
      });
    }
  });
}

function schedulePrefetchFromCurrentPage() {
  if (STATE.prefetchTimer) {
    clearTimeout(STATE.prefetchTimer);
  }
  STATE.prefetchTimer = setTimeout(async () => {
    const symbols = extractSymbolsFromDocument().slice(0, 60);
    setPrefetchStatus(`发现股票链接 ${symbols.length} 个，准备预分析...`);
    const unseen = symbols.filter((symbol) => !STATE.prefetchSymbolSet.has(symbol));
    if (!unseen.length) {
      setPrefetchStatus(`已发现 ${symbols.length} 个，暂无新增`, "rgba(51, 65, 85, 0.9)");
      return;
    }
    unseen.forEach((symbol) => STATE.prefetchSymbolSet.add(symbol));
    try {
      const response = await requestPrefetchSymbols(unseen);
      if (response?.ok) {
        const d = response.data || {};
        const reasonSummary = summarizePrefetchErrors(d.errors);
        setPrefetchStatus(
          `预分析完成: 新增${d.generated || 0} 缓存命中${d.cachedHits || 0} 失败${d.failed || 0}${
            reasonSummary ? ` (${reasonSummary})` : ""
          }`,
          d.failed ? "rgba(180, 83, 9, 0.92)" : "rgba(22, 101, 52, 0.92)",
          { isError: !!d.failed }
        );
        showPrefetchDoneToast(symbols.length, d.generated || 0, d.cachedHits || 0);
        if (d.failed) {
          await appendPrefetchErrorLog(`预分析失败${d.failed}条: ${reasonSummary || "未知原因"}`);
        }
      } else {
        const msg = `预分析失败: ${response?.error || "未知错误"}`;
        setPrefetchStatus(msg, "rgba(185, 28, 28, 0.92)", { isError: true });
        await appendPrefetchErrorLog(msg);
      }
    } catch {
      const msg = "预分析失败：扩展通信异常";
      setPrefetchStatus(msg, "rgba(185, 28, 28, 0.92)", { isError: true });
      await appendPrefetchErrorLog(msg);
    }
  }, 700);
}

async function startAnalysis({ forceRefresh, trigger, skipLlm = false, materialSearch = false }) {
  const symbol = extractSymbolFromUrl();
  if (!symbol) return;

  ensurePanel();

  if (STATE.isAnalyzing) {
    setStatus("分析进行中，请稍候...", "#8a4b00");
    return;
  }

  STATE.isAnalyzing = true;
  setStatus(
    skipLlm
      ? `已触发指标预览（${trigger}）: ${symbol}`
      : `已触发分析（${trigger}）: ${symbol}`,
    "#1155cc"
  );
  setProgress(15, "识别股票代码...");

  try {
    setProgress(40, skipLlm ? "拉取结构化指标..." : (materialSearch ? "拉取指标并检索研报材料..." : "读取缓存并生成分析..."));
    let response = await requestAnalysisWithBundle(symbol, forceRefresh, null, { skipLlm, materialSearch });

    if (!response?.ok && /无法获取雪球数据/.test(String(response.error || ""))) {
      setProgress(62, "后台拉取失败，回退到页面上下文拉取...");
      const bundle = await fetchXueqiuBundleFromPage(symbol);
      response = await requestAnalysisWithBundle(symbol, forceRefresh, bundle, { skipLlm, materialSearch });
    }

    setProgress(
      85,
      skipLlm
        ? "渲染指标面板..."
        : (materialSearch ? "执行逐份材料深读并生成估值结论..." : "渲染分析结果...")
    );

    if (!response?.ok) {
      throw new Error(response?.error || "未知错误");
    }

    STATE.lastResult = response.data;
    renderResult(response.data);
    setStatus("", "#166534");
    setProgress(100, "完成");
  } catch (error) {
    const rawMessage = error?.message || String(error);
    const message = isContextInvalidatedErrorMessage(rawMessage) ? EXT_INVALIDATED_MSG : rawMessage;

    STATE.contentEl.innerHTML = `<div class="xq-warn-box">分析失败：${escapeHtml(message)}</div>`;
    setStatus("分析失败", "#b91c1c");
  } finally {
    setTimeout(() => {
      hideProgress();
      STATE.isAnalyzing = false;
    }, 250);
  }
}

function exportAnalysis() {
  if (!STATE.lastResult) {
    setStatus("暂无可导出的分析结果", "#8a4b00");
    return;
  }

  const symbol = STATE.lastResult.symbol || "UNKNOWN";
  const timestamp = new Date(STATE.lastResult.fetchedAt || Date.now())
    .toISOString()
    .replace(/[:.]/g, "-");

  const s = STATE.lastResult.snapshot;
  const text = [
    `${STATE.lastResult.name} (${symbol})`,
    `更新时间: ${new Date(STATE.lastResult.fetchedAt).toLocaleString()}`,
    `已检索材料: ${fmt(STATE.lastResult?.researchMaterials?.total)} 份`,
    "",
    "[基本面快照]",
    `现价: ${fmt(s?.quote?.current)}`,
    `PE(TTM): ${fmt(s?.valuation?.peTtm)}`,
    `PB: ${fmt(s?.valuation?.pb)}`,
    `ROE: ${fmt(s?.profitability?.roe, "%")}${
      s?.profitability?.roePeriod ? ` (${String(s.profitability.roePeriod).toUpperCase()})` : ""
    }`,
    `净利增速: ${fmt(s?.profitability?.netProfitGrowth, "%")}`,
    `资产负债率: ${fmt(s?.balanceSheet?.debtAssetRatio, "%")}`,
    `净现比: ${fmt(s?.cashFlow?.cashToProfitRatio)}${
      s?.cashFlow?.cashToProfitRatioPeriod ? ` (${String(s.cashFlow.cashToProfitRatioPeriod).toUpperCase()})` : ""
    }`,
    `趋势偏向: ${fmt(s?.trend?.trendBias)}`,
    `MA10/MA20/MA60: ${fmt(s?.trend?.ma10)} / ${fmt(s?.trend?.ma20)} / ${fmt(s?.trend?.ma60)}`,
    `MA120/MA250: ${fmt(s?.trend?.ma120)} / ${fmt(s?.trend?.ma250)}`,
    `MA金叉状态: ${fmt(STATE.lastResult?.signal?.maCross)}`,
    `MA120斜率/MA250斜率: ${fmt(s?.trend?.ma120Slope)} / ${fmt(s?.trend?.ma250Slope)}`,
    `BOLL(上/中/下): ${fmt(s?.trend?.boll?.upper)} / ${fmt(s?.trend?.boll?.middle)} / ${fmt(s?.trend?.boll?.lower)}`,
    `BOLL带宽(今/昨): ${fmt(s?.trend?.boll?.bandwidthNow)} / ${fmt(s?.trend?.boll?.bandwidthPrev)}`,
    `BOLL收窄: ${s?.trend?.boll?.squeeze ? "是" : "否"}`,
    `BOLL上轨突破: ${s?.trend?.boll?.breakoutUp ? "是" : "否"}`,
    `均量比(5日/20日): ${fmt(s?.trend?.volumeRatio5_20)}`,
    `均量比(10日/20日): ${fmt(s?.trend?.volumeRatio10_20)}`,
    `当日量比(1日/20日): ${fmt(s?.trend?.volumeRatio1_20)}`,
    `RSI14: ${fmt(s?.trend?.rsi14)}`,
    `KDJ(K/D/J): ${fmt(s?.trend?.kdj?.k)} / ${fmt(s?.trend?.kdj?.d)} / ${fmt(s?.trend?.kdj?.j)}`,
    `KDJ金叉状态: ${fmt(STATE.lastResult?.signal?.kdjCross)}`,
    `MACD(HIST): ${fmt(s?.trend?.macd?.hist)}`,
    `MACD金叉状态: ${fmt(STATE.lastResult?.signal?.macdCross)}`,
    `价离MA20: ${fmt(STATE.lastResult?.signal?.priceDepartureMa20Pct, "%")}`,
    `趋势强度(类ADX): ${fmt(STATE.lastResult?.signal?.trendStrengthScore)} (${fmt(STATE.lastResult?.signal?.trendStrengthLevel)})`,
    `三重突破(MA+MACD+BOLL): ${STATE.lastResult?.signal?.tripleGoldenBreakout ? "是" : "否"}`,
    `震荡风险(RSI<40且低量比): ${STATE.lastResult?.signal?.sidewaysRiskHigh ? "高" : "低"}`,
    `中性观察: ${(STATE.lastResult?.signal?.neutralFocusNotes || []).join("；") || "无"}`,
    `长周期过滤: ${STATE.lastResult?.signal?.longTrendFilterPass ? "通过" : "未通过"}`,
    `底部形态评分: ${fmt(STATE.lastResult?.signal?.bottomPatternScore)}`,
    `MACD底背离: ${STATE.lastResult?.signal?.macdBullishDivergenceFlag ? "是" : "否"}`,
    `周线确认评分: ${fmt(STATE.lastResult?.signal?.weeklyTrendConfirmScore)}`,
    `所属行业: ${fmt(s?.sectorTrend?.industryName)} ${s?.sectorTrend?.industryCode ? `(${fmt(s.sectorTrend.industryCode)})` : ""}`,
    `板块趋势偏向: ${fmt(s?.sectorTrend?.trend?.trendBias)}`,
    `板块相对强弱20D: ${fmt(s?.sectorTrend?.relativeStrength20d, "%")}`,
    `四象限定位: ${fmt(STATE.lastResult?.signal?.opportunityType)}`,
    "",
    "[估值分析(雪球数据 + 研报/年报/调研材料深读)]",
    STATE.lastResult.analysis || "",
    "",
    "[材料来源URL（前20条）]",
    ...((STATE.lastResult?.researchMaterials?.items || [])
      .slice(0, 20)
      .map((item, idx) => `${idx + 1}. ${item.finalUrl || item.url || "N/A"}`)),
    "",
    "[本地缓存材料摘录（前12条）]",
    ...((STATE.lastResult?.researchMaterials?.items || [])
      .slice(0, 12)
      .map((item, idx) => {
        const excerpt = String(item?.localText || item?.previewText || item?.snippet || "N/A");
        return `#${idx + 1} ${item?.title || "N/A"}\nURL: ${item?.finalUrl || item?.url || "N/A"}\n摘录: ${excerpt}`;
      })),
  ].join("\n");

  const filename = `${symbol}-material-valuation-analysis-${timestamp}.txt`;
  downloadText(filename, text);
  setStatus("已导出 TXT", "#166534");
}

function handleLeftClick(event) {
  if (event.button !== 0) return;
  if (!STATE.clickTriggerEnabled) return;

  const symbol = extractSymbolFromUrl();
  if (!symbol) return;

  ensurePanel();

  if (STATE.panel && STATE.panel.contains(event.target)) {
    return;
  }

  const now = Date.now();
  if (now - STATE.lastTriggerAt < STATE.triggerIntervalMs) {
    return;
  }
  STATE.lastTriggerAt = now;

  startAnalysis({ forceRefresh: false, trigger: "左键点击", skipLlm: true, materialSearch: false });
}

async function init() {
  const symbol = extractSymbolFromUrl();
  await loadUiPrefs();
  ensureUiStyles();
  applyThemeToElements(STATE.uiTheme);

  if (isTargetFullPrefetchPage() && isAutoPrefetchRequestedByUrl() && !STATE.batchAutoStarted) {
    STATE.batchAutoStarted = true;
    clearAutoPrefetchFlagFromUrl();
    setTimeout(() => {
      runManualFullPrefetch();
    }, 220);
  }

  if (!symbol) return;
  ensurePanel();
  applyThemeToElements(STATE.uiTheme);
  setStatus(`已识别股票 ${symbol}，正在加载雪球指标...`);
  if (!STATE.autoPreviewStarted) {
    STATE.autoPreviewStarted = true;
    setTimeout(() => {
      startAnalysis({ forceRefresh: false, trigger: "自动预览", skipLlm: true, materialSearch: false });
    }, 120);
  }
}

init();
