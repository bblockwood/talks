// Phone remote entry (SPEC §7): enter the talk code, optionally remember it on this phone, or
// arrive by a `#c=<code>` link. The hash is never sent to any server.
import { normalizeCode } from "../core/code";
import { DeckError, openDeck } from "../shared/deck";
import { NetworkError, NoTalkError, fetchDeck } from "../shared/fetch-deck";
import { RemoteConsole } from "./console";
import { forget, loadSaved, remember } from "./saved";

const $ = <T extends HTMLElement = HTMLElement>(id: string): T => {
  const el = document.getElementById(id);
  if (!el) throw new Error(`missing #${id}`);
  return el as T;
};

const entry = $("entry");
const chooser = $("chooser");
const consoleEl = $("console");
const status = $("status");
const codeInput = $<HTMLInputElement>("code");
const rememberBox = $<HTMLInputElement>("remember");

let active: RemoteConsole | null = null;
let busy = false;

function setStatus(text: string, error = false): void {
  status.textContent = text;
  status.classList.toggle("error", error);
}

function showSaved(): void {
  const box = $("saved");
  const talks = loadSaved();
  box.replaceChildren();
  box.hidden = talks.length === 0;
  if (talks.length === 0) return;
  const heading = document.createElement("h2");
  heading.textContent = "Saved on this phone";
  box.append(heading);
  for (const talk of talks) {
    const row = document.createElement("div");
    row.className = "saved-row";
    const open = document.createElement("button");
    open.className = "talk";
    const title = document.createElement("span");
    title.textContent = talk.title;
    const code = document.createElement("small");
    code.textContent = talk.code;
    open.append(title, code);
    open.addEventListener("click", () => void openTalk(talk.code, true));
    const drop = document.createElement("button");
    drop.textContent = "Forget";
    drop.addEventListener("click", () => {
      forget(talk.code);
      showSaved();
    });
    row.append(open, drop);
    box.append(row);
  }
}

function showEntry(message = "", error = false): void {
  active?.destroy();
  active = null;
  consoleEl.hidden = true;
  entry.hidden = false;
  chooser.hidden = false;
  showSaved();
  setStatus(message, error);
}

async function openTalk(rawCode: string, keep: boolean): Promise<void> {
  const code = normalizeCode(rawCode);
  if (busy || code === "") return;
  busy = true;
  chooser.hidden = true;
  try {
    const { payload, keys } = await fetchDeck(code, import.meta.env.BASE_URL, (step) =>
      setStatus(step === "unlocking" ? "Unlocking…" : "Loading slides…"),
    );
    setStatus("Opening slides…");
    const deck = await openDeck(payload.pdf.slice().buffer);
    if (keep) remember(code, payload.meta.title || code);

    active?.destroy();
    setStatus("");
    codeInput.value = "";
    entry.hidden = true;
    consoleEl.hidden = false;
    active = new RemoteConsole({
      deck,
      payload,
      keys,
      onLeave: () => showEntry(),
      // The code stays in this closure, in memory, only so a republished deck can be fetched again.
      onReload: () => {
        showEntry();
        void openTalk(code, false);
      },
    });
  } catch (e) {
    if (e instanceof NoTalkError) showEntry("No talk found for that code.", true);
    else if (e instanceof NetworkError) showEntry("Could not reach the server. Check the connection and try again.", true);
    else if (e instanceof DeckError) showEntry(e.message, true);
    else showEntry("Something went wrong opening that talk. Try again.", true);
  } finally {
    busy = false;
  }
}

$<HTMLFormElement>("code-form").addEventListener("submit", (ev) => {
  ev.preventDefault();
  if (codeInput.value.trim() === "") codeInput.focus();
  else void openTalk(codeInput.value, rememberBox.checked);
});

$("boot").remove();
if (typeof crypto === "undefined" || !crypto.subtle || typeof ResizeObserver === "undefined") {
  setStatus("This browser is too old to use the remote. Update it, or use another phone.", true);
} else {
  showEntry();
  // Deep link: …/remote#c=<code>. Taken out of the address bar at once so it isn't left on screen.
  const linked = /^#c=(.+)$/.exec(window.location.hash)?.[1];
  if (linked) {
    history.replaceState(null, "", window.location.pathname);
    void openTalk(decodeURIComponent(linked), false);
  }
}
