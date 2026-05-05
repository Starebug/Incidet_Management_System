import { useEffect, useState } from 'react';
import { useParams, Link } from 'react-router-dom';
import {
  fetchIncident,
  fetchIncidentSignals,
  fetchIncidentHistory,
  updateIncidentStatus,
  fetchRca,
  type Incident,
} from '../api/client';
import SeverityBadge from '../components/SeverityBadge';
import StatusBadge from '../components/StatusBadge';

const TRANSITIONS: Record<string, string[]> = {
  OPEN: ['INVESTIGATING'],
  INVESTIGATING: ['RESOLVED'],
  RESOLVED: ['CLOSED'],
  CLOSED: [],
};

export default function IncidentDetail() {
  const { id } = useParams<{ id: string }>();
  const [incident, setIncident] = useState<Incident | null>(null);
  const [signals, setSignals] = useState<any[]>([]);
  const [signalPagination, setSignalPagination] = useState({ page: 1, totalPages: 1, total: 0 });
  const [history, setHistory] = useState<any[]>([]);
  const [rca, setRca] = useState<any>(null);
  const [error, setError] = useState('');
  const [transitioning, setTransitioning] = useState(false);

  const loadIncident = async () => {
    if (!id) return;
    try {
      const data = await fetchIncident(id);
      setIncident(data);
    } catch (e: any) {
      setError(e.response?.data?.message || 'Incident not found');
    }
  };

  const loadSignals = async (page = 1) => {
    if (!id) return;
    try {
      const data = await fetchIncidentSignals(id, page, 10);
      setSignals(data.data || []);
      setSignalPagination(data.pagination || {});
    } catch { /* ignore */ }
  };

  const loadHistory = async () => {
    if (!id) return;
    try {
      const data = await fetchIncidentHistory(id);
      setHistory(data.data || []);
    } catch { /* ignore */ }
  };

  const loadRca = async () => {
    if (!id) return;
    try {
      const data = await fetchRca(id);
      setRca(data);
    } catch { setRca(null); }
  };

  useEffect(() => {
    loadIncident();
    loadSignals();
    loadHistory();
    loadRca();
  }, [id]);

  const handleTransition = async (targetStatus: string) => {
    if (!id) return;
    setTransitioning(true);
    try {
      const reason = prompt(`Reason for moving to ${targetStatus}?`, '');
      if (reason === null) { setTransitioning(false); return; }

      await updateIncidentStatus(id, targetStatus, reason);
      await loadIncident();
      await loadHistory();
      if (targetStatus === 'CLOSED') await loadRca();
    } catch (e: any) {
      alert(e.response?.data?.message || 'Transition failed');
    } finally {
      setTransitioning(false);
    }
  };

  if (error) {
    return (
      <div className="rounded-xl border border-red-800 bg-red-900/20 p-8 text-center text-red-400">
        <p className="text-lg font-semibold">{error}</p>
        <Link to="/" className="mt-4 inline-block text-sm text-blue-400 hover:underline">← Back to Live Feed</Link>
      </div>
    );
  }

  if (!incident) {
    return <div className="py-20 text-center text-gray-500">Loading…</div>;
  }

  const allowedTransitions = TRANSITIONS[incident.status] || [];

  return (
    <div className="space-y-6">
      {/* Breadcrumb */}
      <Link to="/" className="text-sm text-gray-500 hover:text-gray-300">← Back to Live Feed</Link>

      {/* Header card */}
      <div className="rounded-xl border border-gray-800 bg-gray-900 p-6">
        <div className="flex flex-col gap-4 sm:flex-row sm:items-start sm:justify-between">
          <div>
            <h1 className="text-xl font-bold text-white">{incident.component_id}</h1>
            <p className="mt-1 text-sm text-gray-400">{incident.service_type} · {incident.external_id}</p>
          </div>
          <div className="flex items-center gap-3">
            <SeverityBadge severity={incident.severity} />
            <StatusBadge status={incident.status} />
          </div>
        </div>

        <div className="mt-4 grid grid-cols-2 gap-4 sm:grid-cols-4">
          <Stat label="Signals" value={String(incident.signal_count)} />
          <Stat label="First Seen" value={new Date(incident.first_signal_at).toLocaleString()} />
          <Stat label="Last Signal" value={new Date(incident.last_signal_at).toLocaleString()} />
          <Stat label="MTTR" value={incident.mttr_seconds ? `${Math.round(incident.mttr_seconds / 60)}m` : '—'} />
        </div>

        {/* Status transition buttons */}
        <div className="mt-5 flex flex-wrap gap-2">
          {allowedTransitions.map(target => (
            <button
              key={target}
              onClick={() => handleTransition(target)}
              disabled={transitioning}
              className="rounded-lg border border-gray-700 bg-gray-800 px-4 py-2 text-sm font-medium text-gray-200 transition hover:bg-gray-700 disabled:opacity-50"
            >
              Move to {target}
            </button>
          ))}
          {(incident.status === 'RESOLVED' || incident.status === 'INVESTIGATING') && !rca && (
            <Link
              to={`/incidents/${id}/rca`}
              className="rounded-lg bg-blue-600 px-4 py-2 text-sm font-medium text-white transition hover:bg-blue-500"
            >
              Submit RCA
            </Link>
          )}
        </div>
      </div>

      {/* RCA summary (if exists) */}
      {rca && (
        <div className="rounded-xl border border-green-800/40 bg-green-900/10 p-6">
          <h2 className="mb-3 text-sm font-semibold uppercase text-green-400">Root Cause Analysis</h2>
          <dl className="grid gap-3 sm:grid-cols-2 text-sm">
            <DlItem label="Category" value={rca.root_cause_category} />
            <DlItem label="Incident Start" value={new Date(rca.incident_start).toLocaleString()} />
            <DlItem label="Incident End" value={new Date(rca.incident_end).toLocaleString()} />
            <DlItem label="Created By" value={rca.created_by} />
            <div className="sm:col-span-2">
              <dt className="text-gray-500">Fix Applied</dt>
              <dd className="mt-0.5 text-gray-300">{rca.fix_applied}</dd>
            </div>
            <div className="sm:col-span-2">
              <dt className="text-gray-500">Prevention Steps</dt>
              <dd className="mt-0.5 text-gray-300">{rca.prevention_steps}</dd>
            </div>
          </dl>
        </div>
      )}

      {/* Status History */}
      <section className="rounded-xl border border-gray-800 bg-gray-900 p-6">
        <h2 className="mb-4 text-sm font-semibold uppercase text-gray-400">Status History</h2>
        {history.length === 0 ? (
          <p className="text-sm text-gray-600">No transitions recorded</p>
        ) : (
          <ul className="space-y-3">
            {history.map((h: any) => (
              <li key={h.id} className="flex items-start gap-3 text-sm">
                <div className="mt-0.5 h-2 w-2 flex-shrink-0 rounded-full bg-blue-500" />
                <div>
                  <span className="text-gray-300">{h.from_status || '—'} → {h.to_status}</span>
                  {h.reason && <span className="ml-2 text-gray-500">"{h.reason}"</span>}
                  <div className="text-xs text-gray-600">
                    {new Date(h.changed_at).toLocaleString()} by {h.changed_by}
                  </div>
                </div>
              </li>
            ))}
          </ul>
        )}
      </section>

      {/* Raw Signals */}
      <section className="rounded-xl border border-gray-800 bg-gray-900 p-6">
        <h2 className="mb-4 text-sm font-semibold uppercase text-gray-400">
          Raw Signals ({signalPagination.total || 0})
        </h2>

        {signals.length === 0 ? (
          <p className="text-sm text-gray-600">No signals loaded</p>
        ) : (
          <div className="space-y-3">
            {signals.map((s: any, idx: number) => (
              <details key={s.signal_id || idx} className="group rounded-lg border border-gray-800 bg-gray-950">
                <summary className="flex cursor-pointer items-center justify-between px-4 py-2.5 text-sm">
                  <span className="font-mono text-gray-300">{s.signal_id?.slice(0, 12)}…</span>
                  <span className="text-xs text-gray-500">{new Date(s.received_at).toLocaleString()}</span>
                </summary>
                <pre className="overflow-x-auto border-t border-gray-800 px-4 py-3 text-xs text-gray-400">
                  {JSON.stringify(s.payload || s, null, 2)}
                </pre>
              </details>
            ))}

            {/* Pagination */}
            {signalPagination.totalPages > 1 && (
              <div className="flex items-center justify-center gap-3 pt-2">
                <button
                  onClick={() => loadSignals(signalPagination.page - 1)}
                  disabled={signalPagination.page <= 1}
                  className="rounded border border-gray-700 px-3 py-1 text-xs text-gray-400 hover:bg-gray-800 disabled:opacity-30"
                >
                  Prev
                </button>
                <span className="text-xs text-gray-500">
                  Page {signalPagination.page} of {signalPagination.totalPages}
                </span>
                <button
                  onClick={() => loadSignals(signalPagination.page + 1)}
                  disabled={signalPagination.page >= signalPagination.totalPages}
                  className="rounded border border-gray-700 px-3 py-1 text-xs text-gray-400 hover:bg-gray-800 disabled:opacity-30"
                >
                  Next
                </button>
              </div>
            )}
          </div>
        )}
      </section>
    </div>
  );
}

/* Small helpers */
function Stat({ label, value }: { label: string; value: string }) {
  return (
    <div>
      <dt className="text-xs text-gray-500">{label}</dt>
      <dd className="mt-0.5 text-sm font-medium text-gray-200">{value}</dd>
    </div>
  );
}

function DlItem({ label, value }: { label: string; value: string }) {
  return (
    <div>
      <dt className="text-gray-500">{label}</dt>
      <dd className="mt-0.5 text-gray-300">{value}</dd>
    </div>
  );
}

