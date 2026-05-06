import { useEffect, useState } from 'react';
import { Link } from 'react-router-dom';
import { fetchLiveFeed, type Incident, updateIncidentStatus } from '../api/client';
import SeverityBadge from '../components/SeverityBadge';

const TABS = ['OPEN', 'INVESTIGATING', 'RESOLVED', 'CLOSED'] as const;
type Tab = typeof TABS[number];

export default function LiveFeed() {
  const [activeTab, setActiveTab] = useState<Tab>('OPEN');
  const [incidents, setIncidents] = useState<Incident[]>([]);
  const [loading, setLoading] = useState(true);
  const [error, setError] = useState('');
  const [source, setSource] = useState('');
  const [updatingIds, setUpdatingIds] = useState<Record<string, boolean>>({});

  const load = async (tab: Tab) => {
    try {
      const data = await fetchLiveFeed(tab);
      setIncidents(data.incidents || []);
      setSource(data.source || '');
      setError('');
    } catch (e: any) {
      setError(e.message || 'Failed to load live feed');
    } finally {
      setLoading(false);
    }
  };

  const handleRefresh = () => {
    if (loading) {
      return;
    }

    setLoading(true);
    load(activeTab);
  };

  const handleStatusAdvance = async (incident: Incident) => {
    const nextStatus = getNextStatus(incident.status);
    if (!nextStatus) {
      return;
    }

    setUpdatingIds(prev => ({ ...prev, [incident.external_id]: true }));

    try {
      await updateIncidentStatus(incident.external_id, nextStatus);
      await load(activeTab);
    } catch (e: any) {
      setError(e?.response?.data?.message || e.message || 'Failed to update incident status');
    } finally {
      setUpdatingIds(prev => {
        const next = { ...prev };
        delete next[incident.external_id];
        return next;
      });
    }
  };

  useEffect(() => {
    setLoading(true);
    load(activeTab);
    const interval = setInterval(() => load(activeTab), 20000);
    return () => clearInterval(interval);
  }, [activeTab]);

  const timeAgo = (ts: string) => {
    if (!ts) return '—';
    const diff = Math.floor((Date.now() - new Date(ts).getTime()) / 1000);
    if (diff < 60) return `${diff}s ago`;
    if (diff < 3600) return `${Math.floor(diff / 60)}m ago`;
    if (diff < 86400) return `${Math.floor(diff / 3600)}h ago`;
    return `${Math.floor(diff / 86400)}d ago`;
  };

  const isClosedTab = activeTab === 'CLOSED';

  const tabColors: Record<Tab, string> = {
    OPEN: 'border-red-500 text-red-400',
    INVESTIGATING: 'border-blue-500 text-blue-400',
    RESOLVED: 'border-green-500 text-green-400',
    CLOSED: 'border-gray-500 text-gray-300',
  };

  const getActionConfig = (status: string) => {
    switch (status) {
      case 'OPEN':
        return {
          label: 'Start Investigation',
          nextStatus: 'INVESTIGATING',
          className: 'inline-flex items-center rounded-lg bg-blue-600 px-3 py-1.5 text-xs font-medium text-white transition hover:bg-blue-500 disabled:cursor-not-allowed disabled:opacity-60',
        };
      case 'INVESTIGATING':
        return {
          label: 'Mark Resolved',
          nextStatus: 'RESOLVED',
          className: 'inline-flex items-center rounded-lg bg-emerald-600 px-3 py-1.5 text-xs font-medium text-white transition hover:bg-emerald-500 disabled:cursor-not-allowed disabled:opacity-60',
        };
      case 'RESOLVED':
        return {
          label: 'RCA',
          nextStatus: null,
          className: 'inline-flex items-center rounded-lg bg-blue-600 px-3 py-1.5 text-xs font-medium text-white transition hover:bg-blue-500',
        };
      default:
        return null;
    }
  };

  const getNextStatus = (status: string) => {
    switch (status) {
      case 'OPEN':
        return 'INVESTIGATING';
      case 'INVESTIGATING':
        return 'RESOLVED';
      default:
        return null;
    }
  };

  return (
    <div>
      {/* Header */}
      <div className="mb-6 flex flex-col gap-4 sm:flex-row sm:items-center sm:justify-between">
        <div>
          <div className="flex items-center gap-3">
            <h1 className="text-2xl font-bold text-white">Live Incidents</h1>
            <button
              type="button"
              onClick={handleRefresh}
              className="inline-flex items-center rounded-lg border border-gray-700 px-3 py-1.5 text-xs font-medium text-gray-300 transition hover:bg-gray-800"
            >
              Refresh
            </button>
          </div>
          <p className="text-sm text-gray-500">
            Auto-refreshes every 20s
            {source && <span className="ml-2 text-xs text-gray-600">({source})</span>}
          </p>
          {isClosedTab && (
            <p className="mt-2 text-xs text-gray-500">
              Closed tickets are loaded directly from the source of truth.
            </p>
          )}
        </div>
      </div>

      {/* Tabs */}
      <div className="mb-6 flex border-b border-gray-800">
        {TABS.map(tab => (
          <button
            key={tab}
            onClick={() => setActiveTab(tab)}
            className={`px-5 py-2.5 text-sm font-medium transition border-b-2 -mb-px ${
              activeTab === tab
                ? tabColors[tab]
                : 'border-transparent text-gray-500 hover:text-gray-300'
            }`}
          >
            {tab}
            {!loading && activeTab === tab && (
              <span className="ml-2 rounded-full bg-gray-800 px-2 py-0.5 text-xs text-gray-400">
                {incidents.length}
              </span>
            )}
          </button>
        ))}
      </div>

      {/* Error */}
      {error && (
        <div className="mb-4 rounded-lg border border-red-800 bg-red-900/20 px-4 py-3 text-sm text-red-400">
          {error}
        </div>
      )}

      {/* Loading */}
      {loading && (
        <div className="flex items-center justify-center py-20 text-gray-500">
          <svg className="mr-2 h-5 w-5 animate-spin" viewBox="0 0 24 24">
            <circle className="opacity-25" cx="12" cy="12" r="10" stroke="currentColor" strokeWidth="4" fill="none" />
            <path className="opacity-75" fill="currentColor" d="M4 12a8 8 0 018-8v4a4 4 0 00-4 4H4z" />
          </svg>
          Loading…
        </div>
      )}

      {/* Empty state */}
      {!loading && incidents.length === 0 && !error && (
        <div className="rounded-xl border border-gray-800 bg-gray-900 py-16 text-center text-gray-500">
          <p className="text-4xl mb-2">✅</p>
          <p className="text-lg font-medium text-gray-400">No {activeTab.toLowerCase()} incidents</p>
        </div>
      )}

      {/* Incident table */}
      {!loading && incidents.length > 0 && (
        <div className="overflow-hidden rounded-xl border border-gray-800">
          <table className="w-full text-left text-sm">
            <thead className="border-b border-gray-800 bg-gray-900 text-xs uppercase text-gray-500">
              <tr>
                <th className="px-4 py-3">Severity</th>
                <th className="px-4 py-3">Component</th>
                <th className="px-4 py-3">Service</th>
                <th className="px-4 py-3">First Seen</th>
                <th className="px-4 py-3 text-right">Actions</th>
              </tr>
            </thead>
            <tbody className="divide-y divide-gray-800">
              {incidents.map((inc) => (
                <tr
                  key={inc.external_id}
                  className="bg-gray-950 transition hover:bg-gray-900/70"
                >
                  <td className="px-4 py-3">
                    <SeverityBadge severity={inc.severity} />
                  </td>
                  <td className="px-4 py-3">
                    <Link
                      to={`/incidents/${inc.external_id}`}
                      className="font-medium text-blue-400 hover:text-blue-300 hover:underline"
                    >
                      {inc.component_id}
                    </Link>
                  </td>
                  <td className="px-4 py-3 text-gray-400">{inc.service_type}</td>
                  <td className="px-4 py-3 text-gray-500" title={inc.first_signal_at}>
                    {timeAgo(inc.first_signal_at)}
                  </td>
                  <td className="px-4 py-3 text-right">
                    {(() => {
                      const action = getActionConfig(inc.status);
                      const isUpdating = Boolean(updatingIds[inc.external_id]);

                      return (
                        <>
                    <Link
                      to={`/incidents/${inc.external_id}`}
                      className="mr-2 inline-flex items-center rounded-lg border border-gray-700 px-3 py-1.5 text-xs font-medium text-gray-300 transition hover:bg-gray-800"
                    >
                      View
                    </Link>
                          {action?.nextStatus ? (
                            <button
                              type="button"
                              onClick={() => handleStatusAdvance(inc)}
                              disabled={isUpdating}
                              className={action.className}
                            >
                              {isUpdating ? 'Updating…' : action.label}
                            </button>
                          ) : action ? (
                            <Link
                              to={`/incidents/${inc.external_id}/rca`}
                              className={action.className}
                            >
                              {action.label}
                            </Link>
                          ) : null}
                        </>
                      );
                    })()}
                  </td>
                </tr>
              ))}
            </tbody>
          </table>
        </div>
      )}
    </div>
  );
}
