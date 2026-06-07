import React, { useState, useEffect, useCallback } from "react";
import { createRoot } from "react-dom/client";

// ── Types ─────────────────────────────────────────────────────────────────────

interface Position {
  mint: string;
  name: string;
  symbol: string;
  buyPriceUsd: number;
  amountTokens: string;
  tpPercent: number;
  slPercent: number;
  solSpent: number;
  openedAt: string;
  currentPriceUsd: number | null;
  pnlPercent: number | null;
}

interface DashboardState {
  positions: Position[];
  walletBalance: number;
  updatedAt: string | null;
}

interface Trade {
  date: string;
  mint: string;
  name: string;
  symbol: string;
  action: string;
  amountSOL: string;
  priceUSD: string;
  txid: string;
  pnlSOL: string;
}

declare global {
  interface Window {
    api: {
      getState(): Promise<DashboardState>;
      getTrades(): Promise<Trade[]>;
      startBot(): Promise<{ success: boolean; reason?: string }>;
      stopBot(): Promise<{ success: boolean; reason?: string }>;
      getBotStatus(): Promise<{ running: boolean; pid: number | null }>;
      getLogs(): Promise<string[]>;
      getPositions(): Promise<Position[]>;
      closeAllPositions(): Promise<{ success: boolean }>;
    };
  }
}

// ── Styles ────────────────────────────────────────────────────────────────────

const C = {
  bg: "#0f1117",
  surface: "#1a1d27",
  surface2: "#1e2235",
  border: "#2d3148",
  muted: "#64748b",
  text: "#cbd5e1",
  heading: "#e2e8f0",
  purple: "#a78bfa",
  green: "#34d399",
  red: "#f43f5e",
  yellow: "#fbbf24",
  greenBg: "#064e3b",
  redBg: "#4c0519",
} as const;

const S: Record<string, React.CSSProperties> = {
  app: { background: C.bg, color: C.heading, minHeight: "100vh", display: "flex", flexDirection: "column", fontFamily: "-apple-system, BlinkMacSystemFont, 'Segoe UI', sans-serif" },
  header: { background: C.surface, padding: "14px 24px", display: "flex", alignItems: "center", justifyContent: "space-between", borderBottom: `1px solid ${C.border}`, flexShrink: 0 },
  headerTitle: { fontSize: "16px", fontWeight: 700, color: C.purple, letterSpacing: "0.02em" },
  headerRight: { display: "flex", alignItems: "center", gap: "16px" },
  dot: { width: 8, height: 8, borderRadius: "50%", background: C.green, display: "inline-block", boxShadow: `0 0 6px ${C.green}` },
  lastUpdate: { fontSize: "11px", color: C.muted },
  botControl: { background: C.surface, border: `1px solid ${C.border}`, borderRadius: "8px", padding: "14px 20px", display: "flex", alignItems: "center", gap: "14px", marginBottom: "16px" },
  console: { background: "#0a0c10", border: `1px solid ${C.border}`, borderRadius: "8px", padding: "16px", fontFamily: "monospace", fontSize: "12px", lineHeight: "1.6", height: "calc(100vh - 160px)", overflowY: "auto" as const, display: "flex", flexDirection: "column" as const, gap: "2px" },
  tabBar: { display: "flex", gap: "2px", padding: "12px 24px 0", borderBottom: `1px solid ${C.border}`, background: C.surface, flexShrink: 0 },
  content: { padding: "24px", flex: 1, overflow: "auto" },
  grid4: { display: "grid", gridTemplateColumns: "repeat(4, 1fr)", gap: "14px", marginBottom: "14px" },
  card: { background: C.surface, border: `1px solid ${C.border}`, borderRadius: "8px", padding: "18px 20px" },
  cardLabel: { fontSize: "11px", color: C.muted, marginBottom: "6px", textTransform: "uppercase", letterSpacing: "0.07em" } as React.CSSProperties,
  cardValue: { fontSize: "22px", fontWeight: 700, color: C.heading },
  cardSub: { fontSize: "11px", color: C.muted, marginTop: "4px" },
  tableWrap: { background: C.surface, border: `1px solid ${C.border}`, borderRadius: "8px", overflow: "hidden" },
  table: { width: "100%", borderCollapse: "collapse", fontSize: "13px" } as React.CSSProperties,
  th: { textAlign: "left", padding: "10px 16px", borderBottom: `1px solid ${C.border}`, color: C.muted, fontWeight: 500, fontSize: "11px", textTransform: "uppercase", letterSpacing: "0.07em" } as React.CSSProperties,
  td: { padding: "10px 16px", borderBottom: `1px solid ${C.border}`, color: C.text, verticalAlign: "middle" },
  tdMono: { padding: "10px 16px", borderBottom: `1px solid ${C.border}`, color: C.muted, fontFamily: "monospace", fontSize: "11px", verticalAlign: "middle" },
  empty: { padding: "60px 24px", textAlign: "center", color: C.muted, fontSize: "14px" } as React.CSSProperties,
  sectionLabel: { fontSize: "11px", color: C.muted, textTransform: "uppercase", letterSpacing: "0.07em", marginBottom: "10px", marginTop: "20px" } as React.CSSProperties,
};

function tabStyle(active: boolean): React.CSSProperties {
  return {
    padding: "8px 18px",
    cursor: "pointer",
    border: "none",
    background: active ? C.purple : "transparent",
    color: active ? "#0f1117" : C.muted,
    borderRadius: "6px 6px 0 0",
    fontWeight: active ? 600 : 400,
    fontSize: "13px",
    transition: "background 0.15s",
  };
}

function pnlColor(value: number): string {
  return value >= 0 ? C.green : C.red;
}

function btnStyle(variant: "green" | "red", disabled: boolean): React.CSSProperties {
  const base: React.CSSProperties = {
    padding: "7px 18px", border: "none", borderRadius: "6px", fontWeight: 600,
    fontSize: "13px", cursor: disabled ? "not-allowed" : "pointer", opacity: disabled ? 0.5 : 1,
    transition: "opacity 0.15s",
  };
  return variant === "green"
    ? { ...base, background: C.green,  color: "#0f1117" }
    : { ...base, background: C.red,    color: "#fff"    };
}

function badgeStyle(action: string): React.CSSProperties {
  const isBuy = action === "BUY";
  return { display: "inline-block", padding: "2px 8px", borderRadius: "4px", fontSize: "11px", fontWeight: 700, background: isBuy ? C.greenBg : C.redBg, color: isBuy ? C.green : C.red };
}

// ── PnL Chart ─────────────────────────────────────────────────────────────────

function PnlChart({ trades }: { trades: Trade[] }) {
  const sells = [...trades]
    .filter(t => t.action === "SELL")
    .sort((a, b) => new Date(a.date).getTime() - new Date(b.date).getTime());

  let cum = 0;
  const points: Array<{ label: string; pnl: number }> = [{ label: "Start", pnl: 0 }];
  for (const s of sells) {
    cum += parseFloat(s.pnlSOL) || 0;
    points.push({ label: s.symbol, pnl: parseFloat(cum.toFixed(6)) });
  }

  const W = 800, H = 180;
  const PL = 64, PR = 20, PT = 16, PB = 28;
  const cW = W - PL - PR;
  const cH = H - PT - PB;

  const vals = points.map(p => p.pnl);
  const minV = Math.min(0, ...vals);
  const maxV = Math.max(0, ...vals);
  const range = maxV - minV || 0.001;

  const xp = (i: number) => PL + (points.length > 1 ? (i / (points.length - 1)) * cW : cW / 2);
  const yp = (v: number) => PT + cH - ((v - minV) / range) * cH;
  const z = yp(0);

  const lineColor = cum >= 0 ? C.green : C.red;
  const linePath = points.map((p, i) => `${i === 0 ? "M" : "L"}${xp(i).toFixed(1)},${yp(p.pnl).toFixed(1)}`).join(" ");
  const areaPath = `${linePath} L${xp(points.length - 1).toFixed(1)},${z.toFixed(1)} L${xp(0).toFixed(1)},${z.toFixed(1)}Z`;

  // 3 evenly-spaced Y ticks
  const yTicks = [minV, minV + range / 2, maxV];

  // X labels: show at most 6 evenly spaced
  const step = Math.max(1, Math.ceil((points.length - 1) / 5));
  const xLabelIdxs = new Set<number>([0, points.length - 1]);
  for (let i = step; i < points.length - 1; i += step) xLabelIdxs.add(i);

  return (
    <div style={{ ...S.card, padding: "16px 20px", marginTop: "14px" }}>
      <div style={S.cardLabel}>Cumulative PnL (SOL)</div>
      {points.length < 2 ? (
        <div style={{ textAlign: "center", color: C.muted, padding: "32px 0", fontSize: "13px" }}>
          No completed trades yet
        </div>
      ) : (
        <svg width="100%" viewBox={`0 0 ${W} ${H}`} style={{ display: "block", marginTop: 8 }}>
          {/* Grid lines + Y labels */}
          {yTicks.map((v, i) => (
            <g key={i}>
              <line x1={PL} y1={yp(v)} x2={W - PR} y2={yp(v)} stroke={C.border} strokeWidth={0.75} />
              <text x={PL - 6} y={yp(v) + 4} textAnchor="end" fill={C.muted} fontSize="10">
                {v >= 0 ? "+" : ""}{v.toFixed(4)}
              </text>
            </g>
          ))}

          {/* Zero dashed line when chart spans positive and negative */}
          {minV < 0 && maxV > 0 && (
            <line x1={PL} y1={z} x2={W - PR} y2={z} stroke={C.muted} strokeWidth={1} strokeDasharray="4,3" />
          )}

          {/* Area */}
          <path d={areaPath} fill={lineColor} opacity={0.1} />

          {/* Line */}
          <path d={linePath} fill="none" stroke={lineColor} strokeWidth={2} strokeLinejoin="round" />

          {/* Dots */}
          {points.map((p, i) => (
            <circle key={i} cx={xp(i)} cy={yp(p.pnl)} r={3.5}
              fill={p.pnl >= 0 ? C.green : C.red}
              stroke={C.surface} strokeWidth={1.5}
            />
          ))}

          {/* X labels */}
          {points.map((p, i) =>
            xLabelIdxs.has(i) ? (
              <text key={i} x={xp(i)} y={H - 4} textAnchor="middle" fill={C.muted} fontSize="9">
                {p.label}
              </text>
            ) : null
          )}
        </svg>
      )}
    </div>
  );
}

// ── Components ────────────────────────────────────────────────────────────────

function StatCard({ label, value, sub, color }: { label: string; value: string; sub?: string; color?: string }) {
  return (
    <div style={S.card}>
      <div style={S.cardLabel}>{label}</div>
      <div style={{ ...S.cardValue, ...(color ? { color } : {}) }}>{value}</div>
      {sub && <div style={S.cardSub}>{sub}</div>}
    </div>
  );
}

function BotControl({ running, loading, onStart, onStop }: {
  running: boolean;
  loading: boolean;
  onStart: () => void;
  onStop: () => void;
}) {
  return (
    <div style={S.botControl}>
      <span style={{
        width: 10, height: 10, borderRadius: "50%", flexShrink: 0,
        background: running ? C.green : C.muted,
        display: "inline-block",
        boxShadow: running ? `0 0 8px ${C.green}` : "none",
      }} />
      <span style={{ flex: 1, fontWeight: 600, color: C.heading }}>
        {running ? "Bot działa" : "Bot zatrzymany"}
      </span>
      {running ? (
        <button style={btnStyle("red", loading)} disabled={loading} onClick={onStop}>
          {loading ? "Zatrzymywanie…" : "⏹ Stop Bot"}
        </button>
      ) : (
        <button style={btnStyle("green", loading)} disabled={loading} onClick={onStart}>
          {loading ? "Uruchamianie…" : "▶ Start Bot"}
        </button>
      )}
    </div>
  );
}

function OverviewTab({ state, trades, botRunning, botLoading, onStart, onStop }: {
  state: DashboardState; trades: Trade[];
  botRunning: boolean; botLoading: boolean;
  onStart: () => void; onStop: () => void;
}) {
  const sells = trades.filter(t => t.action === "SELL");
  const buys  = trades.filter(t => t.action === "BUY");

  const totalPnl = sells.reduce((sum, t) => sum + (parseFloat(t.pnlSOL) || 0), 0);
  const wins  = sells.filter(t => parseFloat(t.pnlSOL) > 0);
  const losses = sells.filter(t => parseFloat(t.pnlSOL) <= 0);
  const winRate = sells.length > 0 ? (wins.length / sells.length) * 100 : null;

  const avgWin  = wins.length > 0  ? wins.reduce((s, t) => s + parseFloat(t.pnlSOL), 0) / wins.length   : null;
  const avgLoss = losses.length > 0 ? losses.reduce((s, t) => s + parseFloat(t.pnlSOL), 0) / losses.length : null;

  const bestTrade = sells.length > 0
    ? sells.reduce((best, t) => parseFloat(t.pnlSOL) > parseFloat(best.pnlSOL) ? t : best)
    : null;

  const todayStr = new Date().toLocaleDateString();
  const todayCount = trades.filter(t => new Date(t.date).toLocaleDateString() === todayStr).length;

  const pnlSign = (v: number) => (v >= 0 ? "+" : "") + v.toFixed(4);

  return (
    <>
      <BotControl running={botRunning} loading={botLoading} onStart={onStart} onStop={onStop} />

      {/* Primary stats */}
      <div style={S.grid4}>
        <StatCard
          label="Total PnL"
          value={`${totalPnl >= 0 ? "+" : ""}${totalPnl.toFixed(4)} SOL`}
          sub={`${sells.length} closed trade${sells.length !== 1 ? "s" : ""}`}
          color={totalPnl >= 0 ? C.green : C.red}
        />
        <StatCard
          label="Win Rate"
          value={winRate !== null ? `${winRate.toFixed(1)}%` : "—"}
          sub={`${wins.length}W / ${losses.length}L`}
        />
        <StatCard
          label="Total Trades"
          value={String(buys.length)}
          sub={`${todayCount} today`}
        />
        <StatCard
          label="Wallet Balance"
          value={`${state.walletBalance.toFixed(4)} SOL`}
          sub={state.positions.length > 0 ? `${state.positions.length} open` : "No open positions"}
        />
      </div>

      {/* Secondary stats */}
      <div style={S.grid4}>
        <StatCard
          label="Avg Win"
          value={avgWin !== null ? `${pnlSign(avgWin)} SOL` : "—"}
          color={C.green}
        />
        <StatCard
          label="Avg Loss"
          value={avgLoss !== null ? `${pnlSign(avgLoss)} SOL` : "—"}
          color={C.red}
        />
        <StatCard
          label="Best Trade"
          value={bestTrade ? `${pnlSign(parseFloat(bestTrade.pnlSOL))} SOL` : "—"}
          color={bestTrade && parseFloat(bestTrade.pnlSOL) > 0 ? C.yellow : C.muted}
          {...(bestTrade ? { sub: bestTrade.symbol } : {})}
        />
        <StatCard
          label="Open Positions"
          value={String(state.positions.length)}
          {...(state.updatedAt ? { sub: `as of ${new Date(state.updatedAt).toLocaleTimeString()}` } : {})}
        />
      </div>

      {/* PnL chart */}
      <PnlChart trades={trades} />
    </>
  );
}

function PositionsTab({ positions, botRunning, onCloseAll }: {
  positions: Position[];
  botRunning: boolean;
  onCloseAll: () => Promise<void>;
}) {
  const [closing, setClosing] = React.useState(false);

  const handleCloseAll = async () => {
    const label = botRunning ? "Sprzedać wszystkie pozycje po aktualnej cenie?" : "Wyczyścić listę pozycji? (bot zatrzymany — brak sprzedaży)";
    if (!window.confirm(label)) return;
    setClosing(true);
    try { await onCloseAll(); } finally { setClosing(false); }
  };

  if (positions.length === 0) {
    return <div style={{ ...S.tableWrap, ...S.empty }}>Brak otwartych pozycji</div>;
  }

  return (
    <div>
      <div style={{ display: "flex", justifyContent: "flex-end", marginBottom: "10px" }}>
        <button
          style={btnStyle("red", closing)}
          disabled={closing}
          onClick={() => void handleCloseAll()}
        >
          {closing ? "Zamykanie…" : "✕ Zamknij wszystkie pozycje"}
        </button>
      </div>
    <div style={S.tableWrap}>
      <table style={S.table}>
        <thead>
          <tr>
            {["Token", "Otwarto", "Cena kupna", "Cena bieżąca", "PnL %", "TP", "SL", "SOL"].map(h => (
              <th key={h} style={S.th}>{h}</th>
            ))}
          </tr>
        </thead>
        <tbody>
          {positions.map(pos => {
            const pnl = pos.pnlPercent;
            const pnlStyle: React.CSSProperties = {
              ...S.td,
              fontWeight: 700,
              color: pnl === null ? C.muted : pnl > 0 ? C.green : pnl < 0 ? C.red : C.text,
            };
            const rowBg = pnl === null ? undefined
              : pnl > 0 ? "rgba(52,211,153,0.04)"
              : pnl < 0 ? "rgba(244,63,94,0.04)"
              : undefined;
            return (
              <tr key={pos.mint} style={rowBg ? { background: rowBg } : {}}>
                <td style={S.td}>
                  <span style={{ fontWeight: 600 }}>{pos.symbol}</span>{" "}
                  <span style={{ color: C.muted, fontSize: "12px" }}>{pos.name}</span>
                </td>
                <td style={S.tdMono}>{new Date(pos.openedAt).toLocaleTimeString()}</td>
                <td style={S.tdMono}>${pos.buyPriceUsd.toFixed(8)}</td>
                <td style={S.tdMono}>
                  {pos.currentPriceUsd !== null
                    ? <span style={{ color: pnl !== null && pnl > 0 ? C.green : pnl !== null && pnl < 0 ? C.red : C.text }}>
                        ${pos.currentPriceUsd.toFixed(8)}
                      </span>
                    : <span style={{ color: C.muted }}>—</span>}
                </td>
                <td style={pnlStyle}>
                  {pnl !== null ? `${pnl >= 0 ? "+" : ""}${pnl.toFixed(2)}%` : "—"}
                </td>
                <td style={{ ...S.td, color: C.green }}>+{pos.tpPercent}%</td>
                <td style={{ ...S.td, color: C.red }}>−{pos.slPercent}%</td>
                <td style={S.td}>{pos.solSpent.toFixed(4)}</td>
              </tr>
            );
          })}
        </tbody>
      </table>
    </div>
    </div>
  );
}

function HistoryTab({ trades }: { trades: Trade[] }) {
  if (trades.length === 0) {
    return <div style={{ ...S.tableWrap, ...S.empty }}>No trade history yet</div>;
  }
  const sorted = [...trades].reverse();
  const headers = ["Date", "Token", "Action", "Amount SOL", "Price USD", "PnL SOL", "Tx"];
  return (
    <div style={S.tableWrap}>
      <table style={S.table}>
        <thead>
          <tr>{headers.map(h => <th key={h} style={S.th}>{h}</th>)}</tr>
        </thead>
        <tbody>
          {sorted.map((t, i) => {
            const pnlRaw  = parseFloat(t.pnlSOL);
            const pnl     = t.pnlSOL && Number.isFinite(pnlRaw) ? pnlRaw : null;
            const amount  = parseFloat(t.amountSOL);
            const price   = parseFloat(t.priceUSD);
            const dateObj = new Date(t.date ?? "");
            const dateStr = t.date && !isNaN(dateObj.getTime())
              ? dateObj.toLocaleString()
              : "—";
            return (
              <tr key={i}>
                <td style={S.tdMono}>{dateStr}</td>
                <td style={S.td}><span style={{ fontWeight: 600 }}>{t.symbol || "—"}</span></td>
                <td style={S.td}><span style={badgeStyle(t.action)}>{t.action}</span></td>
                <td style={S.td}>
                  {Number.isFinite(amount) ? amount.toFixed(4) : "—"}
                </td>
                <td style={S.tdMono}>
                  {Number.isFinite(price) ? `$${price.toFixed(8)}` : "—"}
                </td>
                <td style={{ ...S.td, color: pnl !== null ? pnlColor(pnl) : C.muted, fontWeight: pnl !== null ? 600 : 400 }}>
                  {pnl !== null ? `${pnl >= 0 ? "+" : ""}${pnl.toFixed(4)}` : "—"}
                </td>
                <td style={S.tdMono}>{t.txid ? `${t.txid.slice(0, 8)}…` : "—"}</td>
              </tr>
            );
          })}
        </tbody>
      </table>
    </div>
  );
}

// ── Console tab ───────────────────────────────────────────────────────────────

function logColor(line: string): string {
  if (line.includes("[BUY]") || line.includes("[BOUGHT]"))  return C.green;
  if (line.includes("[PROFIT]"))                            return C.green;
  if (line.includes("[LOSS]") || line.includes("[ERROR]"))  return C.red;
  if (line.includes("[SKIP]"))                              return C.muted;
  if (line.includes("[SELL]"))                              return C.yellow;
  return C.text;
}

function ConsoleTab({ logs }: { logs: string[] }) {
  const bottomRef = React.useRef<HTMLDivElement>(null);

  useEffect(() => {
    bottomRef.current?.scrollIntoView({ behavior: "smooth" });
  }, [logs]);

  return (
    <div style={S.console}>
      {logs.length === 0 ? (
        <span style={{ color: C.muted, alignSelf: "center", marginTop: "40px" }}>
          Brak logów — uruchom bota przyciskiem Start Bot
        </span>
      ) : (
        logs.map((line, i) => (
          <span key={i} style={{ color: logColor(line), whiteSpace: "pre-wrap", wordBreak: "break-all" }}>
            {line}
          </span>
        ))
      )}
      <div ref={bottomRef} />
    </div>
  );
}

// ── App ───────────────────────────────────────────────────────────────────────

type TabId = "overview" | "positions" | "history" | "console";

const TABS: Array<{ id: TabId; label: (s: DashboardState, t: Trade[], l: string[], p: Position[]) => string }> = [
  { id: "overview",  label: () => "Overview" },
  { id: "positions", label: (_, __, ___, p) => `Open Positions (${p.length})` },
  { id: "history",   label: (_, t) => `Trade History (${t.length})` },
  { id: "console",   label: (_, __, l) => `Konsola (${l.length})` },
];

function App() {
  const [tab, setTab] = useState<TabId>("overview");
  const [state, setState] = useState<DashboardState>({ positions: [], walletBalance: 0, updatedAt: null });
  const [trades, setTrades] = useState<Trade[]>([]);
  const [lastRefresh, setLastRefresh] = useState<Date | null>(null);
  const [botRunning, setBotRunning] = useState(false);
  const [botLoading, setBotLoading] = useState(false);
  const [logs, setLogs] = useState<string[]>([]);
  const [positions, setPositions] = useState<Position[]>([]);

  const refresh = useCallback(async () => {
    try {
      const [s, t, status, newLogs, newPositions] = await Promise.all([
        window.api.getState(),
        window.api.getTrades(),
        window.api.getBotStatus(),
        window.api.getLogs(),
        window.api.getPositions(),
      ]);
      setState(s);
      setTrades(t);
      setBotRunning(status.running);
      setLogs(newLogs);
      setPositions(newPositions);
      setLastRefresh(new Date());
    } catch (err) {
      console.error("Refresh failed:", err);
    }
  }, []);

  useEffect(() => {
    void refresh();
    const id = setInterval(() => void refresh(), 5_000);
    return () => clearInterval(id);
  }, [refresh]);

  const handleStart = useCallback(async () => {
    setBotLoading(true);
    try { await window.api.startBot(); } finally { setBotLoading(false); void refresh(); }
  }, [refresh]);

  const handleStop = useCallback(async () => {
    setBotLoading(true);
    try { await window.api.stopBot(); } finally { setBotLoading(false); void refresh(); }
  }, [refresh]);

  const handleCloseAll = useCallback(async () => {
    await window.api.closeAllPositions();
    void refresh();
  }, [refresh]);

  const dotColor = botRunning ? C.green : C.muted;

  return (
    <div style={S.app}>
      <header style={S.header}>
        <span style={S.headerTitle}>⬡ Trading Bot Dashboard</span>
        <div style={S.headerRight}>
          <span style={{ ...S.dot, background: dotColor, boxShadow: botRunning ? `0 0 6px ${dotColor}` : "none" }} />
          <span style={{ fontSize: "12px", fontWeight: 600, color: dotColor }}>
            {botRunning ? "RUNNING" : "STOPPED"}
          </span>
          <span style={{ color: C.border }}>|</span>
          <span style={S.lastUpdate}>
            {lastRefresh ? `Updated ${lastRefresh.toLocaleTimeString()}` : "Connecting…"}
          </span>
        </div>
      </header>

      <nav style={S.tabBar}>
        {TABS.map(t => (
          <button key={t.id} style={tabStyle(tab === t.id)} onClick={() => setTab(t.id)}>
            {t.label(state, trades, logs, positions)}
          </button>
        ))}
      </nav>

      <main style={S.content}>
        {tab === "overview"  && (
          <OverviewTab state={state} trades={trades}
            botRunning={botRunning} botLoading={botLoading}
            onStart={handleStart} onStop={handleStop}
          />
        )}
        {tab === "positions" && <PositionsTab positions={positions} botRunning={botRunning} onCloseAll={handleCloseAll} />}
        {tab === "history"   && <HistoryTab trades={trades} />}
        {tab === "console"   && <ConsoleTab logs={logs} />}
      </main>
    </div>
  );
}

const container = document.getElementById("root");
if (container) createRoot(container).render(<App />);
