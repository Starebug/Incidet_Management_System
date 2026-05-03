/**
 * AlertStrategy interface
 *
 * Each strategy determines severity and notification behavior
 * for a specific infrastructure component type.
 *
 * Design Pattern: Strategy
 * - Swap alerting logic by service type without modifying core processing
 * - Open/Closed Principle: add new strategies without touching existing ones
 */
export interface AlertStrategy {
  determineSeverity(signal: SignalContext): string;
  getNotificationChannels(): string[];
  shouldPage(): boolean;
}

export interface SignalContext {
  service_type: string;
  component_id: string;
  payload: Record<string, any>;
  rawSeverity: string;
}

