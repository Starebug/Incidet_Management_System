import axios from 'axios';

const API_BASE = import.meta.env.VITE_API_URL || 'http://localhost:3000/api';

const api = axios.create({
  baseURL: API_BASE,
  timeout: 10000,
  headers: { 'Content-Type': 'application/json' },
});

/* ── Dashboard ─────────────────────────────────────────── */

export const fetchLiveFeed = (status?: string) =>
  api.get('/dashboard/live', { params: status ? { status } : {} }).then(r => r.data);

export const fetchStats = () => api.get('/dashboard/stats').then(r => r.data);

/* ── Incidents ─────────────────────────────────────────── */

export interface Incident {
  external_id: string;
  component_id: string;
  service_type: string;
  severity: string;
  status: string;
  first_signal_at: string;
  last_signal_at: string;
  signal_count: number;
  closed_at: string | null;
  mttr_seconds: number | null;
  created_at: string;
  updated_at: string;
}

export const fetchIncidents = (params?: Record<string, string>) =>
  api.get('/incidents', { params }).then(r => r.data);

export const fetchIncident = (id: string) =>
  api.get(`/incidents/${id}`).then(r => r.data);

export const fetchIncidentSignals = (id: string, page = 1, limit = 20) =>
  api.get(`/incidents/${id}/signals`, { params: { page, limit } }).then(r => r.data);

export const fetchIncidentHistory = (id: string) =>
  api.get(`/incidents/${id}/history`).then(r => r.data);

export const updateIncidentStatus = (id: string, status: string, reason?: string) =>
  api.patch(`/incidents/${id}/status`, { status, reason, changed_by: 'dashboard-user' }).then(r => r.data);

/* ── RCA ───────────────────────────────────────────────── */

export interface RcaPayload {
  incident_start: string;
  incident_end: string;
  root_cause_category: string;
  fix_applied: string;
  prevention_steps: string;
  created_by: string;
}

export const submitRca = (id: string, payload: RcaPayload) =>
  api.post(`/incidents/${id}/rca`, payload).then(r => r.data);

export const fetchRca = (id: string) =>
  api.get(`/incidents/${id}/rca`).then(r => r.data);

/* ── Health ─────────────────────────────────────────────── */

export const fetchHealth = () => api.get('/health').then(r => r.data);

export default api;


