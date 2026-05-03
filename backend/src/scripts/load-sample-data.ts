import { readFile } from 'node:fs/promises';
import { resolve } from 'node:path';

interface SampleSignal {
  signal_id: string;
  component_id: string;
  service_type: string;
  severity: string;
  event_ts: string;
  payload: Record<string, unknown>;
}

interface SampleDataFile {
  description?: string;
  scenario?: string;
  signals: SampleSignal[];
}

async function main() {
  const sampleFilePath = resolve(
    process.cwd(),
    '../sample-data/signals_sample.json',
  );

  const apiBaseUrl = (process.env.IMS_API_URL || 'http://localhost:3000/api').replace(/\/$/, '');
  const endpoint = `${apiBaseUrl}/signals/ingest/batch`;

  const raw = await readFile(sampleFilePath, 'utf-8');
  const sampleData = JSON.parse(raw) as SampleDataFile;

  if (!Array.isArray(sampleData.signals) || sampleData.signals.length === 0) {
    throw new Error(`No signals found in sample file: ${sampleFilePath}`);
  }

  console.log(`[SampleLoader] Loaded ${sampleData.signals.length} signals from ${sampleFilePath}`);
  if (sampleData.description) {
    console.log(`[SampleLoader] Description: ${sampleData.description}`);
  }
  if (sampleData.scenario) {
    console.log(`[SampleLoader] Scenario: ${sampleData.scenario}`);
  }
  console.log(`[SampleLoader] Posting to ${endpoint}`);

  const response = await fetch(endpoint, {
    method: 'POST',
    headers: {
      'Content-Type': 'application/json',
    },
    body: JSON.stringify({ signals: sampleData.signals }),
  });

  const responseText = await response.text();
  let parsed: unknown = responseText;

  try {
    parsed = JSON.parse(responseText);
  } catch {
    // keep raw text if response is not JSON
  }

  if (!response.ok) {
    console.error('[SampleLoader] API request failed');
    console.error(parsed);
    process.exitCode = 1;
    return;
  }

  console.log('[SampleLoader] Sample data loaded successfully');
  console.log(parsed);
}

main().catch((error) => {
  console.error('[SampleLoader] Failed to load sample data');
  console.error(error);
  process.exitCode = 1;
});


