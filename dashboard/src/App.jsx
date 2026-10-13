import { useEffect, useMemo, useRef, useState } from "react";
import { createFeed, deployment, explorer, usdc } from "./chain.js";

const POLL_MS = 1500;
const MAX_JOBS_SHOWN = 12;
const MAX_EVENTS_SHOWN = 60;

function useFeed() {
  const feed = useMemo(() => createFeed(), []);
  const [, setTick] = useState(0);
  const [error, setError] = useState(null);
  useEffect(() => {
    let alive = true;
    const loop = async () => {
      try {
        await feed.refresh();
        setError(null);
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
  return { state: feed.state, error };
}

function useNow(ms = 100) {
  const [now, setNow] = useState(Date.now() / 1000);
  useEffect(() => {
    const id = setInterval(() => setNow(Date.now() / 1000), ms);
    return () => clearInterval(id);
  }, [ms]);
  return now;
}

const fmt = (n, d = 4) => n.toLocaleString(undefined, { minimumFractionDigits: d, maximumFractionDigits: d });
const short = (h) => `${h.slice(0, 6)}…${h.slice(-4)}`;

function TxLink({ hash, children }) {
  if (!hash) return null;
  if (!explorer) return <span className="mono dim">{children ?? short(hash)}</span>;
  return (
    <a className="mono" href={`${explorer}/tx/${hash}`} target="_blank" rel="noreferrer">
      {children ?? short(hash)} ↗
    </a>
  );
}

function scoreClass(s) {
  if (s >= 70) return "good";
  if (s >= 40) return "mid";
  return "bad";
}

function ScoreRing({ score }) {
  const r = 30;
  const circ = 2 * Math.PI * r;
  return (
    <svg className={`ring ${scoreClass(score)}`} viewBox="0 0 76 76" width="76" height="76" role="img" aria-label={`reputation ${score}`}>
      <circle cx="38" cy="38" r={r} className="ring-bg" />
      <circle cx="38" cy="38" r={r} className="ring-fg" strokeDasharray={circ} strokeDashoffset={circ * (1 - score / 100)} />
      <text x="38" y="44" textAnchor="middle">
        {score}
      </text>
    </svg>
  );
}

function Sparkline({ points }) {
  if (!points || points.length < 2) return <div className="spark-empty dim">no paid jobs yet</div>;
  const w = 120;
  const h = 28;
  const step = w / (points.length - 1);
  const d = points.map((p, i) => `${i ? "L" : "M"}${(i * step).toFixed(1)},${(h - (p / 100) * h).toFixed(1)}`).join(" ");
  return (
    <svg className="spark" viewBox={`0 0 ${w} ${h}`} width={w} height={h} aria-hidden="true">
      <path d={d} />
    </svg>
  );
}

function AgentCard({ agent, history }) {
  const prev = useRef(agent.score);
  const [flash, setFlash] = useState("");
  useEffect(() => {
    if (prev.current !== undefined && agent.score !== undefined && agent.score !== prev.current) {
      setFlash(agent.score > prev.current ? "up" : "down");
      const t = setTimeout(() => setFlash(""), 1600);
      prev.current = agent.score;
      return () => clearTimeout(t);
    }
    prev.current = agent.score;
  }, [agent.score]);

  return (
    <article className={`card agent ${flash}`}>
      <header className="agent-head">
        <div className={`avatar ${scoreClass(agent.score ?? 50)}`}>{agent.name?.[0]}</div>
        <div>
          <h3>
            {agent.name} <span className="dim mono">#{String(agent.id)}</span>
          </h3>
          <p className="dim small">{agent.description}</p>
        </div>
      </header>
      <div className="agent-body">
        <ScoreRing score={agent.score ?? 50} />
        <div className="agent-meta">
          <div className="small dim">reputation (paid jobs only)</div>
          <Sparkline points={history} />
          <div className="pills">
            {(agent.skills || []).map((s) => (
              <span key={s} className="pill">
                {s}
              </span>
            ))}
          </div>
        </div>
      </div>
      <dl className="kv">
        <dt>Rate</dt>
        <dd className="mono">{agent.pricing?.ratePerSecond} tUSDC/s</dd>
        <dt>Stake</dt>
        <dd className="mono">
          {fmt(usdc(agent.stake), 2)}
          {agent.locked > 0n && <span className="dim"> +{fmt(usdc(agent.locked), 2)} locked</span>}
        </dd>
        <dt>Earned</dt>
        <dd className="mono good-text">{fmt(usdc(agent.earned))}</dd>
        <dt>Slashed</dt>
        <dd className={`mono ${agent.slashed > 0n ? "bad-text" : ""}`}>{fmt(usdc(agent.slashed))}</dd>
        <dt>Jobs</dt>
        <dd className="mono">
          {String(agent.passed ?? 0)} ✓ · {String(agent.failed ?? 0)} ✗
        </dd>
        <dt>Fake reviews</dt>
        <dd className="mono">
          {String(agent.freeReviews ?? 0)} <span className="dim">(weight 0)</span>
        </dd>
      </dl>
    </article>
  );
}

const STATUS = {
  streaming: { label: "Streaming", cls: "live" },
  verifying: { label: "Verifying", cls: "warn" },
  paid: { label: "Paid", cls: "ok" },
  slashed: { label: "Slashed", cls: "bad" },
};

function JobCard({ job, agents, now }) {
  const end = job.stoppedAt ?? Math.min(now, job.maxEnd);
  const seconds = Math.max(0, end - job.start);
  const accrued = usdc(job.rate) * seconds;
  const budget = usdc(job.budget);
  const st = STATUS[job.status];
  const name = (id) => agents[id]?.name ?? `#${id}`;

  return (
    <article className={`card job ${st.cls}`}>
      <header className="job-head">
        <div>
          <span className="mono dim">job #{String(job.id)}</span>
          <h3>
            {name(job.client)} <span className="arrow">→</span> {name(job.worker)}
          </h3>
          <p className="small dim">{job.spec.title}</p>
        </div>
        <span className={`status ${st.cls}`}>{st.label}</span>
      </header>

      <div className="ticker">
        <span className={`amount mono ${job.status === "slashed" ? "struck" : ""}`}>{fmt(accrued, 4)}</span>
        <span className="unit">tUSDC</span>
        <span className="dim small mono">
          {seconds.toFixed(0)}s × {fmt(usdc(job.rate), 2)}/s
        </span>
      </div>
      <div className="bar" aria-hidden="true">
        <div className="bar-fill" style={{ width: `${Math.min(100, (accrued / budget) * 100)}%` }} />
      </div>
      <div className="row small dim">
        <span>budget {fmt(budget, 2)}</span>
        <span>
          {name(job.worker)} staked {fmt(usdc(job.stake), 2)}
        </span>
      </div>

      {job.output && (
        <pre className="output" title="worker output (on-chain)">
          {job.output.length > 220 ? job.output.slice(0, 220) + "…" : job.output}
        </pre>
      )}
      {job.reason && (
        <p className={`verdict ${st.cls}`}>
          {job.status === "paid" ? "✓ " : "✗ "}
          {job.reason}
          {job.status === "slashed" && <> · stake {fmt(usdc(job.slashed), 2)} slashed to {name(job.client)}</>}
          {job.status === "paid" && <> · {name(job.worker)} received {fmt(usdc(job.paid))}</>}
        </p>
      )}
      <footer className="row small">
        <TxLink hash={job.createdTx}>created</TxLink>
        <TxLink hash={job.settledTx}>settled</TxLink>
      </footer>
    </article>
  );
}

function eventText(e, s) {
  const n = (id) => s.agents[id]?.name ?? `#${id}`;
  const j = e.job !== undefined ? s.jobs[e.job] : null;
  switch (e.kind) {
    case "register":
      return `${n(e.agent)} registered an ERC-8004 identity`;
    case "job":
      return `${n(j.client)} hired ${n(j.worker)} (job #${j.id})`;
    case "submit":
      return `${n(j.worker)} submitted output, stream stopped`;
    case "paid":
      return `Verifier passed job #${j.id}, ${n(j.worker)} paid`;
    case "slashed":
      return `Verifier failed job #${j.id}, ${n(j.worker)} slashed`;
    case "fake":
      return `Free review for ${n(e.agent)} ignored (no paid job)`;
    default:
      return e.kind;
  }
}

export default function App() {
  const { state, error } = useFeed();
  const now = useNow();
  const agents = Object.values(state.agents);
  const jobs = Object.values(state.jobs).sort((a, b) => Number(b.id - a.id));

  const streamed = jobs.reduce((sum, j) => {
    const end = j.stoppedAt ?? Math.min(now, j.maxEnd);
    return j.status === "slashed" ? sum : sum + usdc(j.rate) * Math.max(0, end - j.start);
  }, 0);
  const slashed = jobs.reduce((s, j) => s + (j.slashed ? usdc(j.slashed) : 0), 0);
  const fake = state.events.filter((e) => e.kind === "fake").length;
  const live = jobs.filter((j) => j.status === "streaming").length;
  const settled = jobs.filter((j) => j.status === "paid" || j.status === "slashed").length;

  return (
    <div className="page">
      <header className="top">
        <div>
          <h1>
            Trust<span className="accent">Stream</span>
          </h1>
          <p className="dim">ERC-8004 agents that get paid by the second, and lose their stake when they lie.</p>
        </div>
        <div className="net">
          <span className={`dot ${error ? "bad" : "live"}`} />
          <span className="mono small">{deployment.network}</span>
        </div>
      </header>

      {error && <div className="banner">RPC error: {error}. Retrying…</div>}

      <section className="stats">
        <div className="stat">
          <span className="dim small">Streamed to honest agents</span>
          <strong className="mono">{fmt(streamed)}</strong>
        </div>
        <div className="stat">
          <span className="dim small">Live streams · settled jobs</span>
          <strong className="mono">
            {live} <span className="dim">· {settled}</span>
          </strong>
        </div>
        <div className="stat">
          <span className="dim small">Stake slashed</span>
          <strong className="mono bad-text">{fmt(slashed, 2)}</strong>
        </div>
        <div className="stat">
          <span className="dim small">Fake reviews ignored</span>
          <strong className="mono">{fake}</strong>
        </div>
      </section>

      <h2>Agents</h2>
      <section className="grid agents">
        {agents.length === 0 && <p className="dim">Waiting for agents to register…</p>}
        {agents.map((a) => (
          <AgentCard key={String(a.id)} agent={a} history={state.scoreHistory[a.id]} />
        ))}
      </section>

      <div className="split">
        <section>
          <h2>Jobs</h2>
          <div className="jobs">
            {jobs.length === 0 && <p className="dim">No jobs yet. Run the agents.</p>}
            {jobs.slice(0, MAX_JOBS_SHOWN).map((j) => (
              <JobCard key={String(j.id)} job={j} agents={state.agents} now={now} />
            ))}
            {jobs.length > MAX_JOBS_SHOWN && <p className="dim small">+ {jobs.length - MAX_JOBS_SHOWN} earlier jobs</p>}
          </div>
        </section>
        <aside>
          <h2>On-chain activity</h2>
          <ol className="feed">
            {[...state.events].reverse().slice(0, MAX_EVENTS_SHOWN).map((e, i) => (
              <li key={`${e.tx}-${i}`} className={`feed-${e.kind}`}>
                <span>{eventText(e, state)}</span>
                <TxLink hash={e.tx} />
              </li>
            ))}
          </ol>
          <h2>Contracts</h2>
          <ul className="contracts small">
            {Object.entries(deployment.contracts).map(([k, v]) => (
              <li key={k}>
                <span>{k}</span>
                {explorer ? (
                  <a className="mono" href={`${explorer}/address/${v}`} target="_blank" rel="noreferrer">
                    {short(v)} ↗
                  </a>
                ) : (
                  <span className="mono dim">{short(v)}</span>
                )}
              </li>
            ))}
          </ul>
        </aside>
      </div>
    </div>
  );
}
