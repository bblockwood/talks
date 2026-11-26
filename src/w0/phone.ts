// W0 throwaway: phone side of the relay echo test (SPEC §10 W0).
import { connectRelay, roomIdFromPairing } from "./relay";
import type { RelayHandle } from "./relay";

const $ = <T extends HTMLElement = HTMLElement>(id: string): T => {
  const el = document.getElementById(id);
  if (!el) throw new Error(`missing #${id}`);
  return el as T;
};
const set = (id: string, text: string, state: "ok" | "bad" | "" = ""): void => {
  const el = $(id);
  el.textContent = text;
  el.classList.toggle("ok", state === "ok");
  el.classList.toggle("bad", state === "bad");
};

const PING_EVERY_MS = 1000;
const ROOM_TIMEOUT_MS = 4000;

let relay: RelayHandle | null = null;
let rtts: number[] = [];
let lastPong = -Infinity;
let reportText = "";

function showRtt(): void {
  if (rtts.length === 0) {
    set("p-rtt", "–");
    return;
  }
  const sorted = [...rtts].sort((a, b) => a - b);
  const median = sorted[Math.floor(sorted.length / 2)] ?? 0;
  const last = rtts.at(-1) ?? 0;
  set(
    "p-rtt",
    `last ${last.toFixed(0)} ms · median ${median.toFixed(0)} ms · max ${(sorted.at(-1) ?? 0).toFixed(0)} ms · n=${rtts.length}`,
    median < 150 ? "ok" : "bad",
  );
}

async function connect(digits: string): Promise<void> {
  $("pair").hidden = true;
  $("live").hidden = false;
  const roomId = await roomIdFromPairing(digits);

  const handle = connectRelay(
    roomId,
    (msg) => {
      if (msg.type === "pong") {
        lastPong = performance.now();
        rtts.push(lastPong - msg.t);
        if (rtts.length > 600) rtts = rtts.slice(-600);
        showRtt();
        set("p-room", "connected", "ok");
      } else if (msg.type === "hello" && msg.from === "room") {
        set("p-room", "connected", "ok");
      } else if (msg.type === "state") {
        set("p-slide", `${msg.page} of ${msg.pageCount}`);
      } else if (msg.type === "report") {
        reportText = msg.text;
        $("p-report").textContent = reportText;
        set("p-report-status", `Received at ${new Date().toLocaleTimeString()}.`, "ok");
        $<HTMLButtonElement>("p-copy").disabled = false;
        $<HTMLButtonElement>("p-share").disabled = typeof navigator.share !== "function";
      }
    },
    (status, detail) => {
      set("p-relay", `${status}${detail ? ` (${detail})` : ""}`, status === "connected" ? "ok" : status === "connecting" ? "" : "bad");
      if (status === "connected") handle.send({ type: "hello", from: "phone" });
    },
  );
  relay = handle;

  window.setInterval(() => {
    handle.send({ type: "ping", t: performance.now() });
    if (performance.now() - lastPong > ROOM_TIMEOUT_MS && lastPong > -Infinity) {
      set("p-room", "no answer (is the room PC page still open?)", "bad");
    }
  }, PING_EVERY_MS);

  void requestWakeLock();
}

async function requestWakeLock(): Promise<void> {
  if (!("wakeLock" in navigator)) {
    set("p-wakelock", "not supported", "bad");
    return;
  }
  try {
    const lock = await navigator.wakeLock.request("screen");
    set("p-wakelock", "held", "ok");
    lock.addEventListener("release", () => set("p-wakelock", "released"));
  } catch (e) {
    set("p-wakelock", `refused: ${e instanceof Error ? e.message : String(e)}`, "bad");
  }
}

document.addEventListener("visibilitychange", () => {
  if (relay && document.visibilityState === "visible") void requestWakeLock();
});

const digitsInput = $<HTMLInputElement>("digits");
const tryConnect = (): void => {
  const digits = digitsInput.value.replace(/\D/g, "");
  if (digits.length === 6) void connect(digits);
  else digitsInput.focus();
};
$("connect").addEventListener("click", tryConnect);
digitsInput.addEventListener("keydown", (ev) => {
  if (ev.key === "Enter") tryConnect();
});

$("next").addEventListener("click", () => relay?.send({ type: "command", name: "next" }));
$("prev").addEventListener("click", () => relay?.send({ type: "command", name: "prev" }));
$("reset-rtt").addEventListener("click", () => {
  rtts = [];
  showRtt();
});

$("p-copy").addEventListener("click", async () => {
  try {
    await navigator.clipboard.writeText(reportText);
    set("p-copied", "copied");
  } catch {
    set("p-copied", "copy failed: select the text below and copy it by hand", "bad");
  }
});
$("p-share").addEventListener("click", () => {
  void navigator.share({ title: "Lectern W0 report", text: reportText }).catch(() => {});
});
