import React, { useCallback, useEffect, useState } from "react";
import fs from "node:fs";
import ShelfLink from "./components/ShelfLink.jsx";
import Console from "./pages/Console.jsx";
import Diagram from "./pages/Diagram.jsx";
import Settings from "./pages/Settings.jsx";
import TopMenu, { applyFontSize } from "./top-menu/TopMenu.jsx";
import { get, post } from "./lib/api.js";

const VERSION = (() => { try { return JSON.parse(fs.readFileSync(new URL("../../package.json", import.meta.url), "utf8")).version || null; } catch { return null; } })();

const PAGES = [["console", "Console"], ["settings", "Settings"], ["diagram", "How it fits"]];
const store = {
  read(k) { try { return localStorage.getItem(k); } catch { return null; } },
  write(k, v) { try { localStorage.setItem(k, v); } catch { /* storage may be blocked */ } },
};
const UNVERIFIED = "The request and response shapes follow an earlier internal integration and are UNVERIFIED against PingOne's documentation.";

// The banner says the same mode as the header toggle, on every page and in presenter mode.
export function bannerText(mode, liveConfigured) {
  if (mode === "mock") return `MOCK mode, simulated. The built-in Mock engine answers inside this app. It is not PingOne Authorize, and nothing leaves this machine. ${UNVERIFIED}`;
  if (liveConfigured === null) return "LIVE mode. Checking whether Live is set up. Nothing is sent until it is.";
  if (!liveConfigured) return "LIVE mode, not set up. Nothing is sent: open Settings to connect your own PingOne environment or an on-prem PingAuthorize. No call leaves this machine until you do.";
  return `LIVE mode, owner-run. Decisions go only to the PingOne hosts for your region, or the PingAuthorize URL you set up on Settings, and to no other host. The answers are real. ${UNVERIFIED}`;
}

export default function App() {
  const [mode, setModeState] = useState("mock");
  const [liveConfigured, setLiveConfigured] = useState(null); // null = not known yet
  const [modeInfo, setModeInfo] = useState(null);
  const [switching, setSwitching] = useState(false);
  const [page, setPage] = useState(() => (PAGES.some(([id]) => id === window.location.hash.slice(1)) ? window.location.hash.slice(1) : "console"));
  const [theme, setTheme] = useState(() => store.read("p1az-theme") || "system");
  const [fontStep, setFontStep] = useState(() => { const f = store.read("p1az.font"); return ["S", "M", "L"].includes(f) ? f : "M"; });
  useEffect(() => { applyFontSize(fontStep); store.write("p1az.font", fontStep); }, [fontStep]);
  const [presenter, setPresenter] = useState(false);
  const [epoch, setEpoch] = useState(0); // bumped by Reset: remounts the pages, so the diagram boxes and form fields start over
  const [resetNote, setResetNote] = useState("");

  const loadConfig = useCallback(() => { get("/api/config").then((r) => setLiveConfigured(r.ok ? Boolean(r.data.liveConfigured) : false)); }, []);
  useEffect(() => { loadConfig(); }, [loadConfig]);
  // Rule 19: the Mock/Real toggle is server-side. /api/info is fetched once and after every switch; switching reloads the pages.
  const loadInfo = useCallback(() => {
    get("/api/info").then((r) => {
      if (r.ok) { setModeInfo(r.data); setModeState(r.data.source === "real" ? "live" : "mock"); }
    }).catch(() => {});
  }, []);
  useEffect(() => { loadInfo(); }, [loadInfo]);
  const setMode = async (m) => {
    const target = m === "real" ? "live" : m;
    if (switching || target === mode) return;
    if (target === "live" && modeInfo?.realAvailable === false) return; // Real is disabled with the reason; the button is too
    setSwitching(true);
    const r = await post("/api/mode", { source: target === "live" ? "real" : "mock" });
    setSwitching(false);
    if (!r.ok) { setResetNote(`Could not switch modes: ${r.data?.message || r.data?.error || "unknown error"}`); return; }
    setModeState(target);
    loadInfo();
    setEpoch((n) => n + 1); // remount the pages, so every page reloads its data for the new mode
  };

  const reset = async () => {
    const r = await post("/api/reset");
    setEpoch((n) => n + 1);
    setResetNote(r.ok ? "Reset: call log cleared, diagram restored. Saved settings kept." : "Reset failed: could not reach the server.");
  };

  useEffect(() => {
    if (theme === "system") document.documentElement.removeAttribute("data-theme"); else document.documentElement.setAttribute("data-theme", theme);
    store.write("p1az-theme", theme);
  }, [theme]);
  useEffect(() => { window.location.hash = page; }, [page]);
  useEffect(() => { document.title = `${PAGES.find(([id]) => id === page)?.[1] || "Console"} · P1AZ Inspector LAB`; }, [page]);
  useEffect(() => {
    const on = (e) => {
      if (e.target && /^(INPUT|TEXTAREA|SELECT)$/.test(e.target.tagName)) return;
      if (e.key === "p" || e.key === "P") setPresenter((v) => !v);
      else if (e.key === "Escape") setPresenter(false);
    };
    window.addEventListener("keydown", on);
    return () => window.removeEventListener("keydown", on);
  }, []);

  const onKeyTab = (e, i) => {
    if (e.key !== "ArrowRight" && e.key !== "ArrowLeft") return;
    const next = PAGES[(i + (e.key === "ArrowRight" ? 1 : PAGES.length - 1)) % PAGES.length];
    setPage(next[0]);
    document.getElementById(`tab-${next[0]}`)?.focus();
  };

  return (
    <div className={`app${presenter ? " app--presenter" : ""}`}>
      <a className="skip" href="#main" onClick={(e) => { e.preventDefault(); document.getElementById("main")?.focus(); }}>Skip to content</a>
      <header>
        <p className="banner" role="note" data-state={mode === "live" ? "live" : "mock"} data-testid="banner">{bannerText(mode, liveConfigured)}</p>
        <div className="head">
          <h1 className="head__title">P1AZ Inspector LAB</h1>
          <div className="head__tools">
            <TopMenu
              mode={{ value: mode === "live" ? "real" : "mock", onChange: setMode, realAvailable: modeInfo ? modeInfo.realAvailable : null, realHint: modeInfo?.realReason }}
              theme={{ value: theme, onChange: setTheme }}
              fontSize={{ value: fontStep, onChange: setFontStep }}
              present={{ active: presenter, onToggle: () => setPresenter((v) => !v), label: "Presenter (P)" }}
              shelfUrl="https://local.ping-devops.com:8443/"
              help={{ href: "https://github.com/curtismu7/p1az-inspector-LAB#readme" }}
              version={VERSION}
              onReset={reset}
            >
              <span className="chip" data-testid="mode">Mode: {mode}</span>
              <ShelfLink />
            </TopMenu>
          </div>
        </div>
      </header>
      <p className="sr-only" role="status">{resetNote}</p>
      <div role="tablist" aria-label="Pages" className="tabs">
        {PAGES.map(([id, label], i) => (
          <button key={id} id={`tab-${id}`} role="tab" type="button" aria-selected={page === id} tabIndex={page === id ? 0 : -1}
            onClick={() => setPage(id)} onKeyDown={(e) => onKeyTab(e, i)}>{label}</button>
        ))}
      </div>
      <main id="main" tabIndex={-1} key={epoch}>
        <div role="tabpanel" aria-labelledby={`tab-${page}`}>
          {page === "console" && <Console mode={mode} goSettings={() => setPage("settings")} />}
          {page === "settings" && <Settings onSaved={() => { loadConfig(); loadInfo(); }} />}
          {page === "diagram" && <Diagram theme={theme} />}
        </div>
      </main>
    </div>
  );
}
