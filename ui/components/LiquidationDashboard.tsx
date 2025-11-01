'use client';

import { useEffect, useMemo, useState } from 'react';
import useSWR from 'swr';
import type {
  AssetDistributionBucket,
  MetricsSnapshot,
  NormalizedLiquidationEvent,
  TimelineBucket,
} from '@/types/liquidation';
import { formatUnits } from 'viem';

const API_BASE_URL = (
  process.env.NEXT_PUBLIC_API_BASE_URL ?? ''
).replace(/\/$/, '');

const SNAPSHOT_ENDPOINT = `${API_BASE_URL}/api/liquidations/snapshot`;
const STREAM_ENDPOINT = `${API_BASE_URL}/api/liquidations/stream`;

const fetcher = async (url: string) => {
  const response = await fetch(url);
  if (!response.ok) {
    throw new Error(`Failed to fetch ${url}`);
  }
  return (await response.json()) as MetricsSnapshot;
};

type ConnectionState = 'connecting' | 'open' | 'error';

type MetricCardProps = {
  title: string;
  value: string;
  footnote?: string;
};

const MetricCard = ({ title, value, footnote }: MetricCardProps) => (
  <div className="metric-card glass-panel">
    <span className="metric-title">{title}</span>
    <span className="metric-value">{value}</span>
    {footnote ? <span className="metric-footnote">{footnote}</span> : null}
  </div>
);

const formatTokenAmount = (raw: string, decimals: number) => {
  try {
    const formatted = formatUnits(BigInt(raw), decimals);
    const numericValue = Number(formatted);
    if (!Number.isFinite(numericValue)) {
      return formatted;
    }
    return numericValue.toLocaleString(undefined, {
      minimumFractionDigits: 0,
      maximumFractionDigits: 6,
    });
  } catch {
    return '0';
  }
};

const formatPercent = (value: number) => `${(value * 100).toFixed(1)}%`;

const formatTimestamp = (timestamp: number) =>
  new Date(timestamp).toLocaleString(undefined, {
    hour12: false,
    month: 'short',
    day: '2-digit',
    hour: '2-digit',
    minute: '2-digit',
  });

const useLiquidationSnapshot = () => {
  const { data, error, mutate, isValidating } = useSWR<MetricsSnapshot>(
    SNAPSHOT_ENDPOINT,
    fetcher,
    {
      refreshInterval: 60_000,
      revalidateOnFocus: false,
    },
  );

  return { snapshot: data ?? null, error, mutate, isValidating };
};

const AssetDistribution = ({ buckets }: { buckets: AssetDistributionBucket[] }) => {
  if (!buckets.length) {
    return <div className="empty-state">No liquidation collateral observed in the recent window.</div>;
  }

  return (
    <div className="asset-distribution">
      {buckets.map((bucket) => (
        <div key={bucket.asset} className="asset-bar">
          <span className="badge">{bucket.symbol}</span>
          <div className="asset-bar-track">
            <div
              className="asset-bar-fill"
              style={{ width: `${Math.min(bucket.share, 1) * 100}%` }}
            />
          </div>
        </div>
      ))}
    </div>
  );
};

const Timeline = ({ buckets }: { buckets: TimelineBucket[] }) => {
  if (!buckets.length) {
    return <div className="empty-state">No liquidations recorded for the selected period.</div>;
  }

  return (
    <div className="timeline-list">
      {buckets.map((bucket) => (
        <div key={bucket.bucketStart} className="timeline-item">
          <div>
            <div style={{ fontWeight: 600 }}>{formatTimestamp(bucket.bucketStart)}</div>
            <div style={{ fontSize: '0.85rem', opacity: 0.7 }}>
              {bucket.liquidations} liquidations
            </div>
          </div>
        </div>
      ))}
    </div>
  );
};

const RecentLiquidations = ({ events }: { events: NormalizedLiquidationEvent[] }) => {
  if (!events.length) {
    return <div className="empty-state">No liquidation activity detected yet.</div>;
  }

  return (
    <div style={{ overflowX: 'auto' }}>
      <table className="recent-table">
        <thead>
          <tr>
            <th>Time</th>
            <th>Collateral</th>
            <th>Debt Asset</th>
            <th>Debt Repaid</th>
            <th>Collateral Seized</th>
            <th>Liquidator</th>
            <th>Tx</th>
          </tr>
        </thead>
        <tbody>
          {events.map((event) => (
            <tr key={event.id}>
              <td>{formatTimestamp(event.blockTimestamp)}</td>
              <td>
                {event.collateralSymbol}
              </td>
              <td>{event.debtSymbol}</td>
              <td>
                {formatTokenAmount(event.debtToCoverRaw, event.debtDecimals)}{' '}
                {event.debtSymbol}
              </td>
              <td>
                {formatTokenAmount(event.collateralAmountRaw, event.collateralDecimals)}{' '}
                {event.collateralSymbol}
              </td>
              <td>
                <code>{(event.liquidatorLabel ?? event.liquidator).slice(0, 6)}…{(event.liquidatorLabel ?? event.liquidator).slice(-4)}</code>
              </td>
              <td>
                <a
                  href={`https://etherscan.io/tx/${event.txHash}`}
                  target="_blank"
                  rel="noopener noreferrer"
                  className="etherscan-link"
                  title={event.txHash}
                >
                  🔗
                </a>
              </td>
            </tr>
          ))}
        </tbody>
      </table>
    </div>
  );
};

export const LiquidationDashboard = () => {
  const { snapshot, mutate } = useLiquidationSnapshot();
  const [liveSnapshot, setLiveSnapshot] = useState<MetricsSnapshot | null>(snapshot);
  const [connectionState, setConnectionState] = useState<ConnectionState>('connecting');
  const [lastUpdate, setLastUpdate] = useState<number | null>(null);

  useEffect(() => {
    if (snapshot) {
      setLiveSnapshot(snapshot);
      setLastUpdate(Date.now());
    }
  }, [snapshot]);

  useEffect(() => {
    let eventSource: EventSource | null = null;
    let retryTimer: ReturnType<typeof setTimeout> | null = null;

    const connect = () => {
      if (eventSource) {
        eventSource.close();
      }

      setConnectionState('connecting');
      eventSource = new EventSource(STREAM_ENDPOINT);

      eventSource.addEventListener('open', () => {
        setConnectionState('open');
      });

      eventSource.addEventListener('snapshot', (event) => {
        try {
          const data = JSON.parse((event as MessageEvent).data) as MetricsSnapshot;
          setLiveSnapshot(data);
          setLastUpdate(Date.now());
        } catch (error) {
          console.error('[Dashboard] Failed to parse snapshot payload', error);
        }
      });

      eventSource.addEventListener('liquidation', (event) => {
        try {
          const data = JSON.parse((event as MessageEvent).data) as NormalizedLiquidationEvent;
          setLiveSnapshot((prev) =>
            prev
              ? {
                  ...prev,
                  recent: [data, ...prev.recent.filter((item) => item.id !== data.id)].slice(0, 50),
                }
              : prev,
          );
          setLastUpdate(Date.now());
          mutate();
        } catch (error) {
          console.error('[Dashboard] Failed to parse liquidation payload', error);
        }
      });

      eventSource.onerror = () => {
        setConnectionState('error');
        eventSource?.close();
        retryTimer = setTimeout(connect, 5_000);
      };
    };

    connect();

    return () => {
      eventSource?.close();
      if (retryTimer) {
        clearTimeout(retryTimer);
      }
    };
  }, [mutate]);

  const summary = liveSnapshot?.summary;
  const metrics = useMemo(() => {
    if (!summary) return null;
    return [
      {
        title: 'Liquidations (24h)',
        value: summary.last24Hours.count.toString(),
        footnote: `${summary.lastHour.count} in the last hour`,
      },
      {
        title: 'Active Liquidators',
        value: summary.uniqueLiquidators.toString(),
        footnote: `${summary.last24Hours.uniqueLiquidators} active in the past 24h`,
      },
    ];
  }, [summary]);

  return (
    <div className="dashboard-container">
      <header className="dashboard-header">
        <div className="connection-badge">
          <span
            className={`connection-dot ${
              connectionState === 'open'
                ? 'open'
                : connectionState === 'error'
                ? 'error'
                : 'connecting'
            }`}
          />
          <span>{connectionState === 'open' ? 'Live feed connected' : connectionState === 'error' ? 'Connection lost, retrying…' : 'Connecting to Ethereum…'}</span>
        </div>
        <h1>Aave V3 Liquidation Tracker</h1>
        <p className="dashboard-description">
          Observe live liquidation activity on the Aave V3 Ethereum market, track debt repayments, and understand
          collateral flows across assets. Metrics refresh automatically in real-time using decoded LiquidationCall
          events.
        </p>
        {lastUpdate ? (
          <span style={{ fontSize: '0.85rem', opacity: 0.6 }}>
            Last update: {new Date(lastUpdate).toLocaleTimeString()}
          </span>
        ) : null}
      </header>

      {metrics ? (
        <section className="metrics-grid">
          {metrics.map((metric) => (
            <MetricCard key={metric.title} {...metric} />
          ))}
        </section>
      ) : (
        <div className="empty-state">Initialising metrics…</div>
      )}

      <section className="panels-grid">
        <div className="panel glass-panel">
          <div className="panel-title">
            <span>Asset Distribution</span>
            <span style={{ fontSize: '0.85rem', opacity: 0.6 }}>
              Relative share of collateral events
            </span>
          </div>
          <AssetDistribution buckets={liveSnapshot?.assetDistribution ?? []} />
        </div>

        <div className="panel glass-panel">
          <div className="panel-title">
            <span>Historical Trend (24h)</span>
            <span style={{ fontSize: '0.85rem', opacity: 0.6 }}>
              Liquidation counts per 30 minute bucket
            </span>
          </div>
          <Timeline buckets={liveSnapshot?.timeline ?? []} />
        </div>
      </section>

      <section className="panel glass-panel">
        <div className="panel-title">
          <span>Most Recent Liquidations</span>
          <span style={{ fontSize: '0.85rem', opacity: 0.6 }}>
            Showing up to 50 latest events
          </span>
        </div>
        <RecentLiquidations events={liveSnapshot?.recent ?? []} />
      </section>
    </div>
  );
};
