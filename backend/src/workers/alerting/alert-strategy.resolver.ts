import { Injectable } from '@nestjs/common';
import { AlertStrategy, SignalContext } from './alert-strategy.interface';
import {
  RdbmsAlertStrategy,
  ApiAlertStrategy,
  McpHostAlertStrategy,
  CacheAlertStrategy,
  QueueAlertStrategy,
  NoSqlAlertStrategy,
  DefaultAlertStrategy,
} from './strategies';

/**
 * AlertStrategyResolver
 *
 * Factory that maps service_type → AlertStrategy.
 * Uses Strategy Pattern to swap alerting logic without modifying core processing.
 *
 * Usage:
 *   const strategy = resolver.resolve('RDBMS');
 *   const severity = strategy.determineSeverity(signal);
 */
@Injectable()
export class AlertStrategyResolver {
  private readonly strategies: Map<string, AlertStrategy>;
  private readonly defaultStrategy: AlertStrategy;

  constructor() {
    this.defaultStrategy = new DefaultAlertStrategy();

    this.strategies = new Map<string, AlertStrategy>([
      ['RDBMS', new RdbmsAlertStrategy()],
      ['API', new ApiAlertStrategy()],
      ['MCP_HOST', new McpHostAlertStrategy()],
      ['DISTRIBUTED_CACHE', new CacheAlertStrategy()],
      ['ASYNC_QUEUE', new QueueAlertStrategy()],
      ['NOSQL', new NoSqlAlertStrategy()],
    ]);
  }

  /**
   * Resolve the alert strategy for a given service type.
   * Returns DefaultAlertStrategy if no specific strategy is registered.
   */
  resolve(serviceType: string): AlertStrategy {
    return this.strategies.get(serviceType) || this.defaultStrategy;
  }

  /**
   * List all registered service types (for health/debug).
   */
  getRegisteredTypes(): string[] {
    return Array.from(this.strategies.keys());
  }
}

