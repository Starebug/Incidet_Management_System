import { useState } from 'react';
import { useParams, useNavigate, Link } from 'react-router-dom';
import { submitRca, type RcaPayload } from '../api/client';

const ROOT_CAUSE_CATEGORIES = [
  'Infrastructure Failure',
  'Configuration Error',
  'Code Bug',
  'Dependency Failure',
  'Capacity Exhaustion',
  'Network Partition',
  'Security Incident',
  'Human Error',
  'Unknown',
  'Other',
];

export default function RcaForm() {
  const { id } = useParams<{ id: string }>();
  const navigate = useNavigate();

  const [form, setForm] = useState({
    incident_start: '',
    incident_end: '',
    root_cause_category: '',
    fix_applied: '',
    prevention_steps: '',
    created_by: '',
  });

  const [errors, setErrors] = useState<Record<string, string>>({});
  const [submitting, setSubmitting] = useState(false);
  const [submitError, setSubmitError] = useState('');

  const updateField = (field: string, value: string) => {
    setForm(prev => ({ ...prev, [field]: value }));
    // Clear field error on edit
    if (errors[field]) {
      setErrors(prev => { const next = { ...prev }; delete next[field]; return next; });
    }
  };

  const validate = (): boolean => {
    const errs: Record<string, string> = {};

    if (!form.incident_start) errs.incident_start = 'Incident start time is required';
    if (!form.incident_end) errs.incident_end = 'Incident end time is required';
    if (form.incident_start && form.incident_end && new Date(form.incident_end) < new Date(form.incident_start)) {
      errs.incident_end = 'End time must be after start time';
    }
    if (!form.root_cause_category) errs.root_cause_category = 'Root cause category is required';
    if (!form.fix_applied.trim()) errs.fix_applied = 'Fix applied description is required';
    if (!form.prevention_steps.trim()) errs.prevention_steps = 'Prevention steps are required';
    if (!form.created_by.trim()) errs.created_by = 'Author name is required';

    setErrors(errs);
    return Object.keys(errs).length === 0;
  };

  const handleSubmit = async (e: React.FormEvent) => {
    e.preventDefault();
    if (!validate() || !id) return;

    setSubmitting(true);
    setSubmitError('');

    try {
      const payload: RcaPayload = {
        incident_start: new Date(form.incident_start).toISOString(),
        incident_end: new Date(form.incident_end).toISOString(),
        root_cause_category: form.root_cause_category,
        fix_applied: form.fix_applied.trim(),
        prevention_steps: form.prevention_steps.trim(),
        created_by: form.created_by.trim(),
      };

      await submitRca(id, payload);
      navigate(`/incidents/${id}`);
    } catch (e: any) {
      setSubmitError(e.response?.data?.message || 'Failed to submit RCA');
    } finally {
      setSubmitting(false);
    }
  };

  return (
    <div className="mx-auto max-w-2xl">
      {/* Breadcrumb */}
      <Link to={`/incidents/${id}`} className="text-sm text-gray-500 hover:text-gray-300">
        ← Back to Incident
      </Link>

      <div className="mt-4 rounded-xl border border-gray-800 bg-gray-900 p-6">
        <h1 className="mb-1 text-xl font-bold text-white">Root Cause Analysis</h1>
        <p className="mb-6 text-sm text-gray-500">
          Complete all fields to close incident <span className="font-mono text-gray-400">{id?.slice(0, 12)}…</span>
        </p>

        {submitError && (
          <div className="mb-4 rounded-lg border border-red-800 bg-red-900/20 px-4 py-3 text-sm text-red-400">
            {submitError}
          </div>
        )}

        <form onSubmit={handleSubmit} className="space-y-5">
          {/* Dates row */}
          <div className="grid gap-4 sm:grid-cols-2">
            <Field label="Incident Start" error={errors.incident_start}>
              <input
                type="datetime-local"
                value={form.incident_start}
                onChange={e => updateField('incident_start', e.target.value)}
                className="input-field"
              />
            </Field>

            <Field label="Incident End" error={errors.incident_end}>
              <input
                type="datetime-local"
                value={form.incident_end}
                onChange={e => updateField('incident_end', e.target.value)}
                className="input-field"
              />
            </Field>
          </div>

          {/* Category */}
          <Field label="Root Cause Category" error={errors.root_cause_category}>
            <select
              value={form.root_cause_category}
              onChange={e => updateField('root_cause_category', e.target.value)}
              className="input-field"
            >
              <option value="">Select a category…</option>
              {ROOT_CAUSE_CATEGORIES.map(cat => (
                <option key={cat} value={cat}>{cat}</option>
              ))}
            </select>
          </Field>

          {/* Fix Applied */}
          <Field label="Fix Applied" error={errors.fix_applied}>
            <textarea
              rows={3}
              placeholder="Describe the fix that was applied to resolve this incident…"
              value={form.fix_applied}
              onChange={e => updateField('fix_applied', e.target.value)}
              className="input-field resize-y"
            />
          </Field>

          {/* Prevention Steps */}
          <Field label="Prevention Steps" error={errors.prevention_steps}>
            <textarea
              rows={3}
              placeholder="What steps will be taken to prevent recurrence…"
              value={form.prevention_steps}
              onChange={e => updateField('prevention_steps', e.target.value)}
              className="input-field resize-y"
            />
          </Field>

          {/* Author */}
          <Field label="Created By" error={errors.created_by}>
            <input
              type="text"
              placeholder="Your name"
              value={form.created_by}
              onChange={e => updateField('created_by', e.target.value)}
              className="input-field"
            />
          </Field>

          {/* Submit */}
          <div className="flex items-center justify-end gap-3 pt-2">
            <Link
              to={`/incidents/${id}`}
              className="rounded-lg border border-gray-700 px-4 py-2 text-sm text-gray-400 hover:bg-gray-800 transition"
            >
              Cancel
            </Link>
            <button
              type="submit"
              disabled={submitting}
              className="rounded-lg bg-blue-600 px-5 py-2 text-sm font-medium text-white transition hover:bg-blue-500 disabled:opacity-50"
            >
              {submitting ? 'Submitting…' : 'Submit RCA'}
            </button>
          </div>
        </form>
      </div>
    </div>
  );
}

/* Reusable field wrapper */
function Field({ label, error, children }: { label: string; error?: string; children: React.ReactNode }) {
  return (
    <div>
      <label className="mb-1.5 block text-sm font-medium text-gray-300">{label}</label>
      {children}
      {error && <p className="mt-1 text-xs text-red-400">{error}</p>}
    </div>
  );
}

