import { useEffect, useMemo, useRef, useState } from "react";
import { createFeed, deployment, explorer, usdc } from "./chain.js";

const POLL_MS = 1500;
const SETTLED_EDGE_MS = 5000; // how long a finished job stays drawn on the map
const MAX_JOBS_SHOWN = 14;
const MAX_EVENTS_SHOWN = 40;

// ---------------------------------------------------------------- data hooks

function useFeed() {
  const feed = useMemo(() => createFeed(), []);
  const [, setTick] = useState(0);
  const [error, setError] = useState(null);
  const [loaded, setLoaded] = useState(false);
  useEffect(() => {
    let alive = true;
    const loop = async () => {
      try {
        await feed.refresh();
        setError(null);
        setLoaded(true);
      } catch (e) {
        setError(e.shortMessage || e.message);
      }
      if (alive) {
        setTick((t) => t + 1);
        setTimeout(loop, POLL_MS);
      }
    };
    loop();
    return () => {
      alive = false;
    };
  }, [feed]);
  return { state: feed.state, error, loaded };
}

function useNow(ms = 100) {
  const [now, setNow] = useState(Date.now() / 1000);
  useEffect(() => {
    const id = setInterval(() => setNow(Date.now() / 1000), ms);
    return () => clearInterval(id);
  }, [ms]);
  return now;
}

/// Remembers when each job was first seen settled, so the map can flash it briefly.
/// Jobs already settled on the first load count as old and are not flashed.
function useSettleTimes(jobs, loaded) {
  const seen = useRef(null);
  if (loaded && seen.current === null) {
    seen.current = new Map(jobs.filter((j) => isSettled(j)).map((j) => [j.id, 0]));
  }
  if (seen.current) {
    for (const j of jobs) if (isSettled(j) && !seen.current.has(j.id)) seen.current.set(j.id, Date.now());
  }
  return seen.current ?? new Map();
}

// ---------------------------------------------------------------- helpers

const isSettled = (j) => j.status === "paid" || j.status === "slashed";
const fmt = (n, d = 3) => n.toLocaleString("en-US", { minimumFractionDigits: d, maximumFractionDigits: d });
const short = (h) => `${h.slice(0, 6)}…${h.slice(-4)}`;
const band = (s) => (s >= 70 ? "good" : s >= 40 ? "warn" : "bad");
const BAND_LABEL = { good: "trusted", warn: "unproven", bad: "untrusted" };

function accruedOf(job, now) {
  const end = job.stoppedAt ?? Math.min(now, job.maxEnd);
  return usdc(job.rate) * Math.max(0, end - job.start);
}

function TxLink({ hash, children }) {
  if (!hash) return null;
  if (!explorer) return <span className="mono faint">{children ?? short(hash)}</span>;
  return (
    <a className="mono" href={`${explorer}/tx/${hash}`} target="_blank" rel="noreferrer">
      {children ?? short(hash)} ↗
    </a>
  );
}

const STATUS = {
  streaming: { label: "Streaming", icon: "●", cls: "live" },
  verifying: { label: "Verifying", icon: "◐", cls: "warn" },
  paid: { label: "Paid", icon: "✓", cls: "good" },
  slashed: { label: "Slashed", icon: "✗", cls: "bad" },
};

function StatusPill({ status }) {
  const s = STATUS[status];
  return (
    <span className={`pill ${s.cls}`}>
      <span aria-hidden="true">{s.icon}</span> {s.label}
    </span>
  );
}

// ---------------------------------------------------------------- market map

const W = 760;
const H = 520;
const CX = W / 2;
const CY = H / 2 + 6;
const RX = 290;
const RY = 190;
const NODE_R = 30;

function layout(agents) {
  const n = agents.length;
  const pos = {};
  agents.forEach((a, i) => {
    const t = (i / n) * 2 * Math.PI - Math.PI / 2;
    pos[a.id] = { x: CX + RX * Math.cos(t), y: CY + RY * Math.sin(t), ux: Math.cos(t), uy: Math.sin(t) };
  });
  return pos;
}

/// Curved path from client to worker, bowed toward the centre so parallel jobs don't overlap.
function edgePath(a, b, bend = 0.18, t = 0.68) {
  const mx = (a.x + b.x) / 2;
  const my = (a.y + b.y) / 2;
  const qx = mx + (CX - mx) * bend * 2;
  const qy = my + (CY - my) * bend * 2;
  // shorten to stop at node rims
  const trim = (p, q) => {
    const dx = q.x - p.x;
    const dy = q.y - p.y;
    const d = Math.hypot(dx, dy) || 1;
    return { x: p.x + (dx / d) * (NODE_R + 6), y: p.y + (dy / d) * (NODE_R + 6) };
  };
  const s = trim(a, { x: qx, y: qy });
  const e = trim(b, { x: qx, y: qy });
  const at = (p0, p1, p2) => (1 - t) ** 2 * p0 + 2 * (1 - t) * t * p1 + t ** 2 * p2;
  return { d: `M${s.x},${s.y} Q${qx},${qy} ${e.x},${e.y}`, label: { x: at(s.x, qx, e.x), y: at(s.y, qy, e.y) } };
}

function MarketMap({ agents, jobs, settleTimes, now, onHover, hovered }) {
  const pos = layout(agents);
  const nowMs = now * 1000;
  const visible = jobs.filter((j) => {
    if (!pos[j.client] || !pos[j.worker]) return false;
    if (!isSettled(j)) return true;
    const t = settleTimes.get(j.id);
    return t && nowMs - t < SETTLED_EDGE_MS;
  });

  return (
    <svg className="map" viewBox={`0 0 ${W} ${H}`} role="img" aria-label="Live market: agents and the jobs streaming between them">
      <defs>
        <marker id="arrow" viewBox="0 0 10 10" refX="8" refY="5" markerWidth="7" markerHeight="7" orient="auto-start-reverse">
          <path d="M0,0 L10,5 L0,10 z" className="arrowhead" />
        </marker>
      </defs>

      {visible.map((j, i) => {
        const { d, label } = edgePath(pos[j.client], pos[j.worker], 0.12 + (i % 3) * 0.06, 0.5 + (i % 3) * 0.12);
        const s = j.status;
        const amount = accruedOf(j, now);
        const fade = isSettled(j) ? Math.max(0, 1 - (nowMs - settleTimes.get(j.id)) / SETTLED_EDGE_MS) : 1;
        return (
          <g key={String(j.id)} className={`edge ${s}`} style={{ opacity: 0.25 + 0.75 * fade }}>
            <path d={d} className="edge-line" markerEnd="url(#arrow)" />
            {s === "streaming" &&
              [0, 0.33, 0.66].map((off) => (
                <circle key={off} r="3.5" className="coin">
                  <animateMotion dur="1.4s" repeatCount="indefinite" path={d} begin={`${off * 1.4}s`} />
                </circle>
              ))}
            <g transform={`translate(${label.x},${label.y})`}>
              <rect x="-46" y="-13" width="92" height="26" rx="13" className="edge-tag" />
              <text className="edge-text" textAnchor="middle" y="4.5">
                {s === "slashed" ? "✗ slashed" : s === "paid" ? `✓ +${fmt(usdc(j.paid ?? 0n))}` : s === "verifying" ? `◐ ${fmt(amount)}` : fmt(amount)}
              </text>
            </g>
          </g>
        );
      })}

      {agents.map((a) => {
        const p = pos[a.id];
        const score = a.score ?? 50;
        const b = band(score);
        const circ = 2 * Math.PI * (NODE_R + 4);
        const busy = jobs.some((j) => j.worker === a.id && j.status === "streaming");
        return (
          <g
            key={String(a.id)}
            className={`node ${b} ${hovered === a.id ? "hover" : ""} ${busy ? "busy" : ""}`}
            transform={`translate(${p.x},${p.y})`}
            onMouseEnter={() => onHover(a.id)}
            onMouseLeave={() => onHover(null)}
          >
            <circle r={NODE_R + 14} className="hit" />
            {busy && (
              <circle r={NODE_R + 4} className="halo">
                <animate attributeName="r" from={NODE_R + 4} to={NODE_R + 18} dur="1.4s" repeatCount="indefinite" />
                <animate attributeName="opacity" from="0.8" to="0" dur="1.4s" repeatCount="indefinite" />
              </circle>
            )}
            <circle r={NODE_R + 4} className="ring-bg" />
            <circle r={NODE_R + 4} className="ring" strokeDasharray={circ} strokeDashoffset={circ * (1 - score / 100)} transform="rotate(-90)" />
            <circle r={NODE_R - 2} className="core" />
            <text className="node-score" textAnchor="middle" y="6">
              {score}
            </text>
            <text
              className="node-name"
              textAnchor={p.ux > 0.3 ? "start" : p.ux < -0.3 ? "end" : "middle"}
              x={p.ux * (NODE_R + 14)}
              y={p.uy * (NODE_R + 14) + (p.uy > 0.3 ? 14 : p.uy < -0.3 ? -4 : 5)}
            >
              {a.name}
            </text>
          </g>
        );
      })}
    </svg>
  );
}

function AgentTooltip({ agent }) {
  if (!agent) return null;
  const b = band(agent.score ?? 50);
  return (
    <div className="tooltip" role="tooltip">
      <div className="tt-head">
        <strong>{agent.name}</strong>
        <span className="mono faint">#{String(agent.id)}</span>
        <span className={`pill ${b}`}>{BAND_LABEL[b]}</span>
      </div>
      <p className="muted">{agent.description}</p>
      <dl className="tt-kv">
        <dt>Reputation</dt>
        <dd className="mono">{agent.score ?? 50}/100</dd>
        <dt>Price</dt>
        <dd className="mono">{agent.pricing?.ratePerSecond} tUSDC/s</dd>
        <dt>Skills</dt>
        <dd>{(agent.skills || []).join(", ")}</dd>
        <dt>Stake free / locked</dt>
        <dd className="mono">
          {fmt(usdc(agent.stake), 2)} / {fmt(usdc(agent.locked), 2)}
        </dd>
        <dt>Fake reviews</dt>
        <dd className="mono">{String(agent.freeReviews ?? 0)} (weight 0)</dd>
      </dl>
    </div>
  );
}

// ---------------------------------------------------------------- leaderboard

function Spark({ points }) {
  if (!points || points.length < 2) return <svg width="64" height="20" aria-hidden="true" />;
  const w = 64;
  const h = 20;
  const step = w / (points.length - 1);
  const d = points.map((p, i) => `${i ? "L" : "M"}${(i * step).toFixed(1)},${(h - 2 - (p / 100) * (h - 4)).toFixed(1)}`).join(" ");
  return (
    <svg className="spark" width={w} height={h} viewBox={`0 0 ${w} ${h}`} aria-hidden="true">
      <path d={d} />
    </svg>
  );
}

function Leaderboard({ agents, history, hovered, onHover }) {
  const rows = [...agents].sort((a, b) => (b.score ?? 50) - (a.score ?? 50) || Number(a.id - b.id));
  return (
    <ol className="board">
      {rows.map((a, i) => {
        const s = a.score ?? 50;
        const b = band(s);
        return (
          <li key={String(a.id)} className={hovered === a.id ? "hover" : ""} onMouseEnter={() => onHover(a.id)} onMouseLeave={() => onHover(null)}>
            <span className="rank mono faint">{i + 1}</span>
            <div className="who">
              <div className="who-top">
                <strong>{a.name}</strong>
                <span className="mono faint small">{a.pricing?.ratePerSecond}/s</span>
              </div>
              <div className="meter" aria-hidden="true">
                <div className={`meter-fill ${b}`} style={{ width: `${s}%` }} />
              </div>
            </div>
            <Spark points={history[a.id]} />
            <span className="score mono">{s}</span>
            <span className="jcount mono small">
              <span className="muted">{String(a.passed ?? 0)}✓</span> <span className={a.failed > 0n ? "bad-ink" : "faint"}>{String(a.failed ?? 0)}✗</span>
            </span>
          </li>
        );
      })}
    </ol>
  );
}

// ---------------------------------------------------------------- jobs table

function JobsTable({ jobs, agents, now }) {
  const [open, setOpen] = useState(null);
  const name = (id) => agents[id]?.name ?? `#${id}`;
  if (!jobs.length) return <p className="empty">No jobs yet. Start the agents and they will appear here.</p>;
  return (
    <div className="jobs" role="table" aria-label="Jobs">
      <div className="jrow jhead" role="row">
        <span>Job</span>
        <span>Client → worker</span>
        <span>Task</span>
        <span className="num">Streamed</span>
        <span>Status</span>
      </div>
      {jobs.slice(0, MAX_JOBS_SHOWN).map((j) => {
        const isOpen = open === j.id;
        return (
          <div key={String(j.id)} className={`jwrap ${isOpen ? "open" : ""}`}>
            <button className={`jrow ${j.status}`} role="row" onClick={() => setOpen(isOpen ? null : j.id)} aria-expanded={isOpen}>
              <span className="mono faint">#{String(j.id)}</span>
              <span>
                {name(j.client)} <span className="faint">→</span> <strong>{name(j.worker)}</strong>
              </span>
              <span className="muted">{j.spec.skill}</span>
              <span className={`num mono ${j.status === "slashed" ? "struck" : ""}`}>{fmt(accruedOf(j, now), 4)}</span>
              <span>
                <StatusPill status={j.status} />
              </span>
            </button>
            {isOpen && (
              <div className="jdetail">
                <p className="muted">{j.spec.title}</p>
                {j.output && <pre>{j.output}</pre>}
                {j.reason && (
                  <p className={j.status === "paid" ? "good-ink" : "bad-ink"}>
                    {j.status === "paid" ? "✓" : "✗"} {j.reason}
                    {j.status === "slashed" && ` · ${fmt(usdc(j.slashed), 2)} tUSDC stake slashed to ${name(j.client)}`}
                    {j.status === "paid" && ` · ${name(j.worker)} received ${fmt(usdc(j.paid), 4)} tUSDC`}
                  </p>
                )}
                <p className="small muted">
                  {fmt(usdc(j.rate), 3)} tUSDC/s · budget {fmt(usdc(j.budget), 2)} · stake {fmt(usdc(j.stake), 2)} · <TxLink hash={j.createdTx}>created</TxLink>{" "}
                  {j.settledTx && (
                    <>
                      · <TxLink hash={j.settledTx}>settled</TxLink>
                    </>
                  )}
                </p>
              </div>
            )}
          </div>
        );
      })}
      {jobs.length > MAX_JOBS_SHOWN && <p className="small faint more">+ {jobs.length - MAX_JOBS_SHOWN} earlier jobs</p>}
    </div>
  );
}

function eventText(e, s) {
  const n = (id) => s.agents[id]?.name ?? `#${id}`;
  const j = e.job !== undefined ? s.jobs[e.job] : null;
  switch (e.kind) {
    case "register":
      return { icon: "◆", cls: "", text: `${n(e.agent)} registered an ERC-8004 identity` };
    case "job":
      return { icon: "●", cls: "live", text: `${n(j.client)} hired ${n(j.worker)} · #${j.id}` };
    case "submit":
      return { icon: "◐", cls: "warn", text: `${n(j.worker)} submitted · stream stopped` };
    case "paid":
      return { icon: "✓", cls: "good", text: `#${j.id} verified · ${n(j.worker)} paid` };
    case "slashed":
      return { icon: "✗", cls: "bad", text: `#${j.id} failed · ${n(j.worker)} slashed` };
    case "fake":
      return { icon: "⊘", cls: "warn", text: `Free review for ${n(e.agent)} ignored` };
    default:
      return { icon: "·", cls: "", text: e.kind };
  }
}

// ---------------------------------------------------------------- page

export default function App() {
  const { state, error, loaded } = useFeed();
  const wallNow = useNow();
  const now = wallNow + state.clockOffset;
  const [hovered, setHovered] = useState(null);

  const agents = Object.values(state.agents).sort((a, b) => Number(a.id - b.id));
  const jobs = Object.values(state.jobs).sort((a, b) => Number(b.id - a.id));
  const settleTimes = useSettleTimes(jobs, loaded);

  const streamed = jobs.reduce((s, j) => (j.status === "slashed" ? s : s + accruedOf(j, now)), 0);
  const slashed = jobs.reduce((s, j) => s + (j.slashed ? usdc(j.slashed) : 0), 0);
  const live = jobs.filter((j) => j.status === "streaming").length;
  const settled = jobs.filter(isSettled).length;
  const fake = state.events.filter((e) => e.kind === "fake").length;

  return (
    <div className="page">
      <header className="top">
        <div className="brand">
          <h1>
            Trust<span>Stream</span>
          </h1>
          <p className="muted">ERC-8004 agents, paid by the second, slashed when they lie.</p>
        </div>
        <div className="kpis">
          <div className="kpi">
            <span className="kpi-label">Streamed to agents</span>
            <span className="kpi-value mono">{fmt(streamed, 3)}</span>
            <span className="kpi-unit">tUSDC</span>
          </div>
          <div className="kpi">
            <span className="kpi-label">Live · settled</span>
            <span className="kpi-value mono">
              {live}
              <span className="faint"> · {settled}</span>
            </span>
            <span className="kpi-unit">jobs</span>
          </div>
          <div className="kpi">
            <span className="kpi-label">Stake slashed</span>
            <span className="kpi-value mono">{fmt(slashed, 2)}</span>
            <span className="kpi-unit">tUSDC</span>
          </div>
          <div className="kpi">
            <span className="kpi-label">Fake reviews ignored</span>
            <span className="kpi-value mono">{fake}</span>
            <span className="kpi-unit">weight 0</span>
          </div>
        </div>
      </header>

      {error && <div className="banner">RPC error: {error}. Retrying…</div>}

      <main className="main">
        <section className="panel map-panel">
          <div className="panel-head">
            <h2>Live market</h2>
            <div className="legend small muted">
              <span>
                <i className="lg-dot live" /> money streaming
              </span>
              <span>
                <i className="lg-dot good" /> trusted ≥70
              </span>
              <span>
                <i className="lg-dot warn" /> unproven
              </span>
              <span>
                <i className="lg-dot bad" /> untrusted &lt;40
              </span>
            </div>
          </div>
          {agents.length ? (
            <div className="map-wrap">
              <MarketMap agents={agents} jobs={jobs} settleTimes={settleTimes} now={now} hovered={hovered} onHover={setHovered} />
              <AgentTooltip agent={hovered ? state.agents[hovered] : null} />
            </div>
          ) : (
            <p className="empty">{loaded ? "Waiting for agents to register…" : "Reading the chain…"}</p>
          )}
        </section>

        <section className="panel board-panel">
          <div className="panel-head">
            <h2>Reputation</h2>
            <span className="small faint">paid, verified jobs only</span>
          </div>
          <Leaderboard agents={agents} history={state.scoreHistory} hovered={hovered} onHover={setHovered} />
        </section>

        <section className="panel jobs-panel">
          <div className="panel-head">
            <h2>Jobs</h2>
            <span className="small faint">click a row for the output and verdict</span>
          </div>
          <JobsTable jobs={jobs} agents={state.agents} now={now} />
        </section>

        <section className="panel feed-panel">
          <div className="panel-head">
            <h2>On-chain activity</h2>
            <span className={`net mono small ${error ? "down" : ""}`}>
              <i /> {deployment.network}
            </span>
          </div>
          <ol className="feed">
            {[...state.events]
              .reverse()
              .slice(0, MAX_EVENTS_SHOWN)
              .map((e, i) => {
                const t = eventText(e, state);
                return (
                  <li key={`${e.tx}-${i}`}>
                    <span className={`ficon ${t.cls}`} aria-hidden="true">
                      {t.icon}
                    </span>
                    <span className="ftext">{t.text}</span>
                    <TxLink hash={e.tx} />
                  </li>
                );
              })}
          </ol>
          <div className="contracts small">
            {Object.entries(deployment.contracts).map(([k, v]) => (
              <div key={k}>
                <span className="muted">{k}</span>
                {explorer ? (
                  <a className="mono" href={`${explorer}/address/${v}`} target="_blank" rel="noreferrer">
                    {short(v)} ↗
                  </a>
                ) : (
                  <span className="mono faint">{short(v)}</span>
                )}
              </div>
            ))}
          </div>
        </section>
      </main>
    </div>
  );
}
