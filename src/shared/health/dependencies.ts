export interface DependencyHealth {
  database: boolean;
  redis: boolean;
}

export interface HealthDependencies {
  check(): Promise<DependencyHealth>;
  close(): Promise<void>;
}
